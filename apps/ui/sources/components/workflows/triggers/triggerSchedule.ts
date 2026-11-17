import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { HAPPIER_CLOCK_TIME_FORMAT, resolveHappierFutureLocalDateTime, type HappierLocalDateTimeDraft } from '@happier-dev/plugin-ui/presentation';

/** The editor retains a saved instant exactly; editing its fields releases that retained value. */
export type OnceScheduleDraft = HappierLocalDateTimeDraft & Readonly<{ relative: string; scheduledAt?: number }>;

export type OnceScheduleSource = Readonly<{ kind: string; schedule?: Readonly<{ kind: string }>; remainingOccurrences?: number | null }>;

/** Consumption is scheduler-owned; a paused pending occurrence is still not done. */
export function isSpentOnceSchedule(trigger: OnceScheduleSource): boolean {
    return trigger.kind === 'schedule' && trigger.schedule?.kind === 'once' && trigger.remainingOccurrences === 0;
}

/**
 * A one-time schedule's state: pending until the scheduler consumes its occurrence, then Missed when
 * that occurrence's Run says so (the admission owner's typed `missed` state), otherwise Completed. `null`
 * for any other trigger. The UI never infers Missed from the clock.
 */
export function readOnceScheduleState(trigger: OnceScheduleSource, lastRunState?: string | null): 'pending' | 'done' | 'missed' | null {
    if (trigger.kind !== 'schedule' || trigger.schedule?.kind !== 'once') return null;
    if (!isSpentOnceSchedule(trigger)) return 'pending';
    return lastRunState === 'missed' ? 'missed' : 'done';
}

/** All trigger surfaces share the settled status vocabulary (07 §2.3). */
export function formatOnceScheduleStateLabel(state: ReturnType<typeof readOnceScheduleState>): string | null {
    return state === 'done' ? t('workflows.runState.succeeded')
        : state === 'missed' ? t('workflows.runState.missed') : null;
}

/** Resolve relative text only at the trigger editor's confirmation boundary, never on a timer. */
export function resolveOnceSchedule(draft: OnceScheduleDraft, nowMs = Date.now()): number | null {
    const relative = draft.relative.trim();
    if (relative.length === 0) return draft.scheduledAt ?? resolveHappierFutureLocalDateTime(draft, nowMs);
    const match = /^(?:in\s+)?(\d+(?:\.\d+)?)\s*(min(?:ute)?s?|h(?:ours?)?|d(?:ays?)?)$/iu.exec(relative);
    if (!match) return null;
    const duration = Number(match[1]) * (match[2]!.toLowerCase().startsWith('m') ? 60_000
        : match[2]!.toLowerCase().startsWith('h') ? 3_600_000 : 86_400_000);
    const scheduledAt = nowMs + duration;
    return duration > 0 && Number.isSafeInteger(scheduledAt) && Number.isFinite(new Date(scheduledAt).getTime()) ? scheduledAt : null;
}

/**
 * The simple schedules a person picks (07 S4: Repeat Every day · Weekdays · Weekly, At a time) and
 * the cron they are stored as. A saved hourly cron also reads as Every hour at a minute, so it is
 * edited as a schedule, never as its expression. The summary and the popover both read a cron through
 * this one parser, so a trigger never reads as "Every day" in one place and as its expression in another.
 */
export const SIMPLE_SCHEDULE_REPEATS = ['daily', 'weekdays', 'weekly'] as const;
export type SimpleScheduleRepeat = typeof SIMPLE_SCHEDULE_REPEATS[number] | 'hourly';

export type SimpleSchedule = Readonly<{
    repeat: SimpleScheduleRepeat;
    /** Kept while the schedule is hourly, so switching back to a day keeps its time. */
    hour: number;
    minute: number;
    /** Cron day of week, 0 = Sunday; only for `weekly`. */
    day: number;
}>;

function readNumber(field: string, max: number): number | null {
    if (!/^\d{1,2}$/u.test(field)) return null;
    const value = Number(field);
    return value <= max ? value : null;
}

/** The hourly, daily, weekday and weekly crons; any other expression is `null` and stays as written. */
export function parseSimpleSchedule(expression: string): SimpleSchedule | null {
    const fields = expression.trim().split(/\s+/u);
    if (fields.length !== 5 || fields[2] !== '*' || fields[3] !== '*') return null;
    const minute = readNumber(fields[0]!, 59);
    if (minute !== null && fields[1] === '*' && fields[4] === '*') return { repeat: 'hourly', hour: 9, minute, day: 1 };
    const hour = readNumber(fields[1]!, 23);
    if (minute === null || hour === null) return null;
    const weekdays = fields[4]!;
    if (weekdays === '*') return { repeat: 'daily', hour, minute, day: 1 };
    if (weekdays === '1-5') return { repeat: 'weekdays', hour, minute, day: 1 };
    if (/^[0-7]$/u.test(weekdays)) return { repeat: 'weekly', hour, minute, day: Number(weekdays) % 7 };
    return null;
}

/**
 * A cron a person reads as one sentence (QA-RERUN-1113 F1), whether or not the simple editor can write it:
 * every hour at a minute; or at one minute past listed hours on every day, listed weekdays, listed days of every
 * month, or listed days of listed months. Day, month, weekday and hour fields take lists and ranges. Steps, minute
 * lists and a day restricted by both date and weekday (cron reads that as either) stay `null`.
 */
