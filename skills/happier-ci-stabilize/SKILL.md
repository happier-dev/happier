---
name: happier-ci-stabilize
description: Stabilize failing, flaky, slow, or repeatedly rerun Happier CI and nightlies by collecting all reachable failures from one exact attempt, correcting canonical causes in one batch, simplifying low-value coverage, and choosing the cheapest safe rerun or candidate-resume path.
---

# Happier CI Stabilization

Reach an evidence-backed terminal result with the fewest expensive reruns. This skill owns failure collection, failure clustering, CI cleanup, monitoring, and recovery selection. It does not grant release authority or replace `skills/happier-testing`.

## Use the existing owners

- Apply `skills/happier-testing/SKILL.md` before changing tests, fixtures, mocks, testkits, timeouts, or lane selection.
- Apply `skills/happier-implement/SKILL.md` to repository corrections. Behavior changes require owner-level RED -> GREEN evidence.
- Resolve publication authority through `skills/happier-release/SKILL.md`; this skill never invents mutation authority.
- After a coherent validated 0.2 batch, apply `skills/happier-port-0-2-to-0-3/SKILL.md` once for the batch.

Read [failure-collection.md](references/failure-collection.md) for a failing run, [ci-cleanup.md](references/ci-cleanup.md) before simplifying CI/tests, and [nightly-recovery.md](references/nightly-recovery.md) before rerunning or resuming a release.

## One stabilization loop

1. **Bind the attempt.** Record repository, workflow, run ID, attempt, event, head SHA, branch, and status. Never diagnose “latest” after a branch moves.
2. **Collect once.** Let independent safe jobs reach terminal state. Then run `scripts/collect-actions-failures.mjs`; retain complete failed-job logs under `/tmp` and use its compact summary. Stop early only for an unsafe mutation, conflicting publisher, or proven wedge blocking a corrected run.
3. **Cluster causes.** Collapse aggregators and repeated symptoms into the earliest causal signature and canonical owner. Classify each cluster as product, test, harness/mock, release control/configuration, external contract, infrastructure/resource, or inconclusive. A timeout is only a symptom.
4. **Correct one batch.** Reproduce every deterministic cluster that can be exercised locally. For each behavior change, prove the smallest meaningful RED, fix the canonical owner, and remove or update only coverage invalidated by that cause. Run all focused fixes together, then each affected lane.
5. **Run canonical CI once.** Use the exact coherent SHA. The manual Blacksmith runner-pool input may accelerate approved non-secret Linux lanes; it selects a backend for the same reusable workflow and must not create a copied CI graph.
6. **Recover the cheapest safe way.** Choose a native failed-job rerun, immutable-candidate resume, or fresh release using [nightly-recovery.md](references/nightly-recovery.md). Preserve successful sibling candidates when their source and packaging identity remain valid.
7. **Use one foreground monitor.** Keep exactly one poller bound to the run and attempt. Poll long setup, suites, builds, signing, notarization, store submission, and publication every 5-20 minutes. Long duration alone is not failure evidence.
8. **Close from terminal evidence.** Require canonical CI success for the exact SHA. For a nightly, also inspect the terminal status artifact, immutable identities, required validation, promoted-reference verification, and requested side lanes. A green top-level badge alone is insufficient.

## Keep source CI and release admission separate

- Source CI proves code correctness once for an exact SHA and emits or identifies explicit exact-SHA evidence.
- Release preflight cheaply proves that the already-tested SHA can be released with the requested channel, versions, notes, protocol, tools, credentials, and platform configuration.
- A nightly consumes the explicit successful `ci_run_id`/attestation after verifying its repository, workflow, event, branch, status, and exact SHA. It does not rerun full source CI.
- If explicit evidence is unavailable, use only the repository's canonical unattended lookup; do not create another scanner or occupy a release runner watching CI.

## Expose every reachable failure

- Independent test jobs should not depend on unrelated test jobs.
- Independent checks inside one job may use `continue-on-error` only when a final `if: always()` aggregator fails the job if any required check failed.
- Diagnostic artifact upload and terminal status projection should use `if: always()` where safe.
- Publication, promotion, signing, destructive mutation, and security/trust gates remain fail-closed and must not continue merely to collect more errors.
- A collector exposes all **reachable** failures. A downstream job gated on a missing candidate cannot be meaningfully tested until that prerequisite exists; do not label this unavoidable dependency as hidden CI failure.

Move cheap deterministic contracts, workflow parsing, generated-output checks, and configuration preflights before expensive work. Preflight calls the canonical owner or inspects its output; it does not duplicate source CI or production decisions.

## Stop conditions

Stop and report rather than retry when:

- the origin run is still active and resume validation requires a terminal status artifact;
- source or candidate bytes changed but the proposed recovery would reuse old artifacts;
- a release mutation returned an ambiguous failure and current external state has not been reconciled;
- expected behavior is a product decision rather than an observable current contract;
- logs are unavailable and the remaining evidence cannot distinguish product, test, harness, or infrastructure failure.

## Handoff

Report:

- exact run/attempt/SHA and whether collection was complete;
- every root-cause cluster and its classification;
- focused RED/GREEN evidence and broader lanes actually run;
- tests, mocks, timeouts, or workflow gates consolidated/removed and why coverage did not weaken;
- recovery mechanism used and what work it preserved;
- terminal CI/release evidence and residual risk.
