# CI and test cleanup without weakening ship evidence

## Evidence-led cleanup targets

Consolidate or remove a test/check when current evidence shows it is a duplicate of the same observable owner contract; a non-security structural assertion over YAML/source ordering; wording/logging/formatting/incidental call-count policing; a suite-local mock duplicating a canonical testkit; an unreachable compatibility case; an aggregator that reruns work; or a timeout permutation without a distinct lifecycle.

Strengthen or relocate the canonical owner-level test before deleting overlapping coverage. Preserve one discriminating test for each real happy, failure, cancellation/recovery, compatibility, security, and platform contract selected by risk.

## Repeat-offender cleanup

If the same family escapes twice, stop patching individual assertions. Identify and extend the shared owner/harness, migrate overlapping local variants, add one test proving the shared harness reaches the deciding branch, and run a broader lane for state leakage or cleanup failures.

Mocks represent external boundaries, not internal policy. A fake protocol server must evolve with the methods it claims to implement. Prefer typed fixtures/builders and one boundary harness over repeated inline response objects.

## Timeout policy

Do not raise timeouts globally. Fix deterministic contract failures, deadlocks/leaked handles, resource isolation, or runner selection at their owner. Raise only the owning timeout when measured successful executions approach its limit, with a bounded ceiling. For external asynchronous services, use supported polling/recovery and preserve submitted work. Long duration requires progress evidence; it is not itself a timeout justification.

## Workflow simplification

- Keep one canonical command per lane and let local/manual/automatic workflows call it.
- Keep runner-pool selection as a reusable-workflow input rather than copying workflows for Blacksmith.
- Use matrices only for real platform/configuration differences.
- Keep result aggregators tiny and free of dependency installation.
- Cache only reproducible inputs; never let a cache own generated-output freshness.
- Do not retry release mutations unless idempotency or state reconciliation is proven.

Measure cleanup by fewer competing owners, fewer repeated fixtures, faster time to the first deciding failure, and fewer expensive full reruns—not raw test-count reduction.
