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
It dispatches the canonical top-level `release.yml` with the combined target
and `confirm=release dev to preview and main`. That owner snapshots source/dev/preview
issue eligibility once and invokes `release-channel.yml` for preview and
production in parallel. Its automatic validation profile is `stable` for
combined publication and `integrated` for a single channel; an explicit profile
still overrides that default.

The two calls share the exact source SHA, release notes, CI evidence, explicit
approvals, and one unioned source-risk validation pass. The shared validator
computes changes against both channel bases, then runs each applicable MySQL,
platform-service, and trust-root gate once. Each channel independently admits
that evidence against the same bound SHA. They do not share built artifacts:
preview and production
embed different feature-policy environments, so each channel must build and
verify its own bytes. Same-channel releases still serialize; the two channel
calls use separate non-cancelling concurrency groups. The outer workflow records
the highest channel with successful post-publication verification and canonical
terminal completion. Production completion advances eligible issues to
`stage:stable`; preview completion alone advances source/dev issues to
`stage:preview`. A failed sibling channel does not erase verified availability.

Use GitHub's failed-job rerun while workflow control is unchanged. After a
control fix, resume from the prior combined run; each channel reads its own
terminal `happier-release-status-preview` or `happier-release-status-production`
artifact and reuses only that channel's verified work. Single-channel origins
retain the unscoped `happier-release-status` artifact. Exact
per-channel resume facts are not available until those child workflows resolve
their respective status artifacts. The earlier shared source-validation pass
therefore conservatively treats CLI, stack, server, and Runner as requested
whenever a resume ID is present. This may run a platform-service gate that a
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
post-preview dev changes to a preview candidate. Failed channels and dry-run
releases move nothing. Standalone surface retries do not establish channel
completion; use the canonical release resume to verify the complete channel
before stage advancement. The reconciler re-reads each snapshotted issue, preserves
unrelated labels, and skips closed or manually restaged issues. It never
comments on or closes an issue.

Pinned issue snapshots check correction references in the exact candidate's
cumulative ancestry, including references older than the target branch tip.
References must identify the current complete correction. Missing references
and issues with newer reference-bearing work on canonical dev stay queued with
an explicit provenance diagnostic. Candidates outside canonical dev ancestry
fail closed. A manually applied stage label does not substitute for candidate
inclusion proof. Current-dev nightlies retain their whole-queue contract.

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

On the configured Mac host, invoke
`/Users/leeroy/Documents/Development/happier/maintainers-tools/bin/hmaint`
directly and prove that exact wrapper with
`/Users/leeroy/Documents/Development/happier/maintainers-tools/bin/hmaint --help`;
there is intentionally no required `hmaint --version` command. Do not resolve
a different copy from `PATH`, invoke its internal JavaScript entry point, or
install a second conductor in the VM. From the managed Linux VM, first enter
the configured 0.3 checkout that owns the launcher, then route the Mac command
through its execution target. Invoking this launcher while still in a 0.2
checkout fails its repository boundary. The launcher projects the invocation
directory remotely; its optional `--cwd` selects only a directory within the
synchronized 0.3 checkout, not a different release repository:

```bash
cd <absolute-0.3-checkout>
./apps/stack/bin/hstack-exec --target=mac-host -- \
  /Users/leeroy/Documents/Development/happier/maintainers-tools/bin/hmaint release bootstrap \
  --repo <macOS-mounted-absolute-checkout> --json
```

The launcher's owning checkout and `hmaint --repo` target are independent.
`--repo` may name a 0.2 checkout, but must use its independently verified absolute
path on the Mac execution host, not an inferred translation of a VM path. If the
launcher, configured `mac-host`, Mac wrapper, or target path cannot be proved,
fail closed; do not substitute a VM-local conductor or copy credentials into
the VM.

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

### Iroh transport release admission

Every release that ships an Iroh carrier admits its build prerequisites before
producing it, rather than depending on what a build image happens to contain.

- **Browser (WASM) carrier.** `build-ui-web-bundle.mjs` compiles the Rust
  endpoint for `wasm32-unknown-unknown` and generates the `wasm-bindgen`
  boundary while producing the web output. The UI-web publisher installs the
  pinned Rust toolchain, that target, and the `wasm-bindgen` CLI matching the
  locked crate before the bundle build runs. These are the same pins the
  Chromium real-transport lane proves the carrier with.
- **Mobile carriers.** Gradle's `preBuild` task and the CocoaPods
  `prepare_command` call `cargo` directly, so no pipeline step wraps them. The
  channel is pinned by `packages/iroh-native/rust-toolchain.toml`, and the EAS
  `eas-build-pre-install` hook
  (`packages/iroh-native/scripts/ensure-rust-toolchain.mjs`) installs rustup when
  the image has none and adds the platform's cross-compilation targets. Cloud
  and local EAS builds run the same lifecycle, so one hook serves the EAS images
  and the GitHub-hosted runners the local mode builds on. A build whose
  `HAPPIER_INSTALL_SCOPE` excludes `iroh-native` compiles no Rust and is skipped.
