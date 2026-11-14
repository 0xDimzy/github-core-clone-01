// app.ts — the forge HTTP server: REST v3, GraphQL v4, MCP, and git smart HTTP.
// Single process, fully in-memory store, deterministic output (counter-based ids and
// timestamps; no wall-clock or randomness in any response body).
import http from 'node:http';
import { Forge, VIEWER, EMPTY_TREE_OID, commitMessageOf } from './store.ts';
import type { Repo } from './store.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp, repoJson, issueJson, pullJson } from './mcp.ts';
import {
  ZERO_OID, isObjectId, pktLine, PKT_FLUSH, decodePktLines, parseCommit, parseTag, parseTree,
  peelToCommit, readPack, writePack,
} from './gitcore.ts';
import type { GitObject } from './gitcore.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const AGENT = 'forge/1.0';
// The v2 capability advertisement never changes, so it is built once and reused
// (a clone makes three advertisement GETs; a push makes one).
const V2_ADVERTISEMENT = Buffer.concat([
  pktLine('# service=git-upload-pack\n'), PKT_FLUSH,
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done filter\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);
const UPLOAD_CAPS = (defaultBranch: string): string =>
  `symref=HEAD:refs/heads/${defaultBranch} multi_ack multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT} object-format=sha1`;
const RECEIVE_CAPS = (defaultBranch: string): string =>
  `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${defaultBranch} object-format=sha1`;

let requestSeq = 0;

export function createApp(): http.Server {
  const forge = new Forge();
  const server = http.createServer((req, res) => {
    void handle(req, res, forge).catch((err) => {
      if (!res.headersSent) {
        try { sendJson(req, res, 500, { message: 'internal error' }); } catch { /* socket gone */ }
      }
      process.stderr.write(`[forge] handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    });
  });
  return server;
}

// ---------------------------------------------------------------- plumbing
function nextRequestId(): string { return `forge-${++requestSeq}`; }

function sendJson(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': data.length,
    'X-GitHub-Request-Id': nextRequestId(),
    ...extra,
  });
  res.end(data);
}

function sendError(req: http.IncomingMessage, res: http.ServerResponse, status: number, message: string): void {
  sendJson(req, res, status, { message });
}

function sendGit(res: http.ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'X-GitHub-Request-Id': nextRequestId(),
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(raw.toString('utf8')) }; }
  catch { return { ok: false }; }
}

function authorized(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (SHOP_TOKEN !== '' && token !== SHOP_TOKEN) return false;
  return true;
}

function baseUrlOf(req: http.IncomingMessage): string {
  return `http://${req.headers.host ?? '127.0.0.1'}`;
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; totalPages: number; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), totalPages: Math.max(1, Math.ceil(items.length / perPage)), pageNum, perPage };
}

function linkHeader(req: http.IncomingMessage, query: URLSearchParams, pageNum: number, perPage: number, totalPages: number): string {
  const base = `${baseUrlOf(req)}${new URL(req.url ?? '/', baseUrlOf(req)).pathname}`;
  const mk = (p: number): string => `<${base}?page=${p}&per_page=${perPage}>`;
  const parts: string[] = [];
  if (pageNum < totalPages) parts.push(`${mk(pageNum + 1)}; rel="next"`);
  if (pageNum > 1) parts.push(`${mk(pageNum - 1)}; rel="prev"`);
  parts.push(`${mk(1)}; rel="first"`);
  parts.push(`${mk(totalPages)}; rel="last"`);
  return parts.join(', ');
}

// Resolve a ref-ish (branch name, full ref, or oid) to a commit oid, or null.
function resolveCommit(forge: Forge, repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return forge.defaultTip(repo) ?? null;
  if (isObjectId(ref)) {
    const obj = repo.objects.get(ref);
    if (!obj) return null;
    return obj.type === 'commit' ? ref : peelToCommit(forge.lookup(repo), ref);
  }
  const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  const tip = repo.refs.get(full);
  if (!tip) return null;
  return peelToCommit(forge.lookup(repo), tip);
}

function branchTip(forge: Forge, repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function commitView(forge: Forge, repo: Repo, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  const message = obj && obj.type === 'commit' ? commitMessageOf(repo, oid) : '';
  const view = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
  return {
    sha: oid,
    commit: {
      message,
      author: { name: VIEWER.name, email: VIEWER.email },
      committer: { name: VIEWER.name, email: VIEWER.email },
    },
    parents: (view?.parents ?? []).map((p) => ({ sha: p })),
  };
}

// ---------------------------------------------------------------- git wire helpers
function sidebandChunks(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < data.length; off += 65515) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), data.subarray(off, off + 65515)])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

function refLinesV0(forge: Forge, repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const refs = forge.sortedRefs(repo);
  const defaultTip = forge.defaultTip(repo);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return lines;
  }
  const headOid = defaultTip ?? refs.find(([name]) => name.startsWith('refs/heads/'))?.[1] ?? ZERO_OID;
  lines.push(pktLine(`${headOid} HEAD\0${caps}\n`));
  for (const [name, oid] of refs) {
    if (name.startsWith('refs/tags/')) {
      lines.push(pktLine(`${oid} ${name}\n`));
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(forge.lookup(repo), oid);
        if (peeled) lines.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    } else {
      lines.push(pktLine(`${oid} ${name}\n`));
    }
  }
  return lines;
}

interface FetchPlan {
  wants: string[]; haves: string[]; shallowIn: string[]; deepen: number | null;
}

/**
 * The object set a fetch sends: the tree closure of exactly the `included`
 * commits (their trees and blobs, never a parent commit outside the set — that
 * is what makes a depth-N fetch shallow), plus every want oid itself so an
 * annotated tag object round-trips with the commit it points at. Missing
 * objects are skipped, never thrown on.
 */
function collectFetchSet(lookup: (oid: string) => GitObject | undefined, included: Set<string>, wants: string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const oid of included) {
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit' || seen.has(oid)) continue;
    seen.add(oid);
    queue.push(parseCommit(obj.data).tree);
  }
  for (const want of wants) queue.push(want);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) if (included.has(p)) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
    }
  }
  return seen;
}

