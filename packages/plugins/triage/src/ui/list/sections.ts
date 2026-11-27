import type { PluginTranslate } from '@happier-dev/plugin-ui';
import type { TodoReadinessV1 } from '@happier-dev/plugin-sdk/protocol';
import { readTriageTaskDueV1 } from './taskDue.js';
import type { TriageEntryLocatorV1, TriageEntryRelationsV1, TriageEntryStateV1, TriageSourceWorkflowSubjectV1, TriageTaskCapabilitiesV1,
  TriageTaskTransitionRequiredFieldV1 } from '@happier-dev/triage-protocol/v1';
import { projectTriageDetailFieldsV1, projectTriageDetailFieldTextV1, triageTaskStatusCategoryV1 } from '@happier-dev/triage-protocol/v1';

import { CORPUS_LANE } from '../../corpus/fold/lane.js';
import { createTriageListLensMatcherV1, triageEntryRowKey, triageTaskCompletionMatchesWindowV1,
  type TriageListLensV1, type TriageListRowV1 } from '../../projection/listWindow.js';
import type { TriagePinnedEntryV1 } from '../marks/pinCommand.js';
import {
  indexTriagePinsByEntry,
  projectTriagePinnedRow,
  projectTriageWindowRow,
  type TriageListDisplayRowV1,
  type TriageListRowProjectionOptionsV1,
} from '../marks/pinnedRows.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';
import { readTriageEntryAgentStatusV1, type TriageAgentStateV1, type TriageAgentStatusV1 } from '../detail/agentState.js';
import { isPersonalTaskReferenceV1 } from '../../internalTasks/identity.js';
import { TRIAGE_PR_VIEW_INVENTORY_V1 } from './viewInventory.js';

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
  // The Tasks lens's bands, in the order a person works them: In progress, To do, Backlog, then Done and Canceled.
  'started', 'unstarted', 'backlog', 'completed', 'canceled',
  'everythingElse',
] as const);
export type TriageListGroupIdV1 = (typeof TRIAGE_LIST_GROUPS_V1)[number];

/** The source's status, impact count or supplementary text: the table's source-neutral Signal cell. */
export type TriageListRowSignalV1 = Readonly<{
  label: string;
  tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
}>;

/** One Collection item: the display row, the group it is filed under, and what its peek and signal show. */
export type TriageListItemV1 = Readonly<{
  key: string;
  row: TriageListDisplayRowV1;
  group: TriageListGroupIdV1;
  /**
   * The group its facts file it in, never `pinned`: the same as `group` for an unpinned entry. A view with no Pinned
   * group (the board, owner ruling 2026-10-31) places a pinned entry here and marks the pin on the entry itself.
   */
  statusGroup: Exclude<TriageListGroupIdV1, 'pinned'>;
  /** The source's bounded summary, for the peek. */
  summary: string | null;
  signal: TriageListRowSignalV1 | null;
  /** What the entry's linked agent is doing, from its linked Sessions' live states (the Agent column). */
  agent: TriageAgentStatusV1 | null;
  /** The canonical selected connection's locator; absent for unread or unavailable entries. */
  locator?: TriageEntryLocatorV1 | null;
  /** On the Tasks lens: the task's shared status category, the source's own status word and its live relations. */
  task?: TriageListTaskFactsV1 | null;
}>;

/** A task row's status and relation facts, read from the source's live snapshot (never stored by Happier). */
export type TriageListTaskFactsV1 = Readonly<{
  category: ReturnType<typeof triageTaskStatusCategoryV1>;
  /** The source's own word ("In Review", "Open"); `null` when the source names none. */
  statusLabel: string | null;
  /** Null is source-confirmed unassigned; omission is unknown. */
  assigneeLabel?: string | null;
  /** The source says the reader is an assignee, so the owner reads as You rather than the reader's own handle. */
  assignedToViewer?: true;
  relations: TriageEntryRelationsV1 | null;
  readiness?: TodoReadinessV1;
  /** Source facts only; an omitted timestamp is unknown. */
  dueDate?: string;
  completedAtMs?: number;
  /** Names an offered completed transition; activation uses the existing transition role. */
  completingTransitionId?: string;
  /** The selected connection's offered workflow (the row's status menu), each with the category it moves to. */
  transitions?: readonly Readonly<{ id: string; label: string; category: TriageListTaskFactsV1['category'];
    state?: TriageEntryStateV1; requiredFields?: readonly TriageTaskTransitionRequiredFieldV1[] }>[];
}>;

