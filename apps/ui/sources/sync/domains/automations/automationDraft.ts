import { AUTOMATION_INT_COLUMN_MAX } from '@happier-dev/protocol';

export type NewSessionAutomationDraft = Readonly<{
    enabled: boolean;
    name: string;
    description: string;
    scheduleKind: 'interval' | 'cron';
    everyMinutes: number;
    cronExpr: string;
    timezone: string | null;
}>;

export const LEGACY_DEFAULT_NEW_SESSION_AUTOMATION_NAME = 'Scheduled Session';

const MINUTES_PER_DAY = 24 * 60;

/**
 * The authored interval cadence ceiling, expressed in the unit the interval
 * picker edits: the widest whole-day cadence the Protocol's shared
 * `Automation.everyMs` column ceiling can hold. Offering a wider cadence would
 * only produce a save the canonical server schedule admission rejects.
 */
export const MAX_AUTOMATION_INTERVAL_MINUTES =
    Math.floor(AUTOMATION_INT_COLUMN_MAX / 60_000 / MINUTES_PER_DAY) * MINUTES_PER_DAY;

/**
 * The one clamp for an authored interval cadence. The picker, the draft
 * sanitizer, the settings form, and both submit builders share it so a cadence
 * chosen on one surface cannot be silently narrowed by whichever surface holds
 * or saves it next.
 */
export function clampAutomationIntervalMinutes(value: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.min(Math.max(Math.floor(value), 1), MAX_AUTOMATION_INTERVAL_MINUTES);
}

export const DEFAULT_NEW_SESSION_AUTOMATION_DRAFT: NewSessionAutomationDraft = {
    enabled: false,
    name: '',
    description: '',
    scheduleKind: 'interval',
    everyMinutes: 60,
    cronExpr: '0 * * * *',
    timezone: null,
};

function normalizeString(input: unknown, fallback: string): string {
    const value = typeof input === 'string' ? input.trim() : '';
    if (value === LEGACY_DEFAULT_NEW_SESSION_AUTOMATION_NAME) {
        return fallback;
    }
    return value.length > 0 ? value : fallback;
}

function normalizeOptionalString(input: unknown): string | null {
    const value = typeof input === 'string' ? input.trim() : '';
    return value.length > 0 ? value : null;
}

function normalizeEveryMinutes(input: unknown): number {
    if (typeof input !== 'number' || !Number.isFinite(input)) {
        return DEFAULT_NEW_SESSION_AUTOMATION_DRAFT.everyMinutes;
    }
    return clampAutomationIntervalMinutes(input);
}

function normalizeScheduleKind(input: unknown): 'interval' | 'cron' {
    return input === 'cron' ? 'cron' : 'interval';
}

function normalizeCronExpr(input: unknown): string {
    const value = typeof input === 'string' ? input.trim() : '';
    return value.length > 0 ? value : DEFAULT_NEW_SESSION_AUTOMATION_DRAFT.cronExpr;
}

export function sanitizeNewSessionAutomationDraft(input: unknown): NewSessionAutomationDraft {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return DEFAULT_NEW_SESSION_AUTOMATION_DRAFT;
    }

    const record = input as Record<string, unknown>;
    const scheduleKind = normalizeScheduleKind(record.scheduleKind);

    return {
        enabled: record.enabled === true,
        name: normalizeString(record.name, DEFAULT_NEW_SESSION_AUTOMATION_DRAFT.name),
        description: typeof record.description === 'string' ? record.description : '',
        scheduleKind,
        everyMinutes: normalizeEveryMinutes(record.everyMinutes),
        cronExpr: normalizeCronExpr(record.cronExpr),
        timezone: normalizeOptionalString(record.timezone),
    };
}
