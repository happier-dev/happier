import type { ListSectionData } from '@happier-dev/plugin-ui';

import { CORPUS_LANE, CORPUS_LANES, type CorpusLaneV1 } from '../../corpus/fold/lane.js';
import type { TriageListRowV1 } from '../../projection/listWindow.js';
import type { TriagePinnedEntryV1 } from '../marks/pinCommand.js';
import {
  indexTriagePinsByEntry,
  projectTriagePinnedRow,
  projectTriageWindowRow,
  type TriageListDisplayRowV1,
} from '../marks/pinnedRows.js';
import { triageEntryRowKey } from '../window/entryDisplay.js';

/**
 * The section plan over the mounted window and the reader's durable pins.
 *
 * Sections are a grouping of the window's already-ordered rows, never a second
 * ordering: the window owner decided the order once, and this module only cuts
 * it into the canonical lanes. A row therefore never changes position because
 * it changed section.
 *
 * Pinned is the one section whose membership does not come from a pass. It is
 * ordered by the marks query — newest pin first — and a pinned entry is removed
 * from its lane rather than rendered in both places: one entry is one row, the
 * public `List` requires a unique key per row, and a reader who saw their pin
 * twice would reasonably believe they had pinned it twice.
 *
 * The plan is handed to the public `List`'s sectioned arm, which owns the
 * virtualizer, the flattened traversal order, the roving tab stop and the
 * pending-focus reveal (`core/SURFACE.md` §1.2, §4). Triage adds no section
 * list, no header cell and no navigation of its own — and `List` itself drops a
 * section that has no rows, so an empty lane leaves no labelled header behind.
 */

export type TriageListSectionV1 = ListSectionData<TriageListDisplayRowV1>;

/** The pinned group's stable section identity. It is not a lane. */
export const TRIAGE_PINNED_SECTION_KEY = 'pinned';

/**
 * Lane titles. `Open` and `Done` are the two canonical lanes; attention is a
 * per-row fact and deliberately not a third section, so a row never moves
 * between groups because a provider changed its mind about involvement.
 */
const LANE_TITLES: Readonly<Record<CorpusLaneV1, string>> = Object.freeze({
  [CORPUS_LANE.open]: 'Open',
  [CORPUS_LANE.done]: 'Done',
});

export function planTriageListSections(input: Readonly<{
  rows: readonly TriageListRowV1[];
  pins: readonly TriagePinnedEntryV1[];
}>): readonly TriageListSectionV1[] {
  const pinIndex = indexTriagePinsByEntry(input.pins);
  const projectedByKey = new Map<string, TriageListRowV1>();
  for (const row of input.rows) projectedByKey.set(triageEntryRowKey(row.entryRef), row);

  const pinnedRows = input.pins.map((pin) => projectTriagePinnedRow(
    pin,
    projectedByKey.get(triageEntryRowKey(pin.entryRef)) ?? null,
  ));

  const byLane = new Map<CorpusLaneV1, TriageListDisplayRowV1[]>();
  for (const lane of CORPUS_LANES) byLane.set(lane, []);
  for (const row of input.rows) {
    const display = projectTriageWindowRow(row, pinIndex);
    if (display.pinned) continue;
    byLane.get(row.lane)?.push(display);
  }

  return Object.freeze([
    Object.freeze({
      key: TRIAGE_PINNED_SECTION_KEY,
      title: 'Pinned',
      data: Object.freeze(pinnedRows),
    }),
    ...CORPUS_LANES.map((lane) => Object.freeze({
      key: lane,
      title: LANE_TITLES[lane],
      data: Object.freeze(byLane.get(lane) ?? []),
    })),
  ]);
}
