# Release process

This repo uses a simple three-branch model:

- `dev` is the integration branch where changes land first (default branch; can be unstable).
- `preview` is the release candidate branch used for preview builds/deploys.
- `main` is the stable/production release branch.
- `deploy/**` branches are managed by automation for deployments (do not push to these manually).

## Contributing flow (recommended)

1. Create a feature branch from `dev`.
2. Open a pull request targeting `dev`.
3. After review, changes are merged into `dev`.

Notes:

- Maintainers may push directly to `dev` when needed (depending on branch rules).
- External contributors should assume **PRs must target `dev`**, not `main`.

## Release flow (maintainers)

### Preview release (dev → preview)

When you want to publish/deploy a new preview build:

1. Run **RELEASE — Publish (preview + production)** with:
   - `environment=preview`
   - `confirm=release dev to preview`
2. The workflow runs the configured checks, optionally bumps versions (commit on `dev`), then promotes `dev` → `preview` (fast-forward).
3. Deploy/publish steps for the preview environment build from `preview` (not `dev`).

### Production release (preview → main)

When you want to ship what’s currently in `preview` to production:

1. Run **RELEASE — Publish (preview + production)** with:
   - `environment=production`
   - `confirm=release preview to main`
2. The workflow promotes `preview` → `main` (fast-forward by default; guarded reset is available), then deploys/publishes from `main`.

Notes:

- Urgent path (avoid preview): `confirm=release dev to main` (or `reset main from dev`).

Deploy branches typically include `deploy/<env>/ui`, `deploy/<env>/server`, `deploy/<env>/website`, and `deploy/<env>/docs` (depending on what changed and which options you select).

## Deploy branches → production infrastructure

Pushes to `deploy/<env>/*` are intended to trigger deployment automation (for example, calling a protected deploy hook behind Cloudflare Access). How deployments are performed is intentionally decoupled from how code is promoted into deploy branches.

In this repo, the deploy hook is implemented by the **DEPLOY — Deploy Branch** workflow:

- Trigger: pushes to `deploy/<env>/<component>` (or a manual workflow dispatch).
- Action: sends `POST` requests to one or more configured deploy webhook URLs for that component.
- Auth: adds Cloudflare Access service-token headers (`CF-Access-Client-Id` / `CF-Access-Client-Secret`).
- Server deploy order: API first, then worker.

Configuration (recommended as GitHub *Environment* secrets/vars for `production` / `preview`):

- `CF_WEBHOOK_DEPLOY_CLIENT_ID`, `CF_WEBHOOK_DEPLOY_CLIENT_SECRET`
- `DEPLOY_WEBHOOK_URL`: base URL (e.g. `https://ci.leecloud.ch/api/deploy/`)
- Newline-separated webhook URL lists:
  - `HAPPIER_UI_DEPLOY_WEBHOOKS`
  - `HAPPIER_WEBSITE_DEPLOY_WEBHOOKS`
  - `HAPPIER_DOCS_DEPLOY_WEBHOOKS`
  - `HAPPIER_SERVER_API_DEPLOY_WEBHOOKS`
  - `HAPPIER_SERVER_WORKER_DEPLOY_WEBHOOKS`
  - `HAPPIER_CLI_DEPLOY_WEBHOOKS`

The `HAPPIER_*_DEPLOY_WEBHOOKS` values can be either:
- webhook IDs (recommended), which will be called as `${DEPLOY_WEBHOOK_URL}/{id}`
- full `https://…` URLs (supported for backwards compatibility)

If you only need to move branches (no deploy/publish):

- Use **PROMOTE — Branch (fast-forward or reset)** to move `source` → `target` in a safe, explicit way.

## Why fast-forward?

Fast-forwarding is the safest “no merge commit” promotion:

- It never rewrites history.
- It fails if branches diverged (so you can decide what to do next).

The reset option exists for rare cases where you intentionally want `target` to match `source` exactly.

## Database migrations (server)

For the server, database migrations should be automated as part of the deployment runtime:

- Run `prisma migrate deploy` at container startup (entrypoint) or via an explicit platform “pre-deploy” hook.
- Running migrations from *both* API and worker is acceptable as long as you expect contention and handle it (Prisma uses a DB lock to serialize migrations; the non-holder should wait/retry).
- Avoid running migrations at image build-time (Dockerfile), since migrations require a live DB connection.
