# Server flavors: `happy-server-light` vs `happy-server`

Hapsta supports two server “flavors”. You can switch between them globally (main stack) or per stack.

## What’s the difference?

Historically, both flavors lived in the same upstream server repo (`slopus/happy-server`), but optimized for different use cases.

With the Happier monorepo, the server code comes from the monorepo server package (typically `apps/server`). In branches where
the server includes the SQLite schema (`apps/server/prisma/sqlite/schema.prisma`, legacy paths may differ),
Hapsta treats `happy-server-light` and `happy-server` as **two flavors of the same checkout** (different backends, same repo).

Long-term, the intent is one server package with multiple backends (“flavors”), not separate repos.

### Unified codebase (recommended)

When your `happy-server` checkout includes the light flavor artifacts (notably `prisma/sqlite/schema.prisma` — legacy: `prisma/schema.sqlite.prisma`), Hapsta treats it as a **single unified server codebase** that supports both:

- `happy-server` (full / Postgres+Redis+S3)
- `happy-server-light` (light / SQLite+local files, can serve UI)

In that setup:

- there is **no server code duplication**
- `happy-server-light` can point at the **same checkout/worktree** as `happy-server`
- `hapsta stack new` will default to pinning **both** server component dirs to the same path
- `hapsta start/dev --server=happy-server-light` will run `start:light` / `dev:light` when available

- **`happy-server-light`** (recommended default)
  - optimized for local usage
  - can **serve the built web UI** (so `hapsta start` works end-to-end without a separate web server)
  - usually the best choice when you just want a stable “main” stack on your machine

- **`happy-server`** (full server)
  - closer to upstream “full” behavior (useful when developing server changes meant to go upstream)
  - the upstream server typically does **not** serve the built UI itself, but hapsta provides a **UI gateway** so you still get a single URL that serves the UI and proxies API/websockets/files
  - useful when you need to test upstream/server-only behavior or reproduce upstream issues, with per-stack infra isolation

## Full server infra (no AWS required)

`happy-server` requires:

- Postgres (`DATABASE_URL`)
- Redis (`REDIS_URL`)
- S3-compatible object storage (`S3_*`)

Hapsta can **manage this for you automatically per stack** using Docker Compose (Postgres + Redis + Minio),
so you **do not need AWS S3**.

This happens automatically when you run `hapsta start/dev --server=happy-server` (or when a stack uses `happy-server`),
unless you disable it with:

```bash
export HAPPIER_STACK_MANAGED_INFRA=0
```

If disabled, you must provide `DATABASE_URL`, `REDIS_URL`, and `S3_*` yourself.

## UI serving with `happy-server`

The upstream `happy-server` does not serve the built UI itself.

For a “one URL” UX (especially with Tailscale), hapsta starts a lightweight **UI gateway** that:

- serves the built UI at `/` (if a build exists)
- reverse-proxies API calls to the backend server
- reverse-proxies realtime websocket upgrades (`/v1/updates`)
- reverse-proxies public files (to local Minio)

This means `hapsta start --server=happy-server` can still work end-to-end without requiring AWS S3 or a separate nginx setup.

## Migrating between flavors (SQLite ⇢ Postgres)

Hapsta includes an **experimental** migration helper that can copy core chat data from a
`happy-server-light` stack (SQLite) into a `happy-server` stack (Postgres):

```bash
hapsta migrate light-to-server --from-stack=main --to-stack=full1
```

Optional: include local public files (server-light `files/`) by mirroring them into Minio:

```bash
hapsta migrate light-to-server --from-stack=main --to-stack=full1 --include-files
```

Notes:
- This preserves IDs (session URLs remain valid on the target server).
- It also copies the `HANDY_MASTER_SECRET` from the source stack into the target stack’s secret file so auth tokens remain valid.

## Prisma behavior (why start is safer under LaunchAgents)

- **`hapsta start`** is “production-like”. It avoids running heavyweight schema sync loops under launchd KeepAlive.
- **`hapsta dev`** is for rapid iteration:
  - for `happy-server`: Hapsta runs `prisma migrate deploy` by default (configurable via `HAPPIER_STACK_PRISMA_MIGRATE`).
  - for `happy-server-light`:
    - **unified** server-light (recommended): Hapsta runs `prisma migrate deploy` (SQLite migrations) using the unified schema under `prisma/sqlite/schema.prisma` (legacy: `prisma/schema.sqlite.prisma`).
    - **legacy** server-light: Hapsta does **not** run `prisma migrate deploy` (it commonly fails with `P3005` when the DB was created via `prisma db push` and no migrations exist). The legacy server-light dev/start scripts handle schema via `prisma db push`.

Important: for a given run (`hapsta start` / `hapsta dev`) you choose **one** flavor.

## How to switch (main stack)

Use the `srv` helper (persisted in `~/.happier/stacks/main/env` by default, or in your stack env file when using `hapsta stack ...`):

```bash
hapsta srv status
hapsta srv use happy-server-light
hapsta srv use happy-server
hapsta srv use --interactive
```

This persists `HAPPIER_STACK_SERVER_COMPONENT`.

## How to switch for a specific stack

Use the stack wrapper:

```bash
hapsta stack srv exp1 -- status
hapsta stack srv exp1 -- use happy-server-light
hapsta stack srv exp1 -- use happy-server
hapsta stack srv exp1 -- use --interactive
```

This updates the stack env file (typically `~/.happier/stacks/<name>/env`).

## One-off overrides (do not persist)

You can override the server flavor for a single run:

```bash
hapsta start --server=happy-server-light
hapsta start --server=happy-server

hapsta dev --server=happy-server-light
hapsta dev --server=happy-server
```

## Flavor vs repo selection

There are two separate concepts:

- **Flavor selection**: which server flavor Hapsta runs
  - controlled by `HAPPIER_STACK_SERVER_COMPONENT` (via `hapsta srv use ...`)
- **Repo selection**: which monorepo checkout/worktree the stack runs from
  - controlled by `HAPPIER_STACK_REPO_DIR` (via `hapsta wt use ...` / `hapsta stack wt <stack> -- use ...`)
