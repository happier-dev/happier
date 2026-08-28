# Release process

This page describes an explicitly authorized release operation only. Its immutable source/output identities and publication checks must not be imported into feature implementation, review, or QA: those validate the current moving source and existing development stack without creating or installing a separate release representation.

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

1. Resolve the private maintainer procedure with
   `hmaint release bootstrap --repo <absolute checkout> --json`.
2. Inspect the complete proposed release range once, before materialization.
   The release agent derives the public notes, component-version proposal,
   affected compatibility directions, migration/rollback implications, and
   risk-selected validation plan from that same diff. Run the affected
   source/contract evidence before committing release inputs.
3. Human-review the proposed notes, versions, compatibility assessment, and
   validation selection. For a changed public SDK surface, this is also the one
   editorial/version approval point that consumes the generated comparison;
   release dispatch carries that reviewed decision for the exact source it
   materializes. Required heavy checks are justified by an affected seam;
   optional or borderline deep certification is offered separately.
4. Commit and push only the approved release notes and component versions.
   Final release dispatch does not choose or create a patch/minor/major bump.
   The post-commit check confirms that the analyzed source remains applicable
   and that no unexpected runtime-reachable delta entered; it does not repeat
   the whole semantic review.
5. After explicit approval, the conductor dispatches **RELEASE — Publish
   (preview + production)** for that exact SHA. The workflow validates the
   candidate, proves the already-completed same-repository canonical CI for that
   exact SHA instead of rerunning the general matrix, promotes `dev` →
   `preview`, then deploys/publishes the verified immutable outputs.
6. After post-promotion verification, the workflow advances its pre-promotion
   snapshots of open `stage:source` and `stage:dev` issues to `stage:preview`.

### Production release (preview → main)

When you want to ship what’s currently in `preview` to production:

1. Prepare the already-validated preview candidate through `hmaint`, including
   stable-only compatibility review and preview-equivalence evidence.
2. After explicit approval of the preview source, the workflow promotes
   `preview` → `main`, then deploys/publishes the verified immutable outputs.
3. After post-promotion verification, the workflow advances its pre-promotion
   snapshot of `stage:preview` issues to `stage:stable`.

Notes:

- Urgent path (avoid preview): `confirm=release dev to main` (or `reset main
  from dev`). Because that candidate comes from `dev`, it advances only
  snapshotted `stage:source` and `stage:dev` issues to `stage:stable`; it does
  not claim that unrelated preview-only corrections were included.

Issue availability is tracked by the mutually exclusive `stage:source`,
`stage:dev`, `stage:preview`, and `stage:stable` labels documented in
`docs/issue-triage.md`. Ordinary current-`dev` nightlies perform `source → dev`.
Preview and production releases snapshot only stages proven by their selected
source topology: `dev` → `preview` snapshots source/dev, `preview` → `main`
snapshots preview, and direct `dev` → `main` snapshots source/dev. This lets an
authorized channel bypass advance issues without attributing unrelated
post-preview dev changes to a preview candidate. Failed and dry-run releases
move nothing. The reconciler re-reads each snapshotted issue, preserves
unrelated labels, and skips closed or manually restaged issues. It never
comments on or closes an issue.

### Public release contract and approval boundary

Read the versioned, machine-readable release contract before preparing a
release:

```bash
node scripts/pipeline/run.mjs release-contract
```

This is the public repository seam. General release readiness, approval, and
dispatch authority is maintainer-owned; obtain its private bootstrap contract
from an absolute checkout path with
`hmaint release bootstrap --repo <absolute checkout> --json`.

For preview, the analyzed range starts at the currently promoted `preview`
source; for production it starts at the current `main` source. This prevents
an already validated preview change from repeatedly selecting heavy evidence
on every later preview merely because it has not reached stable yet.

Its `schemaVersion: 1` response describes the canonical versioned targets and
validation suites, plus three profiles. Before materialization, run the
script-owned diff classifier against the exact proposed source range:

```bash
node scripts/pipeline/run.mjs release-analyze \
  --base <released-baseline> --head <proposed-source> \
  --channel <dev|preview|stable> \
  --profile integrated \
  --has-cli-candidate <true|false> \
  --has-server-candidate <true|false> \
  --has-published-relay-predecessor <true|false>
```

`integrated` and `stable` expose the same eligible automatic suite catalog;
the registry selects heavy evidence from changed release seams rather than
merely from the existence of a versioned candidate:

- Every selected CLI/server candidate: immutable artifact verification and
  the applicable basic binary smoke.
