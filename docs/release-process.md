# Release process

This repo uses a simple three-branch model:

- `dev` is the integration branch where changes land first (default branch; can be unstable).
- `preview` is the release candidate branch used for preview builds/deploys.
- `main` is the stable/production release branch.
- `deploy/**` branches are managed by automation for deployments (do not push to these manually).

Source-suite reuse is additive metadata in the existing CI lane summary: the successful suite must match the exact source SHA, validation profile, and embedded policy. Shared source validation consumes that proof and runs each missing selected policy once before publishers consume its result. A standalone publisher without admitted proof runs its source contracts even when `--run-contracts=false`. `HAPPIER_RELEASE_SOURCE_CONTRACTS_RESULT=success` is the trusted same-host/reusable-workflow admission result, not a cryptographic proof token; only controlled callers project the validator’s result, and manual dispatch exposes no proof override. Local candidate batches pass the result to later products only after the first immutable publisher succeeds for that same fixed source and channel. Source Binary Smoke currently proves preview policy only; production and missing/mismatched evidence retain Binary Smoke. Signed candidate checks, artifact verification, and publication approvals remain required.


## Release-only source checks

Development CI selects Windows schtasks self-host E2E, native packaged CLI builds
and runtime smoke for every published target (including Linux ARM64), and local
Android/iOS native compilation when their owning source paths change. The existing
`tests.yml` workflow also selects all three checks nightly. Selection belongs to
`resolve-source-validation-plan.mjs`, consumed by `ci_plan`; selected failures or
skips fail the CI verdict. Explicit reusable release-verification inputs retain
their existing scope.

The mobile checks compile Android Debug and an unsigned iOS simulator app through
the canonical preview profile and native patch hooks; signing, store credentials,
and distribution checks remain with release automation. Scheduled checks use the
line's development branch (`dev` for 0.2, `v0.3` for 0.3). GitHub runs schedules
only when the workflow is present on the repository's default branch, so landing
these edits on another branch alone does not activate its nightly schedule.

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
  The registry selects inexpensive artifact/binary facts for applicable
  products and selects heavy upgrade scenarios only when the actual diff
  changes their seam: daemon/update continuity, session/restart ownership, or
  relay persistence/startup. Candidate existence alone does not select every
  heavy scenario.
- `stable` additionally selects the full source-check profile and requires the
  private release agent to review preview candidate equivalence when promoting
  an existing preview and any available preview observations,
  breaking changes, reachable version-skew directions, persistence, and
  accidental lockstep requirements.
- `deep` is manual comprehensive source certification. The manual `deep`
  profile in `tests-dispatch.yml` fans out every non-mutating in-repository
  lane: extended databases, stress, WSREPL, mobile device E2E, cross-OS
  service/self-host checks, local daemon/session continuity, installer/binary
  smoke, and Docker release-asset compatibility. It does not publish, deploy,
  promote, submit to stores, or run credentialed live-provider scenarios.
  Those provider scenarios remain an explicit custom/provider-contract run,
  and native/store publication remains owned by release automation. `deep` is
  never a normal-release dispatch.

The workflow derives source-check depth from the selected public profile; a
caller cannot select a second checks profile. MySQL, cross-platform service,
and installer/updater trust-root gates are selected by the affected diff rather
than every server, CLI, preview, or stable candidate.

An explicit maintainer may refine the heavy upgrade/continuity suite selection
or waive exact-SHA source certification with a bounded reason. That source
waiver also skips the source-only MySQL and platform-service gates; the workflow
reports the evidence as `WAIVED`, never `PASS`. Candidate identity, artifact
integrity, binary smoke, signing/notarization, release authorization, and
installer/updater trust-root checks remain hard contracts on this shipping line.

Waivers are deliberately narrow and recorded in the terminal release status:

| Approval | May bypass | Never bypasses |
| --- | --- | --- |
| `waive_ci` with a reason | exact-SHA source CI plus source-only MySQL and platform-service checks | trust-root checks, candidate identity, signing, artifact verification, binary smoke, or publication authorization |
| `waive_validation_suites` with a reason | selected risk-based suites such as installer, continuity, or Docker compatibility checks | `artifact-verify` and `binary-smoke` |
| guarded branch reset | fast-forward-only branch topology | release admission, candidate verification, or publication checks |
| Qualified V4 activation approval | only the separately named irreversible activation | ordinary release approval or any other validation |

Do not translate “test-only failure” into a blanket waiver. First identify the
incorrect test or harness at its owner; use a bounded waiver only when the human
explicitly accepts the missing evidence for this exact candidate.

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
dispatch. One approval covers the reviewed source, notes, versions, profile,
scope, materialization and ordinary publication. Materializing unchanged
approved inputs does not require another approval. Qualified V4 activation is
not implemented or offered in this release line; historical callers requesting
it are refused. The go-ahead must name the selected profile and the exact SHA of the
candidate whose evidence was reviewed. Do not substitute a branch name or a
moving channel pointer for the exact SHA.

Run private release authority on the configured macOS host, where Keychain and
native release prerequisites live. An agent already operating on that host may
invoke the provisioned `hmaint` executable directly even when the repository
path is a mounted VM workspace. An agent operating inside the managed Linux VM
must keep source work in the VM and use the configured Stack `mac-host`
execution/broker path; credentials must never be copied into the VM. Confirm
the transport with `yarn ghops auth status` and confirm repository identity with
real paths and exact Git SHAs—similarly named host and VM checkouts are not
interchangeable.

