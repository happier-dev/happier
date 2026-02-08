# Deployment

This document describes how to deploy the Happier backend (`apps/server`) and the infrastructure it expects.

## Runtime overview
- **App server:** Node.js running `tsx ./sources/main.ts` (Fastify + Socket.IO).
- **Database:** Postgres via Prisma.
- **Cache:** Redis (currently used for connectivity and future expansion).
- **Object storage:** S3-compatible storage for user-uploaded assets (MinIO works).
- **Metrics:** Optional Prometheus `/metrics` server on a separate port.

## Required services
1. **Postgres**
   - Required for all persisted data.
   - Configure via `DATABASE_URL`.

2. **Redis**
   - Required by startup (`redis.ping()` is called).
   - Configure via `REDIS_URL`.

3. **S3-compatible storage**
   - Used for avatars and other uploaded assets.
   - Configure via `S3_HOST`, `S3_PORT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL`, `S3_USE_SSL`.

## Environment variables
**Required**
- `DATABASE_URL`: Postgres connection string.
- `HANDY_MASTER_SECRET`: master key for auth tokens and server-side encryption.
- `REDIS_URL`: Redis connection string.
- `S3_HOST`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_PUBLIC_URL`: object storage config.

**Common**
- `PORT`: API server port (default `3005`).
- `METRICS_ENABLED`: set to `false` to disable metrics server.
- `METRICS_PORT`: metrics server port (default `9090`).
- `S3_PORT`: optional S3 port.
- `S3_USE_SSL`: `true`/`false` (default `true`).

**Optional integrations**
- GitHub (OAuth + optional org allowlist enforcement)
  - OAuth (used for linking a GitHub identity and for GitHub-only signup when enabled):
    - `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
    - `GITHUB_REDIRECT_URL` (preferred) or legacy `GITHUB_REDIRECT_URI`
      - Set this to your server callback: `https://YOUR_SERVER/v1/oauth/github/callback`
    - Optional: `GITHUB_STORE_ACCESS_TOKEN` (`true` to persist encrypted user tokens; default `false`)
  - Auth policy / enforcement (enterprise / self-hosting restrictions):
    - `AUTH_ANONYMOUS_SIGNUP_ENABLED` (default `true`)
    - `AUTH_SIGNUP_PROVIDERS` (e.g. `github`)
    - `AUTH_REQUIRED_LOGIN_PROVIDERS` (e.g. `github`)
    - `AUTH_GITHUB_ALLOWED_USERS` (CSV list of lowercase GitHub logins)
    - `AUTH_GITHUB_ALLOWED_ORGS` (CSV list of lowercase org slugs)
    - `AUTH_GITHUB_ORG_MATCH` (`any`/`all`, default `any`)
    - `AUTH_OFFBOARDING_ENABLED` (default `true` when allowlists are set)
    - `AUTH_OFFBOARDING_INTERVAL_SECONDS` (default `600`)
    - `AUTH_OFFBOARDING_MODE` (`per-request-cache`)
    - `AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE` (`github_app` recommended when org allowlist is set, or `oauth_user_token`)
  - GitHub App mode for org membership checks (recommended; avoids relying on user OAuth tokens):
    - `AUTH_GITHUB_APP_ID`
    - `AUTH_GITHUB_APP_PRIVATE_KEY` (PEM)
    - `AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG` (e.g. `acme=123,other=456`)
- Voice (server-minted ElevenLabs conversation tokens via `POST /v1/voice/token`):
  - Required: `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID_PROD`
  - Required when `VOICE_REQUIRE_SUBSCRIPTION=true`: `REVENUECAT_SECRET_KEY`
  - Optional controls:
    - `VOICE_ENABLED` (`true`/`false`, default `true`)
    - `VOICE_REQUIRE_SUBSCRIPTION` (`true`/`false`, defaults to `true` when `NODE_ENV=production`)
    - `VOICE_FREE_SESSIONS_PER_MONTH` (default `0`)
    - `VOICE_FREE_MINUTES_PER_MONTH` (default `0`, enforced when `VOICE_REQUIRE_SUBSCRIPTION=true`)
    - `VOICE_MAX_CONCURRENT_SESSIONS` (default `1`)
    - `VOICE_MAX_SESSION_SECONDS` (default `1200`, min `30`)
    - `VOICE_MAX_MINUTES_PER_DAY` (default `0` = unlimited; global per-user guardrail)
    - `VOICE_TOKEN_MAX_PER_MINUTE` (default `10`, `0` disables rate limiting)
    - `VOICE_COMPLETE_MAX_PER_MINUTE` (default `60`, `0` disables rate limiting)
    - `VOICE_LEASE_CLEANUP` (`true`/`false`, default `false`)
    - `VOICE_LEASE_RETENTION_DAYS` (default `30`, clamp 7–365)
    - `VOICE_LEASE_CLEANUP_INTERVAL_MS` (default `21600000` = 6h, min `10000`)
- Debug logging: `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING` (enables file logging + dev log endpoint).

## Docker image
A single multi-target Dockerfile is provided at `Dockerfile`.

Build targets:
- API server: `server`
- Worker: `server-worker`
- Website: `website`
- Webapp: `webapp`
- Docs: `docs`

Key notes:
- The server defaults to port `3005` (set `PORT` explicitly in container environments).
- The image includes FFmpeg and Python for media processing.
- The server entrypoint (`apps/server/scripts/run-server.sh`) runs `prisma migrate deploy` on startup by default (set `RUN_MIGRATIONS=0` to disable). On Postgres, it retries on advisory-lock contention.

## Kubernetes manifests
Example manifests live in `apps/server/deploy`:
- `handy.yaml`: Deployment + Service + ExternalSecrets for the server.
- `happy-redis.yaml`: Redis StatefulSet + Service + ConfigMap.

The deployment config expects:
- Prometheus scraping annotations on port `9090`.
- A secret named `handy-secrets` populated by ExternalSecrets.
- A service mapping port `3000` to container port `3005`.

## Local dev helpers
The server package includes scripts for local infrastructure:
- `yarn workspace @happier-dev/server db` (Postgres in Docker)
- `yarn workspace @happier-dev/server redis`
- `yarn workspace @happier-dev/server s3` + `s3:init`

Use `.env`/`.env.dev` to load local settings when running `yarn workspace @happier-dev/server dev`.

## Implementation references
- Entrypoint: `apps/server/sources/main.ts`
- Dockerfile: `Dockerfile`
- Kubernetes manifests: `apps/server/deploy`
- Env usage: `apps/server/sources` (`rg -n "process.env"`)
