# happierdev/relay-server

Self-host the Happier Server with Docker.

Quick start (preview):

```bash
docker run --rm -p 3005:3005 \
  -v happier-server-data:/data \
  happierdev/relay-server:preview
```

What you get:

- Happier Server (self-host-friendly defaults: light flavor + SQLite)
- Embedded web UI served at `/` by default
- Persistent state under `/data` (mount a volume)
- Non-root runtime user (`happier`)
- Signed server-runtime + UI-web release artifacts baked into the image

Common options:

- Disable UI serving: `-e HAPPIER_SERVER_UI_DIR=`
- Serve UI under `/ui`: `-e HAPPIER_SERVER_UI_PREFIX=/ui`
- Use Postgres: `-e HAPPIER_DB_PROVIDER=postgres -e DATABASE_URL=...`
- Use MySQL: build the source-based `server` target with `--build-arg HAPPIER_BUILD_DB_PROVIDERS='postgres|mysql'`; prebuilt `relay-server` images do not include the generated MySQL Prisma client.

Docs:

- Docker deployment: https://docs.happier.dev/deployment/docker
