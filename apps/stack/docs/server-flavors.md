# Server presets: `happier-server-light` vs `happier-server`

hstack supports two compatibility-facing server preset names. They select topology and backend defaults, not a restricted database implementation. You can switch presets globally (main stack) or per stack.

## What’s the difference?

Both presets use the **same server codebase**. An explicit `HAPPIER_DB_PROVIDER=postgres|mysql|pglite|sqlite` wins under either preset. Without an explicit provider, light defaults to SQLite and full defaults to Postgres.

### `happier-server-light` (recommended default)

- **No Docker required**
- Uses **SQLite by default**; PostgreSQL/MySQL can be selected with an external `DATABASE_URL`, and PGlite remains available as an embedded option
- Stores local public files under the stack directory
- Best choice for a stable “main” stack and quick local installs

Light stacks are isolated by default:

```
~/.happier/stacks/<stack>/server-light/files
~/.happier/stacks/<stack>/server-light/pglite
~/.happier/stacks/<stack>/server-light/happier-server-light.sqlite
```

Key env vars (stored in the stack env file):

- `HAPPIER_SERVER_LIGHT_DATA_DIR`
- `HAPPIER_SERVER_LIGHT_FILES_DIR`
- `HAPPIER_SERVER_LIGHT_DB_DIR`

### `happier-server` (full server)

- Docker-managed topology per stack (Redis + Minio/S3, plus Postgres only when the selected provider is Postgres without an external `DATABASE_URL`)
- Closer to “production-like” behavior
- Useful when you need Redis/S3 semantics or want to reproduce full-server-only issues

## Full server infra (no AWS required)

The full preset defaults to:

- Postgres (`DATABASE_URL`, managed by hstack when omitted)
- Redis (`REDIS_URL`)
- S3-compatible object storage (`S3_*`)

hstack can **manage this for you automatically per stack** using Docker Compose (Postgres + Redis + Minio),
so you **do not need AWS S3**.

This happens automatically when you run `hstack start/dev --server=happier-server` (or when a stack uses `happier-server`),
unless you disable it with:

```bash
export HAPPIER_STACK_MANAGED_INFRA=0
```

If disabled, you must provide `DATABASE_URL`, `REDIS_URL`, and `S3_*` yourself.

## UI serving with `happier-server`

The upstream `happier-server` does not serve the built UI itself.

For a “one URL” UX (especially with Tailscale), hstack starts a lightweight **UI gateway** that:

- serves the built UI at `/` (if a build exists)
- reverse-proxies API calls to the backend server
- reverse-proxies realtime websocket upgrades (`/v1/updates`)
- reverse-proxies public files (to local Minio)

This means `hstack start --server=happier-server` can still work end-to-end without requiring AWS S3 or a separate nginx setup.

## Migrating between flavors (light ⇢ full)

hstack includes an **experimental** migration helper that can copy core chat data from a
`happier-server-light` stack into a `happier-server` stack (Docker Postgres):

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
- **`hstack dev`** is for rapid iteration. Migration selection follows the provider under either preset (configurable via `HAPPIER_STACK_PRISMA_MIGRATE`): Postgres uses Prisma migrate deploy, MySQL uses `migrate:mysql:deploy`, SQLite uses `migrate:sqlite:deploy`, and PGlite uses `migrate:light:deploy`.

Important: for a given run (`hstack start` / `hstack dev`) you choose **one** flavor.

## How to switch (main stack)

Use the `srv` helper (persisted in `~/.happier/stacks/main/env` by default, or in your stack env file when using `hstack stack ...`):

```bash
hstack srv status
hstack srv use happier-server-light
hstack srv use happier-server
hstack srv use --interactive
```

This persists `HAPPIER_STACK_SERVER_COMPONENT`.

## How to switch for a specific stack

Use the stack wrapper:

```bash
hstack stack srv exp1 -- status
hstack stack srv exp1 -- use happier-server-light
hstack stack srv exp1 -- use happier-server
hstack stack srv exp1 -- use --interactive
```

This updates the stack env file (typically `~/.happier/stacks/<name>/env`).

## One-off overrides (do not persist)

You can override the server flavor for a single run:

```bash
hstack start --server=happier-server-light
hstack start --server=happier-server

hstack dev --server=happier-server-light
hstack dev --server=happier-server
```

## Flavor vs repo selection

There are two separate concepts:

- **Flavor selection**: which server flavor hstack runs
  - controlled by `HAPPIER_STACK_SERVER_COMPONENT` (via `hstack srv use ...`)
- **Repo selection**: which monorepo checkout/worktree the stack runs from
  - controlled by `HAPPIER_STACK_REPO_DIR` (via `hstack wt use ...` / `hstack stack wt <stack> -- use ...`)

## Database provider note

SQLite is the light preset default and Postgres is the full preset default. Set `HAPPIER_DB_PROVIDER` in the stack env to choose independently. PostgreSQL and MySQL require `DATABASE_URL` unless the full preset is allowed to manage its default Postgres service.
