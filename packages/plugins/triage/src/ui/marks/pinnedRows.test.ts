import { describe, expect, it } from 'vitest';

import type { TriageListRowV1 } from '../../projection/listWindow.js';
import { CORPUS_LANE } from '../../corpus/fold/lane.js';
import {
  testkitObservation,
  testkitPresentOutcome,
  testkitSnapshot,
} from '../../corpus/testkit/observations.test-support.js';
import { triageEntryRowKey } from '../window/entryDisplay.js';
import type { TriagePinnedEntryV1 } from './pinCommand.js';
import { indexTriagePinsByEntry, projectTriagePinnedRow, projectTriageWindowRow } from './pinnedRows.js';

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });

function windowRow(overrides: Partial<TriageListRowV1> = {}): TriageListRowV1 {
  return {
    entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' },
    lane: CORPUS_LANE.open,
    sortAtMs: 0,
    presence: { kind: 'present', observedAtMs: 1_000 },
    attention: null,
    selected: { kind: 'selected', sourceInstanceId: '11111111-1111-4111-8111-111111111111', reason: 'onlyPresent' },
    observations: [testkitObservation({
      outcome: testkitPresentOutcome({
        snapshot: testkitSnapshot({ title: 'Replace the duplicated normalizer' }),
      }),
    })],
    ...overrides,
  };
}

function pin(overrides: Partial<TriagePinnedEntryV1> = {}): TriagePinnedEntryV1 {
  return {
    entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' },
    markedAtMs: 1_760_000_900_000,
    displayAtMark: { title: 'Replace the duplicated normalizer', scopeLabel: 'example/repository' },
    ...overrides,
  };
}

describe('the pinned-row overlay', () => {
  it('renders a pinned entry from the fresher projection the caller already holds', () => {
    const row = windowRow({
      observations: [testkitObservation({
        outcome: testkitPresentOutcome({
          snapshot: testkitSnapshot({ title: 'Replace the duplicated normalizer (renamed upstream)' }),
        }),
      })],
    });

    const projected = projectTriagePinnedRow(pin(), row);

    // The mark's own display is a floor, never a ceiling: a pin that kept
    // showing a stale title would read as a broken list, not as durable intent.
    expect(projected.title).toBe('Replace the duplicated normalizer (renamed upstream)');
    expect(projected).toMatchObject({ pinned: true, materialized: true });
  });

  it('keeps a pinned entry the projection never materialized, named from its own mark', () => {
    const projected = projectTriagePinnedRow(pin({
      displayAtMark: { title: 'A change this device has not read', scopeLabel: 'example/other' },
    }), null);

    // Dropping it would leave the user unable to even remove the pin, and it
    // would silently lose intent no provider can hand back.
    expect(projected).toMatchObject({
      title: 'A change this device has not read',
      scopeLabel: 'example/other',
      detail: 'Not yet synchronized',
      pinned: true,
      materialized: false,
    });
  });

  it('matches a pin to its projection only on the exact canonical reference', () => {
    // `example/repositoryX` + `7` and `example/repository` + `X7` are two
    // contract-valid entries. An overlay keyed on a joined string would treat
    // them as one and put the wrong entry under the reader's pin.
    const index = indexTriagePinsByEntry([
      pin({ entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repositoryX', entryId: '7' } }),
    ]);
    const other = windowRow({
      entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: 'X7' },
    });

    expect(index.has(triageEntryRowKey(other.entryRef))).toBe(false);
    expect(projectTriageWindowRow(other, index).pinned).toBe(false);
  });

  it('distinguishes one entry observed under two kinds', () => {
    const index = indexTriagePinsByEntry([pin()]);
    const sameIdOtherKind = windowRow({
      entryRef: { source: SOURCE, kindId: 'issue', collisionScope: 'example/repository', entryId: '17' },
    });

    expect(projectTriageWindowRow(sameIdOtherKind, index).pinned).toBe(false);
    expect(projectTriageWindowRow(windowRow(), index).pinned).toBe(true);
  });
});
