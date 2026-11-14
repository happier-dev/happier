import type { PluginTranslate } from '@happier-dev/plugin-ui';
import type { TriageListTaskFactsV1 } from './sections.js';

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
