---
name: happier-release
description: Resolve Happier's private release authority and run an exact-SHA release or nightly through cheap admission, verified CI evidence, resumable immutable candidates, and terminal publication proof. Use for preparing, dispatching, recovering, or assessing a Happier release.
metadata: {"openclaw":{"homepage":"https://github.com/happier-dev/happier"}}
---

# Happier Release

Keep release policy simple: test source once, admit the operation cheaply, build each immutable candidate once, verify once per trust boundary, promote independent products in parallel where the workflow permits, and recover without rebuilding valid work.

When the same approved `dev` source must ship to both public channels, select
the conductor's `preview-and-production` target. It reuses one exact-SHA CI and
approval packet, and it executes the union of source-only MySQL, platform, and
trust-root checks once before the canonical channel workflow runs preview and
production concurrently. Each channel still performs its own admission against
that shared exact-source evidence. Do not try to reuse preview artifact bytes for
production: channel-specific binaries embed different feature-policy
environments. The fast path removes duplicate orchestration and operator wait,
not required channel-specific builds or artifact verification.

Channel combination does not combine product targets. `website` and `docs` are
independent entries in the target-owned release target set: either may be
selected without the other, and each retains its own plan, job, status surface,
and recovery evidence in both single-channel and combined operations.

## Resolve authority first

Inspect the public machine-readable contract with:

```bash
node scripts/pipeline/run.mjs release-contract
```

Then resolve the private release authority for the absolute checkout:

```bash
hmaint release bootstrap --repo <absolute checkout> --json
```

Use the returned private skill and its instructions as authoritative. The public contract defines targets, profiles, and compatibility intent; private operating procedure stays outside this repository.

Do not publish from a dirty or protocol-incompatible maintainer-tools checkout. Bootstrap/preflight must bind the maintainer-tools commit and return structured admission failures before any release mutation. Do not modify or clean that checkout as an implicit part of releasing.

The `v0.3` control ref is admitted by workflow code but cannot publish yet.
Before enabling publication, the release owner must first add a `v0.3` branch
ruleset matching `dev`, then add `v0.3` to the `release-shared` environment's
deployment branch policy. Preserve that order so an unprotected control ref
never gains access to the release environment.

### Execute private authority where the credentials live

First establish the actual execution host (`uname -s`, `pwd -P`) and the absolute source checkout. A path under a mounted VM workspace does not by itself mean the agent process is running inside Linux.

