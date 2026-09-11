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

`hmaint` is an access-controlled maintainer tool, not a public npm fallback. On
the configured macOS authority, invoke
`/Users/leeroy/Documents/Development/happier/maintainers-tools/bin/hmaint`
directly and prove that exact wrapper with
`/Users/leeroy/Documents/Development/happier/maintainers-tools/bin/hmaint --help`.
From the managed Linux VM, use an existing configured 0.3 checkout and invoke
its launcher from the intended repository-relative working directory:

```bash
cd <absolute-0.3-checkout>
./apps/stack/bin/hstack-exec --target=mac-host -- \
  /Users/leeroy/Documents/Development/happier/maintainers-tools/bin/hmaint \
  release bootstrap --repo <absolute-macOS-checkout> --json
```

The launcher projects the invocation directory remotely and has no
launcher-level `--cwd` option. If the launcher, configured `mac-host` target,
canonical Mac wrapper, or Mac-visible target checkout cannot be proved, fail
closed. Do not resolve another copy from `PATH`, copy private runbooks, install
a second conductor, fall back to a VM-local conductor or personal GitHub login,
or recreate the release workflow in this repository.

Use that response to choose the supported release profile and follow the
maintainer-owned approval/dispatch flow. Do not treat this skill as permission
to publish, deploy, migrate, wait for a fleet, or orchestrate a cutover.

When one approved `dev` source must ship to preview and production, use the
conductor's `preview-and-production` target. It reuses one exact-SHA CI,
release-note, and approval packet, and runs the union of source-only MySQL,
platform-service, and trust-root checks once while the canonical channel
workflow runs both channels concurrently. Each channel still builds and verifies its own
artifacts because preview and production embed different policy environments;
the fast path removes duplicate orchestration and operator waiting, not those
channel-specific bytes.

Channel combination does not combine product targets. `website` and `docs` are
independent entries in the target-owned release target set: either may be
selected without the other, and each retains its own plan, job, status surface,
and recovery evidence in both single-channel and combined operations.

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

For curated Happier StoryDeck and release-note content only, use
`skills/happier-release-notes`; it remains a repository-specific content skill.
For manual-only deep certification, use
`skills/happier-release-validation`; it never dispatches a release.

## Recover through one owner

Choose recovery from evidence rather than restarting the whole graph:

- Use `gh run rerun <run-id> --repo happier-dev/happier --failed` for a
  same-control-SHA transient runner, download, read-only API, or safely
  recoverable external failure.
- After a workflow-control, test, or validation-only fix, wait for the origin
  run to become terminal and use the exact `hmaint release resume` command and
  confirmation returned by the private conductor. Select the richest valid
  origin—the completed run with the most individually verified candidates and
  downstream evidence—not merely the newest run.
- Prepare fresh release outputs when source, package/build dependencies,
  signing inputs, or immutable candidate bytes changed.
- For an ambiguous publication mutation, inspect canonical remote state and
  invoke the owning recovery-aware job. Never blind-retry the mutation.

The terminal release-status artifact is the single resume authority. In
addition to verified immutable candidates, a new control run may preserve
exact-source successful rolling projections, deployments, Docker publication,
and npm publication recorded there. The current workflow still rechecks the
external release/deployment references before declaring success. UI delivery is
reusable only when its recorded web, Expo, and desktop intent exactly matches
the new request. Public SDK npm publication reruns unless the status evidence
can reconstruct and verify the exact package versions; generic npm success is
not enough. Do not add a second recovery manifest or infer success from skipped
jobs.

Allow independent jobs to finish so a single attempt exposes every reachable
failure. A consumer that requires a signed candidate or external publication
cannot run before that prerequisite exists, so no DAG can expose literally all
later failures at time zero. Keep non-dependent validation fail-fast disabled,
reuse exact-SHA source CI, and run independent candidate checks concurrently.
Use one foreground monitor bound to one run/attempt, poll long builds,
notarization, store processing, and publication every 5–20 minutes, and treat
step-level progress plus the owning timeout—not duration alone—as evidence.

For corrected non-secret Linux checks, use the existing
`tests-dispatch.yml` workflow with `runner_pool=github`; it selects the canonical
test graph instead of copying it. Blacksmith is an explicitly approved,
budget-checked accelerator only. It has no automatic fallback and must not be
selected while included credits are exhausted.

npm trusted publishing validates the top-level caller of a reusable workflow.
Every published package must trust both `release.yml` and
`release-preview-and-production.yml` in the `release-shared` environment.
`ENEEDAUTH` across otherwise authorized jobs is a configuration failure at
that boundary, not justification for a long-lived npm token fallback.

TestFlight is a best-effort asynchronous projection. The native workflow owns
building/submitting the exact candidate, then hands its exact EAS build id or
local IPA identity to the existing `retry_testflight_distribution` action from
the current trusted control checkout. Retry only reconciliation after Apple
processing or group attachment fails; do not rebuild the IPA, hold the parent
release open for store processing, or execute new control flags from an older
candidate checkout.

Issue availability is a public release contract owned by `docs/issue-triage.md`. Normal nightly, preview, and stable workflows snapshot only the earlier `stage:*` queues proven by the selected source topology before candidate binding, then advance those snapshots only after their existing post-promotion verifier succeeds: current `dev` nightly uses source, `dev` → `preview` uses source/dev, `preview` → `main` uses preview, direct `dev` → `main` uses source/dev, and coordinated `dev` → preview + main snapshots source/dev once and advances it directly to stable only after both channel releases succeed. This handles an authorized lower-channel bypass without attributing later dev corrections to an older preview candidate. A reconciliation failure does not roll back already published artifacts, but it is a visible release-workflow failure: inspect/retry the idempotent label job or leave the issues at their prior stage for the next matching release. Never compensate by closing issues or claiming a channel shipped without release evidence.
