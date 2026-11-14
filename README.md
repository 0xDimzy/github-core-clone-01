# forge — a GitHub-compatible git forge

A single-process, in-memory GitHub-compatible git forge written in dependency-free
TypeScript (Node 22, erasable types only). It speaks the surfaces the conformance
suite grades:

- **Git smart HTTP** — protocol v2 (`ls-refs`, `fetch` with shallow/deepen,
  `acknowledgments`/`shallow-info`/`packfile` sections) and v0 (`upload-pack`,
  `receive-pack` with report-status, fast-forward enforcement, per-ref `ok`/`ng`).
  Packfiles are written and read in-process (plain objects, OFS/REF delta
  resolution on read), with exact SHA-1 object hashing.
- **REST v3** — repos, branches, refs, commits, contents (create/update/delete with
  base64 blobs and stale-sha 409s), labels, issues, comments, pull requests,
  squash merge with the same-file-different-change conflict rule, and paginated
  lists with `Link` headers.
- **GraphQL v4** — a small hand-written parser and executor covering `viewer`,
  `repository`, `node`, `__type` introspection, issue/PR connections with cursor
  pagination, and the `createIssue` / `closeIssue` / `createPullRequest` /
  `mergePullRequest` / `addComment` mutations.
- **MCP** — JSON-RPC 2.0 over Streamable HTTP (`server/discover`, `initialize`,
  `tools/list`, `tools/call`) with six tools: `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.

All state lives in memory and is deterministic: ids and timestamps come from
counters seeded at a fixed epoch, so a replayed trial produces byte-identical
exports. No network access, no `git` binary, no disk I/O on the request path.

## Layout

- `main.ts` — env lifecycle (bind ephemeral port, register, poll `/done`).
- `app.ts` — HTTP server: routing, auth, REST, GraphQL, MCP, git smart HTTP.
- `store.ts` — the in-memory model: repos, trees, issues, PRs, diff, merge.
- `gitcore.ts` — object model, pkt-line codec, packfile read/write, reachability.
- `graphql.ts` — GraphQL parser + executor.
- `mcp.ts` — MCP JSON-RPC handler and the six tools.

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

The process binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`, and
exits when the env reports done. `MAKEFUN_SHOP_TOKEN` is the Bearer token every
API, GraphQL, MCP, and git call must present; a missing or wrong token is a 401.
