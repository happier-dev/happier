---
name: happier-release
description: Route general Happier release preparation through the maintainer-owned release authority.
---

# Happier Release

General release preparation, approval, dispatch, publication, recovery, and
status authority belongs to `hmaint`, not to a repository-local skill.

Start from the absolute repository checkout path and request its machine-readable
bootstrap contract:

```bash
hmaint release bootstrap --repo <absolute checkout> --json
```

`hmaint` is an access-controlled maintainer-tool installation, not a public npm
fallback. If the configured wrapper is unavailable, stop and obtain the approved
`@happier-dev/maintainer-cli` installation. Verify that exact wrapper's `--help`
exposes `release bootstrap`, then rerun the command above through it. Do not copy
private runbooks or recreate their shell workflow in this repository.

Use that response to choose the supported release profile and follow the
maintainer-owned approval/dispatch flow. Do not treat this skill as permission
to publish, deploy, migrate, wait for a fleet, or orchestrate a cutover.

The `v0.3` control ref is admitted by workflow code but cannot publish yet.
Before enabling publication, the release owner must first add a `v0.3` branch
ruleset matching `dev`, then add `v0.3` to the `release-shared` environment's
deployment branch policy. Preserve that order so an unprotected control ref
never gains access to the release environment.

## Run authority where the credentials live

Establish the execution host (`uname -s`, `pwd -P`) and absolute source path
before invoking the conductor. A repository under a VM-mounted path does not
prove that the agent process itself is running inside Linux.

- On the configured macOS host, invoke
  `/Users/leeroy/Documents/Development/happier/maintainers-tools/bin/hmaint`
  directly and prove that exact wrapper with
  `/Users/leeroy/Documents/Development/happier/maintainers-tools/bin/hmaint --help`.
  Do not resolve a different copy from `PATH`, invoke the internal JavaScript
  entry point, or install a second conductor. This placement lets it use
  Keychain and native release prerequisites.
