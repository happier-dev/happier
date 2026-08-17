import { describe, expect, it } from 'vitest';

import { CORPUS_LANE } from '../../corpus/fold/lane.js';
import type { TriageListRowV1 } from '../../projection/listWindow.js';
import type { TriagePinnedEntryV1 } from '../marks/pinCommand.js';
import { TRIAGE_PINNED_SECTION_KEY, planTriageListSections } from './sections.js';

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;

function row(entryId: string, lane: TriageListRowV1['lane']): TriageListRowV1 {
  return {
    entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'origin', entryId },
    lane,
    sortAtMs: 0,
    presence: { kind: 'unresolved', observedAtMs: null },
    attention: null,
    selected: { kind: 'none', reason: 'noPresentObservation' },
    observations: [],
  };
}

function pin(entryId: string, title = `Pinned ${entryId}`): TriagePinnedEntryV1 {
  return {
    entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'origin', entryId },
    markedAtMs: 1_000,
    displayAtMark: { title, scopeLabel: 'origin' },
  };
}

describe('planTriageListSections', () => {
  it('cuts the window order into lanes without reordering it', () => {
    // The window owner ordered these once. A section plan that re-sorted would
    // move a row under the reader for no reason they could see.
    const sections = planTriageListSections({
      rows: [row('3', CORPUS_LANE.open), row('9', CORPUS_LANE.done), row('1', CORPUS_LANE.open)],
      pins: [],
    });

    expect(sections.map((section) => section.title)).toEqual(['Pinned', 'Open', 'Done']);
    expect(sections[1]?.data.map((entry) => entry.entryRef.entryId)).toEqual(['3', '1']);
    expect(sections[2]?.data.map((entry) => entry.entryRef.entryId)).toEqual(['9']);
  });

  it('keeps a stable section identity when a lane empties', () => {
    const sections = planTriageListSections({ rows: [], pins: [] });
    expect(sections.map((section) => section.key))
      .toEqual([TRIAGE_PINNED_SECTION_KEY, CORPUS_LANE.open, CORPUS_LANE.done]);
    expect(sections.every((section) => section.data.length === 0)).toBe(true);
  });

  it('lifts a pinned entry out of its lane instead of listing it twice', () => {
    const sections = planTriageListSections({
      rows: [row('3', CORPUS_LANE.open), row('9', CORPUS_LANE.done)],
      pins: [pin('3')],
    });

    // One entry is one row. The public List requires a unique key per row, and
    // a reader who saw their pin twice would believe they pinned it twice.
    expect(sections[0]?.data.map((entry) => entry.entryRef.entryId)).toEqual(['3']);
    expect(sections[1]?.data).toEqual([]);
    expect(sections[2]?.data.map((entry) => entry.entryRef.entryId)).toEqual(['9']);
    const keys = sections.flatMap((section) => section.data.map((entry) => entry.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps a pinned entry the current window never walked', () => {
    const sections = planTriageListSections({
      rows: [row('9', CORPUS_LANE.done)],
      pins: [pin('404', 'A change this device has not read')],
    });

    // A stale or cold list must not swallow durable intent: the pin is still
    // listed, still named, and still removable.
    expect(sections[0]?.data).toMatchObject([{
      title: 'A change this device has not read',
      materialized: false,
      pinned: true,
    }]);
  });

  it('orders the pinned section by the marks query rather than the window', () => {
    const sections = planTriageListSections({
      rows: [row('1', CORPUS_LANE.open), row('2', CORPUS_LANE.open)],
      // The marks index already returns newest pin first; re-ranking here would
      // make one entry's position depend on which pass happened to run.
      pins: [pin('2'), pin('1')],
    });

    expect(sections[0]?.data.map((entry) => entry.entryRef.entryId)).toEqual(['2', '1']);
  });
});