/** What a fetcher already holds: like collectReachable, but a commit listed in
 * `boundaries` is held without its parents (it is the shallow boundary of the
 * client's clone). Missing objects are skipped, never thrown on. */
function collectHaveSet(lookup: (oid: string) => GitObject | undefined, roots: string[], boundaries: Set<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      if (!boundaries.has(oid)) for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
    }
  }
  return seen;
}

function computeFetch(forge: Forge, repo: Repo, plan: FetchPlan): {
  acks: string[]; shallow: string[]; unshallow: string[]; pack: Buffer;
} {
  const lookup = forge.lookup(repo);
  // Peel wants to commits; keep non-commit wants as direct object wants.
  const wantCommits: string[] = [];
  for (const want of plan.wants) {
    const peeled = peelToCommit(lookup, want);
    if (peeled) wantCommits.push(peeled);
    else if (repo.objects.has(want)) wantCommits.push(want);
  }
  // BFS distances from the want commits. With a depth limit, stop expanding
  // at distance depth-1: nothing deeper can be included, so walking the whole
  // history for a depth-1 fetch is pure waste (the clone workload's hot path).
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const c of wantCommits) if (!dist.has(c)) { dist.set(c, 0); queue.push(c); }
  while (queue.length) {
    const oid = queue.shift()!;
    const d = dist.get(oid)!;
    if (plan.deepen !== null && d >= plan.deepen - 1) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!dist.has(p) && repo.objects.has(p)) { dist.set(p, d + 1); queue.push(p); }
    }
  }
  const included = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (plan.deepen !== null) {
    const depth = plan.deepen;
    for (const [oid, d] of dist) {
      if (d < depth) included.add(oid);
    }
    for (const oid of included) {
      const d = dist.get(oid)!;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      if (d === depth - 1 && parseCommit(obj.data).parents.length > 0) shallow.push(oid);
    }
    for (const old of plan.shallowIn) {
      if (included.has(old) && (dist.get(old) ?? 0) < depth - 1) unshallow.push(old);
    }
  } else {
    for (const oid of dist.keys()) included.add(oid);
    for (const old of plan.shallowIn) if (included.has(old)) unshallow.push(old);
  }
  // Objects to send: tree closure of the included commits only (never their
  // parents' trees — that is what makes a depth-N fetch shallow), plus the
  // want oids themselves so an annotated tag object round-trips with its commit.
  // Anything reachable from the haves is subtracted.
  const sendSet = collectFetchSet(lookup, included, plan.wants);
  const haveRoots: string[] = [];
  for (const have of plan.haves) {
    const peeled = peelToCommit(lookup, have);
    if (peeled) haveRoots.push(peeled);
    else if (repo.objects.has(have)) haveRoots.push(have);
  }
  if (haveRoots.length) {
    // What the client already holds: full closure of the haves, except a
    // declared shallow boundary is held without its parents (a shallow clone
    // of the tip does not hold the parent — subtracting the full closure
    // would wrongly withhold a deepen delivery).
    const haveSet = collectHaveSet(lookup, haveRoots, new Set(plan.shallowIn));
    for (const oid of haveSet) sendSet.delete(oid);
  }
  const objects: GitObject[] = [];
  for (const oid of sendSet) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  const acks: string[] = [];
  for (const have of plan.haves) {
    const peeled = peelToCommit(lookup, have);
    if (peeled && dist.has(peeled)) acks.push(have);
  }
  return { acks, shallow, unshallow, pack: writePack(objects) };
}