On the Mac host, use
`/Users/leeroy/Documents/Development/happier/maintainers-tools/bin/hmaint`
directly and prove that exact wrapper with
`/Users/leeroy/Documents/Development/happier/maintainers-tools/bin/hmaint --help`;
there is intentionally no required `hmaint --version` command. Do not resolve a
different copy from `PATH`, invoke the maintainer CLI's internal JavaScript
entry point, or install a second conductor inside the VM. This 0.2 checkout
does not contain `hstack-exec`. From the managed Linux VM, first enter an
existing configured 0.3 checkout and invoke its launcher there, not from a 0.2
working directory. The launcher projects the invocation directory remotely;
its optional `--cwd` selects only a directory within the synchronized 0.3
checkout, not a different release repository:

```bash
cd <absolute-0.3-checkout>
./apps/stack/bin/hstack-exec --target=mac-host -- \
  /Users/leeroy/Documents/Development/happier/maintainers-tools/bin/hmaint release bootstrap \
  --repo <macOS-mounted-absolute-checkout> --json
```

The launcher's owning checkout and `hmaint --repo` target are independent.
`--repo` names an independently verified Git root available to the conductor.
The existing synchronized source mirror can supply that root; a separately
maintained product checkout on the Mac is unnecessary. Keep authoritative source
work in its owning checkout and verify the synchronized path rather than
inferring a translation from a VM path.
If the launcher, configured `mac-host`, Mac wrapper, or synchronized target Git root
cannot be proved, fail closed; do not translate paths by inspection or fall back
to a VM-local conductor.

For preview/production, the public `happier.release-dispatch-plan.v3` dry-run
response includes
`hostedDispatch`: the repository, workflow, control ref, and complete string
inputs for the approved source/control SHAs, operation/attempt, modes, profile,
policy, and approvals. The private conductor submits that transport directly;
local `gh` dispatch uses the same serialization. Planning needs no GitHub token,
including when explicit source/control SHAs and a CI run ID are supplied. Hosted
admission still checks trusted workflow refs, the approved control/source SHAs,
and the release actor before privileged work.

Approved-packet runs negotiate `approved-release-packet-v1` through the public
release contract. The packet has kind `happier.approved-release-packet.v1`, the
analyzed `baseSha`, `releaseId`, the complete approved canonical changelog in
`notes.content`, an exact component `versions` map, and the reviewed public
dispatch-plan v3 in `intent`. The public materializer owns the approved child;
the final planner replays and compares the complete approved intent before
private admission and dispatch, including nondefault policy and SDK approvals.
Packets start at `attempt_1` without a resume origin. Existing failed-run resume
preserves that grant and changes only the origin, next attempt, current control
SHA and CI binding through the existing resume checks.
Materialization refuses a `preview` source: production promotes that already
validated candidate through its prepared operation and never writes a new
notes/version child onto `preview`.
`run --operation-id <id>` remains available for an already prepared operation.

The `v0.3` control ref is admitted by workflow code but cannot publish yet.
Before enabling publication, the release owner must first add a `v0.3` branch
ruleset matching `dev`, then add `v0.3` to the `release-shared` environment's
deployment branch policy. Preserve that order so an unprotected control ref
never gains access to the release environment.

Before changelog/version materialization, the release agent runs
`node scripts/pipeline/run.mjs release-analyze ...` over the actual source
range and completes the semantic compatibility review while inspecting that
same diff for notes and version recommendations. After commit/push, only an
unexpected runtime-reachable delta invalidates the affected analysis.

Run `hmaint release run --repo <absolute checkout> --packet <absolute JSON path>`
with the approved packet. The public materialization owner writes the approved
canonical notes and exact component versions and commits only those paths.
The private conductor pushes the child, waits for its exact-SHA canonical CI,
then admits once and dispatches. The final plan must preserve the approved
scope; another dev merge does not
require another editorial or version pass or a second ordinary publication
approval. Unexpected runtime-reachable or scope changes require a refreshed
decision. Dependency, script, native-content, runtime-version and generated
runtime input changes still receive full source CI.

The release-control speed follow-up adds a narrow exception in the existing
`tests.yml` CI planner: a push changing only canonical notes and supported
materializer JSON version fields can select note projection checks and child
packaging instead of broad runtime suites. The classifier compares JSON content,
not just filenames. It proves that the previous
push SHA is an ancestor with successful canonical full-source CI, downloads and
validates that run's lane summary, and validates the final commit's canonical
note projections plus the projection contract suite and build-smoke packaging.
The new completed run and
summary identify the final child SHA; a parent run ID is never accepted as child
evidence. Missing, expired or insufficient baseline evidence selects full source
CI with an explicit diagnostic. An earlier metadata-only run is not a full-source
baseline, so repeated editorial pushes can fall back to full CI. This follow-up
must be integrated before relying on the shortcut; it changes no waiver policy.

### Targeted bug-fix releases (release-control follow-up)

Choose scope deliberately from `release-analyze` over the actual range, including
its shared-package and packaged dependency impacts. Use the existing
`deploy_targets` input to bound both deployment and artifact publication. The
follow-up removes independent change-flag fanout that previously built excluded
products; `force_deploy` remains limited to selected products. Resume preserves
the saved scope and candidate identities. This is an explicit selection, not an
automatic folder-only scope inference.

| Fix scope | Existing release inputs | Retained work |
| --- | --- | --- |
| UI web and compatible OTA | `deploy_targets=ui`, `ui_expo_action=ota`, `ui_desktop_mode=none` | UI web and matching-runtime OTA; excluded CLI/server, desktop and stores keep their versions/assets |
| CLI | `deploy_targets=cli` | CLI npm, signed platform binaries and selected dev-box image; excluded UI/server/stack stay unchanged |
| Server | `deploy_targets=server` (add `server_runner` when publishing the runner package) | Selected server runtime/deployment and relay image; runner npm only when selected |