- **Version parity.** `packages/iroh-native/scripts/verify-iroh-lock-parity.mjs`
  proves the pinned `iroh` and `iroh-relay` crate version, registry source, and
  checksum match across the native and Tauri lockfiles, and that the stock
  relay Docker build installs that exact locked relay version. The
  release plan runs it whenever the `iroh_transport` or `iroh_relay` component
  changes. It is a property of the source being released and never implies
  republishing the relay image; relay publication remains its own decision.
- **Licence evidence.** `packages/iroh-native/scripts/generate-native-release-evidence.mjs`
  is the one evidence owner for the workspace's locked Cargo graph. It emits a
  CycloneDX SBOM plus `THIRD-PARTY-NOTICES.txt` carrying the licence and NOTICE
  texts each package actually distributes — not only names and SPDX expressions
  — and states how many packages distribute no text at all. The native CLI and
  server carriers stage it into their packaged Iroh root; the browser carrier
  stages the same bytes into `vendor/iroh/`, where the existing exact-set asset
  verifier checks the staged files and records per-file digests, so a web output
  cannot be published without it.
- **Relay image evidence.** The existing Docker publisher requests BuildKit
  SBOM and provenance attestations, captures the immutable pushed digest, then
  inspects that exact index for Linux AMD64, Linux ARM64, and per-platform
  attestation manifests. This is image-content evidence; it is distinct from
  the Cargo-graph CycloneDX files packaged with native and browser carriers.
- **Performance evidence.** The reusable test workflow exposes
  `run_workspace_sync_performance` for an explicit manual or release evidence
  run. It enables the existing 1 GiB direct-and-relay fixture and records its
  measurements without inventing an acceptance threshold. Ordinary pull
  requests do not enable this mode.

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

Immutable version publication creates or resumes a draft, uploads missing
assets, and verifies every remote asset's bytes before publishing the draft.
Failed uploads or audits leave the draft private for retry. An existing public
immutable release is audited without adding assets or changing visibility;
missing or different assets fail. Rolling promotion follows successful immutable
publication and verification.

Immutable publication audits and rolling-promotion asset downloads share the
read-retry owner in `scripts/pipeline/github/lib/release-asset-transfer.mjs`.
Publication retains its existing `HAPPIER_PIPELINE_GH_RELEASE_UPLOAD_RETRIES`
(three attempts), `HAPPIER_PIPELINE_GH_RELEASE_UPLOAD_RETRY_DELAY_MS` (2,000 ms),
and `HAPPIER_PIPELINE_GH_RELEASE_TRANSFER_TIMEOUT_MS` (ten minutes per command).
The legacy `UPLOAD` names also govern publication audit reads. Promotion retains
its existing `HAPPIER_PIPELINE_GH_ASSET_READ_ATTEMPTS` (four attempts),
`HAPPIER_PIPELINE_GH_ASSET_READ_RETRY_DELAY_MS` (2,000 ms), and
`HAPPIER_PIPELINE_GH_ASSET_READ_MAX_RETRY_DELAY_MS` (8,000 ms) capped exponential
backoff, with ten minutes per download command. This policy covers immutable,
staged, and published downloads. Staged asset reads keep their temporary-file
rename boundary; bulk release downloads clobber incomplete local files.
Retries log their original error and apply only to transient read failures,
including `gh`'s `unexpected end of JSON input`, never to authorization failures
or integrity checks. A read retry never repeats a publication mutation.

For hosted failures, first rerun failed jobs when no workflow/control change is
needed. When control code changed but candidate bytes did not, a new release
attempt may reuse only individually verified immutable candidates from the
named completed origin run. Release-output-affecting byte changes require new release outputs. One failed sibling product does not invalidate independently
verified immutable candidates from successful products.

Use the narrowest safe recovery:

| Evidence | Recovery |
| --- | --- |
| Same control SHA; transient runner, download, read-only API, or safely recoverable external failure | `gh run rerun <run-id> --repo happier-dev/happier --failed` |
| Corrected workflow control, tests, or validation; unchanged candidate bytes; terminal origin with verified candidates | `hmaint release resume` from the richest valid origin |
| Changed source, package/build dependency, signing input, or immutable candidate bytes | Prepare a fresh release |
| Ambiguous publication mutation | Inspect canonical remote state, then use the owning recovery-aware job; never blind-retry |

