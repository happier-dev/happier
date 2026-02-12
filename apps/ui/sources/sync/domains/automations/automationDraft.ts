export type NewSessionAutomationDraft = Readonly<{
    enabled: boolean;
    name: string;
    description: string;
    scheduleKind: 'interval' | 'cron';
    everyMinutes: number;
    cronExpr: string;
    timezone: string | null;
}>;

export const DEFAULT_NEW_SESSION_AUTOMATION_DRAFT: NewSessionAutomationDraft = {
    enabled: false,
    name: 'Scheduled Session',
    description: '',
    scheduleKind: 'interval',
    everyMinutes: 60,
    cronExpr: '0 * * * *',
    timezone: null,
};

function normalizeString(input: unknown, fallback: string): string {
    const value = typeof input === 'string' ? input.trim() : '';
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
    return Math.min(Math.max(Math.floor(input), 1), 24 * 60);
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
