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
  The registry selects inexpensive artifact/binary facts for applicable
  products and selects heavy upgrade scenarios only when the actual diff
  changes their seam: daemon/update continuity, session/restart ownership, or
  relay persistence/startup. Candidate existence alone does not select every
  heavy scenario.
- `stable` additionally selects the full source-check profile and requires the
  private release agent to review preview candidate equivalence and soak,
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
dispatch. Qualified V4 activation is not implemented in this release line; its
separate approval input must remain false. That go-ahead must name the selected profile and the exact SHA of the
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
`--repo` may name a 0.2 checkout, but must use its independently verified absolute
path on the Mac execution host, not an inferred translation of a VM path.
If the launcher, configured `mac-host`, Mac wrapper, or Mac-visible target path
cannot be proved, fail closed; do not translate paths by inspection or fall back
to a VM-local conductor.

Before changelog/version materialization, the release agent runs
`node scripts/pipeline/run.mjs release-analyze ...` over the actual source
range and completes the semantic compatibility review while inspecting that
same diff for notes and version recommendations. After commit/push, only an
unexpected runtime-reachable delta invalidates the affected analysis.

Materialize the approved notes and versions for the selected products once on
that source, commit them, and require completed CI for the resulting exact SHA.
Prepare the pinned operation from that final SHA; another dev merge does not
require another editorial or version pass. Version files, manifests, lockfiles,
native configuration and generated runtime inputs still receive full source CI.

The release-control speed follow-up adds a narrow exception in the existing
`tests.yml` CI planner: a push changing only `apps/ui/CHANGELOG.md` can select
note projection checks instead of runtime suites. It proves that the previous
push SHA is an ancestor with successful canonical full-source CI, downloads and
validates that run's lane summary, and validates the final commit's canonical
note projections plus the projection contract suite. The new completed run and
summary identify the final child SHA; a parent run ID is never accepted as child
evidence. Missing, expired or insufficient baseline evidence selects full source
CI with an explicit diagnostic. An earlier notes-only run is not a full-source
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
opts in; preview/main destinations remain exact. Post-promotion candidate
binding and immutable publication keep their exact-equality checks.

Normal release issue snapshots intersect the open stage queue with correction
references in the exact pre-promotion target-base-to-candidate range. Use a
`Refs`, `Fixes`, `Closes` or `Resolves` line naming the issue in correction
commits; missing references remain queued for later reconciliation. The combined
release uses the main-to-candidate range once for both channels. This follow-up
must be integrated into the target workflow controls and the private conductor
before pinned new releases are available.

### Preview release (dev → preview)

When you want to publish/deploy a new preview build:

1. Run **RELEASE — Publish (preview + production)** with:
   - `environment=preview`
   - `confirm=release dev to preview`
2. The workflow runs the configured checks against already materialized release-note/version source, then promotes `dev` → `preview` (fast-forward).
3. Deploy/publish steps for the preview environment build from `preview` (not `dev`).
4. After post-promotion verification, the workflow advances its pre-promotion snapshots of open `stage:source` and `stage:dev` issues to `stage:preview`.

### Production release (preview → main)

When you want to ship what’s currently in `preview` to production:

1. Run **RELEASE — Publish (preview + production)** with:
   - `environment=production`
   - `confirm=release preview to main`
2. The workflow promotes `preview` → `main` (fast-forward by default; guarded reset is available), then deploys/publishes from `main`.
3. After post-promotion verification, the workflow advances its pre-promotion snapshot of `stage:preview` issues to `stage:stable`.

Notes:

- Urgent path (avoid preview): `confirm=release dev to main` (or `reset main from dev`). Because that candidate comes from `dev`, it advances only snapshotted `stage:source` and `stage:dev` issues to `stage:stable`; it does not claim that unrelated preview-only corrections were included.

### Combined preview and production release (dev → both)

When the same approved source must ship to preview and production without a
second operator cycle, use the private conductor target
`preview-and-production`. The target dispatches
`release-preview-and-production.yml`, which snapshots source/dev issue
eligibility once and invokes the canonical `release.yml` for both channels in
parallel.

The two calls share the exact authorized source, release notes, and successful
CI run. Source-only MySQL, platform-service, and installer/updater trust-root
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
non-cancelling concurrency groups. Issues advance directly
to `stage:stable` only after both channel workflows succeed.

Use GitHub's failed-job rerun when workflow control is unchanged. If control
changes, resume the combined operation from its prior run; each channel reads
its own terminal status artifact and reuses only the verified work for that
channel.

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

Issue availability is tracked by the mutually exclusive `stage:source`, `stage:dev`, `stage:preview`, and `stage:stable` labels documented in `docs/issue-triage.md`. Ordinary current-`dev` nightlies perform `source → dev`; preview, production, and combined releases perform the transitions above. Failed and dry-run releases move nothing. The reconciler re-reads each snapshotted issue, preserves unrelated labels, and skips closed or manually restaged issues. It never comments on or closes an issue.

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

### Release authority and binary integrity

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
must therefore trust both supported callers in `happier-dev/happier`:

- `release.yml` for an individual preview or production operation;
- `release-preview-and-production.yml` for the coordinated combined operation.

Both use the `release-shared` GitHub environment. Register the workflow filename
without `.github/workflows/`; do not add a long-lived `NPM_TOKEN` fallback.
`ENEEDAUTH` in all npm publisher jobs while the release actor and OIDC steps are
otherwise healthy usually means the top-level caller is absent or mismatched in
npm's trusted-publisher configuration. Verify the package/version in the npm
registry after publication rather than relying only on the workflow badge.

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
   moves the audited staging Release onto the real rolling tag, verifies the
   public Release and tag, then removes staging and backup refs. Recovery restores
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
What’s New text, and submits App Review with `AFTER_APPROVAL` and no phased
release. Existing TestFlight groups and Beta App Review are separate optional
distribution steps; no TestFlight group is required for production publication.
[Expo's submission guide](https://docs.expo.dev/submit/ios/) distinguishes the
upload from App Review, and [Apple's release options](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/select-an-app-store-version-release-option)
describe automatic publication after approval.

On Android, the submit owner validates the Play API credential and the bound
notes before EAS upload. EAS stages the exact AAB as a production-track draft;
the Play Publisher owner then commits its approved localized notes and
`status=completed` together, without a staged `userFraction`. Other releases and
localizations are preserved. Google defines the full-rollout policy in the
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

- For a single unmanaged container, the default entrypoint may run `prisma migrate deploy` before server startup.
- For health-managed or multi-replica deployments, run `run-server --migrate-only` once in an explicit platform pre-deploy operation. Start API and worker replicas with `RUN_MIGRATIONS=0` only after that operation succeeds.
- When an application platform cannot run and await a blocking pre-deploy operation, designate exactly one API service as the migration owner and set `RUN_MIGRATIONS=0` on workers and all other replicas. Protect that owner with start-first rollout, rollback on failure, and sufficient health-check startup grace; webhook acceptance alone does not prove migration or deployment completion.
- Do not rely on API and worker startup races as migration ownership. Prisma's database lock serializes contenders, but it cannot preserve the winning migration when an orchestrator terminates that container for missing its startup-health window.
- Avoid running migrations at image build-time (Dockerfile), since migrations require a live DB connection.