Materialize only selected component versions, preserving publication's existing
version checks. Include every affected product required by a shared dependency
or compatibility change. Native dependencies/configuration/runtime-version
changes need new native binaries; OTA cannot repair those changes or reach an
incompatible installed runtime. An all-product release remains all-product.

### Early preparation (release-control follow-up)

Exact-source credential-free OTA exports and unsigned Tauri desktop builds can
start once their source/product admission is satisfied, alongside unrelated
software builds. The existing workflows expose preparation and consumption
phases and reuse their existing named artifacts within the same workflow run.
Consumers validate source, environment and version metadata before using those
bytes. Signing/notarization, updater signatures, checksums and publication retain
their existing admission and verification boundaries. Credential-bearing native
iOS/Android build/submission jobs remain behind those boundaries. This is a
preparation scheduling change, not a measured release-time guarantee, and is
available only after the follow-up workflow controls are integrated.

`node scripts/pipeline/run.mjs release --release-profile integrated` is the
normal preview path; preview and dev default to `integrated`, while production
defaults to `stable`. `stable` remains a normal dispatch only after its
additional manual evidence is complete. `deep` is deliberately rejected by the
normal dispatcher.

The profile contract describes self-hosted independent upgrade evidence; it
does not require a fleet wait, global cutover, or synchronized deployment.

### Preparing a pinned candidate (release-control follow-up)

The follow-up conductor implementation accepts
`hmaint release prepare --source-sha <full-40-character-sha>` alongside the
existing prepare options. Omitting it selects the current source-branch tip.
The selected commit must exist in the target repository and be reachable from
the source branch. Later merges do not replace the saved candidate: revalidation,
exact-SHA CI evidence (or the existing explicit waiver), promotion and resume
continue using that SHA. Including newer work requires a new prepare operation.
This source selection is separate from workflow-control authorization.

Promotion fast-forwards the target branch to the candidate itself. A target
already ahead of, or divergent from, that candidate still fails the existing
fast-forward guard. Synchronizing a published candidate back into development
is different: it preserves newer dev commits when dev already contains the
candidate, but still rejects divergent history. Only this synchronization caller
opts in; preview/main destinations remain exact. Candidate binding and immutable
publication keep their exact-equality checks before channel promotion.

Normal release issue snapshots intersect the open stage queue with correction
references in the exact candidate's cumulative commit ancestry. Use a
`Refs`, `Fixes`, `Closes` or `Resolves` line naming the issue in correction
commits identifying the complete correction; older references remain eligible
after branch promotion. Missing references and issues with newer reference-bearing
work on canonical dev stay queued with an explicit provenance diagnostic.
Candidates outside canonical dev ancestry fail closed. The combined
release snapshots source/dev/preview eligibility once for both channels. This follow-up
must be integrated into the target workflow controls and the private conductor
before pinned new releases are available.

### Preview release (dev → preview)

When you want to publish/deploy a new preview build:

1. Run **RELEASE — Publish (preview + production)** with:
   - `environment=preview`
   - `confirm=release dev to preview`
2. The workflow runs the configured checks against already materialized release-note/version source.
3. Deploy/publish steps use that exact admitted SHA, then the workflow promotes `dev` → `preview` only after every selected product has succeeded.
4. After post-promotion verification, the workflow advances its pre-promotion snapshots of open `stage:source` and `stage:dev` issues to `stage:preview`.

### Production release (preview → main)

When you want to ship what’s currently in `preview` to production:

1. Run **RELEASE — Publish (preview + production)** with:
   - `environment=production`
   - `confirm=release preview to main`
2. The workflow deploys/publishes from the exact admitted preview SHA, then promotes `preview` → `main` only after every selected product has succeeded (fast-forward by default; guarded reset is available).
3. After post-promotion verification, the workflow advances its pre-promotion snapshot of `stage:preview` issues to `stage:stable`.

Notes:

- Urgent path (avoid preview): `confirm=release dev to main` (or `reset main from dev`). Because that candidate comes from `dev`, it advances only snapshotted `stage:source` and `stage:dev` issues to `stage:stable`; it does not claim that unrelated preview-only corrections were included.

### Combined preview and production release (dev → both)

When the same approved source must ship to preview and production without a
second operator cycle, use the private conductor target
`preview-and-production`. The target dispatches the canonical `release.yml`,
which snapshots source/dev/preview issue eligibility once, validates one source
risk union, and invokes `release-channel.yml` through one channel matrix with
`fail-fast: false`. Single-channel releases use the same matrix with one entry.
Keeping one static call reduces expansion against GitHub's workflow object-size limit;
the release graph contract caps recursively expanded reusable calls at 100.
The retired `release-preview-and-production.yml` remains a supported historical
resume origin; new operations use `release.yml`.

The two matrix entries share the exact authorized source, release notes, and
successful CI run. Both channels publish concurrently from the reviewed source; this
does not establish preview soak before production. Source-only MySQL, platform-service, and installer/updater trust-root
checks are selected from the union of both release ranges and execute once in
the combined parent. Each channel retains its own planning and final admission,
which verifies that the shared evidence covers that channel's selected risks.
They deliberately do not share built artifacts: preview and production
embed different feature-policy environments and therefore require distinct
candidate bytes. Desktop candidate, finalized, and publication artifact names
include the environment so downloads and asset preparation cannot select or
merge the other channel's bytes. Nightly desktop recovery accepts its historical
single-channel candidate names; candidate materialization still verifies the
exact environment before bundling or signing. Mobile build artifacts include
environment, platform, and effective profile; immediate APK publication uses
the producer's artifact ID. Android store retry downloads historical collided
AAB/APK artifacts separately and admits exactly one AAB with its adjacent
candidate identity. OTA and release-note artifacts also include the environment.
Same-channel releases still serialize, while the two channel calls use separate
non-cancelling concurrency groups. Issue stages follow the highest channel with
successful post-promotion verification and canonical terminal completion:
production completion advances eligible issues to `stage:stable`, while preview
completion alone advances source/dev issues to `stage:preview`. A failed sibling
channel does not block verified availability in the completed channel. The
parent reads the separate terminal status artifacts rather than reusable matrix
outputs, which expose only one completed entry's value.

