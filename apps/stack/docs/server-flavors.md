# Server flavors: `happy-server-light` vs `happy-server`

hstack supports two server “flavors”. You can switch between them globally (main stack) or per stack.

## What’s the difference?

Historically, both flavors lived in the same upstream server repo (`slopus/happy-server`), but optimized for different use cases.

With the Happier monorepo, the server code comes from the monorepo server package (typically `apps/server`). In branches where
the server includes the SQLite schema (`apps/server/prisma/sqlite/schema.prisma`, legacy paths may differ),
hstack treats `happy-server-light` and `happy-server` as **two flavors of the same checkout** (different backends, same repo).

Long-term, the intent is one server package with multiple backends (“flavors”), not separate repos.

### Unified codebase (recommended)

When your `happy-server` checkout includes the light flavor artifacts (notably `prisma/sqlite/schema.prisma` — legacy: `prisma/schema.sqlite.prisma`), hstack treats it as a **single unified server codebase** that supports both:

- `happy-server` (full / Postgres+Redis+S3)
- `happy-server-light` (light / SQLite+local files, can serve UI)

In that setup:

- there is **no server code duplication**
- `happy-server-light` can point at the **same checkout/worktree** as `happy-server`
- `hstack stack new` will default to pinning **both** server component dirs to the same path
- `hstack start/dev --server=happy-server-light` will run `start:light` / `dev:light` when available

- **`happy-server-light`** (recommended default)
  - optimized for local usage
  - can **serve the built web UI** (so `hstack start` works end-to-end without a separate web server)
  - usually the best choice when you just want a stable “main” stack on your machine

- **`happy-server`** (full server)
  - closer to upstream “full” behavior (useful when developing server changes meant to go upstream)
  - the upstream server typically does **not** serve the built UI itself, but hstack provides a **UI gateway** so you still get a single URL that serves the UI and proxies API/websockets/files
  - useful when you need to test upstream/server-only behavior or reproduce upstream issues, with per-stack infra isolation

## Full server infra (no AWS required)

`happy-server` requires:

- Postgres (`DATABASE_URL`)
- Redis (`REDIS_URL`)
- S3-compatible object storage (`S3_*`)

hstack can **manage this for you automatically per stack** using Docker Compose (Postgres + Redis + Minio),
so you **do not need AWS S3**.

This happens automatically when you run `hstack start/dev --server=happy-server` (or when a stack uses `happy-server`),
unless you disable it with:

```bash
export HAPPIER_STACK_MANAGED_INFRA=0
```

If disabled, you must provide `DATABASE_URL`, `REDIS_URL`, and `S3_*` yourself.

## UI serving with `happy-server`

The upstream `happy-server` does not serve the built UI itself.

For a “one URL” UX (especially with Tailscale), hstack starts a lightweight **UI gateway** that:

- serves the built UI at `/` (if a build exists)
- reverse-proxies API calls to the backend server
- reverse-proxies realtime websocket upgrades (`/v1/updates`)
- reverse-proxies public files (to local Minio)

This means `hstack start --server=happy-server` can still work end-to-end without requiring AWS S3 or a separate nginx setup.

## Migrating between flavors (SQLite ⇢ Postgres)

hstack includes an **experimental** migration helper that can copy core chat data from a
`happy-server-light` stack (SQLite) into a `happy-server` stack (Postgres):

```bash
hstack migrate light-to-server --from-stack=main --to-stack=full1
```

Optional: include local public files (server-light `files/`) by mirroring them into Minio:

```bash
hstack migrate light-to-server --from-stack=main --to-stack=full1 --include-files
```

Notes:
- This preserves IDs (session URLs remain valid on the target server).
- It also copies the `HANDY_MASTER_SECRET` from the source stack into the target stack’s secret file so auth tokens remain valid.

## Prisma behavior (why start is safer under LaunchAgents)

- **`hstack start`** is “production-like”. It avoids running heavyweight schema sync loops under launchd KeepAlive.
- **`hstack dev`** is for rapid iteration:
  - for `happy-server`: hstack runs `prisma migrate deploy` by default (configurable via `HAPPIER_STACK_PRISMA_MIGRATE`).
  - for `happy-server-light`:
    - **unified** server-light (recommended): hstack runs `prisma migrate deploy` (SQLite migrations) using the unified schema under `prisma/sqlite/schema.prisma` (legacy: `prisma/schema.sqlite.prisma`).
    - **legacy** server-light: hstack does **not** run `prisma migrate deploy` (it commonly fails with `P3005` when the DB was created via `prisma db push` and no migrations exist). The legacy server-light dev/start scripts handle schema via `prisma db push`.

Important: for a given run (`hstack start` / `hstack dev`) you choose **one** flavor.

## How to switch (main stack)

Use the `srv` helper (persisted in `~/.happier/stacks/main/env` by default, or in your stack env file when using `hstack stack ...`):

```bash
hstack srv status
hstack srv use happy-server-light
hstack srv use happy-server
hstack srv use --interactive
```

This persists `HAPPIER_STACK_SERVER_COMPONENT`.

## How to switch for a specific stack

Use the stack wrapper:

```bash
hstack stack srv exp1 -- status
hstack stack srv exp1 -- use happy-server-light
hstack stack srv exp1 -- use happy-server
hstack stack srv exp1 -- use --interactive
```

This updates the stack env file (typically `~/.happier/stacks/<name>/env`).

## One-off overrides (do not persist)

You can override the server flavor for a single run:

```bash
hstack start --server=happy-server-light
hstack start --server=happy-server

hstack dev --server=happy-server-light
hstack dev --server=happy-server
```

## Flavor vs repo selection

There are two separate concepts:

- **Flavor selection**: which server flavor hstack runs
  - controlled by `HAPPIER_STACK_SERVER_COMPONENT` (via `hstack srv use ...`)
- **Repo selection**: which monorepo checkout/worktree the stack runs from
  - controlled by `HAPPIER_STACK_REPO_DIR` (via `hstack wt use ...` / `hstack stack wt <stack> -- use ...`)
