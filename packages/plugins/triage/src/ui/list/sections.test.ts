import { describe, expect, it } from 'vitest';

import { CORPUS_LANE } from '../../corpus/fold/lane.js';
import type { TriageListRowV1 } from '../../projection/listWindow.js';
import type { TriagePinnedEntryV1 } from '../marks/pinCommand.js';
import {
  TRIAGE_PINNED_SECTION_KEY,
  planTriageListSections,
  triageContinuationRowKey,
  type TriageListSectionV1,
} from './sections.js';

/** The entry rows of one section, in order. */
function entryIds(section: TriageListSectionV1 | undefined): readonly string[] {
  return (section?.data ?? [])
    .filter((item) => item.kind === 'entry')
    .map((item) => item.row.entryRef.entryId);
}

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
      coverage: 'complete',
      morePins: false,
    });

    expect(sections.map((section) => section.title)).toEqual(['Pinned', 'Open', 'Done']);
    expect(entryIds(sections[1])).toEqual(['3', '1']);
    expect(entryIds(sections[2])).toEqual(['9']);
  });

  it('keeps a stable section identity when a lane empties', () => {
    const sections = planTriageListSections({
      rows: [], pins: [], coverage: 'complete', morePins: false,
    });
    expect(sections.map((section) => section.key))
      .toEqual([TRIAGE_PINNED_SECTION_KEY, CORPUS_LANE.open, CORPUS_LANE.done]);
    expect(sections.every((section) => section.data.length === 0)).toBe(true);
  });

  it('lifts a pinned entry out of its lane instead of listing it twice', () => {
    const sections = planTriageListSections({
      rows: [row('3', CORPUS_LANE.open), row('9', CORPUS_LANE.done)],
      pins: [pin('3')],
      coverage: 'complete',
      morePins: false,
    });

    // One entry is one row. The public List requires a unique key per row, and
    // a reader who saw their pin twice would believe they pinned it twice.
    expect(entryIds(sections[0])).toEqual(['3']);
    expect(sections[1]?.data).toEqual([]);
    expect(entryIds(sections[2])).toEqual(['9']);
    const keys = sections.flatMap((section) => section.data.map((item) => item.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps a pinned entry the current window never walked', () => {
    const sections = planTriageListSections({
      rows: [row('9', CORPUS_LANE.done)],
      pins: [pin('404', 'A change this device has not read')],
      coverage: 'complete',
      morePins: false,
    });

    // A stale or cold list must not swallow durable intent: the pin is still
    // listed, still named, and still removable.
    expect(sections[0]?.data).toMatchObject([{
      kind: 'entry',
      row: {
        title: 'A change this device has not read',
        materialized: false,
        pinned: true,
      },
    }]);
  });

  it('ends an unfinished section with its labelled continuation row', () => {
    // `core/SURFACE.md` §4.2/§4.3. The public `List` has no `onEndReached` and
    // no per-section footer, so a section that is still walking states its own
    // limit as its last row. Rendering the loaded rows with nothing after them
    // would silently claim the section is complete, which is the exact wrong
    // fix this case rejects.
    const sections = planTriageListSections({
      rows: [row('3', CORPUS_LANE.open), row('9', CORPUS_LANE.done)],
      pins: [],
      coverage: 'partial',
      morePins: false,
    });

    for (const lane of [sections[1], sections[2]]) {
      const data = lane?.data ?? [];
      expect(data.at(-1)).toEqual({
        kind: 'continuation',
        key: triageContinuationRowKey(lane?.key ?? ''),
      });
      // It is the LAST row, not a header, a banner, or a row in the middle.
      expect(data.slice(0, -1).every((item) => item.kind === 'entry')).toBe(true);
    }
    // Every key is still unique across the whole List, continuation rows
    // included — the sectioned arm addresses one row by one key.
    const keys = sections.flatMap((section) => section.data.map((item) => item.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('drops the continuation row exactly when every applicable lane is exhausted', () => {
    const rows = [row('3', CORPUS_LANE.open), row('9', CORPUS_LANE.done)];

    const complete = planTriageListSections({
      rows, pins: [pin('3')], coverage: 'complete', morePins: false,
    });
    expect(complete.flatMap((section) => section.data).every((item) => item.kind === 'entry'))
      .toBe(true);

    // Pinned pages from the marks cursor, not from the window walk, so the two
    // continuation facts are independent. Blending them would tell a reader
    // their pins are incomplete because a source was still walking.
    const morePins = planTriageListSections({
      rows, pins: [pin('3')], coverage: 'complete', morePins: true,
    });
    expect(morePins[0]?.data.at(-1))
      .toEqual({ kind: 'continuation', key: triageContinuationRowKey(TRIAGE_PINNED_SECTION_KEY) });
    expect(morePins[1]?.data.every((item) => item.kind === 'entry')).toBe(true);
    expect(morePins[2]?.data.every((item) => item.kind === 'entry')).toBe(true);
  });

  it('leaves an empty section empty rather than making it a row of pure limit', () => {
    // With no rows there is nothing for a continuation row to come after, and
    // `List` drops the section outright — so a lone continuation row would be
    // a labelled group whose entire content is the statement that it has none.
    // The shell's coverage-aware empty state owns that case (§6.2).
    const sections = planTriageListSections({
      rows: [], pins: [], coverage: 'partial', morePins: true,
    });
    expect(sections.every((section) => section.data.length === 0)).toBe(true);
  });

  it('orders the pinned section by the marks query rather than the window', () => {
    const sections = planTriageListSections({
      rows: [row('1', CORPUS_LANE.open), row('2', CORPUS_LANE.open)],
      // The marks index already returns newest pin first; re-ranking here would
      // make one entry's position depend on which pass happened to run.
      pins: [pin('2'), pin('1')],
      coverage: 'complete',
      morePins: false,
    });

    expect(entryIds(sections[0])).toEqual(['2', '1']);
  });
});