Use GitHub's failed-job rerun when workflow control is unchanged. If control
changes, resume the combined operation from its prior run; each channel reads
its own terminal status artifact and reuses only the verified work for that
channel.

Successful native flows remain reusable when the candidate source differs from
the origin run's workflow-control SHA. Candidate-bound status must match the
authorized source and operation, and the exact origin run's channel-specific
native jobs and required build steps must have succeeded. A control correction
alone does not invalidate that evidence or require rebuilding and resubmitting.

Desktop recovery prefers that channel's unexpired finalized updater artifacts,
bound to the exact origin run and SHA-256 archive digest. Restoring them does not
rebuild, re-sign, or re-notarize their payloads. Missing finalized platforms use
admitted unsigned candidates where available, otherwise build normally. The
trusted recovery control still prepares the publication envelope, verifies all
updater signatures, and runs the applicable desktop-setup gate before production
publication. Full release callers forward the canonical resolver's admitted
artifact maps and original run number; standalone nightly recovery retains its
legacy single-channel artifact admission.

When only desktop publication remains, an authorized maintainer can dispatch
`build-tauri.yml` from corrected `dev` control with `source_ref` set to the exact
approved candidate, `resume_run_id` set to its terminal original run, and
`release_notes_id` set to the approved notes. For a release origin, also set
`resume_workflow=release.yml` or `release-preview-and-production.yml` and
`resume_operation_id` to the exact conductor operation. `environment` selects
the channel's status and artifacts; the canonical resolver still verifies the
operation, source, run, and archive digests. `candidate_cli_version` can pin the
immutable CLI used by the production setup gate. All available finalized
platforms skip builds, signing, and notarization. This desktop-only recovery
does not run mobile flows or change the failed parent operation's status.

For the same-source origin, the canonical resume resolver can also retain accepted
OTA, native iOS/Android, and APK flows from exact channel-scoped successful jobs
and their decisive successful steps. The original Expo action remains unchanged;
only satisfied flows are skipped, and a partial native recovery builds only the
missing platform. Missing, failed, skipped, or ambiguous evidence does not mark a
flow complete. This admission is not proof of public App Store or Play availability.

For a same-SHA transient failure, retain successful jobs and rerun only the
failed jobs and their dependents:

```bash
gh run rerun <run-id> --repo happier-dev/happier --failed
```

For a control/test-only correction, wait until the origin run is terminal and
then resume the existing conductor operation. Prefer the completed origin with
the richest individually verified candidate and downstream evidence; the most
recent run can be a worse origin when it failed during admission before
re-verifying candidates.

```bash
hmaint release resume \
  --repo <absolute-checkout> \
  --operation-id <operation-id> \
  --origin-run-id <completed-origin-run-id> \
  --confirm "resume <operation-id> from run <completed-origin-run-id>" \
  --json
```

Resume is valid only when source, package/build inputs, signing inputs, and
immutable candidate bytes are unchanged. A candidate-reachable change requires
a new prepared release. Never dispatch the privileged release workflow
directly as a substitute for the conductor.

Issue availability is tracked by the mutually exclusive `stage:source`, `stage:dev`, `stage:preview`, and `stage:stable` labels documented in `docs/issue-triage.md`. Ordinary current-`dev` nightlies perform `source → dev`; preview, production, and combined releases perform the transitions above. Failed channels and dry-run releases move nothing. Standalone surface retries do not establish channel completion; use the canonical release resume to verify the complete channel before stage advancement. The reconciler re-reads each snapshotted issue, preserves unrelated labels, and skips closed or manually restaged issues. It never comments on or closes an issue.

Deploy branches typically include `deploy/<env>/ui`, `deploy/<env>/server`, `deploy/<env>/website`, and `deploy/<env>/docs` (depending on what changed and which options you select).

Release/deploy-ref promotion requests both Contents and Workflows write permission from
the release app: moving a branch to a source commit can change `.github/workflows`
even when the deployed component itself is unchanged. Asset-only publishing
tokens retain their narrower scope.

`website` and `docs` are independent release targets. Either may be selected
without the other, and each has its own change decision, deploy job, status
surface, and recovery evidence. The combined preview-and-production mode
combines channels; it forwards the selected target set to both channels and
does not couple website and docs publication.

Each immutable product consumes its own artifact and applicable upgrade
verification before promoting its rolling release. A failed sibling does not
hold a verified product's promotion or an unrelated deployment. Products that
consume CLI or server artifacts still wait for those inputs, and required
platforms remain a single product's verification cohort. The channel summary
retains every selected failure or pending result; one published product does
not make the selected release complete. Resume reuses completed products
through the existing resolver. Issue availability advances only after the
whole required channel outcome is verified.
Selected web deployment also waits for its own candidate's signature and source
identity verification before promoting the UI deploy branch.

Channel branches move last: a failed selected publication or deployment prevents
`main`/`preview` promotion without rolling back successful sibling products.
Immutable and rolling component releases explicitly suppress GitHub Latest during
publication. After production channel promotion, the workflow marks the selected
immutable component candidates Latest; GitHub has one repository-wide Latest pointer. Preview
prereleases remain ineligible. Terminal status records channel and Latest failures
separately while preserving each product's published, pending, or failed outcome.
These workflow changes apply to the next release dispatch; they do not alter
already-published releases.
A configured Homebrew tap is a selected CLI distribution: it waits for the CLI
verifier and rolling publication, contributes its own status, and must finish
before the channel branch moves. An unconfigured tap remains unselected.