- CLI/daemon lifecycle, replacement, updater, service ownership, persisted
  daemon state, or child-session survival: released-CLI -> exact-candidate CLI
  upgrade continuity.
- Session/runtime ownership, restart recovery, transcript/state persistence,
  or daemon-relay reconnection: candidate session continuity.
- Database schema/migrations, persistence, relay image/runtime dependencies,
  startup, authentication persistence, encryption storage, or upgrade
  behavior: the named Docker relay-upgrade scenario when a supported published
  predecessor exists.
- Dialect-sensitive schema/query/transaction changes: the focused MySQL
  contract.
- Installer, updater, service, process/path, filesystem, or native packaging
  changes: the affected platform/service evidence.
- Signing/updater/notarization trust changes: the trust-root evidence named by
  the preparation packet.

Unrelated UI, documentation, notes-only, or internally compatible changes do
not pay these heavy costs merely because release propagation produced a server
or CLI version. Unnecessary checks are skipped automatically with a reason.
An explicit maintainer may refine the heavy suite selection or waive exact-SHA
CI with a bounded reason; the workflow records that evidence as `WAIVED`, not
`PASS`. Candidate identity, artifact integrity, signatures, authorization, and
irreversible-data admission remain hard target contracts rather than release
checkboxes.

The public API comparator supplies mechanical facts; it does not choose SemVer
or create a second approval workflow. The maintainer reviews those facts during
the existing editorial/version pass. Later publication code rechecks the exact
packed bytes and consumes that decision only for the source/candidate bound by
the release operation.

The final materialized commit normally has a successful canonical `CI — Tests`
run on its source branch. Release admission verifies that exact run and does
not replay the broad CI matrix unless an explicit maintainer waives it with a
recorded reason. Release-specific artifact,
upgrade, platform, database, and trust-root gates remain selected independently
from the changed seams.

`stable` additionally selects the full source-check profile and requires the
private release agent to review the actual stable diff, preview equivalence and
soak evidence, breaking changes, reachable version-skew directions,
persistence, and accidental lockstep requirements. `deep` is manual-only: it
owns broader cross-OS, provider, mobile, installer, and comprehensive
certification. It dispatches no generic compatibility or upgrade verdict.

The workflow derives source-check depth from this public profile; callers do
not select a second `checks_profile`. Integrated preview releases use the fast
source gate plus risk-selected exact-candidate evidence. Stable promotion
reuses evidence for the byte-identical preview candidate, adds the
previous-stable semantic/soak review, and runs new heavy evidence only when a
post-preview change invalidated or expanded the earlier selection. `deep`
remains explicit manual certification rather than a routine release tax.

The contract is preparation-only. It does not select a candidate, publish,
deploy, migrate a database, wait for a fleet, or cut over a self-hosted relay.
Run individual suites through `release-validate --suite ...` with their
suite-specific sources; `release-validate --profile <id> --dry-run` only prints
the profile's dispatchable suite IDs.

Passing preparation is not a release go-ahead. A human must explicitly dispatch
the hosted release with its confirmation phrase. A Qualified V4 activation is
an irreversible migration and requires its own explicit approval; the ordinary
branch-promotion confirmation does not authorize it. The workflow resolves and
records the release source SHA before it publishes or promotes release outputs;
operators must review that SHA and the selected profile evidence, not infer
identity from a moving branch name.

### Local execution and phase recovery

GitHub Actions supplies hosted runner matrices, protected environments,
permissions, and secret delivery; release decisions and phase behavior remain
in repository scripts. The immutable-candidate spine can be executed locally
without dispatching a GitHub workflow:

```bash
node scripts/pipeline/run.mjs release-local-candidates \
  --channel preview \
  --source-sha <exact-sha> \
  --repository happier-dev/happier \
  --candidates cli=<version>,server=<version> \
  --dry-run
```

Use `--phase publish-immutable`, `verify`, or `promote-rolling` to resume at a
specific phase. Non-dry execution requires the exact confirmation phrase shown
by command help. It calls the same immutable publishers, candidate verifier,
and rolling promoter as hosted workflows; it is not a parallel publication
implementation. Native/platform-specific artifact preparation must run on a
host capable of producing that artifact. npm, Docker, hosted deploy, Expo, and
Tauri surfaces likewise retain direct `run.mjs` commands, so their semantic
operations are callable without GitHub even though GitHub remains the normal
official-release privilege boundary.

