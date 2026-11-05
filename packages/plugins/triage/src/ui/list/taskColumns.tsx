import * as React from 'react';
import { Text, type CollectionAnatomy, type PluginTranslate } from '@happier-dev/plugin-ui';
import type { TriageListItemV1, TriageListTaskFactsV1 } from './sections.js';

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