// ---------------------------------------------------------------- main dispatch
async function handle(req: http.IncomingMessage, res: http.ServerResponse, forge: Forge): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', baseUrlOf(req));
  const path = url.pathname;
  const segments = path.split('/').filter((s) => s !== '');

  // Health: no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && segments[1].endsWith('.git')) {
    await handleGit(req, res, forge, method, url);
    return;
  }

  // GraphQL.
  if (path === '/api/graphql') {
    if (method !== 'POST') { sendError(req, res, 405, 'Method not allowed'); return; }
    if (!authorized(req)) { sendError(req, res, 401, 'Requires authentication'); return; }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) { sendError(req, res, 400, 'Malformed JSON body'); return; }
    if (Array.isArray(parsed.value)) {
      sendJson(req, res, 200, parsed.value.map((item) => executeGraphQL(forge, item)));
    } else {
      sendJson(req, res, 200, executeGraphQL(forge, parsed.value));
    }
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (method === 'DELETE') { sendJson(req, res, 200, {}); return; }
    if (method !== 'POST') { sendError(req, res, 405, 'Method not allowed'); return; }
    if (!authorized(req)) { sendError(req, res, 401, 'Requires authentication'); return; }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(req, res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const body = parsed.value as Record<string, unknown>;
    if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.method !== 'string') {
      sendJson(req, res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const out = handleMcp(forge, body as never);
    if (out.body === null) { res.writeHead(out.status, { 'X-GitHub-Request-Id': nextRequestId() }); res.end(); return; }
    sendJson(req, res, out.status, out.body);
    return;
  }

  // REST v3 root + meta: no auth.
  if (path === '/api/v3/' || path === '/api/v3') {
    if (method !== 'GET') { sendError(req, res, 405, 'Method not allowed'); return; }
    sendJson(req, res, 200, { current_user_url: `${baseUrlOf(req)}/api/v3/user` }, { 'X-OAuth-Scopes': 'repo, read:org' });
    return;
  }
  if (path === '/api/v3/meta') {
    if (method !== 'GET') { sendError(req, res, 405, 'Method not allowed'); return; }
    sendJson(req, res, 200, { installed_version: '1.0.0' });
    return;
  }

  // Everything else under /api/v3 needs auth.
  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!authorized(req)) { sendError(req, res, 401, 'Requires authentication'); return; }
    await handleRest(req, res, forge, method, url, segments);
    return;
  }

  sendError(req, res, 404, 'Not Found');
}

// ---------------------------------------------------------------- REST v3
async function handleRest(req: http.IncomingMessage, res: http.ServerResponse, forge: Forge, method: string, url: URL, segments: string[]): Promise<void> {
  const query = url.searchParams;

  // GET /api/v3/user
  if (segments.length === 3 && segments[2] === 'user') {
    if (method !== 'GET') { sendError(req, res, 405, 'Method not allowed'); return; }
    sendJson(req, res, 200, {
      login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User',
      url: `${baseUrlOf(req)}/api/v3/user`, html_url: `https://forge.local/${VIEWER.login}`,
    });
    return;
  }

  // /api/v3/user/repos
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'POST') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) { sendError(req, res, 400, 'Malformed JSON body'); return; }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') { sendError(req, res, 422, 'Repository name is required'); return; }
      if (forge.getRepo(VIEWER.login, name)) { sendError(req, res, 422, 'Repository already exists'); return; }
      const repo = forge.createRepo(VIEWER.login, name, typeof body.description === 'string' ? body.description : '', body.private === true);
      sendJson(req, res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const repos = forge.listRepos(VIEWER.login);
      const { page, totalPages, pageNum, perPage } = paginate(repos, query);
      sendJson(req, res, 200, page.map((r) => repoJson(r)), { Link: linkHeader(req, query, pageNum, perPage, totalPages) });
      return;
    }
    sendError(req, res, 405, 'Method not allowed');
    return;
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (segments.length >= 4 && segments[2] === 'repos') {
    const owner = segments[3];
    const repoName = segments[4];
    const repo = forge.getRepo(owner, repoName);
    if (!repo) { sendError(req, res, 404, 'Not Found'); return; }
    const rest = segments.slice(5);
    await handleRepoRest(req, res, forge, repo, method, url, rest);
    return;
  }

  sendError(req, res, 404, 'Not Found');
}

