import { getPreferredLanguage } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

/**
 * The simple schedules a person picks (07 S4: Repeat Every day · Weekdays · Weekly, At a time) and
 * the cron they are stored as. The summary and the popover both read a cron through this one parser,
 * so a trigger never reads as "Every day" in one place and as its expression in another.
 */
export type SimpleScheduleRepeat = 'daily' | 'weekdays' | 'weekly';

export type SimpleSchedule = Readonly<{
    repeat: SimpleScheduleRepeat;
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

/** The daily, weekday and weekly crons; any other expression is `null` and stays as written. */
export function parseSimpleSchedule(expression: string): SimpleSchedule | null {
    const fields = expression.trim().split(/\s+/u);
    if (fields.length !== 5 || fields[2] !== '*' || fields[3] !== '*') return null;
    const minute = readNumber(fields[0]!, 59);
    const hour = readNumber(fields[1]!, 23);
    if (minute === null || hour === null) return null;
    const weekdays = fields[4]!;
    if (weekdays === '*') return { repeat: 'daily', hour, minute, day: 1 };
    if (weekdays === '1-5') return { repeat: 'weekdays', hour, minute, day: 1 };
    if (/^[0-7]$/u.test(weekdays)) return { repeat: 'weekly', hour, minute, day: Number(weekdays) % 7 };
    return null;
}

export function buildSimpleScheduleCron(schedule: SimpleSchedule): string {
    const weekdays = schedule.repeat === 'daily' ? '*' : schedule.repeat === 'weekdays' ? '1-5' : String(schedule.day);
    return `${schedule.minute} ${schedule.hour} * * ${weekdays}`;
}

export function formatClockTime(schedule: Pick<SimpleSchedule, 'hour' | 'minute'>): string {
    return formatWithCachedDateTimeFormatter(new Date(Date.UTC(2023, 0, 1, schedule.hour, schedule.minute)),
        getPreferredLanguage(), { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}

/** The editable field's round-trippable 24-hour value, independent of the display locale. */
export function formatClockTimeInput(schedule: Pick<SimpleSchedule, 'hour' | 'minute'>): string {
    return `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
}

/** "HH:MM" (or "H:MM") typed by a person, or null while it is not a time yet. */
export function parseClockTime(text: string): Pick<SimpleSchedule, 'hour' | 'minute'> | null {
    const match = /^(\d{1,2}):(\d{2})$/u.exec(text.trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}
