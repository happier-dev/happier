# Deployment

This document describes how to deploy the Happier backend (`apps/server`) and the infrastructure it expects.

## Runtime overview
- **App server:** Node.js running `tsx ./sources/main.ts` (Fastify + Socket.IO).
- **Database:** Postgres via Prisma.
- **Cache:** Redis (currently used for connectivity and future expansion).
- **Object storage:** S3-compatible storage for user-uploaded assets (MinIO works).
- **Metrics:** Optional Prometheus `/metrics` server on a separate port.

## Managed Home owner provisioning boundary (0.3 development)

The current repository has no managed-host producer that creates a Home's first Account.
`provisionFreshAccountInTx` belongs to authentication admission—native, Key Challenge, OAuth,
and mTLS—and must not turn one of those signup paths into an owner election. The server-side
ownership contract is ready for a distinct trusted deployment producer, but this does not make
a managed-hosting journey available by itself.

A supported producer must run inside the trusted server deployment and compose Account
creation with
`apps/server/sources/app/home/governance/ownerAssignment.ts#claimHomeOwnerInTx` in the same
serializable database transaction. The owner service accepts one explicit Account ID, requires
that Account to exist and be active, and succeeds only while the Home has no active owner. It
also writes the target's `AccountChange` refresh and the Home-governance invalidation in that
transaction. If the transaction fails later, Account creation, role assignment, and both
refresh writes roll back together.

The producer owns its existing provisioning-request identity and must resolve a retry to the
same Account before deciding anything about ownership. After an uncertain outcome it re-reads
that Account and the active owner in a fresh transaction: the same active Account already being
owner is recovery of the prior success; a different owner, an inactive Account, or a missing
Account is a refusal. With zero active owners it may call `claimHomeOwnerInTx` again. The
producer returns success only after commit and a canonical Account/Home-governance readback.

This boundary is deliberately not HTTP-accessible. Do not add a public bootstrap route, setup
bearer, first-signup election, second owner writer, scheduler, or provisioning ledger. An
out-of-process producer that cannot participate in the server transaction needs an explicitly
approved integration contract; the deployment-local `--claim-home-owner` command remains an
operator setup/recovery tool and is not a substitute for atomic managed provisioning.

Operators and owners reach the same transition through three adapters, all ending in
`claimHomeOwnerInTx` with its zero-active-owner precondition (Teams Lane 01.02 AM-1, Home owner
console plan §3.5):

- `happier-server --claim-home-owner=<accountId>` (deployment command; audit actor
  `deployment_command`);
- the hosting desktop's hsetup task `relay.runtime.personal_home.claim_owner.v1`, which runs that
  command against the local Personal Home runtime (installed server binary, `server.env`) while the
  runtime keeps running (SQLite WAL), under the Personal Home data-operation lease so it never
  interleaves with a backup, restore, erase, relocation or update. Only hsetup registers it; the
  daemon does not advertise it;
- `POST /v1/home/governance/claim` (`home.governance.claim`), redeeming a one-time code minted on
  demand by `happier-server --print-home-claim-code`. The code is 32 random bytes, stored only as
  a SHA-256 in `SimpleCache` key `home.owner-claim-code.v1` (a new print replaces it), expires
  after 15 minutes, is spent in the claiming transaction (a refused claim rolls the spend back),
  and is rate-limited per address (`home.governance.claim`). Every refusal is the same
  `home_claim_refused` 403. The audit actor is the claiming Account with `via: 'claim_code'`.
  Holding a code proves the same deployment-level access as the command, so this is not a public
  bootstrap route: nothing is claimable until an operator prints a code.

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

**Development 0.3 private Artifact storage**
- `S3_PRIVATE_BUCKET`: a separate provisioned S3 bucket for binary Artifact bytes,
  using the existing S3 connection and credentials. It must differ from the public
  `S3_BUCKET` and have no anonymous-access policy. The server does not change bucket
  policies or fall back to the public bucket; missing or unsafe private storage
  leaves private operations unavailable.
