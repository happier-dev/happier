import type { ScheduledJob } from './native';

function record(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid native record');
    return value as Record<string, unknown>;
}
function array(text: string): unknown[] {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!Array.isArray(value)) throw new TypeError('Invalid native list');
    return value;
}

/** Only schedule/account fields survive; executable text is never projected. */
export function parseCrontab(text: string, source: string, system: boolean): ScheduledJob[] {
    const jobs: ScheduledJob[] = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || /^[A-Za-z_][\w]*\s*=/.test(trimmed)) continue;
        const fields = trimmed.split(/\s+/);
        const scheduleFields = fields[0].startsWith('@') ? 1 : 5;
        const commandIndex = scheduleFields + (system ? 1 : 0);
        if (fields.length <= commandIndex) throw new TypeError('Invalid cron entry');
        if (scheduleFields === 1) {
            if (!/^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)$/.test(fields[0])) throw new TypeError('Invalid cron macro');
        } else {
            const monthNames = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i;
            const weekdays = /^(sun|mon|tue|wed|thu|fri|sat)$/i;
            const valid = fields.slice(0, 5).every((field, fieldIndex) => field.split(/[,\/-]/).every(atom =>
                /^(?:\d+|\*)$/.test(atom) || fieldIndex === 3 && monthNames.test(atom) || fieldIndex === 4 && weekdays.test(atom)));
            if (!valid) throw new TypeError('Invalid cron schedule');
        }
        const schedule = fields.slice(0, scheduleFields).join(' ');
        const account = system ? fields[scheduleFields] : 'current user';
        if (system && account.includes('=')) throw new TypeError('Invalid cron account');
        jobs.push({ id: `${source}:${index + 1}`, name: account, schedule });
    }
    return jobs;
}

export function parseSystemdTimers(text: string): Pick<ScheduledJob, 'id' | 'name'>[] {
    return array(text).map(value => {
        const row = record(value);
        if (typeof row.unit !== 'string' || !row.unit.endsWith('.timer')) throw new TypeError('Invalid timer unit');
        return { id: row.unit, name: row.unit };
    });
}

export function parseSystemdTimerSchedules(text: string): Map<string, string> {
    const schedules = new Map<string, string>();
    for (const block of text.trim().split(/\n\s*\n/)) {
        const id = /^Id=(.+)$/m.exec(block)?.[1]?.trim();
        if (!id) continue;
        const expressions = [...block.matchAll(/^Timers(?:Calendar|Monotonic)=\{\s*(On\w+=[^;]+);[^\n]*\}/gm)]
            .map(match => match[1].trim());
        if (expressions.length) schedules.set(id, expressions.join('; '));
    }
    return schedules;
}

export function parseLaunchdSchedule(text: string, source: string): ScheduledJob[] {
    const row = record(JSON.parse(text));
    const schedules: string[] = [];
    if (row.StartInterval !== undefined) {
        if (typeof row.StartInterval !== 'number' || !Number.isInteger(row.StartInterval) || row.StartInterval <= 0) throw new TypeError('Invalid launchd interval');
        schedules.push(`every ${row.StartInterval} seconds`);
    }
    if (row.StartCalendarInterval !== undefined) {
        const calendars: unknown[] = Array.isArray(row.StartCalendarInterval) ? row.StartCalendarInterval : [row.StartCalendarInterval];
        for (const calendar of calendars) {
            const fields = record(calendar);
            const parts: string[] = [];
            for (const key of ['Minute', 'Hour', 'Day', 'Weekday', 'Month']) {
                const value = fields[key];
                if (value === undefined) continue;
                if (typeof value !== 'number' || !Number.isInteger(value)) throw new TypeError('Invalid launchd calendar');
                parts.push(`${key}=${value}`);
            }
            schedules.push(parts.length ? `calendar ${parts.join(' ')}` : 'every minute');
        }
    }
    if (!schedules.length) return [];
    if (typeof row.Label !== 'string' || !row.Label) throw new TypeError('Missing launchd label');
    // Disabled is only a plist default: launchctl keeps effective overrides
    // elsewhere. Do not invent effective enabled state from that default.
    return [{ id: source, name: row.Label, schedule: schedules.join('; ') }];
}

export function parseWindowsScheduledTasks(text: string): ScheduledJob[] {
    return array(text).map(value => {
        const row = record(value);
        if (typeof row.id !== 'string' || !row.id || typeof row.name !== 'string'
            || typeof row.schedule !== 'string' || typeof row.enabled !== 'boolean') throw new TypeError('Invalid scheduled task');
        const time = (key: 'nextRun' | 'lastRun'): string | undefined => {
            const value = row[key];
            if (value === null || value === undefined) return undefined;
            if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError('Invalid task timestamp');
            return new Date(value).toISOString();
        };
        const nextRun = time('nextRun');
        const lastRun = time('lastRun');
        return { id: row.id, name: row.name, schedule: row.schedule, enabled: row.enabled,
            ...(nextRun ? { nextRun } : {}), ...(lastRun ? { lastRun } : {}) };
    });
}
