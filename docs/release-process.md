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

Run the private conductor on the configured macOS authority. The canonical
wrapper in this environment is
`/Users/leeroy/Documents/Development/happier/maintainers-tools/bin/hmaint`;
invoke it directly and prove it with
`/Users/leeroy/Documents/Development/happier/maintainers-tools/bin/hmaint --help`.
From the managed Linux VM, keep source work in the authoritative VM checkout
and route the same wrapper through an existing configured 0.3 checkout:

```bash
cd <absolute-0.3-checkout>
./apps/stack/bin/hstack-exec --target=mac-host -- \
  /Users/leeroy/Documents/Development/happier/maintainers-tools/bin/hmaint \
  release bootstrap --repo <absolute-macOS-checkout> --json
```

Invoke the launcher from the intended repository-relative working directory;
it projects that directory remotely and does not accept a launcher-level
`--cwd` option. If the launcher, configured `mac-host` target, wrapper, or
Mac-visible target checkout cannot be proved, fail closed. Do not guess another
checkout, copy credentials into the VM, install a VM-local conductor, or use a
personal GitHub login.

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

### Combined preview and production release (dev → both)

When the same approved source must ship to both channels without a second
operator cycle, use the private conductor target `preview-and-production`.
It dispatches `release-preview-and-production.yml`, which snapshots source/dev
issue eligibility once and invokes the canonical `release.yml` for preview and
production in parallel.

The two calls share the exact source SHA, release notes, CI evidence, explicit
approvals, and one unioned source-risk validation pass. The shared validator
computes changes against both channel bases, then runs each applicable MySQL,
platform-service, and trust-root gate once. Each channel independently admits
that evidence against the same bound SHA. They do not share built artifacts:
preview and production
embed different feature-policy environments, so each channel must build and
verify its own bytes. Same-channel releases still serialize; the two channel
calls use separate non-cancelling concurrency groups. The outer workflow moves
its source/dev issue snapshot directly to `stage:stable` only after both calls
succeed.

Use GitHub's failed-job rerun while workflow control is unchanged. After a
control fix, resume from the prior combined run; each channel reads its own
terminal status artifact and reuses only that channel's verified work. Exact
per-channel resume facts are not available until those child workflows resolve
their respective status artifacts. The earlier shared source-validation pass
therefore conservatively treats CLI, stack, and server as requested whenever a
combined resume ID is present. This may run a platform-service gate that a
website-only or otherwise non-binary resume does not ultimately consume, but it
cannot waive or bypass a required gate. Do not duplicate the resume resolver in
the parent workflow to remove this conservative check.

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

`website` and `docs` are independent release targets. Either may be selected
without the other, and each has its own change decision, deploy job, status
surface, and recovery evidence. Combined preview-and-production combines
channels; it forwards the selected target set to both channels and does not
couple website and docs publication.

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
An explicit maintainer may refine the heavy suite selection or waive supported
evidence with a bounded reason; the workflow records that evidence as `WAIVED`,
never `PASS`. The exact boundaries are:

| Override | May waive | Does not waive |
| --- | --- | --- |
| `waive_ci` with a reason | exact-SHA source CI plus source-only MySQL and platform-service checks | trust-root checks, candidate identity, signing, artifact verification, binary smoke, or publication authorization |
| `waive_validation_suites` with a reason | target-registered risk suites other than the two hard suites | `artifact-verify` and `binary-smoke` |

When `plugin_sdk` or `sdk` publication is selected, exact-SHA CI cannot be
waived at all. The external SDK authentication-readiness waiver is a separate
named admission fact and does not waive release validation. Candidate identity,
artifact integrity, signatures, authorization, and irreversible-data admission
remain hard target contracts rather than release checkboxes.

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

Passing preparation is not a release go-ahead. A human must explicitly
authorize the exact candidate and confirmation phrase; the private conductor
then owns the hosted dispatch. A Qualified V4 activation is
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

Use this decision table instead of restarting the full graph:

| Evidence | Recovery |
| --- | --- |
| Same control SHA; transient runner, download, read-only API, or safely recoverable external failure | `gh run rerun <run-id> --failed` |
| Corrected workflow control, test, or validation; unchanged candidate bytes; terminal origin with verified candidates | `hmaint release resume` from the richest valid origin |
| Changed source, package/build dependency, signing input, or immutable candidate bytes | Prepare a fresh release |
| Ambiguous publication mutation | Inspect the canonical remote state, then use the owning recovery-aware job; never blind-retry |

The terminal release-status artifact is the canonical recovery record. A
control-only resume can preserve exact-source verified immutable candidates and
already successful rolling projections, UI/server/website/docs deployments,
Docker publication, and npm publication. The resumed run still performs its
actor/source checks, exact candidate verification, and final external-reference
verification; reuse avoids duplicate work but is not a validation bypass.

UI deployment evidence is reusable only when its recorded web, Expo, and
desktop intent exactly matches the resumed request. Public SDK npm publication
reruns unless exact package-version integrity can be reconstructed from the
status evidence. A generic npm-success bit cannot safely authorize skipping an
unknown package set. The resolver and terminal status projector are the only
owners of these decisions; workflows must not infer completion independently
from skipped jobs.