- The local files backend defaults to the existing private-files directory,
  separate from the public file root. Its development guard resolves both roots
  and refuses private IO when either contains the other, including symlinked
  overlaps. The regression GREEN remains blocked by an unrelated Action-catalog
  collection error; this is source behavior, not deployment certification.
  Neither backend issues a public URL for these bytes.

**Optional browser-hosted plugin Artifacts**
- `HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN`: opt in to browser Artifact delivery with a dedicated HTTPS origin. Leave it unset to keep browser Artifact hosting unavailable; desktop/native Artifact delivery is independent.
- The Artifact origin must differ from both the effective web-app origin and `HAPPIER_PUBLIC_SERVER_URL`. The server fails closed if either configured origin aliases it.
- The deployment operator must provision DNS, TLS, and a dedicated path-restricted virtual host that forwards only the `/v1/plugins/availability/ui-artifacts/browser/` route prefix to the existing API service. Preserve the trusted request host/protocol projection so the server can validate the Artifact origin. This repository does not provision that host or start a second static server.
- Browser Preview uses this delivery path only for online plaintext Accounts; E2EE Accounts receive the typed unavailable result.

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
  - Required when `HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION=true`: `REVENUECAT_SECRET_KEY`
  - Optional controls:
    - `HAPPIER_FEATURE_VOICE__ENABLED` (`true`/`false`, default `true`)
    - `HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION` (`true`/`false`, defaults to `true` when `NODE_ENV=production`)
    - `VOICE_FREE_SESSIONS_PER_MONTH` (default `0`)
    - `VOICE_FREE_MINUTES_PER_MONTH` (default `0`, enforced when `HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION=true`)
    - `VOICE_MAX_CONCURRENT_SESSIONS` (default `1`)
    - `VOICE_MAX_SESSION_SECONDS` (default `1200`, min `30`)
    - `VOICE_MAX_MINUTES_PER_DAY` (default `0` = unlimited; global per-user guardrail)
    - `VOICE_TOKEN_MAX_PER_MINUTE` (default `10`, `0` disables rate limiting)
    - `VOICE_COMPLETE_MAX_PER_MINUTE` (default `60`, `0` disables rate limiting)
    - `VOICE_LEASE_CLEANUP` (`true`/`false`, default `false`)
    - `VOICE_LEASE_RETENTION_DAYS` (default `30`, clamp 7–365)
    - `VOICE_LEASE_CLEANUP_INTERVAL_MS` (default `21600000` = 6h, min `10000`)
  - In 0.3 development, reservation release reconciles provider-attested terminal
    conversation usage through the same settlement owner as completion. Active,
    unknown or unverifiable provider state does not free the reservation. Tokens
    without a usable provider conversation identity remain reserved; expired
    unsettled leases remain quota-counted through their UTC grant month and day
    windows rather than disappearing during retention cleanup.
- WorkOS SSO and Directory Sync (0.3 development; see
  [enterprise-identity.md](enterprise-identity.md)):
  - `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` — the deployment owns the WorkOS platform
    credentials. Teams never store an API key; they store exact WorkOS organization and
    connection references.
  - Both must be present. Neither set reports `not_configured`, exactly one reports
    `partial_configuration`, and an unusable pair reports `invalid_configuration`. All three
    surface to administrators as `workos_platform_unavailable`, so a half-configured
    deployment fails closed instead of appearing to work.
  - Changing either value changes the WorkOS runtime fingerprint, which invalidates
    already-started OAuth attempts bound to the previous runtime.
- Debug logging: `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING` (enables file logging + dev log endpoint).

## Happier Cloud as the default Account Service (0.3)

