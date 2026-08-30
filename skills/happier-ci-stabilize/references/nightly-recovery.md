# Nightly recovery and work preservation

## Choose the cheapest safe recovery

| Evidence | Recovery | Why |
|---|---|---|
| Same workflow SHA; transient runner, download, read-only API, or external failure; failed job is safe to retry | Native failed-job rerun | Retains successful jobs and retries only failures/dependents |
| New workflow-control/test/validation fix; origin run is terminal; immutable candidates were individually verified; candidate/source bytes are unchanged | Dispatch nightly with `resume_run_id=<origin-run-id>` from the corrected control SHA | Reuses expensive builds/signing while re-verifying identity and rerunning downstream gates |
| Product source, packaging inputs, build scripts, dependencies, signing inputs, or candidate bytes changed | Fresh nightly | Old artifacts no longer prove the new source |
| Ambiguous mutation failure (for example HTTP failure after release PATCH/upload) | Reconcile observed remote state, then use the owning recovery-aware rerun | Blind retry could duplicate or overwrite publication |
| Origin run is still active or lacks its terminal status artifact | Wait | Resume trust intentionally requires completed evidence |

For 0.2 nightly, the public workflow input is defined by `.github/workflows/nightly-dev.yml`. A typical authorized dispatch is:

```bash
gh workflow run nightly-dev.yml \
  --repo happier-dev/happier \
  --ref dev \
  -f source_ref=dev \
  -f resume_run_id=<completed-origin-run-id>
```

Do not dispatch merely because this command is documented. Confirm current repository instructions, release authority, exact control SHA, origin run, and source identity first.

## Resume invariants

The resolver must prove the origin workflow/channel, terminal `happier-release-status` artifact, candidate source SHA, candidate version, and individual verification evidence. A resumed run still performs actor/source trust gates and exact artifact verification. Skipped build/sign jobs are expected evidence of reuse, not missing coverage.

A control-only fix may change workflow/test code while reusing immutable candidates only when the workflow explicitly separates trusted current control bytes from the preserved candidate source. Never execute a new control flag using an old candidate checkout that cannot support it.

## Monitoring

- Use step-level status to distinguish queueing, dependency installation, compilation, notarization, store processing, publication, and cleanup.
- Poll long operations every 5-20 minutes. Avoid repeated 30-second reads.
- A GitHub API timeout while polling is a monitoring failure, not a workflow failure.
- Do not cancel notarization, native builds, store submission, or a release mutation solely because duration is unusual.
- Compare a suspected hang with the same step's successful baseline and configured job timeout. Obtain terminal logs before changing code when live logs are unavailable.
- Cancel a superseded run only when it is already unable to satisfy the requested outcome and it blocks a corrected run; preserve useful candidate/status evidence required for resume.

## Terminal proof

For a nightly, verify all applicable evidence:

- exact run SHA and attempt;
- immutable versions for CLI, HStack, server, and UI web;
- grouped immutable-candidate verifier;
- required release-validation suites;
- rolling promotions;
- desktop/mobile/Docker jobs requested by the profile;
- `Verify promoted nightly references`;
- `happier-release-status` with complete/success/verified required surfaces and terminal `published`;
- immutable and rolling tags resolving to the expected source SHA.

Report best-effort side-lane failure separately even when the workflow is terminal-green.