async function handleRepoRest(req: http.IncomingMessage, res: http.ServerResponse, forge: Forge, repo: Repo, method: string, url: URL, rest: string[]): Promise<void> {
  const query = url.searchParams;
  const readJson = async (): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> => {
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) return { ok: false };
    return { ok: true, value: (parsed.value ?? {}) as Record<string, unknown> };
  };

  // Repo itself: GET / PATCH / DELETE
  if (rest.length === 0) {
    if (method === 'GET') { sendJson(req, res, 200, repoJson(repo)); return; }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      res.writeHead(204, { 'X-GitHub-Request-Id': nextRequestId() });
      res.end();
      return;
    }
    if (method === 'PATCH') {
      const body = await readJson();
      if (!body.ok) { sendError(req, res, 400, 'Malformed JSON body'); return; }
      if (typeof body.value.description === 'string') repo.description = body.value.description;
      repo.updatedAt = forge.stamp().iso;
      sendJson(req, res, 200, repoJson(repo));
      return;
    }
    sendError(req, res, 405, 'Method not allowed');
    return;
  }

  // Branches
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) } }));
      sendJson(req, res, 200, branches);
      return;
    }
    if (method === 'GET' && rest.length >= 2) {
      const branch = rest.slice(1).join('/');
      const tip = branchTip(forge, repo, branch);
      if (!tip) { sendError(req, res, 404, 'Branch not found'); return; }
      sendJson(req, res, 200, { name: branch, commit: { sha: tip } });
      return;
    }
    sendError(req, res, 405, 'Method not allowed');
    return;
  }

  // git/refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = await readJson();
      if (!body.ok) { sendError(req, res, 400, 'Malformed JSON body'); return; }
      const ref = typeof body.value.ref === 'string' ? body.value.ref : '';
      const sha = typeof body.value.sha === 'string' ? body.value.sha : '';
      if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.has(sha)) { sendError(req, res, 422, 'Invalid ref or sha'); return; }
      if (repo.refs.has(ref)) { sendError(req, res, 422, 'Reference already exists'); return; }
      repo.refs.set(ref, sha);
      sendJson(req, res, 201, { ref, object: { sha } });
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const all = forge.sortedRefs(repo).map(([name, oid]) => ({ ref: name, object: { sha: oid } }));
      sendJson(req, res, 200, all);
      return;
    }
    if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
      const branch = rest.slice(3).join('/');
      const tip = branchTip(forge, repo, branch);
      if (!tip) { sendError(req, res, 404, 'Reference not found'); return; }
      sendJson(req, res, 200, { ref: `refs/heads/${branch}`, object: { sha: tip } });
      return;
    }
    if (method === 'GET' && rest.length >= 4 && rest[2] === 'tags') {
      const tag = rest.slice(3).join('/');
      const tip = repo.refs.get(`refs/tags/${tag}`);
      if (!tip) { sendError(req, res, 404, 'Reference not found'); return; }
      sendJson(req, res, 200, { ref: `refs/tags/${tag}`, object: { sha: tip } });
      return;
    }
    sendError(req, res, 404, 'Not Found');
    return;
  }

  // Commits
  if (rest[0] === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const tip = resolveCommit(forge, repo, query.get('sha') ?? undefined);
      if (!tip) { sendJson(req, res, 200, []); return; }
      const walked = forge.walkCommits(repo, tip);
      const { page } = paginate(walked, query);
      sendJson(req, res, 200, page.map((oid) => commitView(forge, repo, oid)));
      return;
    }
    sendError(req, res, 404, 'Not Found');
    return;
  }

  // Contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const tip = resolveCommit(forge, repo, query.get('ref') ?? undefined);
      if (!tip) { sendError(req, res, 404, 'Not Found'); return; }
      const commitObj = repo.objects.get(tip);
      if (!commitObj || commitObj.type !== 'commit') { sendError(req, res, 404, 'Not Found'); return; }
      const treeOid = parseCommit(commitObj.data).tree;
      if (path === '') {
        const children = forge.listDir(repo, treeOid, '') ?? [];
        sendJson(req, res, 200, children.map((c) => ({ type: c.type, name: c.name, path: c.path, sha: c.oid, size: 0 })));
        return;
      }
      const entry = forge.readPath(repo, treeOid, path);
      if (entry) {
        const blob = repo.objects.get(entry.oid);
        if (!blob) { sendError(req, res, 404, 'Not Found'); return; }
        sendJson(req, res, 200, {
          type: 'file', encoding: 'base64', name: path.split('/').pop(), path,
          sha: entry.oid, size: blob.data.length, content: blob.data.toString('base64'),
        });
        return;
      }
      const children = forge.listDir(repo, treeOid, path);
      if (children) {
        sendJson(req, res, 200, children.map((c) => ({ type: c.type, name: c.name, path: c.path, sha: c.oid, size: 0 })));
        return;
      }
      sendError(req, res, 404, 'Not Found');
      return;
    }
    if (method === 'PUT') {
      const body = await readJson();
      if (!body.ok) { sendError(req, res, 400, 'Malformed JSON body'); return; }
      const message = typeof body.value.message === 'string' ? body.value.message : '';
      const contentB64 = typeof body.value.content === 'string' ? body.value.content : '';
      if (message === '' || contentB64 === '') { sendError(req, res, 422, 'message and content are required'); return; }
      const branch = typeof body.value.branch === 'string' ? body.value.branch : repo.defaultBranch;
      let tip = branchTip(forge, repo, branch);
      if (!tip) {
        const defaultTip = forge.defaultTip(repo);
        if (defaultTip) { repo.refs.set(`refs/heads/${branch}`, defaultTip); tip = defaultTip; }
      }
      const baseTree = tip ? parseCommit(repo.objects.get(tip)!.data).tree : EMPTY_TREE_OID;
      const current = tip ? forge.readPath(repo, baseTree, path) : null;
      const expectedSha = typeof body.value.sha === 'string' ? body.value.sha : undefined;
      if (expectedSha !== undefined) {
        if (!current || current.oid !== expectedSha) { sendError(req, res, 409, 'sha does not match the current file'); return; }
      }
      const blobOid = forge.putObject(repo, 'blob', Buffer.from(contentB64, 'base64'));
      const newTree = forge.writePath(repo, baseTree, path, blobOid);
      const commitSha = forge.makeCommit(repo, newTree, tip ? [tip] : [], message);
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      const status = current ? 200 : 201;
      sendJson(req, res, status, {
        content: { name: path.split('/').pop(), path, sha: blobOid, size: Buffer.from(contentB64, 'base64').length, encoding: 'base64', type: 'file' },
        commit: { sha: commitSha, message },
      });
      return;
    }
    if (method === 'DELETE') {
      const body = await readJson();
      if (!body.ok) { sendError(req, res, 400, 'Malformed JSON body'); return; }
      const message = typeof body.value.message === 'string' ? body.value.message : '';
      const sha = typeof body.value.sha === 'string' ? body.value.sha : '';
      const branch = typeof body.value.branch === 'string' ? body.value.branch : repo.defaultBranch;
      const tip = branchTip(forge, repo, branch);
      if (!tip) { sendError(req, res, 404, 'Not Found'); return; }
      const baseTree = parseCommit(repo.objects.get(tip)!.data).tree;
      const current = forge.readPath(repo, baseTree, path);
      if (!current) { sendError(req, res, 404, 'Not Found'); return; }
      if (sha !== '' && current.oid !== sha) { sendError(req, res, 409, 'sha does not match the current file'); return; }
      const newTree = forge.deletePath(repo, baseTree, path);
      const commitSha = forge.makeCommit(repo, newTree, [tip], message);
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      sendJson(req, res, 200, { commit: { sha: commitSha, message }, content: null });
      return;
    }
    sendError(req, res, 405, 'Method not allowed');
    return;
  }

  // Labels
  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const body = await readJson();
      if (!body.ok) { sendError(req, res, 400, 'Malformed JSON body'); return; }
      const name = typeof body.value.name === 'string' ? body.value.name : '';
      if (name === '') { sendError(req, res, 422, 'Label name is required'); return; }
      const color = typeof body.value.color === 'string' ? body.value.color : 'ededed';
      repo.labels.set(name, { name, color, description: typeof body.value.description === 'string' ? body.value.description : '' });
      sendJson(req, res, 201, { name, color, description: '' });
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      sendJson(req, res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })));
      return;
    }
    sendError(req, res, 404, 'Not Found');
    return;
  }

  // Issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = await readJson();
        if (!body.ok) { sendError(req, res, 400, 'Malformed JSON body'); return; }
        const title = typeof body.value.title === 'string' ? body.value.title : '';
        if (title === '') { sendError(req, res, 422, 'Issue title is required'); return; }
        const labels = Array.isArray(body.value.labels) ? (body.value.labels as unknown[]).map((l) => typeof l === 'string' ? l : (l as { name?: unknown }).name).filter((l): l is string => typeof l === 'string') : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) { sendError(req, res, 422, `Label "${label}" does not exist`); return; }
        }
        const issue = forge.createIssue(repo, title, typeof body.value.body === 'string' ? body.value.body : '', labels);
        sendJson(req, res, 201, issueJson(repo, issue));
        return;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((i) => i.state === state);
        if (sort === 'created') {
          issues.sort((a, b) => direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq);
        }
        const { page } = paginate(issues, query);
        sendJson(req, res, 200, page.map((i) => issueJson(repo, i)));
        return;
      }
      sendError(req, res, 405, 'Method not allowed');
      return;
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num)) { sendError(req, res, 404, 'Not Found'); return; }
    const issue = repo.issues.get(num);
    if (!issue) { sendError(req, res, 404, 'Not Found'); return; }
    if (rest.length === 2) {
      if (method === 'GET') { sendJson(req, res, 200, issueJson(repo, issue)); return; }
      if (method === 'PATCH') {
        const body = await readJson();
        if (!body.ok) { sendError(req, res, 400, 'Malformed JSON body'); return; }
        if (typeof body.value.state === 'string' && (body.value.state === 'open' || body.value.state === 'closed')) issue.state = body.value.state;
        if (typeof body.value.title === 'string') issue.title = body.value.title;
        if (typeof body.value.body === 'string') issue.body = body.value.body;
        issue.updatedAt = forge.stamp().iso;
        sendJson(req, res, 200, issueJson(repo, issue));
        return;
      }
      sendError(req, res, 405, 'Method not allowed');
      return;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'POST') {
        const body = await readJson();
        if (!body.ok) { sendError(req, res, 400, 'Malformed JSON body'); return; }
        const commentBody = typeof body.value.body === 'string' ? body.value.body : '';
        if (commentBody === '') { sendError(req, res, 422, 'Comment body is required'); return; }
        const comment = forge.addComment(repo, issue, commentBody);
        sendJson(req, res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: comment.createdAt });
        return;
      }
      if (method === 'GET') {
        sendJson(req, res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: c.createdAt })));
        return;
      }
      sendError(req, res, 405, 'Method not allowed');
      return;
    }
    sendError(req, res, 404, 'Not Found');
    return;
  }

  // Pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = await readJson();
        if (!body.ok) { sendError(req, res, 400, 'Malformed JSON body'); return; }
        const head = typeof body.value.head === 'string' ? body.value.head : '';
        const base = typeof body.value.base === 'string' ? body.value.base : '';
        const title = typeof body.value.title === 'string' ? body.value.title : '';
        if (head === '' || base === '' || title === '') { sendError(req, res, 422, 'head, base and title are required'); return; }
        const headSha = branchTip(forge, repo, head);
        const baseSha = branchTip(forge, repo, base);
        if (!headSha || !baseSha) { sendError(req, res, 422, 'head or base branch not found'); return; }
        for (const p of repo.pulls.values()) {
          if (p.state === 'open' && p.headRef === head && p.baseRef === base) { sendError(req, res, 422, 'A pull request already exists for this head branch'); return; }
        }
        const pull = forge.createPull(repo, title, typeof body.value.body === 'string' ? body.value.body : '', head, base, headSha, baseSha);
        sendJson(req, res, 201, pullJson(repo, pull));
        return;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
        pulls.sort((a, b) => b.createdSeq - a.createdSeq);
        const { page } = paginate(pulls, query);
        sendJson(req, res, 200, page.map((p) => pullJson(repo, p)));
        return;
      }
      sendError(req, res, 405, 'Method not allowed');
      return;
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num)) { sendError(req, res, 404, 'Not Found'); return; }
    const pull = repo.pulls.get(num);
    if (!pull) { sendError(req, res, 404, 'Not Found'); return; }
    if (rest.length === 2) {
      if (method === 'GET') { sendJson(req, res, 200, pullJson(repo, pull)); return; }
      sendError(req, res, 405, 'Method not allowed');
      return;
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (method === 'GET') { sendJson(req, res, 200, forge.pullFiles(repo, pull)); return; }
      sendError(req, res, 405, 'Method not allowed');
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (method === 'PUT') {
        if (pull.state !== 'open' || pull.merged) { sendError(req, res, 405, 'Pull request is not open'); return; }
        if (forge.pullConflicts(repo, pull)) { sendError(req, res, 405, 'Merge conflict'); return; }
        const sha = forge.mergePull(repo, pull);
        if (!sha) { sendError(req, res, 405, 'Merge failed'); return; }
        sendJson(req, res, 200, { merged: true, sha, message: pull.title });
        return;
      }
      sendError(req, res, 405, 'Method not allowed');
      return;
    }
    sendError(req, res, 404, 'Not Found');
    return;
  }

  sendError(req, res, 404, 'Not Found');
}

