import * as React from 'react';
import { Avatar, ProgressRing, Row, Text, useAccountActorName, type CollectionAnatomy, type PluginTranslate } from '@happier-dev/plugin-ui';
import type { TriageEntryRefV1, TriageEntryRelationsV1 } from '@happier-dev/triage-protocol/v1';
import { TriageTaskStatusLabel } from '../detail/taskFields.js';
import type { TriageListItemV1, TriageListTaskFactsV1 } from './sections.js';

function TaskOwner({ item, text }: Readonly<{ item: TriageListItemV1; text: PluginTranslate }>) {
  const self = useAccountActorName({ kind: 'self' });
  const owner = item.task?.assigneeLabel;
  const label = item.task?.assignedToViewer === true ? self
    : owner === null ? text('plugins.triage.tasks.unassigned', 'Unassigned')
      : owner === undefined ? '—' : owner;
  // Nobody owning a task is the common case, so it stays quieter than a name: the column reads as who, not as a
  // repeated word.
  const name = <Text variant="meta" tone={owner === null ? 'muted' : 'secondary'} value={label} numberOfLines={1} />;
  // A person is drawn with their mark from Happier's one avatar owner (lab `tasks-everyone`); nobody has none.
  return item.task?.assignedToViewer === true || typeof owner === 'string'
    ? <Row gap="xsmall" align="center"><Avatar name={label} size="small" />{name}</Row> : name;
}

/**
 * The lens declares its fields; Collection owns their responsive placement (lab `tasks-*`):
 * - Mine: Status · Where · Agent · Progress · Due;
 * - Agents: Status · Agent, widened to what its Session is about, · Where (Progress and Due step back);
 * - Everyone: Status · Owner · Where · Agent · Due (Owner replaces Progress).
 */
export function createTriageTaskColumnsV1(input: Readonly<{
  audience: 'mine' | 'agents' | 'everyone';
  locale: string;
  text: PluginTranslate;
  /** The Agents lens' wide agent cell. */
  renderAgent: NonNullable<CollectionAnatomy<TriageListItemV1>['agent']>;
  /** A blocker's short name when the list holds it ("OPS-1170"), else `null`. */
  blockerName?: (blocker: TriageEntryRefV1) => string | null;
}>): NonNullable<CollectionAnatomy<TriageListItemV1>['fields']> {
  const { audience, locale, text, blockerName } = input;
  type Field = NonNullable<CollectionAnatomy<TriageListItemV1>['fields']>[number];
  const status: Field = {
    key: 'status', title: text('plugins.triage.tasks.column.status', 'Status'), leading: true, minWidth: 104, priority: 3,
    render: item => <TriageTaskStatusLabel entryRef={item.row.entryRef} statusLabel={item.task?.statusLabel ?? null} />,
  };
  if (audience === 'agents') return [status, {
    key: 'agent', title: text('plugins.triage.surface.column.agent', 'Agent'), leading: true, minWidth: 224, priority: 3,
    render: input.renderAgent,
  }];
  const due: Field = {
    key: 'due', title: text('plugins.triage.tasks.column.due', 'Due'), minWidth: 96, priority: 1,
    render: item => {
      const read = item.task == null ? null : readTriageTaskDueV1(item.task.dueDate, item.task.category, locale, Date.now(), text);
      return read === null ? null : <Text variant="meta" tone={read.tone ?? 'secondary'} value={read.label} numberOfLines={1} />;
    },
  };
  if (audience === 'everyone') return [status, {
    key: 'owner', title: text('plugins.triage.tasks.column.owner', 'Owner'), leading: true, minWidth: 120, priority: 2,
    render: (item: TriageListItemV1) => <TaskOwner item={item} text={text} />,
  }, due];
  return [status, {
    key: 'progress', title: text('plugins.triage.tasks.column.progress', 'Progress'), minWidth: 120, priority: 2,
    render: (item: TriageListItemV1) => {
      const progress = readTriageTaskProgressV1(item.task?.relations ?? null, text, blockerName);
      if (progress === null) return null;
      const words = <Text variant="meta" tone="secondary" value={progress.label} numberOfLines={1} />;
      return progress.done === undefined ? words
        : <Row gap="xsmall" align="center"><ProgressRing completed={progress.done.completed} total={progress.done.total} />{words}</Row>;
    },
  }, due];
}

/**
 * The task list row's one trailing fact on a phone, where the table's Agent, Progress and Due columns have no room
 * (lab `tasks` phone): an agent asking for you leads, then a due date that is today or past, then Blocked, then an
 * agent at work. A quiet task says nothing there.
 */