/** A retained blocker's short name; an entry outside the displayed lens stays unnamed. */
export function readTriageTaskBlockerNameV1(item: TriageListItemV1 | undefined): string | null {
  return item === undefined ? null : item.row.designation ?? item.row.title;
}

function readTaskFacts(row: TriageListRowV1 | null, declared?: TriageTaskCapabilitiesV1): TriageListTaskFactsV1 | null {
  const snapshot = row?.content?.outcome.snapshot;
  if (snapshot === undefined) return null;
  // Display content may come from a different connection. A write affordance
  // uses only the exact selected connection's workflow, as the detail does.
  const selected = row === null ? null : readTriageSelectedObservationV1(row);
  const capabilities = selected === null ? undefined : selected.observation.snapshot.taskCapabilities ?? declared;
  const completing = capabilities?.transitions?.find(transition => transition.id === capabilities.completingTransitionId
    && triageTaskStatusCategoryV1(transition.state) === 'completed');
  return Object.freeze({
    category: triageTaskStatusCategoryV1(snapshot.state),
    statusLabel: snapshot.state.nativeLabel ?? null,
    ...(snapshot.assigneeLabel === undefined ? {} : { assigneeLabel: snapshot.assigneeLabel }),
    ...(row?.content?.outcome.viewer.involvement.includes('assignee') === true ? { assignedToViewer: true as const } : {}),
    relations: snapshot.relations ?? null,
    ...(snapshot.taskReadiness === undefined ? {} : { readiness: snapshot.taskReadiness }),
    ...(snapshot.dueDate === undefined ? {} : { dueDate: snapshot.dueDate }),
    ...(snapshot.completedAtMs === undefined ? {} : { completedAtMs: snapshot.completedAtMs }),
    ...(completing === undefined ? {} : { completingTransitionId: completing.id }),
    ...(capabilities?.transitions === undefined || capabilities.transitions.length === 0 ? {} : {
      transitions: capabilities.transitions.map((transition) => Object.freeze({
        id: transition.id, label: transition.label, category: triageTaskStatusCategoryV1(transition.state), state: transition.state,
        ...(transition.requiredFields === undefined ? {} : { requiredFields: transition.requiredFields }),
      })),
    }),
  });
}

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

const NO_AGENT_STATES: readonly TriageAgentStateV1[] = Object.freeze([]);

function readSignal(row: TriageListRowV1 | null, locale: string): TriageListRowSignalV1 | null {
  const facts = row?.content?.outcome.snapshot.facts ?? [];
  for (const fact of facts) {
    if (fact.importance === 'primary' && fact.value.kind === 'status') {
      return { label: fact.value.value, tone: fact.value.tone };
    }
  }
  // Identity text (entry number, repository) already has its own columns. Source-declared impact and
  // supplementary text (such as labels) carry the remaining useful signal without parsing source ids.
  const fields = projectTriageDetailFieldsV1(facts);
  const impact = fields.find((field) => field.importance === 'primary' && field.kind === 'number');
  if (impact?.kind === 'number') {
    const value = projectTriageDetailFieldTextV1(impact, locale, 0);
    const label = facts.find((fact) => fact.id === impact.id)?.label;
    return { label: label === undefined ? value! : `${value} ${label}`, tone: 'neutral' };
  }
  const text = fields.find((field) => field.importance === 'supplementary' && field.kind === 'text');
  if (text?.kind === 'text') return { label: text.value, tone: 'neutral' };
  return null;
}