Allow independent jobs to finish so one attempt exposes every reachable
failure. Publication and trust-dependent jobs still remain gated by real
prerequisites: a consumer cannot be tested before its candidate exists. Poll
long builds, notarization, store submission, and publication every 5–20 minutes
and use step-level progress plus the owning timeout; duration alone is not
failure evidence.

For a corrected non-secret Linux lane, follow the exact manual-dispatch,
exact-SHA binding, runner-pool, and failed-job rerun recipes in
`skills/happier-ci-stabilize/SKILL.md`. Focused dispatch remains diagnostic
evidence and does not replace the final canonical exact-SHA CI required by
release policy.

For a complete release-workflow correction batch, first collect the terminal
attempt once and retain raw logs under `/tmp`:

```bash
gh run view <run-id> --repo happier-dev/happier \
  --json databaseId,attempt,event,headBranch,headSha,status,conclusion,workflowName,url
node skills/happier-ci-stabilize/scripts/collect-actions-failures.mjs \
  --repo happier-dev/happier --run-id <run-id> --attempt <attempt>
```

Iterate on the exact failing test files with `node --test`, run the affected
package lane, then run `yarn -s test:release:contracts` once for the coherent
batch. Dispatch canonical exact-SHA CI only after that local widening passes.
This exposes all failures reachable from the current inputs without repeatedly
paying for the whole hosted graph. A later consumer whose required candidate was
not produced remains genuinely unreachable; resume the verified candidate after
the controlling fix rather than rebuilding successful siblings.

### npm trusted-publishing identity

npm validates the top-level calling workflow identity for OIDC publication
through a reusable workflow. Every npm package published by this release graph
must therefore trust both supported callers in `happier-dev/happier`:

- `release.yml` for an individual preview or production operation;
- `release-preview-and-production.yml` for the coordinated combined operation.

Both use the `release-shared` GitHub environment. Register the workflow filename
without `.github/workflows/`; do not add a long-lived `NPM_TOKEN` fallback.
`ENEEDAUTH` across otherwise-authorized npm publisher jobs usually means the
top-level caller is absent or mismatched in npm's trusted-publisher
configuration. Verify the package/version in the registry after publication
rather than relying only on the workflow badge.

### Immutable and rolling binary releases

For CLI, stack, server-runtime, and UI-web binary releases:

1. Bind the authorized source commit once.
2. Publish the version-tagged immutable Release first. Existing immutable tags,
   assets, and bytes must match; they are never moved or clobbered.
3. Download and verify the complete checksummed and signed immutable asset set.
4. Promote those exact bytes into the rolling Release, then download them again
   and verify byte equality, checksums, and the minisign signature.
5. Create or reuse the SHA-qualified
   `happier-rolling-staging-<rolling-tag>-<source-sha>` draft, replace its asset
   set with the complete unversioned rolling payload, and audit that draft by
   Release ID. Remove older staging drafts for the same rolling tag.
6. Preserve an existing predecessor under
   `happier-rolling-backup-<rolling-tag>`, move the audited staging Release onto
   the real rolling tag, verify the public Release and tag, then remove staging
   and backup refs. If an interrupted attempt left only the backup visible,
   restore the predecessor before retrying.

The immutable version-tagged Release remains available throughout. A same-SHA
retry reuses and re-audits the same staging draft or recognizes an already exact
rolling Release; it does not append blindly to a partial Release or create a
second publication owner. After an interrupted rolling upload, rerun the owning
publisher with the same channel and immutable `retry_version`, leaving
`source_ref=auto` so recovery derives the authorized SHA from the immutable tag.
Only the latest published immutable version for that product/channel is an
eligible retry; recovery copies its verified bytes and does not rebuild, assign
a new version, re-sign, or mutate the immutable Release.

### Best-effort TestFlight distribution

The native iOS build/submission and App Store processing/group attachment are
separate phases. After the signed build is submitted, the mobile workflow writes
its exact EAS build id or local IPA build identity and dispatches the existing
`retry_testflight_distribution` recovery action from the current trusted control
checkout. Release promotion therefore does not hold a runner or the whole
release open while Apple processes a build.

The reconciliation run validates the source ref, environment, profile, app id,
and build identity before querying App Store Connect. A skipped fingerprint
build is an explicit no-op. A failed reconciliation remains visible and can be
retried with the same recovery action; it must not trigger another native build
or cause already verified product candidates to be rebuilt.

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

- For a single unmanaged container, the default entrypoint may run the provider's migration deploy command before server startup.
- For health-managed or multi-replica deployments, run `run-server --migrate-only` once in an explicit, blocking platform pre-deploy operation. Start API and worker replicas with `RUN_MIGRATIONS=0` only after it succeeds.
- When a platform cannot run and await a blocking pre-deploy operation, designate exactly one API service as the migration owner and set `RUN_MIGRATIONS=0` on workers and all other replicas. Protect that owner with start-first rollout, rollback on failure, and sufficient health-check startup grace; webhook acceptance alone does not prove migration or deployment completion.
- Do not rely on API and worker startup races as migration ownership. Prisma's database lock serializes contenders, but it cannot preserve the winning migration when an orchestrator terminates that container.
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