- From the managed Linux VM, keep source work in the authoritative VM checkout
  and first enter the configured 0.3 checkout that owns
  `./apps/stack/bin/hstack-exec --target=mac-host -- <command> ...`; invoking it
  while still in 0.2 fails its repository boundary. The launcher's working
  directory is separate from `hmaint --repo`, which names an independently
  verified target Git root and may be 0.2. The existing synchronized source
  mirror can supply that root without a separately maintained Mac product
  checkout. Planning is credential-free; the Mac authority submits the public
  plan's complete `hostedDispatch` transport. See [the execution
  example](../../../docs/release-process.md#public-release-contract-and-approval-boundary).
  If the launcher, configured Mac target, exact Mac wrapper, or target checkout
  cannot be proved, fail closed. Never copy signing or GitHub credentials into
  the VM or substitute a VM-local conductor.
- Use `yarn ghops auth status` as the safe credential-path probe; it must not
  print the token. Do not replace a failed broker/Keychain path with a personal
  `gh` login.

Resolve real paths, repository roots, current SHAs, and dirty state before
porting or releasing. Similarly named host and VM checkouts are not evidence
that they share the same repository.

## Reuse evidence and completed work

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

Development source CI now selects schtasks self-host E2E, packaged CLI build/runtime
smoke on every native target, and unsigned Android/iOS native compilation by owned
paths and nightly in `tests.yml`. Keep these source checks before publication;
release signing and distribution still need their real candidates. A scheduled
workflow must be present on the repository default branch to activate.

Source CI proves an exact SHA once. Release preflight validates only the
operation-specific inputs and consumes explicit exact-SHA CI evidence; it must
not repeat unit, integration, typecheck, or E2E lanes. Artifact identity,
signature/install checks, update continuity, store submission, and promoted
references remain downstream because their real signed candidate must exist.

For source suites, reuse only the shared source validator’s exact-SHA/profile/policy result from the existing CI summary; do not relabel generic CI success. Missing proof runs the selected policy once at source validation, while standalone publishers retain their source-contract fallback. Source Binary Smoke currently supplies preview proof only; production smoke and signed-artifact verification remain required.

For failures, apply `.agents/skills/happier-ci-stabilize/SKILL.md` and choose
the cheapest safe recovery: native failed-job rerun for a safe transient on the
same SHA, verified immutable-candidate resume after a control/test-only fix, or
a fresh candidate when source, packaging, dependencies, signing inputs, or
candidate bytes changed. Reconcile ambiguous publication state before retrying
a mutation. Use one monitor and poll long builds, notarization, store work, and
publication every 5-20 minutes.

For a same-control transient failure, use
`gh run rerun <run-id> --repo happier-dev/happier --failed`. For a
control/test-only correction, wait for a terminal origin and use the exact
`hmaint release resume` command and confirmation token returned by the private
conductor. Prefer the completed origin with the richest verified candidate and
downstream evidence; the newest run is not necessarily the best recovery
origin. Never replace the conductor with a direct dispatch of the privileged
release workflow.

npm trusted publishing validates the top-level caller of a reusable publisher.
On this release line every published package therefore trusts `release.yml` in
the `release-shared` environment. Do not name a second caller unless that
workflow exists and invokes the same canonical publisher. A cluster of
`ENEEDAUTH` publisher failures is configuration evidence to check at that
boundary, not justification for a long-lived npm token.

TestFlight is a best-effort asynchronous projection. The native workflow owns
building/submitting the exact candidate; it then hands the exact EAS build id or
local IPA build identity to the existing `retry_testflight_distribution` action,
which runs from the current trusted control checkout. Do not keep the parent
release waiting for App Store processing, start a second iOS build to retry group
attachment, or run a new control flag from an older candidate checkout. Inspect
and rerun only the reconciliation action when Apple processing or group
attachment fails.

Before any release-note/version commit, the private conductor must inspect the
complete proposed release diff once and use the target-owned
`release-analyze` command to derive changed compatibility seams and the
risk-selected evidence plan. Semantic compatibility adjudication, affected
source/contract checks, notes, and version recommendations belong to that same
pre-materialization pass. After commit/push, confirm only that the analyzed
source is unchanged apart from approved materialization and run exact-artifact
evidence; do not repeat the semantic review unless an unexpected contract
change entered.

Heavy checks are required only when their named seam changed. Skip unrelated
heavy scenarios automatically and record the reason. Ask the maintainer only
about optional/borderline additional certification; `deep` remains explicit
and manual.

Approve source, notes, versions, compatibility, selected profile and ordinary
publication scope once. That grant covers unchanged materialization and dispatch;
do not request a second approval after the approved inputs are committed.
For an approved packet, use `hmaint release run --repo <absolute checkout>
--packet <absolute JSON path>`. The public owner materializes canonical notes
and exact versions and commits only approved paths. The private conductor owns
the authenticated push, waits for the final child's exact-SHA canonical CI,
then admits once and dispatches. The CI selector owns metadata-only reuse;
never substitute the ancestor's run for the child's run. Existing prepared
operations use `--operation-id <id>` instead of `--packet`.
Materialization refuses production packets sourced from `preview`; use an
existing prepared operation to promote the already validated preview candidate.
Unexpected source or scope changes need a refreshed decision. The explicit
irreversible V4/reset decisions remain separate. A combined operation publishes
both channels concurrently and does not establish preview soak.

Consume the final child's exact-SHA CI. The automatic selector may reuse a
successful non-metadata ancestor for content-proven notes/version fields while
keeping child projections and artifact builds. Missing baseline proof or changes
to dependencies, scripts, native content, runtime versions or generated inputs
retain ordinary source gates. A metadata child is not a new full-source baseline.

For curated Happier StoryDeck and release-note content only, use
`.agents/skills/happier-release-notes`; it remains a repository-specific content skill.
For manual-only deep certification, use
`.agents/skills/happier-release-validation`; it never dispatches a release.

Issue availability is a public release contract owned by `docs/issue-triage.md`. Normal nightly, preview, and stable workflows snapshot only the earlier `stage:*` queues proven by the selected source topology before candidate binding, then advance those snapshots only after their existing post-promotion verifier succeeds: current `dev` nightly uses source, `dev` → `preview` uses source/dev, `preview` → `main` uses preview, and direct `dev` → `main` uses source/dev. This handles an authorized lower-channel bypass without attributing later dev corrections to an older preview candidate. A reconciliation failure does not roll back already published artifacts, but it is a visible release-workflow failure: inspect/retry the idempotent label job or leave the issues at their prior stage for the next matching release. Never compensate by closing issues or claiming a channel shipped without release evidence.
