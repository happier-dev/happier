import * as React from 'react';
import { readTriageTaskDueV1 } from './taskDue.js';
export { readTriageTaskDueV1 } from './taskDue.js';
import { Avatar, ProgressRing, Row, Text, useAccountActorName, type CollectionAnatomy, type PluginTranslate } from '@happier-dev/plugin-ui';
import type { TriageEntryRefV1, TriageEntryRelationsV1 } from '@happier-dev/triage-protocol/v1';
import type { TodoReadinessV1 } from '@happier-dev/plugin-sdk/protocol';
import { TriageTaskStatusLabel } from '../detail/taskFields.js';
import type { TriageListItemV1 } from './sections.js';

function TaskOwner({ item, text }: Readonly<{ item: TriageListItemV1; text: PluginTranslate }>) {
  const self = useAccountActorName({ kind: 'self' });
  const owner = item.task?.assigneeLabel;
  const label = item.task?.assignedToViewer === true ? self
    : owner === null ? text('plugins.triage.tasks.unassigned', 'Nobody')
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
      const progress = readTriageTaskProgressV1(item.task?.relations ?? null, text, blockerName, item.task?.readiness);
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
    const blocker = readBlockerProgress(text, item.task?.readiness);
    if (blocker !== null) {
      return <Text variant="meta" tone="secondary" value={blocker} numberOfLines={1} />;
    }
    // Otherwise the agent's state, as the lab ends a task's line ("Working", "Finished"); history (offline, archived)
    // says nothing.
    return item.agent !== null && input.agentSpeaks(item.agent) ? input.renderAgent(item) : null;
  };
}

/** A task's relation hint: what it says, and the share of sub-tasks done when the source counted them. */
export type TriageTaskProgressV1 = Readonly<{ label: string; done?: Readonly<{ completed: number; total: number }> }>;

function readBlockerProgress(text: PluginTranslate, readiness: TodoReadinessV1 | undefined, name?: string | null): string | null {
  if (readiness?.ready !== false) return null;
  if (readiness.reason === 'blocker_unreadable') return text('plugins.triage.tasks.progress.blockerUnavailable', 'Blocker unavailable');
  if (readiness.reason !== 'blocker_not_terminal') return null;
  return name ? text('plugins.triage.tasks.progress.blockedBy', 'Blocked by {name}', { name })
    : text('plugins.triage.tasks.progress.blocked', 'Blocked');
}

/**
 * Readiness supplies the blocker fact. A name is definite only when the Task has one blocker.
 */
export function readTriageTaskProgressV1(
  relations: TriageEntryRelationsV1 | null,
  text: PluginTranslate,
  nameOf?: (blocker: TriageEntryRefV1) => string | null,
  readiness?: TodoReadinessV1,
): TriageTaskProgressV1 | null {
  const blockers = relations?.blockedBy;
  const name = readiness?.ready === false && readiness.reason === 'blocker_not_terminal' && blockers?.length === 1
    ? nameOf?.(blockers[0]!) : undefined;
  const blocker = readBlockerProgress(text, readiness, name);
  if (blocker !== null) return { label: blocker };
  if (relations === null) return null;
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
