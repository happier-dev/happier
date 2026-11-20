import { describe, expect, it } from 'vitest';
import {
  testkitObservation,
  testkitPresentOutcome,
  testkitSnapshot,
} from '../corpus/testkit/observations.test-support.js';
import { retainTriageObservation } from './listWindowReconciliation.js';

const REVISION = {
  baseSha: 'base-sha',
  headSha: 'head-sha',
  nativeRevision: 'head-sha',
};
const BRANCHES = { head: 'feature', base: 'main' };

function exactRead(sourceUpdatedAtMs: number) {
  return testkitObservation({
    observedAtMs: 1_000,
    outcome: testkitPresentOutcome({
      sourceUpdatedAtMs,
      snapshot: testkitSnapshot({
        reviewRevision: REVISION,
        branches: BRANCHES,
      }),
    }),
  });
}

function scanAnswer(sourceUpdatedAtMs: number) {
  return testkitObservation({
    observedAtMs: 2_000,
    outcome: testkitPresentOutcome({ sourceUpdatedAtMs }),
  });
}

function snapshotOf(observation: ReturnType<typeof testkitObservation>) {
  if (observation.outcome.kind !== 'present')
    throw new Error('expected a present observation');
  return observation.outcome.snapshot;
}

describe('retainTriageObservation', () => {
  // A list scan that lands after the detail's exact read must not erase the head the
  // detail's head-pinned writes (Start review, Update branch) are built from (QB-50, READY244).
  it('keeps the exact read head and branches when a later scan of the unchanged entry omits them', () => {
    const retained = retainTriageObservation(
      exactRead(5_000),
      scanAnswer(5_000),
    );
    expect(retained.observedAtMs).toBe(2_000);
    expect(snapshotOf(retained).reviewRevision).toEqual(REVISION);
    expect(snapshotOf(retained).branches).toEqual(BRANCHES);
  });

  it('drops the earlier head once the source reports a newer change', () => {
    const retained = retainTriageObservation(
      exactRead(5_000),
      scanAnswer(6_000),
    );
    expect(snapshotOf(retained).reviewRevision).toBeUndefined();
    expect(snapshotOf(retained).branches).toBeUndefined();
  });
});