Happier Cloud (`https://api.happier.dev`) is the client's default Account Service, but clients
treat it exactly like a self-hosted one: every method, creation path and reset is read from what it
advertises. The operator-facing contract is the published
[Running your own Account Service](../apps/docs/content/docs/self-hosting/auth.mdx) section; this
records what the Happier Cloud deployment itself must set.

Observed 2026-09-25: production runs 0.2. `GET /v1/features` has no `capabilities.accountDirectory`,
`capabilities.server` is empty (no canonical URL), GitHub is enabled but not configured, and
`/v1/auth/entry` does not exist. Current clients therefore show "Happier Cloud can't find Homes yet"
and no sign-in methods. Nothing changes until Cloud deploys 0.3.

For email and password on Happier Cloud once it runs 0.3:

- `HAPPIER_CANONICAL_SERVER_URL=https://api.happier.dev`. Without it, clients reject the service
  (no stable audience for the Account Directory key challenge).
- `HANDY_MASTER_SECRET`: already required. It derives the Account Directory signing key, so it must
  stay stable; rotating it changes the key Homes pin.
- `HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME` is optional. Clients already call the default service
  "Happier Cloud".
- `HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED=1` and `HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__PROVISION_ENABLED=1`.
  Both are on by default; set them explicitly so a later default change is not silent.
- SMTP, required for account creation, "Forgot password?" and sign-in email changes:
  - `HAPPIER_AUTH_EMAIL_SMTP_HOST` and `HAPPIER_AUTH_EMAIL_FROM_ADDRESS` (for example `no-reply@happier.dev`);
  - `HAPPIER_AUTH_EMAIL_SMTP_PORT` and `HAPPIER_AUTH_EMAIL_SMTP_SECURE` (465 with `true`, or 587 with `false`);
  - `HAPPIER_AUTH_EMAIL_SMTP_USERNAME` and `HAPPIER_AUTH_EMAIL_SMTP_PASSWORD` from the mail provider;
  - optionally `HAPPIER_AUTH_EMAIL_FROM_NAME=Happier`.
- Mail links also need an application origin and a published Home connection descriptor:
  `HAPPIER_WEBAPP_URL` (for example `https://app.happier.dev`) and the public HTTPS ingress
  (`HAPPIER_PUBLIC_SERVER_URL`). Without them the mail-dependent actions are reported unavailable
  (one readiness owner: `resolveAuthEmailReadiness`, SMTP **and** a buildable link), so clients do
  not offer them.
- Public sign-up policy (`shouldDenyPublicSignupProvisioningAction`) still applies to email
  account creation. Decide it together with key sign-up.

Without SMTP, clients show email and password sign-in only: no "Create an account" by email and no
mailed reset. That is safe, but new users could then create accounts only with a key.

## Managed identity provider secrets (0.3 development)

Database-managed provider credentials — OIDC client secrets and GitHub App private keys and
client secrets — are write-only. They are encrypted with the existing server operational
encryption under a domain-separated path
(`storage / identity_provider_instance / <id> / <kind> / secrets / v1`), decrypted only for the
selected runtime, and never returned by any read; administration responses carry only a
`configured` boolean.

These are operational secrets the Home can read, not end-to-end encrypted material, and they
derive from `HANDY_MASTER_SECRET`. Losing or rotating that master secret makes existing
provider secrets undecryptable: the affected provider fails closed with
`provider_secret_unreadable` and must have its credential re-entered. Include managed identity
providers in the blast-radius assessment for any master-secret rotation plan.

## Managed identity networking (0.3 development)

Database-managed OIDC resolves its network policy in
`apps/server/sources/app/auth/providers/managed/managedIdentityNetworkPolicy.ts`.
The deployment is the outer ceiling: absent or malformed
`HAPPIER_FEATURE_AUTH_MANAGED_IDENTITY__PRIVATE_NETWORK_ENABLED` leaves managed
providers public HTTPS-only on port 443. When explicitly enabled, the persisted
Home policy may permit exact private hostnames, CIDRs, and ports. Team
administration cannot widen that policy. File/environment OIDC retains its
existing deployment-trusted policy through the same outbound transport.