- On the configured macOS host, run `/Users/leeroy/Documents/Development/happier/maintainers-tools/bin/hmaint` directly so it can use the Mac Keychain and native signing/release prerequisites. Prove that exact wrapper with `/Users/leeroy/Documents/Development/happier/maintainers-tools/bin/hmaint --help` (there is no required `hmaint --version` command). Do not scan unrelated home directories, resolve a different copy from `PATH`, invoke the maintainer CLI's internal JavaScript entry point, install another copy, or guess a checkout.
- From the managed Linux development VM, keep repository work in the authoritative VM checkout and use the Stack execution-host/broker path for Mac-only authority. This 0.2 checkout does not own the launcher: first enter an existing configured 0.3 checkout, then invoke its `./apps/stack/bin/hstack-exec --target=mac-host -- <command> ...`. Invoking that launcher while still in 0.2 fails its repository boundary. The launcher's working directory is separate from `hmaint --repo`, which names an independently verified target Git root and may be 0.2. The existing synchronized source mirror can supply that root without a separately maintained Mac product checkout. Planning is credential-free; the Mac authority submits the public plan's complete `hostedDispatch` transport. See [the execution example](../../../docs/release-process.md#public-contract-private-operation-and-human-go-ahead). If the launcher, configured `mac-host` target, Mac wrapper, or target path cannot be proved, fail closed. Never copy Keychain secrets into the VM or substitute a VM-local conductor.
- `yarn ghops auth status` is the safe credential-path probe. In a managed Linux workspace it should report the Mac-host credential broker; it must not print the token. Failure of direct Keychain access from one process does not authorize falling back to a personal `gh` login.

Before porting or releasing, resolve and compare real paths, repository roots, branch/commit bases, and dirty state. Host checkouts and VM-mounted siblings with similar names may be distinct repositories; never assume that changes written to one are visible in the other.

## Admit without repeating CI

Read each selected product's status independently. Its own candidate and
applicable upgrade verification govern promotion; unrelated failures do not
hold it. Preserve real artifact dependencies and required platform cohorts.
Keep the aggregate failed or pending while selected work remains unsatisfied,
reuse completed products on resume, and advance issue availability only from
the fully verified channel outcome.
Move the channel branch only after every selected product's publication and
deployment succeeds. Keep GitHub Latest disabled when creating/publishing
component releases; mark the selected immutable releases Latest only after
production channel promotion. Preserve per-product outcomes if branch or Latest
promotion fails, and report the aggregate as incomplete.
Selected web deployment must wait for its own candidate's signature and source
identity verification before promoting the deploy branch.

Keep hosted runner image versions explicit, including matrix and dynamic runner
mappings. An image upgrade is a deliberate workflow change; validate it with
`node --test scripts/release/workflow_runner_images.contract.test.mjs`.

Linux Tauri prerequisites belong to the existing install action. Preserve its
exact bundled-WebKit SDK cache: warm hits skip compiler acquisition and SDK
compilation, while retaining required system runtime and packaging libraries.
Do not substitute a broad cache restore or remove dependencies merely because
the SDK was restored; see [release process](../../../docs/release-process.md).

Before expensive candidate work, run the repository's cheap, non-mutating release preflight. It validates operation-specific inputs such as source/channel identity, version and notes projection, maintainer protocol compatibility, tools, credentials, external configuration, and selected runner/platform prerequisites. It must call canonical owners and must not repeat unit, typecheck, integration, or E2E work from source CI.

Development source CI selects schtasks self-host E2E, packaged CLI build/runtime
smoke on every native target, and unsigned Android/iOS native compilation by owned
paths and nightly in `tests.yml`. Keep these checks before publication; release
signing and distribution still need their real candidates. A scheduled workflow
must be present on the repository default branch to activate.

Consume an explicit successful exact-SHA CI run/attestation whenever available. Pass its numeric `ci_run_id`; the release verifier must bind repository, canonical workflow, event, branch, completion, success, and exact head SHA. Nightly release validation remains artifact-specific and risk-selected—it is not another full source-CI run. The hosted verifier fails or defers quickly when source CI is absent; the private approved-packet conductor waits for the child before dispatch rather than occupying a release runner.
For source suites, reuse only the shared source validator’s exact-SHA/profile/policy result from the existing CI summary; do not relabel generic CI success. Missing proof runs the selected policy once at source validation, while standalone publishers retain their source-contract fallback. Source Binary Smoke currently supplies preview proof only; production smoke and signed-artifact verification remain required.


Approve the reviewed source, notes, versions, compatibility, selected profile
and ordinary publication scope once. The same grant covers unchanged
materialization and dispatch; do not ask again after committing approved inputs.
For an approved packet, use `hmaint release run --repo <absolute checkout>
--packet <absolute JSON path>`. The public owner materializes canonical notes
and exact versions and commits only approved paths. The private conductor owns
the authenticated push, waits for the final child's exact-SHA canonical CI,
then admits once and dispatches. The CI selector owns metadata-only reuse;
never substitute the ancestor's run for the child's run. Existing prepared
operations use `--operation-id <id>` instead of `--packet`.
Materialization refuses production packets sourced from `preview`; use an
existing prepared operation to promote the already validated preview candidate.
Unexpected source or scope changes need a refreshed decision. Combined releases
publish both channels concurrently and do not establish preview soak. This 0.2
line does not offer V4 activation; historical true requests remain refused.

The CI planner may reuse a successful non-metadata ancestor for content-proven
notes/version-only children, retaining child projections and build-smoke
packaging. Dependency, script, native-content, runtime-version or unexpected
generated changes retain full source CI. Always consume the final child's exact-SHA
evidence; a metadata child cannot become a full-source baseline. Rolling promotion
keeps the staged byte/signature audit and same-id publication acknowledgement,
without a third full-byte download after acknowledgement.

Source CI cannot prove behavior that requires an as-yet-unpublished signed candidate. Candidate identity, archive/signature checks, installer consumption of the candidate, CLI update continuity between real published versions, store submission, and promoted-reference checks therefore remain in the release graph after their required artifact exists. Run those independent candidate validations in parallel where their prerequisites allow, but never replace them with source mocks or waive artifact verification. A collector can expose every reachable error in one attempt; it cannot execute a consumer before the artifact or external state that consumer requires exists.

Keep `fast`, `release`, and `deep` profile ownership distinct as defined in [CI cleanup](../happier-ci-stabilize/references/ci-cleanup.md). Do not turn a profile or runner backend into a copied workflow.

## Recover through one owner

For a failing or slow run, apply `skills/happier-ci-stabilize/SKILL.md`. Its recovery table decides among:

- native failed-job rerun for a same-SHA safe transient failure;
- immutable-candidate resume after a control/test-only fix, preserving individually verified successful siblings;
- fresh release when source, packaging, dependencies, signing inputs, or candidate bytes changed.

Do not blindly retry an ambiguous publication mutation. Reconcile remote state through its canonical mutation owner first. Use one foreground monitor, bound to one run and attempt, with 5-20 minute polling for long operations. Close only from terminal release status, exact candidate identity, required validation, and promoted-reference evidence.

For a same-control transient failure, use GitHub's native
`gh run rerun <run-id> --repo happier-dev/happier --failed`. For a
control/test-only correction, wait for a terminal origin and run the exact
`hmaint release resume` command and confirmation token returned by the private
conductor. Select the richest valid origin—the completed run with the most
individually verified candidates and downstream evidence—rather than assuming
the newest run is best. Never replace the privileged conductor with a direct
release workflow dispatch.

npm trusted publishing validates the top-level caller of the reusable npm
workflow. Individual and combined operations use the `release.yml` top-level
caller with `release-shared` for every published npm package; the reusable
`release-channel.yml` is not that identity. Verify registry-side configuration
at the release boundary. The retired combined wrapper remains a historical
resume origin. An `ENEEDAUTH` cluster across otherwise-authorized publisher jobs is a
configuration failure to verify at that boundary, not a reason to add a
long-lived npm token.

TestFlight is a best-effort asynchronous projection. The native workflow owns
building/submitting the exact candidate; it then hands the exact EAS build id or
local IPA build identity to the existing `retry_testflight_distribution` action,
which runs from the current trusted control checkout. Do not keep the parent
release waiting for App Store processing, start a second iOS build to retry group
attachment, or run a new control flag from an older candidate checkout. Inspect
and rerun only the reconciliation action when Apple processing or group
attachment fails.

## Preserve issue availability evidence

Issue availability is a public release contract owned by `docs/issue-triage.md`. Snapshot only the earlier `stage:*` queues proved by the selected source topology before candidate binding, and advance that snapshot only after post-promotion verification:

- current `dev` nightly: source;
- `dev` -> `preview`: source/dev;
- `preview` -> `main`: preview;
- authorized direct `dev` -> `main`: source/dev.
- coordinated `dev` -> preview + main: snapshot source/dev once and advance it
  directly to stable only after both channel releases succeed.

A reconciliation failure does not roll back published artifacts, but remains a visible release-workflow failure. Retry only the idempotent label owner or leave issues at their prior stage for the next matching release. Never compensate by closing issues or claiming availability without release evidence.