export function createTriageTaskListFactV1(input: Readonly<{
  locale: string;
  text: PluginTranslate;
  renderAgent: NonNullable<CollectionAnatomy<TriageListItemV1>['agent']>;
  /** Whether the agent has a state to say, from the row badge's owner (`readTriageAgentBadgeV1`); history does not. */
  agentSpeaks: (agent: NonNullable<TriageListItemV1['agent']>) => boolean;
}>): (item: TriageListItemV1) => React.ReactNode {
  const { locale, text } = input;
  return (item) => {
    if (item.agent !== null && item.agent.tone !== 'neutral') return input.renderAgent(item);
    const due = item.task == null ? null : readTriageTaskDueV1(item.task.dueDate, item.task.category, locale, Date.now(), text);
    if (due?.tone != null) return <Text variant="meta" tone={due.tone} value={due.label} numberOfLines={1} />;
    if ((item.task?.relations?.blockedBy?.length ?? 0) > 0) {
      return <Text variant="meta" tone="secondary" value={text('plugins.triage.tasks.progress.blocked', 'Blocked')} numberOfLines={1} />;
    }
    // Otherwise the agent's state, as the lab ends a task's line ("Working", "Ready"); history (offline, archived)
    // says nothing.
    return item.agent !== null && input.agentSpeaks(item.agent) ? input.renderAgent(item) : null;
  };
}

const DAY_MS = 86_400_000;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Calendar dates stay in the reader's calendar; completed tasks only say their date. */
export function readTriageTaskDueV1(
  dueDate: string | undefined,
  category: TriageListTaskFactsV1['category'],
  locale: string,
  nowMs: number,
  text: PluginTranslate,
): Readonly<{ label: string; tone: 'danger' | 'warning' | null }> | null {
  if (dueDate === undefined) return null;
  const calendar = CALENDAR_DATE.exec(dueDate);
  const due = calendar === null
    ? new Date(Date.parse(dueDate))
    : new Date(Number(calendar[1]), Number(calendar[2]) - 1, Number(calendar[3]));
  if (Number.isNaN(due.getTime())) return null;
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const dueDay = new Date(due);
  dueDay.setHours(0, 0, 0, 0);
  const days = Math.round((dueDay.getTime() - today.getTime()) / DAY_MS);
  const date = Math.abs(days) <= 6
    ? new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(due)
    : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(due);
  if (category === 'completed' || category === 'canceled') return { label: date, tone: null };
  const passed = calendar === null ? due.getTime() < nowMs : days < 0;
  if (passed) {
    const when = days === 0 ? new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(due) : date;
    return { label: text('plugins.triage.tasks.due.overdue', 'Overdue · {date}', { date: when }), tone: 'danger' };
  }
  if (days === 0) return { label: text('plugins.triage.tasks.due.today', 'Today'), tone: 'warning' };
  return { label: date, tone: null };
}

/** A task's relation hint: what it says, and the share of sub-tasks done when the source counted them. */
export type TriageTaskProgressV1 = Readonly<{ label: string; done?: Readonly<{ completed: number; total: number }> }>;

/**
 * Blockers lead, then subtasks and parent; unread relations stay unknown. A blocker is named only when the list
 * holds it (`nameOf`): the relation carries a reference, not the blocker's name.
 */
export function readTriageTaskProgressV1(
  relations: TriageEntryRelationsV1 | null,
  text: PluginTranslate,
  nameOf?: (blocker: TriageEntryRefV1) => string | null,
): TriageTaskProgressV1 | null {
  if (relations === null) return null;
  const blockers = relations.blockedBy ?? [];
  if (blockers.length > 0) {
    const name = blockers.map(blocker => nameOf?.(blocker) ?? null).find(value => value !== null) ?? null;
    if (name === null) return { label: text('plugins.triage.tasks.progress.blocked', 'Blocked') };
    return { label: blockers.length === 1
      ? text('plugins.triage.tasks.progress.blockedBy', 'Blocked by {name}', { name })
      : text('plugins.triage.tasks.progress.blockedByMore', 'Blocked by {name} +{more}', { name, more: blockers.length - 1 }) };
  }
  const children = relations.children;
  if (children !== undefined && children.total > 0) {
    return children.completed === undefined
      ? { label: text('plugins.triage.tasks.progress.subtasks', '{total} sub-tasks', { total: children.total }) }
      : { label: text('plugins.triage.tasks.progress.done', '{completed} of {total}', { completed: children.completed, total: children.total }),
        done: { completed: children.completed, total: children.total } };
  }
  if (relations.parent !== undefined) return { label: text('plugins.triage.tasks.progress.subtask', 'Sub-task') };
  return null;
}