For hosted failures, first rerun failed jobs when no workflow/control change is
needed. When control code changed but candidate bytes did not, a new release
attempt may reuse only individually verified immutable candidates from the
named completed origin run. Release-output-affecting byte changes require new release outputs. One failed sibling product does not invalidate independently
verified immutable candidates from successful products.

Self-hosted relays upgrade independently. The release contract never holds a
fleet at a barrier, coordinates a migration, or declares a global cutover. A
specific released migration can still have its own documented operator
procedure; that procedure remains the owner of its external writer/drain facts.

### Reusing an exact CLI native candidate

Use **PUBLISH — CLI Binaries (GitHub)** with `candidate_only=true` to build,
sign, and retain one five-target native matrix without creating or changing a
GitHub Release. The run uploads
`cli-candidate-native-<channel>-<version>-<source_sha>` for seven days.
Dispatch candidate creation from the target channel branch (`dev`, `preview`,
or `main`): the checked-out source must equal the workflow run head. Candidate
creation uses the normal rolling allocator, so dev and preview artifacts are
born with their final `-dev.<n>` or `-preview.<n>` version rather than the raw
package version.

To publish those exact native archives later, supply all three candidate
identity inputs together:

- `candidate_run_id`
- `candidate_version`
- `candidate_source_sha`

For the unified preview release, supply that same triple to **RELEASE — Publish
(preview + production)**. The release workflow binds the supplied source SHA to
the promoted `preview` source, then forwards the complete identity to the sole
CLI publisher. Candidate reuse is rejected for production releases. Leave all
three values empty when a fresh native matrix should be built by the ordinary
release path. Post-publication release verification retains the selected prior
run as the CLI manifest's build identity; server and stack manifests remain
bound to the current release run.

Before download, the publisher asks GitHub for the exact run and artifact. The
run must be a successful direct dispatch of the canonical CLI producer in the
same repository, on the requested channel branch and source SHA; the artifact
must be the sole non-expired exact-name match from that run. Download then uses
the admitted immutable artifact ID rather than a caller-selected name.

The signed checksum manifest covers all five archives and both Darwin
notarization evidence JSON files. Promotion verifies the complete nine-file
envelope with workflow-control verifier bytes and the trusted workflow-control
public key, then publishes that same envelope without rebuilding, regenerating
checksums, or re-signing. Missing, extra, expired, unsigned, or modified bytes
fail closed. Ordinary publishing still builds and signs a fresh matrix when
the candidate inputs are empty.

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

Repository variables used for exact hosted-server completion proof:

- `HAPPIER_SERVER_API_PREVIEW_VERSION_URL`
- `HAPPIER_SERVER_API_PRODUCTION_VERSION_URL`

Each value must be the public `https://.../v1/version` endpoint for that
environment. A selected server deployment fails release verification unless
the endpoint reports the approved release `source_sha`; webhook acceptance alone
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

### Irreversible Qualified Connected Accounts V4 activation

`20260725100000_activate_qualified_connected_accounts_v4` is an explicit
no-rollback boundary for old server binaries. Before its first promotion into
each deployed server environment:

1. Release validation must confirm the exact migration exists in the
   PostgreSQL, MySQL, and SQLite migration trees and that their final schemas
   agree.
2. Refresh and record the current `../remote-dev` predecessor `HEAD`, dirty
   state, schema, readers, and writers. The supported predecessor cannot create
   rows under the activated schema or read novel rows with nullable legacy
   identity.
3. Start a maintenance window in the hosting control plane. Stop or scale to
   zero **every existing API and worker server instance that can write the
   target database**, then verify that no old server process or container
   remains. Removing API traffic alone is insufficient because the worker also
   writes database state.
4. A release approver must verify backup and restore readiness, attest that all
   old API and worker writers are stopped and will remain stopped if migration
   fails, and explicitly accept that old-server rollback is prohibited after
   activation.
5. Use the unified release confirmation, or the direct server-promotion
   `qualified_v4_activation_approval` checkbox. The promotion workflow records
   the named migration and acknowledgement in its job summary before changing
   a release or deploy branch.
6. Keep the maintenance window in force while the candidate API and worker
   deployments start. Do not end it until the activation migration has a
   successful `finished_at` entry in Prisma's `_prisma_migrations` table and
   the current-version API and worker instances are ready.

The current hosted deployment path is not itself a quiescence mechanism. A
deploy-branch push calls independent API and worker deployment webhooks, API
first, and each new container runs `prisma migrate deploy` in its entrypoint
before starting its server role. Normal rolling replacement can therefore
leave predecessor API or worker writers alive while the first candidate
container migrates. Prisma's migration lock serializes migration runners; it
does not stop application writes. Complete step 3 before dispatching the
promotion rather than relying on the rollout or entrypoint to drain writers.

