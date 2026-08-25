import { describe, expect, it, vi } from 'vitest';

import {
  testkitEntryRef,
  testkitLocator,
  testkitPresentOutcome,
  testkitSnapshot,
  testkitViewer,
} from '../../corpus/testkit/observations.test-support.js';
import {
  TRIAGE_LIST_DEFAULT_LENS_V1,
  foldTriageListWindow,
} from '../../projection/listWindow.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';
import { reobserveTriagePostMutationRow } from './postMutationReobservation.js';

const INSTANCE = '11111111-1111-4111-8111-111111111111';
const entryRef = testkitEntryRef();

describe('reobserveTriagePostMutationRow', () => {
  it('runs one target Action and gives detail and header the same folded observation', async () => {
    const before = foldTriageListWindow({
      observations: [{
        entryRef,
        sourceInstanceId: INSTANCE,
        observedAtMs: 1_000,
        outcome: testkitPresentOutcome({ snapshot: testkitSnapshot({ title: 'Before' }) }),
      }],
      lanes: [{
        sourceInstanceId: INSTANCE,
        source: entryRef.source,
        health: { kind: 'walkFinished' },
        exhausted: true,
      }],
      configuredSourcesStatus: 'complete',
      activeSourceInstanceIds: [INSTANCE],
      lens: { ...TRIAGE_LIST_DEFAULT_LENS_V1, limit: 1 },
      assembledAtMs: 1_000,
    }).rows[0];
    if (before === undefined) throw new Error('fixture row missing');
    const executeAction = vi.fn(async () => ({
      kind: 'observed' as const,
      entryRef,
      observation: {
        sourceInstanceId: INSTANCE,
        observedAtMs: 2_000,
        outcome: testkitPresentOutcome({
          locator: testkitLocator(),
          snapshot: testkitSnapshot({ title: 'After' }),
          viewer: testkitViewer(),
        }),
      },
    }));

    const after = await reobserveTriagePostMutationRow(
      { executeAction },
      before,
      [{
        sourceInstanceId: INSTANCE,
        source: entryRef.source,
        health: { kind: 'walkFinished' },
        exhausted: true,
      }],
      INSTANCE,
    );

    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(after?.content?.outcome.snapshot.title).toBe('After');
    const selected = readTriageSelectedObservationV1(after ?? before)?.observation;
    expect(selected?.snapshot).toBe(after?.content?.outcome.snapshot);
    expect(selected?.locator).toBe(after?.content?.outcome.locator);
  });
});
