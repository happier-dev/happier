# Complete and efficient failure collection

## Collect one exact attempt

After the workflow attempt is terminal:

```bash
node skills/happier-ci-stabilize/scripts/collect-actions-failures.mjs \
  --repo happier-dev/happier \
  --run-id <run-id>
```

For a specific rerun attempt, add `--attempt <attempt-number>`. Use `--out <absolute-directory>` only for another temporary location.

The collector writes under `/tmp` by default:

- `summary.json`: exact run identity, all job conclusions, failed steps, and compact excerpts;
- `jobs/<job-id>.log`: complete log for every failed, cancelled, timed-out, or action-required job.

Do not write diagnostic logs into the repository. If `collectionComplete` is false, treat the output as a progress snapshot, not the complete failure set. Wait for independent jobs with a 5-20 minute cadence unless a named stop condition applies.

## Read compactly without losing evidence

1. Start from `summary.json`, not raw run-level output.
2. Remove aggregator-only failures from the causal count while retaining them in the inventory.
3. Group identical stack origins, failed commands, error codes, and stale generated-output messages.
4. Open the full retained log only for each distinct causal cluster.
5. Record the earliest causal error in a job; teardown and aggregate exit-code messages are usually propagation.

GitHub annotations are useful indexes but can omit child-process stderr, collapse repeated failures, or show only one test. The full job log remains deciding evidence. When a workflow uploads a richer failure artifact, inspect it only when the log does not decide the cause; avoid downloading unexpectedly huge artifacts before checking metadata.

## Compare with the last known green basis

For deterministic failures, compare the failing SHA with the most recent green SHA and identify changes in the failing production owner, canonical tests/testkit, shared fixtures/generators, lane inputs and runner image, action versions, environment, and external dependencies or published artifacts.

A previous green run on a different SHA proves the old basis, not the new commit set. Conversely, passing sibling jobs on the failing SHA narrow the affected corridor and should be preserved as evidence.

## Do not serially rediscover downstream errors

Before another full run, reproduce every collected deterministic cluster locally where feasible, run all corrected focused suites together, run every affected package/lane locally or through a focused manual workflow, inspect skipped downstream jobs for unavoidable versus unnecessary coupling, and preflight release configuration/generated outputs that do not require publication credentials.

One run cannot expose a job whose real input artifact was never produced. Use immutable-candidate resume after fixing control/validation bytes so downstream validation can execute without rebuilding already verified products.