Linux Tauri jobs acquire prerequisites through
`.github/actions/install-tauri-linux-dependencies`. Bundled WebKit restores only
the exact SDK cache key. A valid hit skips the LLVM repository/toolchain setup
and SDK compilation; the job still installs the native, packaging, and runtime
libraries needed to build and execute its packages. A miss builds the pinned SDK
before installing and validating it. Keep those runtime dependencies on warm
jobs; restoring the SDK does not install its system dependencies.

### Release authority and binary integrity

Hosted workflows pin operating-system image versions, including runner labels
provided by matrices, expressions, and output mappings. Image upgrades are
deliberate workflow changes; run
`node --test scripts/release/workflow_runner_images.contract.test.mjs` to check
that floating runner labels have not returned.

The default privileged conductor dispatches the hosted workflow, but the
semantic release phases remain script-owned. `release-analyze` performs
changed-seam planning, `release-validate` runs selected evidence, and
`release-local-candidates` can publish, verify, and promote the same immutable
CLI/stack/server/UI-web candidates directly when appropriate credentials and
native platform prerequisites are available. GitHub YAML supplies triggers,
permissions, runners, secrets/OIDC, matrices, and typed job wiring; it must not
become a second owner of release policy.

Local `--dry-run` planning uses
remote-advertised identities and object-only fetches, so it does not update or
prune local branch, remote-tracking, or tag refs.

When a hosted run fails, use native failed-job rerun if workflow code and
candidate bytes are unchanged. If workflow control changed, resume the failed
operation through `hmaint release resume`; a new attempt may reuse only
individually verified immutable candidates from the exact prior run. Any
release-output-affecting source change requires new release outputs.

Use this decision table instead of restarting the full graph:

| Evidence | Recovery |
| --- | --- |
| Same control SHA; transient runner, download, read-only API, or safely recoverable external failure | `gh run rerun <run-id> --failed` |
| Corrected workflow control, tests, or validation; unchanged candidate bytes; terminal origin with verified candidates | `hmaint release resume` from the richest valid origin |
| Changed source, package/build dependency, signing input, or immutable candidate bytes | Prepare a fresh release |
| Ambiguous publication mutation | Inspect the canonical remote state, then use the owning recovery-aware job; never blind-retry |

Independent jobs should be allowed to finish so one attempt exposes every
reachable failure. Publication and trust-dependent jobs still remain gated by
their real prerequisites: a consumer cannot be tested before its candidate
exists. Poll long builds, notarization, store submission, and publication every
5–20 minutes and use step-level progress plus the owning timeout; duration alone
is not failure evidence.

For a corrected non-secret Linux lane, follow the exact manual-dispatch,
exact-SHA binding, runner-pool, and failed-job rerun recipes in
`.agents/skills/happier-ci-stabilize/SKILL.md`. Focused dispatch remains
diagnostic evidence and does not replace the final canonical exact-SHA CI
required by release policy.

### npm trusted-publishing identity

npm validates the top-level calling workflow identity for an OIDC publication
through a reusable workflow. Every npm package published by this release graph
must therefore trust `release.yml` in `happier-dev/happier` for individual and
combined operations, with the `release-shared` GitHub environment. The reusable
`release-channel.yml` is not the top-level OIDC caller. Historical combined run
status remains resumable after the old wrapper is retired. Registry-side trusted
publisher configuration must be verified by the release owner before publishing;
local workflow tests do not verify npm's configuration. Register the workflow filename
without `.github/workflows/`; do not add a long-lived `NPM_TOKEN` fallback.
`ENEEDAUTH` in all npm publisher jobs while the release actor and OIDC steps are
otherwise healthy usually means the top-level caller is absent or mismatched in
npm's trusted-publisher configuration. Verify the package/version in the npm
registry after publication rather than relying only on the workflow badge.

The nightly `dev` release promotes the verified CLI candidate first, then calls
`release-npm.yml` with `channel=dev`, `npm_tag=dev`, and the exact candidate SHA and
version. This publishes `@happier-dev/cli@dev`; stable remains `latest` and preview
remains `next`. The reusable workflow uses the existing `release-shared` environment,
npm trusted publishing, and provenance permissions, so those environment credentials
must be reachable from the nightly caller.

For CLI, stack, server-runtime, and UI-web binary releases:

1. The hosted workflow binds the authorized source commit once.
2. It creates or resumes the version-tagged Release as a draft, uploads missing
   assets, and remotely verifies every asset's bytes before publishing the draft.
   Failed uploads or audits leave the draft private for retry. Existing public
   immutable releases are verified without adding assets or changing visibility;
   missing or different assets fail. Tags and existing bytes are never moved or
   clobbered.
3. It downloads that Release and verifies the complete checksummed and signed
   asset set.
4. A separate promotion step projects those exact bytes into the rolling
   Release, downloads them again, and checks byte equality, checksums, and the
   minisign signature.
5. Promotion creates or reuses one SHA-qualified staging draft, uploads the
   complete unversioned rolling asset set, and audits that draft by Release id.
   Older staging drafts for the same rolling tag are removed.
6. If a predecessor exists, promotion preserves it under one bounded backup tag,
   moves the audited staging Release onto the real rolling tag, requires the
   publication acknowledgement to name that same audited Release id, and then
   removes staging and backup refs. It does not download the complete bytes a
   third time after that acknowledgement. Recovery restores
   the predecessor when an interrupted attempt left only the backup visible.

