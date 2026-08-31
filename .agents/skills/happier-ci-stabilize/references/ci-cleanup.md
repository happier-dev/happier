# CI and test cleanup without weakening ship evidence

## Evidence-led cleanup targets

Consolidate or remove a test/check when current evidence shows it is one of:

- a duplicate of the same observable contract at the same boundary;
- a structural assertion over YAML/source ordering that does not protect a security or operational invariant;
- wording, logging, formatting, incidental call-count, or constant-value policing with no public contract;
- a suite-local mock that duplicates a canonical testkit boundary;
- an obsolete compatibility case with no released producer/consumer or reachable migration direction;
- an aggregator that reruns work instead of aggregating prior outcomes;
- a timeout permutation that does not exercise a materially different lifecycle.

Strengthen or relocate the canonical owner-level test before deleting overlapping coverage. Preserve one discriminating test for each real happy, failure, cancellation/recovery, compatibility, security, and platform contract selected by risk.

## Repeat-offender cleanup

If the same family escapes twice:

1. stop patching individual assertions;
2. identify the shared owner or harness that allowed drift;
3. extend/consolidate that owner;
4. migrate overlapping local variants;
5. add one test proving the shared harness reaches the deciding branch;
6. run a broader lane that can expose state leakage or cleanup failures.

Mocks represent external boundaries, not internal policy. A fake protocol server must evolve with the protocol methods it claims to implement. Prefer typed fixtures/builders and one boundary harness over repeated inline response objects.

## Timeout policy

Do not raise timeouts globally. First classify:

- deterministic assertion/configuration failure: fix the contract;
- deadlock/leaked handle: fix lifecycle ownership;
- resource exhaustion or runner stall: fix resource isolation or runner selection;
- legitimate measured operation near the limit: raise only the owning timeout with a success-runtime baseline and bounded ceiling;
- external asynchronous service: use the service's supported polling/recovery semantics and preserve its existing submitted work.

A larger timeout is valid only when the operation is making observable progress or measured successful executions need the budget. It is not a substitute for progress evidence.

## Workflow simplification

- Keep one canonical command per lane and let local/manual/automatic workflows call it.
- Keep runner-pool selection as an input to the reusable workflow rather than copying workflows for Blacksmith.
- Use matrices only for real platform/configuration differences.
- Keep result aggregators tiny and free of dependency installation.
- Cache only reproducible inputs; never let a cache become the authority for generated-output freshness.
- Do not add retries around release mutations unless the operation is proven idempotent or state reconciliation precedes retry.

Measure cleanup by fewer competing owners, fewer repeated fixtures, faster time to the first deciding failure, and fewer expensive full reruns—not by raw test-count reduction.
