# Happier Server

Minimal backend for open-source end-to-end encrypted Claude Code clients.

## What is Happier?

Happier Server is the synchronization backbone for secure Claude Code clients. It enables multiple devices to share encrypted conversations while maintaining complete privacy - the server never sees your messages, only encrypted blobs it cannot read.

## Features

- 🔐 **Zero Knowledge** - The server stores encrypted data but has no ability to decrypt it
- 🎯 **Minimal Surface** - Only essential features for secure sync, nothing more
- 🕵️ **Privacy First** - No analytics, no tracking, no data mining
- 📖 **Open Source** - Transparent implementation you can audit and self-host
- 🔑 **Cryptographic Auth** - No passwords stored, only public key signatures
- ⚡ **Real-time Sync** - WebSocket-based synchronization across all your devices
- 📱 **Multi-device** - Seamless session management across phones, tablets, and computers
- 🤝 **Session Sharing** - Collaborate on conversations with granular access control
- 🔔 **Push Notifications** - Notify when Claude Code finishes tasks or needs permissions (encrypted, we can't see the content)
- 🌐 **Distributed Ready** - Built to scale horizontally when needed

## How It Works

Your Claude Code clients generate encryption keys locally and use Happier Server as a secure relay. Messages are end-to-end encrypted before leaving your device. The server's job is simple: store encrypted blobs and sync them between your devices in real-time.

### Session Sharing

Happier Server supports secure collaboration through two sharing methods:

**Direct Sharing**: Share sessions with specific users by username, with three access levels:
- **View**: Read-only access to messages
- **Edit**: Can send messages but cannot manage sharing
- **Admin**: Full access including sharing management

**Public Links**: Generate shareable URLs for broader access:
- Always read-only for security
- Optional expiration dates and usage limits
- Consent-based access logging (IP/UA only logged with explicit consent)

All sharing maintains end-to-end encryption - encrypted data keys are distributed to authorized users, and the server never sees unencrypted content.

## Hosting

**You don't need to self-host!** Our hosted Happier Server at `api.happier.dev` is just as secure as running your own. Since all data is end-to-end encrypted before it reaches our servers, we literally cannot read your messages even if we wanted to. The encryption happens on your device, and only you have the keys.

That said, Happier Server is open source and self-hostable if you prefer running your own infrastructure. The security model is identical whether you use our servers or your own.

## Server flavors

Happier Server supports two flavors that share the same API + internal logic. The only difference is which infrastructure backends are used for storage.

- **full** (default, recommended for production): Postgres + optional Redis (for multi-replica Socket.IO) + S3/Minio-compatible public file storage.
- **light** (recommended for self-hosting/testing): embedded Postgres via PGlite (no external Postgres/Redis required) + local public file storage served by the server under `GET /files/*`.

## Required environment (full flavor)

The full flavor expects these env vars to be set:

- `DATABASE_URL` (Postgres), for example: `postgresql://user:pass@db.example.com:5432/happy?sslmode=require`
- `HANDY_MASTER_SECRET` (used to derive auth/encryption secrets)
- Public file storage (S3/Minio):
  - `S3_HOST`
  - `S3_PORT` (optional)
  - `S3_USE_SSL` (`true`/`false`, defaults to `true`)
  - `S3_BUCKET`
  - `S3_PUBLIC_URL` (base URL used to build file URLs)
  - `S3_ACCESS_KEY`
  - `S3_SECRET_KEY`

Optional (recommended for multi-core / multi-replica):

- `REDIS_URL` + `HAPPY_SOCKET_REDIS_ADAPTER=1`

### Example `.env` (full flavor, production)

```bash
# Required: DB
DATABASE_URL=postgresql://happy:happy@127.0.0.1:5432/happy?sslmode=require
HANDY_MASTER_SECRET=change-me-to-a-long-random-string

# Required: public file storage (S3 / Minio)
S3_HOST=127.0.0.1
S3_PORT=9000
S3_USE_SSL=false
S3_BUCKET=happy-public
S3_PUBLIC_URL=http://127.0.0.1:9000/happy-public
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin

# Optional: enable multi-replica Socket.IO fanout + cluster RPC routing
# (required if you run more than one API replica)
REDIS_URL=redis://127.0.0.1:6379
HAPPY_SOCKET_REDIS_ADAPTER=1

# Optional: process role when scaling (unset => "all")
# SERVER_ROLE=api
# SERVER_ROLE=worker

# Optional: ports
PORT=3005
METRICS_ENABLED=true
METRICS_PORT=9090

# Optional: instance id for logs/registry
# HAPPY_INSTANCE_ID=api-1
```

### Example `.env` (light flavor, self-hosting)

```bash
# Optional: where light flavor stores its local data (DB + files + secrets).
# If unset, defaults to ~/.happy/server-light
HAPPY_SERVER_LIGHT_DATA_DIR=/var/lib/happy/server-light

# Optional: ports
PORT=3005
METRICS_PORT=9090

# Optional: you can set this for a stable secret (otherwise light will generate+persist one).
# HANDY_MASTER_SECRET=change-me-to-a-long-random-string
```

### TLS note (light flavor only)

The light flavor runs an embedded Postgres-compatible server (`pglite-socket`) bound to `127.0.0.1` and **does not support TLS**. Happy Server automatically connects to it with `sslmode=disable`.

This does **not** affect the full flavor. If your production Postgres requires TLS, keep using a normal `postgresql://...` `DATABASE_URL` (the server will not force-disable TLS for real Postgres URLs).

Light DB version pairing note:

- This repo is tested with `@electric-sql/pglite@0.3.15` + `@electric-sql/pglite-socket@0.0.20` (see `yarn.lock`).
- If you change these versions, run `yarn --cwd packages/happy-server migrate:light:deploy` and `yarn --cwd packages/happy-server start:light` as a smoke check.

## Production scaling (multi-core / multi-replica)

Happy Server scales by running **multiple API processes** (one Node.js process uses one CPU core effectively for JS work). To scale safely with Socket.IO, you must use a shared adapter and a load balancer configuration that keeps long-lived websocket sessions stable.

### Roles (API vs worker)

The server can run in three modes:

- `SERVER_ROLE` unset → **all** (default): runs API + realtime + background loops in a single process (simple deployments / dev).
- `SERVER_ROLE=api`: runs HTTP + Socket.IO (accepts client connections) + metrics server.
- `SERVER_ROLE=worker`: runs background loops (timeouts, DB metrics updater) and publishes realtime events via Redis adapter; does **not** accept client connections.

Recommended production topology:

- **N× API replicas** with `SERVER_ROLE=api`
- **1× worker replica** with `SERVER_ROLE=worker`

### Redis adapter (required when running >1 API)

When running more than one API process/replica, enable the Socket.IO Redis Streams adapter:

- `REDIS_URL=redis://...`
- `HAPPY_SOCKET_REDIS_ADAPTER=1`

To explicitly disable it (single-process mode / light flavor), leave it unset or set:

- `HAPPY_SOCKET_REDIS_ADAPTER=0`

This enables:

- room-based fanout for `update` / `ephemeral` events
- cluster-aware Socket.IO RPC routing (method registry stored in Redis)

Presence stream (when Redis adapter is enabled):

- `HAPPY_PRESENCE_STREAM_MAXLEN` (default: `100000`)
  - uses Redis `XADD ... MAXLEN ~ N` trimming for the `presence:alive:v1` stream to prevent unbounded growth
  - set to `0` to disable trimming (not recommended in production)

Important:

- When you run `SERVER_ROLE=api` with the Redis adapter enabled, durable presence is **published** by API processes but **consumed** (and written to the DB) by a `SERVER_ROLE=worker` process. If you do not run a worker replica, durable presence updates will not be persisted.

### Example: multi-process on one host

For a quick local production-like test (requires Redis):

```bash
# Worker (no HTTP server; publishes events via Redis adapter; runs background loops)
SERVER_ROLE=worker HAPPY_SOCKET_REDIS_ADAPTER=1 REDIS_URL=redis://127.0.0.1:6379 METRICS_PORT=0 yarn start

# API replicas (different PORTs on the same host; put a load balancer in front in real deployments)
SERVER_ROLE=api HAPPY_SOCKET_REDIS_ADAPTER=1 REDIS_URL=redis://127.0.0.1:6379 PORT=3005 METRICS_PORT=0 yarn start
SERVER_ROLE=api HAPPY_SOCKET_REDIS_ADAPTER=1 REDIS_URL=redis://127.0.0.1:6379 PORT=3006 METRICS_PORT=0 yarn start
```

### Sticky sessions (required for websocket load balancing)

If you run multiple API replicas behind a load balancer/ingress, you must configure **sticky sessions** so a given websocket client keeps talking to the same API pod/process after the initial upgrade. Without stickiness, reconnects and long-poll fallbacks can flap between replicas and degrade realtime behavior.

### DB connection pool sizing

With multiple API processes, total Postgres connections become roughly:

`(N_api + N_worker) × prisma_pool_size`

To avoid exhausting Postgres connections:

- pick a Postgres `max_connections` target (or pooler capacity),
- budget connections per process,
- keep per-process pools conservative (especially for websocket-heavy API processes).

Prisma pooling is typically configured via the database connection string / driver settings. A common pattern is to append a per-process limit (for example `connection_limit=<n>`) to `DATABASE_URL`, or to point `DATABASE_URL` at a pooler (PgBouncer) and keep the app-side pool small.

### Operational tips

- Set `HAPPY_INSTANCE_ID` to something stable per process/pod for debugging (for example, Kubernetes `metadata.uid`). If unset, it is generated automatically at runtime.
- If you run API + worker processes on the same host, ensure their `PORT`/`METRICS_PORT` values do not conflict.
- To disable the metrics server (for example in some local multi-process setups), set `METRICS_ENABLED=false`. To avoid conflicts while keeping it enabled, set `METRICS_PORT=0` (random free port) or choose distinct ports per process.

### Choosing a flavor

- **full**: run `yarn start` (uses `sources/main.ts` → `startServer('full')`)
- **light**: run `yarn start:light` (uses `sources/main.light.ts` → `startServer('light')`)

For local development, `yarn dev:light` is the easiest entrypoint for the light flavor (it creates the local dirs and runs `prisma migrate deploy` against embedded Postgres (PGlite) before starting).

### Local development

#### Prerequisites

- Node.js + Yarn
- Docker (required only for the full flavor local deps)

#### Full flavor (Postgres + Redis + S3/Minio)

This repo includes convenience scripts to start Postgres/Redis/Minio via Docker and then run migrations.

```bash
yarn install

# Start dependencies
yarn db
yarn redis
yarn s3
yarn s3:init

# Apply migrations (uses `.env.dev`)
yarn migrate

# Start the server (loads `.env.dev`)
PORT=3005 yarn dev
```

Verify:

```bash
curl http://127.0.0.1:3005/health
```

Notes:

- If port `3005` is already in use, choose another: `PORT=3007 ...`.
- `yarn dev` does **not** kill anything by default. You can force-kills whatever is listening on the port by using: `PORT=3005 yarn dev -- --kill-port` (or `yarn dev:kill-port`).
- `yarn start` is production-style (it expects env vars already set in your environment).
- Minio cleanup: `yarn s3:down`.

#### Light flavor (PGlite + local files)

*The light flavor does not require Docker.* It uses an embedded Postgres database (PGlite) persisted on disk and serves public files from disk under `GET /files/*`.

```bash
yarn install

# Runs `prisma migrate deploy` against embedded Postgres (PGlite) before starting
PORT=3005 yarn dev:light
```

Verify:

```bash
curl http://127.0.0.1:3005/health
```

Notes:

- `yarn dev:light` runs `prisma migrate deploy` against the embedded Postgres database before starting.
- If you want a clean slate for local dev/testing, delete the light data dir (default: `~/.happy/server-light`) or point the light flavor at a fresh dir via `HAPPY_SERVER_LIGHT_DATA_DIR=/tmp/happy-server-light`.

### Prisma schema (full vs light)

- `prisma/schema.prisma` is the single source of truth.
- Both **full** and **light** use the same schema and the same migration history:
  - migrations: `prisma/migrations/*`

The full (Postgres) flavor uses migrations:

- Dev migrations: `yarn migrate` / `yarn migrate:reset` (uses `.env.dev`)
  - Applies/creates migrations under `prisma/migrations/*`

The light (PGlite) flavor uses the same migrations:

- Apply checked-in migrations (recommended for self-hosting upgrades): `yarn migrate:light:deploy`
  - Applies migrations under `prisma/migrations/*` to the embedded Postgres database.

Light flavor note (SQLite → PGlite):

- Older versions of Happy Server used SQLite for the light flavor.
- Current versions use embedded Postgres via PGlite for better compatibility with production Postgres and a single shared Prisma schema.
- There is currently **no built-in automatic migration** from the old SQLite database to PGlite.
  - Before upgrading, back up your previous light data directory (including any SQLite DB files).
  - After upgrading, run `yarn migrate:light:deploy` and validate the server starts with `yarn start:light`.

### Schema changes (developer workflow)

When you change the data model:

1. Edit `prisma/schema.prisma`
2. Create/update the migration:
   - `yarn migrate --name <name>` (writes to `prisma/migrations/*`)
3. Validate:
   - `yarn test`
   - Smoke test both flavors (`yarn dev` and `yarn dev:light`)

No-data-loss guidelines:

- Prefer “expand/contract”: add new columns/tables, backfill, switch code, and only remove old fields in a major version (or never).
- Be careful with renames. If you only need to rename the Prisma Client API, prefer `@map` / `@@map`.

Light defaults (when env vars are missing):

- data dir: `~/.happy/server-light`
- pglite db dir: `~/.happy/server-light/pglite`
- public files: `~/.happy/server-light/files/*`
- `HANDY_MASTER_SECRET` is generated (once) and persisted to `~/.happy/server-light/handy-master-secret.txt`

### Serve UI (optional, any flavor)

You can serve a prebuilt web UI bundle (static directory) from the server process. This is opt-in and does not affect the full flavor unless enabled.

- `HAPPY_SERVER_UI_DIR=/absolute/path/to/ui-build`
- `HAPPY_SERVER_UI_PREFIX=/` (default) or `/ui`

Notes:

- If `HAPPY_SERVER_UI_PREFIX=/`, the server serves the UI at `/` and uses an SPA fallback for unknown `GET` routes (it does **not** fallback for API paths like `/v1/*` or `/files/*`).
- If `HAPPY_SERVER_UI_PREFIX=/ui`, the UI is served under `/ui` and the server keeps its default `/` route.

## License

MIT - Use it, modify it, deploy it anywhere.
