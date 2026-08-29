# Nightly recovery and work preservation

## Choose the cheapest safe recovery

| Evidence | Recovery | Why |
|---|---|---|
| Same workflow SHA; transient runner, download, read-only API, or external failure; failed job is safe to retry | Native failed-job rerun | Retains successful jobs and retries only failures/dependents |
| New workflow-control/test/validation fix; origin run is terminal; immutable candidates were individually verified; candidate/source bytes are unchanged | Dispatch nightly with `resume_run_id=<origin-run-id>` from corrected control | Reuses builds/signing while re-verifying identity and rerunning downstream gates |
| Product source, packaging inputs, build scripts, dependencies, signing inputs, or candidate bytes changed | Fresh nightly | Old artifacts no longer prove the new source |
| Ambiguous mutation failure | Reconcile observed remote state, then use the owning recovery-aware rerun | Blind retry could duplicate publication |
| Origin run is active or lacks its terminal status artifact | Wait | Resume trust requires completed evidence |

The current public nightly input is defined by `.github/workflows/nightly-dev.yml`. A typical authorized dispatch is:

```bash
gh workflow run nightly-dev.yml \
  --repo happier-dev/happier \
  --ref dev \
  -f source_ref=dev \
  -f resume_run_id=<completed-origin-run-id>
```

Do not dispatch merely because this command is documented. Follow `skills/happier-release`, confirm current authority, exact control SHA, origin run, and source identity first.

## Resume invariants

The resolver must prove the origin workflow/channel, terminal `happier-release-status` artifact, candidate source SHA, candidate version, and individual verification evidence. A resumed run still performs actor/source trust gates and exact artifact verification. Skipped build/sign jobs are expected reuse evidence.

A control-only fix may reuse candidates only when trusted current control bytes are separated from preserved candidate source. Never execute a new control flag using an old candidate checkout that cannot support it.

## Monitoring

- Use step-level status to distinguish queueing, installation, compilation, notarization, store processing, publication, and cleanup.
- Poll long operations every 5-20 minutes; avoid repeated 30-second reads.
- A GitHub API timeout while polling is not a workflow failure.
- Do not cancel native builds, notarization, store submission, or release mutation solely for unusual duration.
- Compare a suspected hang with the same step's successful baseline and job timeout. Obtain terminal logs before changing code when live logs are unavailable.
- Cancel a superseded run only when it cannot satisfy the outcome and blocks a corrected run; preserve candidate/status evidence required for resume.

## Terminal proof

Verify exact run SHA/attempt; immutable candidates and grouped verification; required validation suites; rolling promotions; requested desktop/mobile/Docker surfaces; promoted-reference verification; `happier-release-status` with complete required surfaces and terminal `published`; and immutable/rolling tags at the expected source SHA. Report a best-effort side-lane failure separately even when the workflow is terminal-green.