export type ClockTime = Readonly<{ hour: number; minute: number }>;
export type CalendarSchedule =
    | Readonly<{ repeat: 'hourly'; minute: number }>
    | Readonly<{ repeat: 'daily'; times: readonly ClockTime[] }>
    | Readonly<{ repeat: 'weekly'; weekdays: readonly number[]; times: readonly ClockTime[] }>
    | Readonly<{ repeat: 'monthly'; days: readonly number[]; times: readonly ClockTime[] }>
    | Readonly<{ repeat: 'yearly'; months: readonly number[]; days: readonly number[]; times: readonly ClockTime[] }>;

/** Days in each month of a leap year, so 29 February stays a date. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** "5", "2,8", "1-5" or "1,15-17": the sorted distinct values, or null for anything else (steps, `*`, out of range). */
function readValueList(field: string, min: number, max: number): number[] | null {
    const values = new Set<number>();
    for (const part of field.split(',')) {
        const match = /^(\d{1,2})(?:-(\d{1,2}))?$/u.exec(part);
        if (!match) return null;
        const from = Number(match[1]);
        const to = match[2] === undefined ? from : Number(match[2]);
        if (from < min || to > max || from > to) return null;
        for (let value = from; value <= to; value += 1) values.add(value);
    }
    return [...values].sort((left, right) => left - right);
}

export function parseCalendarSchedule(expression: string): CalendarSchedule | null {
    const fields = expression.trim().split(/\s+/u);
    if (fields.length !== 5) return null;
    const [minuteField, hourField, dayField, monthField, weekdayField] = fields as [string, string, string, string, string];
    const minute = readNumber(minuteField, 59);
    if (minute === null) return null;
    if (hourField === '*') {
        return dayField === '*' && monthField === '*' && weekdayField === '*' ? { repeat: 'hourly', minute } : null;
    }
    const hours = readValueList(hourField, 0, 23);
    if (hours === null) return null;
    const times = hours.map((hour) => ({ hour, minute }));
    if (dayField === '*') {
        if (monthField !== '*') return null;
        if (weekdayField === '*') return { repeat: 'daily', times };
        const weekdays = readValueList(weekdayField, 0, 7);
        return weekdays === null ? null
            : { repeat: 'weekly', weekdays: [...new Set(weekdays.map((day) => day % 7))].sort((left, right) => left - right), times };
    }
    if (weekdayField !== '*') return null;
    const days = readValueList(dayField, 1, 31);
    if (days === null) return null;
    if (monthField === '*') return { repeat: 'monthly', days, times };
    const months = readValueList(monthField, 1, 12);
    // A day some listed month doesn't have would fire only in the others: say it as written instead.
    if (months === null || months.some((month) => days.some((day) => day > MONTH_DAYS[month - 1]!))) return null;
    return { repeat: 'yearly', months, days, times };
}

/** "February": a month's name in the person's language. */
export function formatMonthName(month: number): string {
    return formatWithCachedDateTimeFormatter(new Date(Date.UTC(2024, month - 1, 1)), getPreferredLanguage(), { month: 'long', timeZone: 'UTC' });
}

/** "1 January" / "January 1": a yearly date in the person's language, independent of the year. */
export function formatCalendarDate(schedule: Readonly<{ month: number; day: number }>): string {
    return formatWithCachedDateTimeFormatter(new Date(Date.UTC(2024, schedule.month - 1, schedule.day)),
        getPreferredLanguage(), { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

export function buildSimpleScheduleCron(schedule: SimpleSchedule): string {
    if (schedule.repeat === 'hourly') return `${schedule.minute} * * * *`;
    const weekdays = schedule.repeat === 'daily' ? '*' : schedule.repeat === 'weekdays' ? '1-5' : String(schedule.day);
    return `${schedule.minute} ${schedule.hour} * * ${weekdays}`;
}

/** A schedule's clock in every summary: the app's one clock, so "Every day at 9:00 AM" reads like the Event times beside it. */
export function formatClockTime(schedule: Pick<SimpleSchedule, 'hour' | 'minute'>): string {
    return formatWithCachedDateTimeFormatter(new Date(Date.UTC(2023, 0, 1, schedule.hour, schedule.minute)),
        getPreferredLanguage(), { ...HAPPIER_CLOCK_TIME_FORMAT, timeZone: 'UTC' });
}

/** The editable field's round-trippable 24-hour value, independent of the display locale. */
export function formatClockTimeInput(schedule: Pick<SimpleSchedule, 'hour' | 'minute'>): string {
    return `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
}

/** The At field's value: "HH:MM", or ":MM" past every hour. */
export function formatScheduleTimeInput(schedule: SimpleSchedule): string {
    return schedule.repeat === 'hourly' ? `:${String(schedule.minute).padStart(2, '0')}` : formatClockTimeInput(schedule);
}

/** The At field typed for this schedule: a clock time, or for an hourly one the minute (":15" or "15"). */
export function parseScheduleTime(schedule: SimpleSchedule, text: string): Pick<SimpleSchedule, 'hour' | 'minute'> | null {
    if (schedule.repeat !== 'hourly') return parseClockTime(text);
    const match = /^:?(\d{1,2})$/u.exec(text.trim());
    const minute = match ? Number(match[1]) : NaN;
    return minute <= 59 ? { hour: schedule.hour, minute } : null;
}

/** "HH:MM" (or "H:MM") typed by a person, or null while it is not a time yet. */
export function parseClockTime(text: string): Pick<SimpleSchedule, 'hour' | 'minute'> | null {
    const match = /^(\d{1,2}):(\d{2})$/u.exec(text.trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}
