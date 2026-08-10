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

### Public contract, private operation, and human go-ahead

The public, versioned release contract is machine-readable:

```bash
node scripts/pipeline/run.mjs release-contract
```

It names the canonical versioned release targets, executable validation suites,
and three profiles:

- `integrated` and `stable` expose the same eligible automatic suite catalog.
  The registry's candidate-applicability owner selects only suites the exact
  release can exercise: artifact verification and CLI upgrade for a CLI
  candidate; binary smoke for CLI or server candidates; session continuity for
  a server candidate; and the named Docker relay upgrade only when a supported
  published relay predecessor exists.
- `stable` additionally selects the full source-check profile and requires the
  private release agent to review preview candidate equivalence and soak,
  breaking changes, reachable version-skew directions, persistence, and
  accidental lockstep requirements.
- `deep` is manual comprehensive certification. It has no automatic suite
  membership, owns risk-selected installer and Docker checks when those
  surfaces change, and covers cross-OS, provider, mobile, and full
  certification before it is considered complete. It is never a normal-release
  dispatch.

The workflow derives source-check depth from the selected public profile; a
caller cannot select a second checks profile. Every exact server candidate also
runs the focused real MySQL 8 contract. The broader cross-platform service
matrix remains part of the full stable gate rather than every preview.

The slow test lane contains two pinned server-v0.2.1 regressions for pending
queue and first-prompt behavior. They are exact tests, not a general
compatibility verdict. The release agent selects them when the actual diff can
affect those seams and reports precisely what they prove.
Broader installer, platform, provider, mobile, and historical-version checks
remain risk-selected deep certification. No suite name emits a general
compatibility verdict.

The contract is public so callers can select and verify the right evidence;
the operating procedure is private. Resolve it for an absolute checkout with:

```bash
hmaint release bootstrap --repo <absolute checkout> --json
```

Use the returned private skill rather than copying a private release policy
into this repository. A human go-ahead is required before any non-dry release
dispatch. Qualified V4 activation is not implemented in this release line; its
separate approval input must remain false. That go-ahead must name the selected profile and the exact SHA of the
candidate whose evidence was reviewed. Do not substitute a branch name or a
moving channel pointer for the exact SHA.

`node scripts/pipeline/run.mjs release --release-profile integrated` is the
normal preview path; preview and dev default to `integrated`, while production
defaults to `stable`. `stable` remains a normal dispatch only after its
additional manual evidence is complete. `deep` is deliberately rejected by the
normal dispatcher.

The profile contract describes self-hosted independent upgrade evidence; it
does not require a fleet wait, global cutover, or synchronized deployment.

### Preview release (dev → preview)

When you want to publish/deploy a new preview build:

1. Run **RELEASE — Publish (preview + production)** with:
   - `environment=preview`
   - `confirm=release dev to preview`
2. The workflow runs the configured checks against already materialized release-note/version source, then promotes `dev` → `preview` (fast-forward).
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

### Release authority and binary integrity

Privileged release writes run only in the hosted workflows. A non-dry local
`scripts/pipeline/run.mjs release` invocation validates its inputs and dispatches
`release.yml`; it does not publish assets, move deploy refs, load release
secrets, or call deployment hooks itself. Local `--dry-run` planning uses
remote-advertised identities and object-only fetches, so it does not update or
prune local branch, remote-tracking, or tag refs.

For CLI, stack, server-runtime, and UI-web binary releases:

1. The hosted workflow binds the authorized source commit once.
2. It publishes the version-tagged Release first. Existing immutable tags,
   assets, and bytes must match; they are never moved or clobbered.
3. It downloads that Release and verifies the complete checksummed and signed
   asset set.
4. A separate promotion step projects those exact bytes into the rolling
   Release, downloads them again, and checks byte equality, checksums, and the
   minisign signature.
5. For a channel with no published rolling Release yet, promotion creates one
   native GitHub draft on the real rolling tag, uploads and audits by Release
   id, then publishes that same draft. It does not create a temporary staging
   tag or ref.
6. For an already-published rolling Release, promotion retains the bounded
   fail-closed prune/repopulate/retry path. Only after its audit succeeds does
   the workflow advance the rolling tag and notes/version marker.

An initial native draft is not visible through the public Release lookup until
publication. Existing rolling replacement is deliberately recoverable rather
than atomic: downloads from the rolling tag can fail during the bounded
prune/repopulation interval, while the verified version-tagged Release remains
available throughout.

If a rolling upload is interrupted after the immutable Release was published,
rerun the owning publisher with the same `channel` and its version as
`retry_version`. Leave `source_ref=auto`: recovery derives the exact authorized
SHA from the product's immutable version tag, so it remains valid after the
channel branch and current control-checkout package base advance. Recovery
accepts only the latest published immutable Release for that product and
channel; it does not permit rollback to an arbitrary older version. The
supported publishers are:

- **PUBLISH — CLI Binaries (GitHub)** (`publish-cli-binaries.yml`)
- **PUBLISH — Stack Binaries (GitHub)** (`publish-hstack-binaries.yml`)
- **PUBLISH — Server Runtime (GitHub)** (`publish-server-runtime.yml`)
- **PUBLISH — UI Web Bundle (GitHub)** (`publish-ui-web.yml`)

This recovery path copies the existing immutable bytes; it does not rebuild,
allocate a new version, sign new bytes, or mutate the immutable Release. For
example:

```bash
gh workflow run publish-server-runtime.yml \
  --repo OWNER/REPOSITORY \
  --ref dev \
  -f channel=preview \
  -f source_ref=auto \
  -f allow_stable=false \
  -f retry_version=0.2.2-preview.123
```

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

Repository variables used for exact hosted-server completion proof:

- `HAPPIER_SERVER_API_PREVIEW_VERSION_URL`
- `HAPPIER_SERVER_API_PRODUCTION_VERSION_URL`

Each value must be the public `https://.../v1/version` endpoint for that
environment. A selected server deployment fails release verification unless
the endpoint reports the exact candidate `source_sha`; webhook acceptance alone
is not deployment completion.

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
