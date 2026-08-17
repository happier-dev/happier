import { describe, expect, it } from 'vitest';

import { CORPUS_LANE } from '../../corpus/fold/lane.js';
import type { ProjectedObservationV1 } from '../../corpus/fold/projectedObservation.js';
import type { TriageListRowV1 } from '../../projection/listWindow.js';
import {
  testkitLocator,
  testkitSnapshot,
  testkitViewer,
} from '../../corpus/testkit/observations.test-support.js';
import { projectTriageEntryDisplay, triageEntryRowKey } from './entryDisplay.js';

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';

function entryRef(input: Readonly<{ entryId?: string; collisionScope?: string }> = {}) {
  return {
    source: SOURCE,
    kindId: 'pull-request',
    collisionScope: input.collisionScope ?? 'origin',
    entryId: input.entryId ?? '42',
  } as const;
}

function present(input: Readonly<{
  sourceInstanceId: string;
  title: string;
  observedAtMs: number;
  scopeLabel?: string;
}>): ProjectedObservationV1 {
  return {
    sourceInstanceId: input.sourceInstanceId,
    observedAtMs: input.observedAtMs,
    outcome: {
      kind: 'present',
      locator: testkitLocator(),
      snapshot: testkitSnapshot({
        title: input.title,
        ...(input.scopeLabel === undefined ? {} : { scopeLabel: input.scopeLabel }),
      }),
      viewer: testkitViewer(),
    },
  };
}

function row(input: Partial<TriageListRowV1> = {}): TriageListRowV1 {
  return {
    entryRef: entryRef(),
    lane: CORPUS_LANE.open,
    sortAtMs: 1_000,
    presence: { kind: 'present', observedAtMs: 1_000 },
    attention: null,
    selected: { kind: 'selected', sourceInstanceId: INSTANCE_A, reason: 'onlyPresent' },
    observations: [present({ sourceInstanceId: INSTANCE_A, title: 'A title', observedAtMs: 1_000 })],
    ...input,
  };
}

describe('projectTriageEntryDisplay', () => {
  it('shows the connection the window selected, not whichever answered last', () => {
    // Two connections observe the same entry with different titles. The row's
    // own selection decides which one the reader sees, so the list and the
    // picker cannot disagree about what this entry is called.
    const display = projectTriageEntryDisplay(row({
      selected: { kind: 'selected', sourceInstanceId: INSTANCE_A, reason: 'attention' },
      observations: [
        present({ sourceInstanceId: INSTANCE_B, title: 'Mirror copy', observedAtMs: 9_000 }),
        present({ sourceInstanceId: INSTANCE_A, title: 'Canonical copy', observedAtMs: 1_000 }),
      ],
    }));

    expect(display.title).toBe('Canonical copy');
  });

  it('still names an entry whose every observing connection has retired', () => {
    const display = projectTriageEntryDisplay(row({
      selected: { kind: 'none', reason: 'allInstancesRetired' },
      observations: [present({
        sourceInstanceId: INSTANCE_B,
        title: 'Retired but real',
        observedAtMs: 5_000,
      })],
    }));

    expect(display.title).toBe('Retired but real');
  });

  it('says why a row cannot be shown instead of quietly losing it', () => {
    const absent = projectTriageEntryDisplay(row({
      presence: { kind: 'absent', observedAtMs: 2_000 },
      selected: { kind: 'none', reason: 'noPresentObservation' },
      observations: [{
        sourceInstanceId: INSTANCE_A,
        observedAtMs: 2_000,
        outcome: { kind: 'absent' },
      }],
    }));

    expect(absent.detail).toBe('No longer reported by the source');
    expect(absent.tone).toBe('danger');
    // With no present observation anywhere, the canonical reference is the only
    // true thing left to show.
    expect(absent.title).toBe('42');
  });

  it('does not advertise attention over an entry the source no longer reports', () => {
    const display = projectTriageEntryDisplay(row({
      presence: { kind: 'unresolved', observedAtMs: 2_000 },
      attention: {
        level: 'required',
        fromSourceInstanceId: INSTANCE_A,
        reasonId: 'involvement/review-requested',
        reasonLabel: 'Your review was requested',
      },
    }));

    expect(display.detail).toBe('Could not be read in the last pass');
  });

  it('shows the attention reason on a present row', () => {
    const display = projectTriageEntryDisplay(row({
      attention: {
        level: 'required',
        fromSourceInstanceId: INSTANCE_A,
        reasonId: 'involvement/review-requested',
        reasonLabel: 'Your review was requested',
      },
    }));

    expect(display.detail).toBe('Your review was requested');
    expect(display.tone).toBe('neutral');
  });
});

describe('triageEntryRowKey', () => {
  it('separates two contract-valid entries a delimiter join would merge', () => {
    // `U+001F` is representable inside `collisionScope`, so a joined key would
    // give these two distinct entries one row — and put focus and selection on
    // an entry the reader never chose.
    const left = triageEntryRowKey(entryRef({ collisionScope: 'originregion', entryId: '42' }));
    const right = triageEntryRowKey(entryRef({ collisionScope: 'origin', entryId: '42' }));

    expect(left).not.toBe(right);
  });
});
