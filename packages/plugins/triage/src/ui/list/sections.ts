import type { TriageEntryLocatorV1, TriageSourceWorkflowSubjectV1 } from '@happier-dev/triage-protocol/v1';

import { CORPUS_LANE } from '../../corpus/fold/lane.js';
import { triageEntryRowKey, type TriageListRowV1 } from '../../projection/listWindow.js';
import type { TriagePinnedEntryV1 } from '../marks/pinCommand.js';
import {
  indexTriagePinsByEntry,
  projectTriagePinnedRow,
  projectTriageWindowRow,
  type TriageListDisplayRowV1,
  type TriageListRowProjectionOptionsV1,
} from '../marks/pinnedRows.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';

/**
 * The PRs & Issues rows and their ONE grouping axis (PLAN.md r0.41): **Needs you / With an agent / In review /
 * Everything else**, decided from facts the window already carries, never from a provider id.
 *
 * The axis is handed to the Collection model as `groups`, which cuts the window's already-ordered rows into
 * groups; it is never a second ordering, so an entry never moves within its group because it changed group.
 *
 * **Pinned leads the axis.** A pin is the reader's own durable intent and has no fact to be grouped by (a pin
 * this mount never walked has no observation at all), so pinned entries are one group ahead of the four, and a
 * pinned entry is lifted out of its fact group rather than listed twice: one entry is one row, and a reader who
 * saw their pin twice would believe they had pinned it twice.
 */
export const TRIAGE_LIST_GROUPS_V1 = Object.freeze([
  'pinned',
  'needsYou',
  'withAgent',
  'inReview',
  'everythingElse',
] as const);
export type TriageListGroupIdV1 = (typeof TRIAGE_LIST_GROUPS_V1)[number];

/** A source-labelled status fact the source marked primary: the table's signal column, source-neutral. */
export type TriageListRowSignalV1 = Readonly<{
  label: string;
  tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
}>;

/** One Collection item: the display row, the group it is filed under, and what its peek and signal show. */
export type TriageListItemV1 = Readonly<{
  key: string;
  row: TriageListDisplayRowV1;
  group: TriageListGroupIdV1;
  /** The source's bounded summary, for the peek. */
  summary: string | null;
  signal: TriageListRowSignalV1 | null;
  /** The canonical selected connection's locator; absent for unread or unavailable entries. */
  locator?: TriageEntryLocatorV1 | null;
}>;

/**
 * Who acts next, from the facts on the row:
 * - **Needs you**: an open entry with a required-attention reason (review requested, assigned, a source's own ask);
 * - **With an agent**: a linked session is working on it;
 * - **In review**: a pull request you opened that nothing asks of you, so it waits on someone else;
 * - **Everything else**: the rest, including every finished entry.
 */
export function readTriageListGroupV1(input: Readonly<{
  row: TriageListRowV1;
  workflowSubject: TriageSourceWorkflowSubjectV1 | null;
  agentActive: boolean;
}>): Exclude<TriageListGroupIdV1, 'pinned'> {
  const open = input.row.lane === CORPUS_LANE.open;
  if (open && input.row.attention?.level === 'required') return 'needsYou';
  if (open && input.agentActive) return 'withAgent';
  const involvement = input.row.content?.outcome.viewer.involvement ?? [];
  if (open && input.workflowSubject === 'pullRequest' && involvement.includes('author')) return 'inReview';
  return 'everythingElse';
}

function readSignal(row: TriageListRowV1 | null): TriageListRowSignalV1 | null {
  for (const fact of row?.content?.outcome.snapshot.facts ?? []) {
    if (fact.importance === 'primary' && fact.value.kind === 'status') {
      return { label: fact.value.value, tone: fact.value.tone };
    }
  }
  return null;
}

export function planTriageListItemsV1(input: Readonly<{
  rows: readonly TriageListRowV1[];
  pins: readonly TriagePinnedEntryV1[];
  /** The admitted source contribution's workflow subject for this kind, or `null` when none was declared. */
  workflowSubjectOf: (entryRef: TriageListRowV1['entryRef']) => TriageSourceWorkflowSubjectV1 | null;
  /**
   * Whether a linked Session's canonical host Work status is working. The shell
   * supplies its single mounted relationship/Session-fact join, shared by every row.
   */
  agentActive?: (key: string) => boolean;
  /** How the rows say the words this plugin authors, and whether the window they came from is current. */
  display?: TriageListRowProjectionOptionsV1;
}>): readonly TriageListItemV1[] {
  const pinIndex = indexTriagePinsByEntry(input.pins);
  const projectedByKey = new Map<string, TriageListRowV1>();
  for (const row of input.rows) projectedByKey.set(triageEntryRowKey(row.entryRef), row);

  const items: TriageListItemV1[] = input.pins.map((pin) => {
    const projected = projectedByKey.get(triageEntryRowKey(pin.entryRef)) ?? null;
    const row = projectTriagePinnedRow(pin, projected, input.display);
    return Object.freeze({
      key: row.key,
      row,
      group: 'pinned' as const,
      summary: projected?.content?.outcome.snapshot.summary ?? null,
      signal: readSignal(projected),
      locator: projected === null ? null : readTriageSelectedObservationV1(projected)?.observation.locator ?? null,
    });
  });
  for (const windowRow of input.rows) {
    const row = projectTriageWindowRow(windowRow, pinIndex, input.display);
    if (row.pinned) continue;
    items.push(Object.freeze({
      key: row.key,
      row,
      group: readTriageListGroupV1({
        row: windowRow,
        workflowSubject: input.workflowSubjectOf(windowRow.entryRef),
        agentActive: input.agentActive?.(row.key) === true,
      }),
      summary: windowRow.content?.outcome.snapshot.summary ?? null,
      signal: readSignal(windowRow),
      locator: readTriageSelectedObservationV1(windowRow)?.observation.locator ?? null,
    }));
  }
  return Object.freeze(items);
}