The richest valid origin is the completed run with the most individually
verified candidates and downstream evidence, not necessarily the newest run.
Use the exact confirmation token supplied by the conductor:

```bash
hmaint release resume \
  --repo <absolute-checkout> \
  --operation-id <operation-id> \
  --origin-run-id <completed-origin-run-id> \
  --confirm "resume <operation-id> from run <completed-origin-run-id>" \
  --json
```

Let independent jobs finish so one attempt exposes every reachable failure.
Consumers that require a real signed artifact or external store state still
remain behind that prerequisite. Poll builds, notarization, store submission,
and publication every 5–20 minutes; elapsed time alone is not failure evidence.

Use the existing manual test dispatcher rather than copying the CI graph. The
default is GitHub-hosted runners:

```bash
gh workflow run tests-dispatch.yml \
  --repo happier-dev/happier \
  --ref dev \
  -f profile=custom \
  -f runner_pool=github \
  -f custom_checks=release_contracts
```

This is corrected-SHA diagnostic evidence; canonical exact-SHA CI remains the
final release source gate. Blacksmith is only an explicitly approved,
budget-checked accelerator for the same non-secret Linux graph. It has no
automatic fallback. Do not select it while included credits are exhausted.

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
Android internal-track behavior and configured EAS release statuses.

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
separate phases. After the signed build is submitted, the mobile workflow hands
its exact EAS build id or local IPA build identity to reconciliation from the
current trusted control checkout. Preview/dev use
`retry_testflight_distribution`; the production follow-up uses
`retry_store_publication` with the approved release-note identity, even when no
external TestFlight groups are configured. The parent release therefore does
not hold a runner or block required promotions while Apple processes the build.

The reconciliation action validates source, environment, profile, app, and
build identity before querying App Store Connect. A skipped fingerprint build
is an explicit no-op. Retry only that reconciliation action after an Apple
processing or group-attachment failure; do not start a second native build.

A successful dispatch proves only that reconciliation was requested, not that
Apple processed or distributed the build. Attachment errors remain failures in
the follow-up run: a relationship 404 is reconciled against the current build
and app groups, and an absent group is not silently treated as success. Recover
an uploaded local IPA with its build number and app version; an EAS submission
id is not an EAS build id.

Self-hosted relays upgrade independently. The release contract never holds a
fleet at a barrier, coordinates a migration, or declares a global cutover. A
specific released migration can still have its own documented operator
procedure; that procedure remains the owner of its external writer/drain facts.

### npm trusted-publishing identity

npm validates the top-level calling workflow identity when a reusable workflow
publishes with OIDC. On this release line the top-level public-release caller is
`release.yml`, which must be trusted in the `release-shared` environment. Do not
document or configure a second caller unless that workflow actually exists and
invokes the same canonical publisher.
This follows npm's [calling-workflow validation](https://docs.npmjs.com/trusted-publishers/)
and GitHub's [caller claims for reusable workflows](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows).
Register the workflow filename without `.github/workflows/`; do not add a
long-lived `NPM_TOKEN` fallback. A cluster of otherwise-authorized `ENEEDAUTH`
publisher failures normally indicates a missing or mismatched top-level caller.
Verify the package/version in the npm registry after publication.

### Desktop artifact isolation and recovery

The development desktop workflow scopes candidate, finalized, and publication
artifact names by environment, so concurrent channel calls cannot select or
merge each other's bytes. Nightly desktop recovery also accepts historical
unscoped candidates from its single-channel predecessor. Both name shapes use
the same origin admission and exact-environment materialization checks; candidates
explicitly named for preview or production are rejected by nightly recovery.

Standard release recovery admits only the requested UI channel's scoped desktop
artifacts from the exact terminal origin and source. It prefers unexpired
finalized updater archives, verifies their admitted SHA-256 archive digest, and
restores the same payloads and signatures without rebuilding, re-signing, or
re-notarizing. Missing finalized platforms reuse admitted unsigned candidates or
build normally. Full release callers forward the canonical resolver's artifact
maps, source identity, and original run number. Trusted preparation regenerates
the publication envelope and verifies every updater signature before publishing.

When only desktop publication remains, an authorized maintainer can dispatch
`build-tauri.yml` from corrected `dev` control with `source_ref` set to the exact
approved candidate, `resume_run_id` set to its terminal original run, and
`release_notes_id` set to the approved notes. For a release origin, also set
`resume_workflow=release.yml` for either single-channel or combined releases, and
`resume_operation_id` to the exact conductor operation. `environment` selects
the channel's status and artifacts; the canonical resolver still verifies the
operation, source, run, and archive digests. It selects the channel-scoped status
for combined origins and the unscoped status for single-channel or nightly
origins; ambiguous status topology or a missing channel fails admission.
All available finalized platforms
skip builds, signing, and notarization. This desktop-only recovery does not run
mobile flows or change the failed parent operation's status.