The catalog includes the effective network policy and, for a Team-bound provider,
the exact Team connection revision in the selected runtime's fingerprint.
Finalization resolves it again in the transaction that commits the identity
changes, so an earlier OAuth attempt cannot authorize against a changed policy or
Team connection. The outbound owner enforces DNS/address, connected-peer, TLS, redirect,
timeout, header and decoded-response bounds; callers do not substitute a plain
fetch implementation.

Managed administration and composed live sign-in validation are still in progress;
this is development architecture, not a stable/preview availability claim. See the
[operator OIDC guide](../apps/docs/content/docs/self-hosting/auth-oidc.mdx) for
configuration and the deployment-provider compatibility boundary, and
[enterprise-identity.md](enterprise-identity.md) for the surrounding provider, Team
connection, and directory domain.

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
- Before a MySQL deployment first applies
  `20260729102000_add_voice_conversation_grant_provenance`, follow the
  maintenance-window, old-writer drain, trigger-authority/configuration, and
  definer-lifetime preflight in `docs/release-process.md`. The MySQL migration
  command fails closed unless that pending transition has exact operator
  admission and its live trigger prerequisites pass. A normal rolling
  entrypoint deployment is unsafe for that one non-atomic transition.

## Socket.IO Redis cluster transport

When `HAPPIER_SOCKET_ADAPTER=redis-streams` (or the legacy
`HAPPIER_SOCKET_REDIS_ADAPTER` boolean) is set together with `REDIS_URL`, the
API role joins a Socket.IO cluster through
[`@socket.io/redis-streams-adapter`](https://github.com/socketio/socket.io-redis-streams-adapter)
`0.3.1` in current development source; stable/preview deployment availability is
not established by this document. Canonical owners:

- `apps/server/sources/config/socketAdapter.ts` — the one adapter option
  projection.
- `apps/server/sources/storage/redis/redis.ts` — the one socket-cluster Redis
  connection factory, its root accessor, and the adapter-facing client.
- `apps/server/sources/app/api/socket.ts` — the one `createAdapter(...)` call
  site and shutdown order.

### Two backplanes

| Traffic | Redis mechanism |
|---|---|
| Ordinary room broadcasts (connection-state recovery is disabled) | Redis Streams (`XADD`/`XREAD` on `socket.io`) |
| `fetchSockets`, `serverSideEmit`, `serverSideEmitWithAck`, broadcast-acknowledgement control traffic | Redis Pub/Sub (`socket.io#<namespace>#…` channels) |

Pub/Sub traffic is intentionally transient. A request published while Pub/Sub is
unavailable is never replayed after Redis recovers: the caller receives its
existing timeout/error and retries if the operation is still wanted. RPC target
discovery, external-action routing, and peer/tunnel coordination all consume
this path, so it is load-bearing beyond human presence.

### Connections per API process

At `streamCount = 1` each API process holds **four** Redis connections, not one:

| Diagnostic `CLIENT` name | Purpose |
|---|---|
| `happier-socket-cluster:root` | Adapter `XADD`, `PUBLISH`, and `PUBSUB NUMSUB` commands |
| `happier-socket-cluster:adapter-1`, `happier-socket-cluster:adapter-2` | One blocking `XREAD` reader and one Pub/Sub subscriber; ordinals identify connections, not semantic roles |
| `happier-socket-cluster:relay-admission` | Exact peer-tunnel relay-grant admission claims |

The relay-admission connection reserves and commits one-time relay-grant claims
independently of the adapter's blocking reader and Pub/Sub recovery. It is not
another backplane or Redis pool.

Every adapter connection is built by the same factory, so each has independent
reconnect state, its own classified/rate-limited error diagnostics (`module:
redis-socket-cluster`, with the `connection` field naming the failing socket),
and command instrumentation. The names are diagnostics only; they carry no
authority. Size managed-Redis connection limits for four connections per API
replica, plus the separate application/worker connections.

The adapter owns the lifecycle of the connections it creates. Shutdown order is
`io.close()` (aborts the reader, disconnects the subscriber) → tunnel relay
coordinator close → `closeRedisSocketClusterClient()` (root only). Happier keeps
no competing duplicate registry.

### Fixed adapter options

`maxLen` (`HAPPIER_SOCKET_ADAPTER_MAXLEN`) and `readCount`
(`HAPPIER_SOCKET_ADAPTER_READ_COUNT`) remain the only operator tunables.
Everything else is fixed: `streamName`/`channelPrefix` `socket.io`,
`streamCount: 1`, `useShardedPubSub: false`, `onlyPlaintext: false`, and
`blockTimeInMs: 100`.

`blockTimeInMs` matters operationally. Adapter `0.2.3` hard-coded a 100 ms
ioredis `XREAD BLOCK`; `0.3.1` made it configurable and defaults it to 5,000 ms —
exactly the dedicated client's `socketTimeout`. Accepting that default would make
a healthy blocking read indistinguishable from the silent stall the retry policy
detects. Raise it only from measured Redis polling evidence plus a proven margin
below the stall timeout.

### Redis ACL

For Redis 6.2+ ACL users, the adapter-only rule tokens are:

```text
~socket.io &socket.io#*
+auth +info +client|setname
+xadd +xread
+publish +subscribe +pubsub|numsub
```

These are ACL tokens, not a shell command. Preserve other permissions required by
application Redis, worker streams and peer/tunnel coordination using `REDIS_URL`;
this is not a complete API-user ACL and must not replace one with `reset`.
`~socket.io` is the Stream key and `&socket.io#*` covers common request and private
response channels. Sharded commands (`SPUBLISH`, `SSUBSCRIBE`,
`PUBSUB SHARDNUMSUB`) and connection-state-recovery session keys are not required
by the active configuration.

The dedicated relay-admission connection uses the same API Redis credential but
has a separate, narrow command/key surface: `SET` for provisional claims and
`EVAL` scripts that read, update, or delete the exact
`peer-tunnel-relay-grant:v1:*` claim key. Grant the corresponding `SET`, `GET`,
`DEL`, and `EVAL` permissions plus that key pattern when server-routed peer
tunnels are enabled. Do not mistake those relay permissions for adapter
requirements or grant them to an adapter-only credential.

The command surface follows the pinned [0.3.1 adapter source](https://github.com/socketio/socket.io-redis-streams-adapter/blob/e4e38eb1065b04383749347f97b6442f60249a24/lib/adapter.ts)
and [Redis utilities](https://github.com/socketio/socket.io-redis-streams-adapter/blob/e4e38eb1065b04383749347f97b6442f60249a24/lib/util.ts).
A missing Pub/Sub permission can leave startup healthy while discovery degrades.
Check command failure metrics and Redis ACL denial logs and exercise a cross-node
query; do not assume every command rejection emits a `client_error` connection
log. Redis is trusted internal infrastructure: retain authentication, private
networking/TLS and least-privilege credentials because adapter messages have no
separate authentication or encryption.

### Upgrade and rollback: no mixed adapter generation

Adapter `0.2` and `0.3` nodes are **not** a supported serving cluster. A `0.2`
node publishes transient requests to the Stream while a `0.3` node publishes them
to Pub/Sub and answers on a private Pub/Sub channel, and `serverCount()` changes
from Stream heartbeats to Pub/Sub subscriber count. Ordinary broadcast bytes may
still cross versions, which makes the failure worse: RPC and tunnel logic can
conclude a live target does not exist.

- Single-node Home: ordinary process restart.
- Multi-replica: drain/stop the old Socket.IO API pool, confirm it no longer
  serves, then bring the new pool up as one compatibility unit.
- Confirm the ACL above before starting the new pool.
- Roll back with the same coordinated no-mix transition in reverse; never roll a
  single replica back while `0.3` replicas serve.
- Watch: Redis connection count (four per API replica), `redis-socket-cluster`
  diagnostics, RPC/tunnel outcome metrics, socket reconnect health.

A deployment with its own zero-downtime requirement needs separate old/new
load-balancer pools and isolated Redis adapter namespaces during cutover. That is
an operator topology decision; the application deliberately has no dual
`0.2`/`0.3` protocol.

### Validation recipe

Use `apps/server/sources/app/api/socket.redisStreamsAdapterCluster.integration.spec.ts`
for the real two-node adapter/ACL/restart/shutdown boundary, together with the RPC,
worker-emitter, tunnel and transfer suites for their current outer consumers.
A test's presence is not evidence that the current run passed.

In an isolated environment matching the target Redis version and ACL:

1. Connect clients to different API nodes and establish binary Stream fanout,
   remote discovery, server-side emit/ack, RPC and tunnel/transfer operations.
2. Stop Redis without restarting API nodes. Observe the current timeout/failure
   for an in-outage transient request; it must not hang indefinitely.
3. Restart Redis, wait for all eight transport connections to recover, and repeat
   those operations. Disconnect a remote socket and verify discovery removes it.
4. Shut down in production order and inspect `CLIENT LIST` with a separate
   operator credential. No socket-cluster or relay-admission connection may remain or reconnect
   after a grace interval longer than the five-second stale-timer boundary.
5. Repeat the full sequence twice; also exercise silent partition recovery and
   positive/negative restricted ACL cases. Do not grant administrative test commands
   such as `CLIENT LIST` or `ACL SETUSER` to the application's adapter credential.

`apps/server/scripts/validate.redisAdapterFanout.ts` creates two local test servers
against the selected Redis URL. It is an ordinary-fanout smoke check, not a probe
of deployed API nodes or certification of Pub/Sub/restart recovery. Use isolated
Redis: the script uses the same fixed Stream/channel names as the application.

### Prospective predecessor compatibility

On 2026-09-09, `../0.2` at `b23f95ed354e8d49183017e487bdb75f217017de`
declares adapter `^0.2.2` and resolves `0.2.3`. Its actual `socket.ts` calls
`createAdapter(getRedisClient())` with upstream defaults; `redis.ts` owns one
ordinary shared client. `config/socketAdapter.ts` and
`app/events/createRedisStreamsRoomEmitter.ts` do not exist there; adapter selection
is in `config/backends.ts`, and event routing uses the Socket.IO server through
`eventRouter.ts`/`connectionEventRouter.ts`. These inspected production and
lockfile paths have no staged or unstaged changes.

This source evidence requires the coordinated no-mix API rollout in both
directions. It does not certify a released artifact or deployment. The current
worker emitter's `uid`/`nsp`/`type` plus JSON `data` Stream envelope is accepted by
the pinned 0.3.1 decoder; the real emitter integration remains the deciding runtime
check. The adapter upgrade changes neither client handshake/events nor SQL state;
no client capability gate, persistence migration or dual-generation adapter is added.

## Kubernetes manifests
Example manifests live in `apps/server/deploy`:
- `handy.yaml`: Deployment + Service + ExternalSecrets for the server.
- `happy-redis.yaml`: Redis StatefulSet + Service + ConfigMap.

The Redis-backed two-replica API Deployment in `handy.yaml` uses Kubernetes
`Recreate`, intentionally stopping the old API pods before starting the new
generation. Do not change it to `RollingUpdate` while adapter `0.2` and `0.3`
remain incompatible for cross-node discovery. The worker Deployment keeps its
ordinary rollout strategy because it publishes the compatible Stream event
envelope and is not a Socket.IO discovery peer.

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
