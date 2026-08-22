import { describe, expect, it } from 'vitest';

import { CORPUS_LANE } from '../../corpus/fold/lane.js';
import type { ProjectedObservationV1 } from '../../corpus/fold/projectedObservation.js';
import type { TriageListRowV1 } from '../../projection/listWindow.js';
import {
  testkitLocator,
  testkitSnapshot,
  testkitViewer,
} from '../../corpus/testkit/observations.test-support.js';
import { projectTriageEntryDisplay } from './entryDisplay.js';

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

/**
 * The row's `content` is the fold's own decision, so a fixture that carried
 * observations without one would be a row no fold can produce. It defaults to
 * the first present observation this row carries.
 */
function contentOf(observations: readonly ProjectedObservationV1[]): TriageListRowV1['content'] {
  for (const observation of observations) {
    if (observation.outcome.kind !== 'present') continue;
    return {
      sourceInstanceId: observation.sourceInstanceId,
      observedAtMs: observation.observedAtMs,
      outcome: observation.outcome,
    };
  }
  return null;
}

function row(input: Partial<TriageListRowV1> = {}): TriageListRowV1 {
  const observations = input.observations
    ?? [present({ sourceInstanceId: INSTANCE_A, title: 'A title', observedAtMs: 1_000 })];
  return {
    entryRef: entryRef(),
    content: contentOf(observations),
    lane: CORPUS_LANE.open,
    sortAtMs: 1_000,
    presence: { kind: 'present', observedAtMs: 1_000 },
    attention: null,
    selected: { kind: 'selected', sourceInstanceId: INSTANCE_A, reason: 'onlyPresent' },
    ...input,
    observations,
  };
}

describe('projectTriageEntryDisplay', () => {
  it('shows the content observation the fold chose, never a winner of its own', () => {
    // Two connections observe the same entry with different titles, and the
    // mirror answered last. The fold decided once which observation speaks for
    // the row (`core/CORPUS.md` §3.2); re-deciding here is how a row's title
    // came to disagree with the lane the same row was filed under. The selected
    // connection is deliberately the other one: selection routes detail and
    // Actions (§3.6) and never re-decides content.
    const canonical = present({ sourceInstanceId: INSTANCE_A, title: 'Canonical copy', observedAtMs: 1_000 });
    const display = projectTriageEntryDisplay(row({
      selected: { kind: 'selected', sourceInstanceId: INSTANCE_B, reason: 'attention' },
      observations: [
        present({ sourceInstanceId: INSTANCE_B, title: 'Mirror copy', observedAtMs: 9_000 }),
        canonical,
      ],
      content: contentOf([canonical]),
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
      observations: [present({
        sourceInstanceId: INSTANCE_A,
        title: 'A title',
        observedAtMs: 1_000,
      })],
      attention: {
        level: 'required',
        fromSourceInstanceId: INSTANCE_A,
        reasonId: 'involvement/review-requested',
        reasonLabel: 'Your review was requested',
      },
    }));

    expect(display.detail).toBe('Your review was requested');
    expect(display.summary).toBeNull();
    expect(display.tone).toBe('neutral');
  });
});