export function planTriageListItemsV1(input: Readonly<{
  rows: readonly TriageListRowV1[];
  pins: readonly TriagePinnedEntryV1[];
  /**
   * Retained rows and exact detail reads outside the active window supply a pin's known facts for filtering and
   * display. They never join the window's own groups. A window row for the same entry wins.
   */
  readRows?: readonly TriageListRowV1[];
  lens?: Pick<TriageListLensV1, 'query' | 'filters' | 'sort'>;
  locale?: string;
  /** The admitted source contribution's workflow subject for this kind, or `null` when none was declared. */
  workflowSubjectOf: (entryRef: TriageListRowV1['entryRef']) => TriageSourceWorkflowSubjectV1 | null;
  /**
   * The live states of the Sessions linked to a row, by row key. The shell supplies its single mounted
   * relationship/Session-fact join, shared by every row; both the "With an agent" group and the Agent
   * column are read from it, so they cannot disagree about one entry.
   */
  agentStatesOf?: (key: string) => readonly TriageAgentStateV1[];
  /** How the rows say the words this plugin authors, and whether the window they came from is current. */
  display?: TriageListRowProjectionOptionsV1;
  tasks?: Readonly<{
    audience: 'mine' | 'agents' | 'everyone';
    /** Home's urgency order; the full page retains its own status bands and manual order. */
    urgency?: Readonly<{ nowMs: number; locale: string; text: PluginTranslate }>;
    isTask: (entryRef: TriageListRowV1['entryRef']) => boolean;
    hasSessions: (key: string) => boolean;
    capabilitiesOf?: (entryRef: TriageListRowV1['entryRef']) => TriageTaskCapabilitiesV1 | undefined;
    /** Caller supplies its calendar boundary. Unknown completion times cannot claim membership. */
    completedSinceMs?: number;
    /** A read of tasks.internal.list; this projection never persists order. */
    personalOrder?: readonly string[];
    personalAccountId?: string;
  }>;
}>, previous: readonly TriageListItemV1[] = []): readonly TriageListItemV1[] {
  const pinIndex = indexTriagePinsByEntry(input.pins);
  const matchesLens = input.lens === undefined ? undefined : createTriageListLensMatcherV1(input.lens);
  const agentStatesOf = (key: string) => input.agentStatesOf?.(key) ?? NO_AGENT_STATES;
  const projectedByKey = new Map<string, TriageListRowV1>();
  for (const row of input.readRows ?? []) projectedByKey.set(triageEntryRowKey(row.entryRef), row);
  for (const row of input.rows) projectedByKey.set(triageEntryRowKey(row.entryRef), row);

  const included = (ref: TriageListRowV1['entryRef'], row: TriageListRowV1 | null): boolean => {
    // Personal Account tasks belong to the Tasks view. The neutral corpus
    // stays shared with the picker; both pinned and listed page rows use this
    // one view-membership decision.
    if (input.tasks === undefined) return TRIAGE_PR_VIEW_INVENTORY_V1.includesKind(ref);
    if (!input.tasks.isTask(ref)) return false;
    const snapshot = row?.content?.outcome.snapshot;
    if (snapshot !== undefined && !triageTaskCompletionMatchesWindowV1(snapshot, input.tasks.completedSinceMs)) return false;
    if (input.tasks.audience === 'everyone') return true;
    if (input.tasks.audience === 'agents') return input.tasks.hasSessions(triageEntryRowKey(ref));
    return row?.observations.some((observation) => observation.outcome.kind === 'present'
      && observation.outcome.viewer.involvement.some(role => role === 'assignee' || role === 'author')) ?? false;
  };
  const statusGroupOf = (row: TriageListRowV1, key: string): Exclude<TriageListGroupIdV1, 'pinned'> => (input.tasks !== undefined
    ? (row.content === null ? null : triageTaskStatusCategoryV1(row.content.outcome.snapshot.state)) ?? 'everythingElse'
    : readTriageListGroupV1({
      row,
      workflowSubject: input.workflowSubjectOf(row.entryRef),
      agentActive: agentStatesOf(key).some((state) => state.workStatus.bucket === 'working'),
    }));
  const items: TriageListItemV1[] = input.pins.filter((pin) => {
    const projected = projectedByKey.get(triageEntryRowKey(pin.entryRef)) ?? null;
    return included(pin.entryRef, projected) && (matchesLens?.(projected ?? pin) ?? true);
  }).map((pin) => {
    const projected = projectedByKey.get(triageEntryRowKey(pin.entryRef)) ?? null;
    const row = projectTriagePinnedRow(pin, projected, input.display);
    return Object.freeze({
      key: row.key,
      row,
      group: 'pinned' as const,
      // A pin the window never walked has no facts to file it by.
      statusGroup: projected === null ? 'everythingElse' : statusGroupOf(projected, row.key),
      summary: projected?.content?.outcome.snapshot.summary ?? null,
      signal: readSignal(projected, input.locale ?? 'en'),
      agent: readTriageEntryAgentStatusV1(agentStatesOf(row.key)),
      locator: projected === null ? null : readTriageSelectedObservationV1(projected)?.observation.locator ?? null,
      ...(input.tasks === undefined ? {} : { task: readTaskFacts(projected, input.tasks.capabilitiesOf?.(pin.entryRef)) }),
    });
  });
  for (const windowRow of input.rows) {
    if (!included(windowRow.entryRef, windowRow)) continue;
    const row = projectTriageWindowRow(windowRow, pinIndex, input.display);
    if (row.pinned) continue;
    const statusGroup = statusGroupOf(windowRow, row.key);
    items.push(Object.freeze({
      key: row.key,
      row,
      group: statusGroup,
      statusGroup,
      summary: windowRow.content?.outcome.snapshot.summary ?? null,
      signal: readSignal(windowRow, input.locale ?? 'en'),
      agent: readTriageEntryAgentStatusV1(agentStatesOf(row.key)),
      locator: readTriageSelectedObservationV1(windowRow)?.observation.locator ?? null,
      ...(input.tasks === undefined ? {} : { task: readTaskFacts(windowRow, input.tasks.capabilitiesOf?.(windowRow.entryRef)) }),
    }));
  }
  if (input.lens?.sort === undefined && input.tasks?.personalOrder !== undefined) {
    const rank = new Map(input.tasks.personalOrder.map((id, index) => [id, index]));
    const groups = new Map<TriageListGroupIdV1, { slots: number[]; items: TriageListItemV1[] }>();
    for (const [index, item] of items.entries()) {
      if (!isPersonalTaskReferenceV1(item.row.entryRef, input.tasks.personalAccountId) || !rank.has(item.row.entryRef.entryId)) continue;
      const group = groups.get(item.group) ?? { slots: [], items: [] };
      group.slots.push(index); group.items.push(item); groups.set(item.group, group);
    }
    for (const group of groups.values()) {
      group.items.sort((left, right) => rank.get(left.row.entryRef.entryId)! - rank.get(right.row.entryRef.entryId)!);
      group.slots.forEach((slot, index) => { items[slot] = group.items[index]!; });
    }
  }
  if (input.tasks?.urgency !== undefined) {
    const { nowMs, locale, text } = input.tasks.urgency;
    const ranks = new Map(items.map(item => {
      const due = item.task == null ? null : readTriageTaskDueV1(item.task.dueDate, item.task.category, locale, nowMs, text);
      const needsYou = agentStatesOf(item.key).some(state => state.workStatus.bucket === 'needs_you');
      return [item.key, needsYou ? 0 : due?.tone === 'danger' ? 1 : due?.tone === 'warning' ? 2
        : item.task?.category === 'started' ? 3 : 4] as const;
    }));
    items.sort((left, right) => ranks.get(left.key)! - ranks.get(right.key)!);
  }
  // A Session transition changes its own item/group, not every unchanged
  // display row. Retain only the preceding projection; no history is kept.
  const previousByKey = new Map(previous.map((item) => [item.key, item]));
  const retained = items.map((item) => {
    const prior = previousByKey.get(item.key);
    if (prior === undefined) return item;
    const rowKeys = Object.keys(item.row) as (keyof TriageListDisplayRowV1)[];
    const row = rowKeys.length === Object.keys(prior.row).length
      && rowKeys.every((key) => item.row[key] === prior.row[key])
      ? prior.row : item.row;
    if (row === prior.row && item.group === prior.group && item.statusGroup === prior.statusGroup && item.summary === prior.summary
      && item.locator === prior.locator
      && JSON.stringify(item.task) === JSON.stringify(prior.task)
      && JSON.stringify(item.signal) === JSON.stringify(prior.signal)
      && JSON.stringify(item.agent) === JSON.stringify(prior.agent)) return prior;
    return row === item.row ? item : Object.freeze({ ...item, row });
  });
  return retained.length === previous.length && retained.every((item, index) => item === previous[index])
    ? previous : Object.freeze(retained);
}

/**
 * The suggestion a whole group shares: when every entry of a group (two or more) is there for the same suggested
 * reason ("Mentioned"), the group says it once and its rows leave the chip out. A group with any other reason, a
 * required one, or none keeps the reasons on its rows, where they tell entries apart.
 */
export function readTriageSharedGroupReasonsV1(
  items: readonly TriageListItemV1[],
): ReadonlyMap<TriageListGroupIdV1, string> {
  const byGroup = new Map<TriageListGroupIdV1, { label: string | null; count: number }>();
  for (const item of items) {
    const label = item.row.detailKind === 'suggestion' ? item.row.detail : null;
    const seen = byGroup.get(item.group);
    if (seen === undefined) byGroup.set(item.group, { label, count: 1 });
    else byGroup.set(item.group, { label: seen.label === label ? label : null, count: seen.count + 1 });
  }
  const shared = new Map<TriageListGroupIdV1, string>();
  for (const [group, { label, count }] of byGroup) if (label !== null && count > 1) shared.set(group, label);
  return shared;
}