The immutable version-tagged Release remains available throughout. Re-running
the same promotion reuses and re-audits the same-SHA staging draft or recognizes
an already exact rolling Release; it does not create a second publication owner
or blindly append assets to a partial rolling Release.

Immutable publication audits and all rolling-promotion asset downloads share
the read-retry owner in `scripts/pipeline/github/lib/release-asset-transfer.mjs`.
They reuse the existing transfer budget: `HAPPIER_PIPELINE_GH_RELEASE_UPLOAD_RETRIES`
(three attempts), `HAPPIER_PIPELINE_GH_RELEASE_UPLOAD_RETRY_DELAY_MS` (2,000 ms),
and `HAPPIER_PIPELINE_GH_RELEASE_TRANSFER_TIMEOUT_MS` (ten minutes per command).
The legacy `UPLOAD` names already govern publication audit reads as well as
uploads. A failed read restarts with a truncated or clobbered local destination;
retry warnings retain the original error. Transient transport failures and
`gh`'s `unexpected end of JSON input` are retryable reads, not evidence that an
artifact is corrupt. Authorization failures and other permanent errors stop
immediately. Byte, checksum, and signature verification remain outside retries,
and a read retry never repeats a publication mutation.

### Desktop macOS build tooling

Repository desktop builds use the shared UI tooling adapter
`apps/ui/scripts/tauriActoolEnvironment.mjs`: the release pipeline's build/bundle
commands, `hstack build --tauri`, and UI `tauri:build:*` scripts all consume it.
It temporarily wraps the resolved Xcode `actool` executable to reopen stdin on
`/dev/null`, preserving arguments, environment, exit status, and layered icons.
The native Node Tauri CLI otherwise closes inherited stdin at exec, which can
leave Apple's persistent `ibtoold` helper failing on later invocations too.
The adapter warns when active and removes its private executable directory when
the command settles; it does not restart shared Apple helpers or set private
Apple process-registry options. Raw third-party `tauri` invocations are unchanged.
Remove the adapter and its callers once the pinned CLI includes
[the upstream captured-command stdin fix](https://github.com/tauri-apps/tauri/pull/15991),
then verify a real layered-icon bundle with a fresh macOS build worker.

### Production mobile store publication (development follow-up)

This follow-up is source-level release automation, not evidence that an existing
App Store or Google Play version is public. Use these controls only after the
store-publication changes are integrated into the trusted workflow checkout.
Production native publication uses the existing mobile release workflow and
approved source; preview/dev distribution keeps its existing TestFlight and
Android internal-track behavior.

Store copy comes from the canonical v2 release-note projection of
`apps/ui/CHANGELOG.md`. Publication requires `appStore.whatsNew` for iOS (at most
4,000 characters) and `playStore.whatsNew` for Android (at most 500 characters).
The bundle must match the release id, exact source SHA, and UI marketing version
of the submitted binary. Missing copy or a mismatched binding fails publication;
recovery cannot substitute notes from the moving control checkout.

On iOS, EAS submission uploads the binary to App Store Connect; it does not
submit the production version for App Review. The follow-up resolves the exact
processed build, creates or reuses its App Store version, applies the approved
What’s New text on every existing version localization, and submits App Review with `AFTER_APPROVAL` and no phased
release. Existing TestFlight groups and Beta App Review are separate optional
distribution steps; no TestFlight group is required for production publication.
[Expo's submission guide](https://docs.expo.dev/submit/ios/) distinguishes the
upload from App Review, and [Apple's release options](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/select-an-app-store-version-release-option)
describe automatic publication after approval.

Android local AAB builds and every Android store submission use
`scripts/pipeline/expo/verify-android-page-size.mjs` before artifact publication
or upload. It checks every arm64-v8a and x86_64 ELF LOAD segment in all bundle
modules and the APK alignment requested by `BundleConfig.pb`. Uncompressed
libraries require `PAGE_ALIGNMENT_16K` or higher; AAB ZIP offsets themselves are
not APK offsets. A failure lists the offending libraries and requires a native
rebuild, not a store-only retry. See [Android's page-size guidance](https://developer.android.com/guide/practices/page-sizes).
Nonproduction cloud submissions resolve latest to an immutable store-build ID;
a pending build must finish before verification and submission can proceed.
Prerelease Android verification failures return failure without suppressing a
requested iOS submission; the Android upload is skipped.
The Sherpa JNI CMake owner passes both max-page-size and common-page-size 16384
to the linker; changing the NDK alone does not repair already built libraries.

On Android, the submit owner validates the Play API credential and the bound
notes before EAS upload. EAS stages the exact AAB as a production-track draft;
the Play Publisher owner then commits its approved localized notes and
`status=completed` together, without a staged `userFraction` or country targeting.
The track update contains only the new release, superseding the previous completed
release; existing localized notes on the target release are preserved. Google defines the full-rollout policy in the
[tracks API](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks).
An accepted edit still reports public availability as unverified: Google review
and [managed publishing](https://support.google.com/googleplay/android-developer/answer/9859654?hl=en)
can delay availability. Inspect Play Console before claiming that users can
install that version.

#### One-time maintainer setup

1. Add `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` to the repository's `release-shared`
   GitHub environment. Its value is the complete service-account JSON key for
   the existing EAS Android submit account; reuse that account rather than
   creating a second publisher identity. A Firebase `google-services.json` is
   client configuration and cannot authenticate the Play Publisher API.
2. Enable the Google Play Android Developer API in that account's Google Cloud
   project. Follow [Google's API setup](https://developers.google.com/android-publisher/getting_started).
3. In Play Console → Users and permissions, grant the service account access to
   the production Happier app with **View app information (read-only)** and
   **Release to production, exclude devices, and use Play App Signing**. Existing
   grants may already suffice; check them against [Google's permission definitions](https://support.google.com/googleplay/android-developer/answer/9844686?hl=en).
4. Check managed publishing in Play Console's Publishing overview. For
   automatic go-live after approval, turn managed publishing off; when it is
   enabled, a maintainer must publish the approved changes there.
5. Reuse the existing App Store Connect issuer/key configuration and
   `APPLE_API_PRIVATE_KEY`. Confirm that key can edit the production version and
   submit App Review, and complete the app's required metadata and agreements in
   App Store Connect. This follow-up introduces no new Apple secret.

Do not put credential values in logs, release notes, or support reports. A
missing Play secret fails with `missing_play_credential` and a nonzero exit
before binary submission; it does not silently leave a successful production
release at draft. A failed publication after upload is recovered separately
from binary submission.

#### Retry publication of an uploaded binary

Use `build-ui-mobile-local.yml` with `action=retry_store_publication`,
`environment=production`, and `platform=ios` or `android`. Set `source_ref` to the
binary's exact 40-character source SHA and `release_notes_id` to its approved
release id. Set the matching production profile (`profile=auto` selects it).

For iOS, pass `retry_testflight_eas_build_id` for the exact EAS build, or pass
both `retry_testflight_build_number` and `retry_testflight_app_version` for a
local IPA. An EAS submission id is not an EAS build id. For Android, pass
`retry_store_version_code` and `retry_testflight_app_version` for the exact
uploaded AAB. The workflow reads the canonical notes from the candidate source
and calls `scripts/pipeline/expo/store-publish.mjs`; it performs no native build
or binary resubmission.

Keep `retry_android_store_submit` for its existing purpose: resubmitting a
retained AAB when the binary upload itself needs recovery. Once the exact
binary is uploaded, use `retry_store_publication` for notes, review, or rollout
recovery. Do not use native rebuilds or binary resubmission to repair a
publication-only failure.

The retry writes `store-publication-status.json` and adds the observation to the
workflow summary. iOS reports `uploaded`, `processing`, `waiting_for_review`,
`in_review`, `pending_release`, `published`, `rejected`, or `action_required`,
together with the observed App Store state and exact build/version identities
when available. `waiting_for_review` proves review submission, not public
availability; `published` means App Store Connect reports the version ready for
sale/distribution. Processing waits reuse
`APP_STORE_CONNECT_PRODUCTION_PROCESSING_TIMEOUT_SECONDS` (default 3,600 seconds).
An unprocessed build when the wait ends, rejection, or required intervention
fails the retry so it can be recovered visibly.

Apple review-readiness failures report `status=failed`, `code=asc_review_not_ready`,
the HTTP status, and associated validation errors with resource ids, error codes,
and attribute pointers. Correct the named metadata and retry publication; partial
localization updates are reused without rebuilding or uploading the binary.

Android reports `publication_submitted` or `publication_already_submitted` with
`releaseStatus=completed` and `publicAvailability=unverified`. A successful
workflow badge or reconciliation dispatch alone never proves public store
availability.

### Best-effort TestFlight distribution

The native iOS build/submission and App Store processing/group attachment are
separate phases. After the signed build is submitted, the mobile workflow writes
its exact EAS build id or local IPA build identity and dispatches reconciliation
from the current trusted control checkout. Preview/dev use
`retry_testflight_distribution`; the production follow-up uses
`retry_store_publication` with the approved release-note identity, even when no
external TestFlight groups are configured. Release promotion therefore does not
hold a runner or the whole release open while Apple processes a build.

The reconciliation run validates the source ref, environment, profile, app id,
and build identity before querying App Store Connect. A skipped fingerprint build
is an explicit no-op. A failed reconciliation remains visible and can be retried
with the same recovery action; it must not trigger another native build or cause
already verified product candidates to be rebuilt.

A successful dispatch proves only that reconciliation was requested, not that
Apple processed or distributed the build. Attachment errors remain failures in
the follow-up run: a relationship 404 is reconciled against the current build
and app groups, and an absent group is not silently treated as success. Recover
an uploaded local IPA with its build number and app version; an EAS submission
id is not an EAS build id.

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

Development change, pending operator switch: server and UI promotion publish
hosted images in CI before advancing the deploy ref with the existing
compare-and-swap operation. The publisher builds from that exact candidate and
returns `hosted_images`, mapping each service to
`ghcr.io/happier-dev/relay-server:<server-version>-<channel>-<source-sha>@sha256:<digest>`
for both API and worker, and `ghcr.io/happier-dev/webapp:<ui-version>-<channel>-<source-sha>@sha256:<digest>` for UI.
Channel tags remain convenient aliases; deployment consumes the digest-pinned
output. API and worker use the same public relay image with full/Postgres runtime
env; UI uses the generic webapp stage, published to both GHCR and
`happierdev/webapp` on Docker Hub. Server promotion requires the exact server
artifact version, supplied by runtime publication or the `server_version` input;
the immutable release target must match the hosted image's candidate SHA.

After a changed deploy ref, or when `force_deploy` is selected, promotion updates
Dokploy's `dockerImage` plus documented runtime env and requests deployment, API before worker. It refuses
applications still configured with a Git source. Deploy-ref pushes and the
legacy webhook CLI no longer trigger server/UI builds. API and worker requests
are sequential, not an atomic rollout; inspect Dokploy completion before retrying
or rolling back a partially successful deployment.

Configure `DOKPLOY_API_URL` (the instance origin), secret `DOKPLOY_API_KEY`, and
`DOKPLOY_<PRODUCTION|PREVIEW>_<API|WORKER|UI>_APPLICATION_ID` variables in
`release-shared` for promotion, and in `production` / `preview` for manual
deployment. Retain `CF_WEBHOOK_DEPLOY_CLIENT_ID` and
`CF_WEBHOOK_DEPLOY_CLIENT_SECRET` when the API is behind Cloudflare Access.
For each target environment, the application variables are
`DOKPLOY_PRODUCTION_API_APPLICATION_ID`, `DOKPLOY_PRODUCTION_WORKER_APPLICATION_ID`,
`DOKPLOY_PRODUCTION_UI_APPLICATION_ID`, or the corresponding
`DOKPLOY_PREVIEW_API_APPLICATION_ID`, `DOKPLOY_PREVIEW_WORKER_APPLICATION_ID`,
`DOKPLOY_PREVIEW_UI_APPLICATION_ID`. Both promotion and manual UI deployment need
the matching `HAPPIER_PRODUCTION_SERVER_URL` / `HAPPIER_PREVIEW_SERVER_URL`
variable in their selected GitHub environment; an absent production URL fails
deployment instead of selecting the preview API.
The API key needs application read, service update and deployment permissions.
Public UI build variables belong in the publisher's `release-shared` environment:
`POSTHOG_API_KEY`, `POSTHOG_HOST`, `SENTRY_DSN` and `REVENUE_CAT_STRIPE`.
`HAPPIER_PRODUCTION_SERVER_URL` / `HAPPIER_PREVIEW_SERVER_URL` configure the UI
at runtime through `DOKPLOY_UI_SERVER_URL`, which the adapter writes as
`HAPPIER_WEBAPP_SERVER_URL`. Self-hosters set that container env directly.

Before enabling this path, disable Dokploy Git auto-deployment for each selected
application and switch its source to **Docker**, with registry `ghcr.io` and the
publisher's exact image. Preserve its environment, domains, networks, health
checks and mounts. Configure GHCR pull credentials in Dokploy if packages are
private; CI never rewrites those credentials. Keep API routing on port 3005 and
UI routing on 8080. Preserve migration ownership: the designated API runs
migrations; workers use `RUN_MIGRATIONS=0`.

Coordinate this operator switch with landing the workflow changes. They replace
the webhook path immediately: manual server/UI deployment and changed-ref
promotion fail when Dokploy is unconfigured, while direct pushes to server/UI
deploy refs no longer start a deployment workflow. A failed deployment after
promotion may leave the deploy ref advanced; configure Dokploy and rerun with
`force_deploy=true`, or use the explicit image map in the manual deploy workflow.
The replaced webhook path is not an automatic fallback.

The adapter sets API/worker env `HAPPIER_SERVER_FLAVOR=full`,
`HAPPIER_DB_PROVIDER=postgres`, `HAPPIER_SERVER_UI_REQUIRED=0`,
`HAPPIER_SERVER_UI_DIR=` (empty), `HAPPIER_SOCKET_ADAPTER=redis-streams`, and
`SERVER_ROLE=api` or `worker`. It retains the existing `DATABASE_URL`, `REDIS_URL`,
`RUN_MIGRATIONS` and all other operator env. Set API `RUN_MIGRATIONS=1` and worker
`RUN_MIGRATIONS=0` during the one-time source switch. No hosted-only image exists.

For redeployment or rollback, use **DEPLOY — Deploy Branch** with the matching
environment/component and an explicit `hosted_images` JSON map copied from the
desired prior publication. This does not move deploy refs or reverse database
migrations. Verify the running image digests, API health/version, worker queue
processing and UI before accepting the rollout.

Docs and website stay on Cloudflare by owner decision (2026-11-03), outside this
API/worker/UI change. Existing legacy deploy-branch hooks remain separate. For those hooks,
`DEPLOY_WEBHOOK_URL` is the base URL and `HAPPIER_DOCS_DEPLOY_WEBHOOKS` /
`HAPPIER_WEBSITE_DEPLOY_WEBHOOKS` are newline-separated IDs or full URLs.

Repository variables used for exact hosted-server completion proof:

- `HAPPIER_SERVER_API_PREVIEW_VERSION_URL`
- `HAPPIER_SERVER_API_PRODUCTION_VERSION_URL`

Each value must be the public `https://.../v1/version` endpoint for that
environment. A selected server deployment fails release verification unless
the endpoint reports the approved release `source_sha`; deploy-request acceptance alone
is not deployment completion.

If you only need to move branches (no deploy/publish):

- Use **PROMOTE — Branch (fast-forward or reset)** to move `source` → `target` in a safe, explicit way.

## Why fast-forward?

Fast-forwarding is the safest “no merge commit” promotion:

- It never rewrites history.
- It fails if branches diverged (so you can decide what to do next).

The reset option exists for rare cases where you intentionally want `target` to match `source` exactly.

## Database migrations (server)

For the server, database migrations should be automated as part of the deployment runtime:

- For a single unmanaged container, the default entrypoint may run `prisma migrate deploy` before server startup.
- For health-managed or multi-replica deployments, run `run-server --migrate-only` once in an explicit platform pre-deploy operation. Start API and worker replicas with `RUN_MIGRATIONS=0` only after that operation succeeds.
- When an application platform cannot run and await a blocking pre-deploy operation, designate exactly one API service as the migration owner and set `RUN_MIGRATIONS=0` on workers and all other replicas. Protect that owner with start-first rollout, rollback on failure, and sufficient health-check startup grace; webhook acceptance alone does not prove migration or deployment completion.
- Do not rely on API and worker startup races as migration ownership. Prisma's database lock serializes contenders, but it cannot preserve the winning migration when an orchestrator terminates that container for missing its startup-health window.
- Avoid running migrations at image build-time (Dockerfile), since migrations require a live DB connection.