### Mobile and OTA current-origin recovery

Standard release recovery can retain accepted OTA, native iOS/Android, and APK
flows from exact-source successful jobs and their decisive successful steps.
The admitted status binds the approved candidate source and conductor operation;
job evidence binds the exact origin run, workflow control SHA, and channel. A
different workflow control SHA from the candidate does not discard completed
flows when those bindings and successful steps match.
The canonical status projection records the original Expo action; completion is
reused only for that same action. Missing historical mode or ambiguous job evidence
keeps the flow enabled. Saved status also carries the original web, Expo, and
desktop request; historical origins without that complete intent use the new
explicit dispatch inputs. Partial native recovery builds only the missing platform.
These accepted workflow outcomes do not prove public App Store or Play availability.

The `full` Expo action includes OTA, native store submission, and dedicated APK
publication. Android source builds retain their profile-qualified AAB and APK
artifacts without release-write credentials. A separate trusted-control job
signs and publishes the APK using the admitted source and embedded app version;
a successful build alone is not APK publication evidence. Retained-AAB retry
admits the original source, environment, and profile before submitting the same
artifact from a dependency-free project-identity workspace, without rebuilding.

Accepted successful downstream deployments and non-SDK npm/Docker publication
can be reused on resume. Rolling assets additionally require the origin's
verification and fresh final verification of the current exact release refs.
Retained CLI, stack, server, and Runner verification authenticates the exact
immutable manifest with the existing release-signature owner and requires the
rolling manifest to contain the same authenticated bytes. Its original build
and publication identities may belong to a completed failed or cancelled
aggregate; fresh products and external CLI build candidates keep their existing
run-success requirements. UI-web has no `latest.json` provenance producer and
continues through its existing signed-bundle and exact-ref verification path.
Public SDK publishers still produce their individual integrity evidence and
cannot be skipped through generic npm completion.

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

Release/deploy-ref promotion requests both Contents and Workflows write permission from
the release app: moving a branch to a source commit can change `.github/workflows`
even when the deployed component itself is unchanged. Asset-only publishing
tokens retain their narrower scope.

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
2. Refresh and record the current `../0.2` predecessor `HEAD`, dirty
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

### Account lifecycle activation (development)

`20260905220000_add_team_home_governance` activates `Account.status` and
contracts the old Account-disable RepeatKey namespace. It is independently a
no-old-server boundary: a status-unaware server can re-admit inactive Accounts
even if Qualified Connected Accounts V4 is absent. Before first deployment,
refresh immutable server artifact/deploy provenance and the current `../0.2`
Account readers/writers, verify provider migration parity/backfill, stop every
old API and worker instance sharing the database, and keep them stopped through
migration and status-aware startup. Teams feature disablement does not relax
this Account authentication boundary, and no client update floor follows.

The managed installer shares the existing irreversible-migration admission and
rollback path for both boundaries. In current development source, SQLite
migration admission inspects the existing schema and finished migration ledger
before migration writes. A fresh database (including an empty ledger with no
application tables) needs no updater handoff; an existing database, including a
legacy schema without a ledger, still requires the managed installer's forward
recovery capability. Stack server startup does not supply that contract: migrate
existing data through the updated managed Personal Home installer with all other
server processes stopped. Shared-DB QA consumers set
`HAPPIER_SQLITE_AUTO_MIGRATE=0` and `HAPPIER_STACK_MIGRATE_MODE=skip` after the
database owner has migrated it. Do not manually declare
`HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY` to bypass admission.
On candidate failure the updater queries
the candidate migration executable against the existing migration ledger and
refuses previous-runtime restoration if any included boundary is applied or
cannot be determined. Recovery remains with the existing updater owner; there
is no shadow disable marker, dual writer, or extra activation ledger.

The V4-specific hosted promotion approval above is not Account-status activation
certification. The release owner must verify this lifecycle boundary against the
actual deployment before dispatch. Docker, runner, and manual deployment
operators must enforce quiescence themselves. Old binaries have no new startup
refusal mechanism: manually starting one against the activated database is
unsupported and unsafe. After failure, preserve the database/recovery artifacts,
keep old server roles stopped, and use an approved forward recovery with a
status-aware server rather than restarting the predecessor.

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
finished migration record and exact trigger shape/definer before the server can
start. The same preflight and postflight cover every pending MySQL migration in
the current tree that installs a trigger, including the Session Follow,
provisioned-identity, and Workflow Run invariants. Those later migrations do not
require the Voice maintenance-window approval above; the command derives their
required table-scoped `TRIGGER` authority directly from the pending migration
set.

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
