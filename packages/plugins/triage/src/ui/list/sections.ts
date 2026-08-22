import type { ListSectionData } from '@happier-dev/plugin-ui';

import { CORPUS_LANE, CORPUS_LANES, type CorpusLaneV1 } from '../../corpus/fold/lane.js';
import {
  triageEntryRowKey,
  type TriageListRowV1,
  type TriageListWindowV1,
} from '../../projection/listWindow.js';
import type { TriagePinnedEntryV1 } from '../marks/pinCommand.js';
import {
  indexTriagePinsByEntry,
  projectTriagePinnedRow,
  projectTriageWindowRow,
  type TriageListDisplayRowV1,
} from '../marks/pinnedRows.js';

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
 *
 * **A section that is not finished says so as its own last row**
 * (`core/SURFACE.md` §4.2). The public `List` publishes no `onEndReached` and
 * no per-section footer, and that turns out to be the better shape for this
 * product: an invisible scroll trigger *implies* a limit, while a labelled row
 * states it, is reachable by the same roving keys as every other row, and is
 * announced. A section that is genuinely exhausted simply has no such row, so
 * its absence is the honest claim of completeness rather than a silence.
 */

/**
 * One item in a section: an entry, or the section's own statement that it is
 * not finished.
 *
 * A continuation row is deliberately NOT a `TriageListDisplayRowV1` with empty
 * fields. It has no canonical entry reference, so it can be neither selected,
 * pinned, focused as an entry, nor addressed by the reducer's visible order,
 * and a shape that let it pretend otherwise would put a row with no identity
 * into every one of those owners.
 */
export type TriageListSectionItemV1 =
  | Readonly<{ kind: 'entry'; key: string; row: TriageListDisplayRowV1 }>
  | Readonly<{ kind: 'continuation'; key: string }>;

export type TriageListSectionV1 = ListSectionData<TriageListSectionItemV1>;

/** The one continuation-row key per section; unique across the whole `List`. */
export function triageContinuationRowKey(sectionKey: string): string {
  return `continuation:${sectionKey}`;
}

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

/**
 * Close one section's item list, appending its continuation row when the
 * section is not finished.
 *
 * Only a section that already has rows gets one: the row means "there is more
 * after these", so with nothing to come after, `List` drops the whole empty
 * section and the shell's own coverage-aware empty state is what tells the
 * reader the walk is unfinished (`core/SURFACE.md` §6.2).
 */
function closeSection(
  key: string,
  rows: readonly TriageListDisplayRowV1[],
  unfinished: boolean,
): readonly TriageListSectionItemV1[] {
  const items: TriageListSectionItemV1[] = rows.map(
    (row) => Object.freeze({ kind: 'entry' as const, key: row.key, row }),
  );
  if (unfinished && items.length > 0) {
    items.push(Object.freeze({ kind: 'continuation' as const, key: triageContinuationRowKey(key) }));
  }
  return Object.freeze(items);
}

export function planTriageListSections(input: Readonly<{
  rows: readonly TriageListRowV1[];
  pins: readonly TriagePinnedEntryV1[];
  /**
   * The window's own coverage claim (`projection/listWindow.ts`), which is
   * `complete` exactly when every applicable lane reported exhaustion and the
   * row bound did not truncate. It is read rather than re-derived from the
   * lanes so that one owner decides what "finished" means.
   */
  coverage: TriageListWindowV1['coverage'];
  /** Whether the bounded marks page left pins it did not carry. */
  morePins: boolean;
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

  // Pinned pages from the marks cursor and every other section pages this
  // window, so the two carry different continuation facts rather than one
  // blended "there might be more".
  return Object.freeze([
    Object.freeze({
      key: TRIAGE_PINNED_SECTION_KEY,
      title: 'Pinned',
      data: closeSection(TRIAGE_PINNED_SECTION_KEY, pinnedRows, input.morePins),
    }),
    ...CORPUS_LANES.map((lane) => Object.freeze({
      key: lane,
      title: LANE_TITLES[lane],
      data: closeSection(lane, byLane.get(lane) ?? [], input.coverage === 'partial'),
    })),
  ]);
}