If migration, build, or candidate startup fails, stop the candidate deployment
or restart loop and keep both old server roles stopped. Do not restart the
predecessor image or retry the normal rolling deployment. Preserve the
database, inspect its schema and Prisma migration record, and obtain an
approved provider-specific recovery procedure before any manual DDL or
`prisma migrate resolve` action.

The release admission check rejects a PostgreSQL/MySQL/SQLite split-brain and
any candidate that removes the activation from an already-activated
environment. After the deployed baseline contains the migration, the check
does not require recurring approval; Prisma's existing `_prisma_migrations`
history remains the sole applied-state record. Do not add a runtime feature
flag, product setting, or second migration ledger for this boundary.

### MySQL Voice conversation grant-provenance rollout

`20260729102000_add_voice_conversation_grant_provenance` has a MySQL-only
non-atomic rollout boundary. MySQL commits the column `ALTER TABLE` before the
following compatibility trigger is installed. An old API or worker that
deletes a Voice lease in that interval can permanently erase the only exact
grant provenance. Prisma's migration lock does not stop those application
writes.

Before the migration is first applied to each server environment that uses
MySQL:

1. Start a maintenance window in the hosting control plane. Stop or scale to
   zero every old API and worker instance that can write the target database,
   and verify that no old process or container remains. Keep all old writers
   stopped for the complete migration window.
2. Using the exact target database and migration identity, record:

   ```sql
   SELECT CURRENT_USER(), @@GLOBAL.log_bin, @@GLOBAL.log_bin_trust_function_creators;
   SHOW GRANTS FOR CURRENT_USER;
   ```

   The identity must have `ALTER`, `UPDATE`, and `TRIGGER` authority for the
   target schema. When binary logging is enabled, either
   `log_bin_trust_function_creators` must be `ON` for trigger creation or the
   migration identity's equivalent trigger-creation authority must already
   have been proven against a disposable clone with the same MySQL version,
   variables, and grants. A schema-scoped `TRIGGER` grant alone is not
   sufficient when that server policy still rejects `CREATE TRIGGER`.
3. Confirm that the account named by `CURRENT_USER()` will remain valid while
   `VoiceSessionLease_preserve_conversation_grant` exists. The trigger runs
   with its definer's authority; do not remove or invalidate that account
   before a later migration removes or safely replaces the adapter.
4. Only after steps 1–3, start the deployment or direct migration through the
   hosting provider's maintenance-window procedure. If containers normally
   migrate on startup, keep the old deployment stopped before starting the
   first candidate container. Admit that one migration invocation with:

   ```text
   HAPPIER_DB_MIGRATION_APPROVAL=20260729102000_add_voice_conversation_grant_provenance
   ```

   The exact value is an operator attestation to the external drain and
   definer-lifetime checks above; it is not database evidence that writers
   stopped. The canonical MySQL migration command refuses the pending
   migration without it.
5. Keep the maintenance window in force until the migration has a successful
   `finished_at` entry in `_prisma_migrations`, the trigger exists in
   `INFORMATION_SCHEMA.TRIGGERS` with the expected definer, and current-version
   API and worker instances are ready.

Before Prisma runs, the canonical MySQL migration command checks the live
database's migration ledger, effective schema/table grants visible to
`SHOW GRANTS`, and the binary-logging/trusted-creator policy. It refuses the
unsafe binary-log policy before the first `ALTER` unless the migration identity
has provable global `SUPER` authority. After Prisma returns, it verifies the
finished migration record and exact compatibility trigger/definer before the
server can start.

If migration or startup fails, keep old writers stopped. Do not restart an old
API or worker against a schema where the columns may exist without the trigger.
Preserve the database, correct the target privilege/configuration failure, and
use an approved provider-specific recovery procedure before retrying DDL or
running `prisma migrate resolve`.

The repository does not enforce this transition with a GitHub promotion gate:
the release workflow has no trusted mapping from an environment to its live
database provider or applied Prisma state. Migration-file presence in a Git
ref does not prove that a previous deployment applied the migration
successfully. The SQL observations above prove trigger prerequisites, not the
absence of external writers. The hosting or self-host operator owns the
external drain fact and must complete this procedure before container
entrypoints or direct `migrate:mysql:deploy` invocations apply the migration.
The required exact-migration environment value records that external
attestation but does not prove it; a database marker likewise cannot prove
that external writers are actually drained.
