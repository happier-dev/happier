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

Common options:

- Disable UI serving: `-e HAPPIER_SERVER_UI_DIR=`
- Serve UI under `/ui`: `-e HAPPIER_SERVER_UI_PREFIX=/ui`
- Use Postgres: `-e HAPPIER_DB_PROVIDER=postgres -e DATABASE_URL=...`

Docs:

- Docker deployment: https://docs.happier.dev/deployment/docker