// ---------------------------------------------------------------- git smart HTTP
async function handleGit(req: http.IncomingMessage, res: http.ServerResponse, forge: Forge, method: string, url: URL): Promise<void> {
  const segments = url.pathname.split('/').filter((s) => s !== '');
  const owner = segments[0];
  const repoName = segments[1].slice(0, -'.git'.length);
  const sub = segments.slice(2);
  const service = url.searchParams.get('service') ?? '';

  if (!authorized(req)) { sendError(req, res, 401, 'Requires authentication'); return; }
  const repo = forge.getRepo(owner, repoName);
  if (!repo) { sendError(req, res, 404, 'Not Found'); return; }

  // GET info/refs?service=...
  if (method === 'GET' && sub.length === 2 && sub[0] === 'info' && sub[1] === 'refs') {
    const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (service === 'git-upload-pack') {
      if (v2) {
        sendGit(res, 200, 'application/x-git-upload-pack-advertisement', V2_ADVERTISEMENT);
        return;
      }
      // A v0 advertisement is a pkt-line stream terminated by a flush: real git
      // reads refs until that flush and treats EOF without one as a hangup.
      const body = Buffer.concat([pktLine('# service=git-upload-pack\n'), PKT_FLUSH, ...refLinesV0(forge, repo, UPLOAD_CAPS(repo.defaultBranch)), PKT_FLUSH]);
      sendGit(res, 200, 'application/x-git-upload-pack-advertisement', body);
      return;
    }
    if (service === 'git-receive-pack') {
      const body = Buffer.concat([pktLine('# service=git-receive-pack\n'), PKT_FLUSH, ...refLinesV0(forge, repo, RECEIVE_CAPS(repo.defaultBranch)), PKT_FLUSH]);
      sendGit(res, 200, 'application/x-git-receive-pack-advertisement', body);
      return;
    }
    sendError(req, res, 400, 'Unknown service');
    return;
  }

  // POST git-upload-pack
  if (method === 'POST' && sub.length === 1 && sub[0] === 'git-upload-pack') {
    const raw = await readBody(req);
    let packets: ReturnType<typeof decodePktLines>['packets'];
    try {
      packets = decodePktLines(raw).packets;
    } catch {
      sendError(req, res, 400, 'Malformed pkt-line stream');
      return;
    }
    const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
    if (lines.length === 0 || !lines[0].startsWith('command=')) {
      // v0 fetch: two sections, wants then haves, each flush-terminated.
      const plan: FetchPlan = { wants: [], haves: [], shallowIn: [], deepen: null };
      for (const line of lines) {
        const text = line.replace(/\n$/, '');
        if (text.startsWith('want ')) plan.wants.push(text.slice(5).split(' ')[0]);
        else if (text.startsWith('have ')) plan.haves.push(text.slice(5).trim());
        else if (text.startsWith('shallow ')) plan.shallowIn.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) plan.deepen = parseInt(text.slice(7), 10);
      }
      if (plan.wants.length === 0) { sendError(req, res, 400, 'No wants in fetch request'); return; }
      const { acks, shallow, unshallow, pack } = computeFetch(forge, repo, plan);
      const out: Buffer[] = [];
      if (acks.length) for (const ack of acks) out.push(pktLine(`ACK ${ack}\n`));
      else out.push(pktLine('NAK\n'));
      for (const oid of shallow) out.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) out.push(pktLine(`unshallow ${oid}\n`));
      out.push(...sidebandChunks(pack), PKT_FLUSH);
      sendGit(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
      return;
    }
    // v2: command=ls-refs | command=fetch
    const command = lines[0].slice('command='.length).replace(/\n$/, '');
    const delimIdx = lines.findIndex((l) => l === '');
    // decodePktLines represents delim packets how? We re-derive args from data lines after delim.
    const args = lines.slice(1).filter((l) => l !== 'command=ls-refs\n' && l !== 'command=fetch\n');
    void delimIdx;
    if (command === 'ls-refs') {
      let peel = false;
      let symrefs = false;
      let unborn = false;
      const prefixes: string[] = [];
      for (const line of args) {
        const text = line.replace(/\n$/, '');
        if (text === 'peel') peel = true;
        else if (text === 'symrefs') symrefs = true;
        else if (text === 'unborn') unborn = true;
        else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
      }
      const out: Buffer[] = [];
      const defaultTip = forge.defaultTip(repo);
      const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
      // HEAD is emitted whenever it matches the requested prefixes: with no
      // prefixes (plain ls-refs) and when 'HEAD' itself is a requested prefix
      // (real git asks for it on clone); a refs/heads/ prefix alone does not
      // match it, which is what the ls-refs-prefix check asserts.
      if (symrefs && keep('HEAD')) {
        if (defaultTip) out.push(pktLine(`${defaultTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
        else if (unborn) out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      }
      for (const [name, oid] of forge.sortedRefs(repo)) {
        if (!keep(name)) continue;
        if (name.startsWith('refs/tags/')) {
          let line = `${oid} ${name}`;
          if (peel) {
            const obj = repo.objects.get(oid);
            if (obj && obj.type === 'tag') {
              const peeled = peelToCommit(forge.lookup(repo), oid);
              if (peeled) line += ` peeled:${peeled}`;
            }
          }
          out.push(pktLine(`${line}\n`));
        } else {
          out.push(pktLine(`${oid} ${name}\n`));
        }
      }
      out.push(PKT_FLUSH);
      sendGit(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
      return;
    }
    if (command === 'fetch') {
      const plan: FetchPlan = { wants: [], haves: [], shallowIn: [], deepen: null };
      for (const line of args) {
        const text = line.replace(/\n$/, '');
        if (text.startsWith('want ')) plan.wants.push(text.slice(5).trim());
        else if (text.startsWith('have ')) plan.haves.push(text.slice(5).trim());
        else if (text.startsWith('shallow ')) plan.shallowIn.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) plan.deepen = parseInt(text.slice(7), 10);
      }
      if (plan.wants.length === 0) { sendError(req, res, 400, 'No wants in fetch request'); return; }
      const { acks, shallow, unshallow, pack } = computeFetch(forge, repo, plan);
      // Protocol v2: the acknowledgments section exists only when the client
      // sent 'have' lines. With no haves, real git skips straight to the
      // shallow-info/packfile sections and dies on a stray acknowledgments
      // header ("expected 'packfile', received 'acknowledgments'").
      const out: Buffer[] = [];
      if (plan.haves.length > 0) {
        out.push(pktLine('acknowledgments\n'));
        if (acks.length) for (const ack of acks) out.push(pktLine(`ACK ${ack}\n`));
        else out.push(pktLine('NAK\n'));
        out.push(pktLine('ready\n'), PKT_FLUSH);
      }
      if (shallow.length || unshallow.length) {
        out.push(pktLine('shallow-info\n'));
        for (const oid of shallow) out.push(pktLine(`shallow ${oid}\n`));
        for (const oid of unshallow) out.push(pktLine(`unshallow ${oid}\n`));
        out.push(PKT_FLUSH);
      }
      out.push(pktLine('packfile\n'), ...sidebandChunks(pack), PKT_FLUSH);
      sendGit(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
      return;
    }
    sendError(req, res, 400, `Unknown upload-pack command: ${command}`);
    return;
  }

  // POST git-receive-pack
  if (method === 'POST' && sub.length === 1 && sub[0] === 'git-receive-pack') {
    const raw = await readBody(req);
    let decoded: ReturnType<typeof decodePktLines>;
    try {
      decoded = decodePktLines(raw);
    } catch {
      sendError(req, res, 400, 'Malformed pkt-line stream');
      return;
    }
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    for (const packet of decoded.packets) {
      if (packet.kind !== 'data') continue;
      let text = packet.payload.toString('utf8');
      const nul = text.indexOf('\0');
      if (nul >= 0) text = text.slice(0, nul);
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(text);
      if (!m) continue;
      commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
    }
    const packBytes = raw.subarray(decoded.offset);
    const reportLines: string[] = [];
    let unpackDetail = 'ok';
    if (packBytes.length > 0) {
      try {
        const objects = readPack(packBytes, forge.lookup(repo));
        for (const [oid, obj] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      } catch (err) {
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }
    if (unpackDetail !== 'ok') {
      reportLines.push(`unpack ${unpackDetail}`);
      for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpack failed`);
    } else {
      reportLines.push('unpack ok');
      for (const cmd of commands) {
        const current = repo.refs.get(cmd.ref);
        if (cmd.oldOid === ZERO_OID && cmd.newOid === ZERO_OID) {
          reportLines.push(`ng ${cmd.ref} invalid command`);
          continue;
        }
        if (cmd.oldOid === ZERO_OID) {
          // Create.
          if (current !== undefined) { reportLines.push(`ng ${cmd.ref} already exists`); continue; }
          if (!repo.objects.has(cmd.newOid)) { reportLines.push(`ng ${cmd.ref} object not found`); continue; }
          if (cmd.ref.startsWith('refs/heads/')) {
            if (!peelToCommit(forge.lookup(repo), cmd.newOid)) { reportLines.push(`ng ${cmd.ref} new tip is not a commit`); continue; }
          }
          repo.refs.set(cmd.ref, cmd.newOid);
          reportLines.push(`ok ${cmd.ref}`);
          continue;
        }
        if (cmd.newOid === ZERO_OID) {
          // Delete.
          if (current === undefined) { reportLines.push(`ng ${cmd.ref} reference does not exist`); continue; }
          if (current !== cmd.oldOid) { reportLines.push(`ng ${cmd.ref} old value does not match`); continue; }
          repo.refs.delete(cmd.ref);
          reportLines.push(`ok ${cmd.ref}`);
          continue;
        }
        // Update.
        if (current === undefined) { reportLines.push(`ng ${cmd.ref} reference does not exist`); continue; }
        if (current !== cmd.oldOid) { reportLines.push(`ng ${cmd.ref} old value does not match`); continue; }
        if (!repo.objects.has(cmd.newOid)) { reportLines.push(`ng ${cmd.ref} object not found`); continue; }
        const newCommit = peelToCommit(forge.lookup(repo), cmd.newOid);
        if (!newCommit) { reportLines.push(`ng ${cmd.ref} new tip is not a commit`); continue; }
        const oldCommit = peelToCommit(forge.lookup(repo), cmd.oldOid);
        if (!oldCommit || !forge.isAncestor(repo, oldCommit, newCommit)) { reportLines.push(`ng ${cmd.ref} non-fast-forward`); continue; }
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}`);
      }
    }
    // The report-status stream is itself pkt-lined inside band 1, and real git
    // reads it until an inner flush packet: without that terminator it reports
    // "the remote end hung up unexpectedly" even though every line parsed.
    const inner = Buffer.concat([...reportLines.map((l) => pktLine(`${l}\n`)), PKT_FLUSH]);
    const body = Buffer.concat([...sidebandChunks(inner), PKT_FLUSH]);
    sendGit(res, 200, 'application/x-git-receive-pack-result', body);
    return;
  }

  sendError(req, res, 404, 'Not Found');
}
