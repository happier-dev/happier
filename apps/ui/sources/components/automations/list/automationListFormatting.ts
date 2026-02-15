export function formatAutomationScheduleLabel(automation: {
    schedule: { kind: 'cron' | 'interval'; everyMs: number | null; scheduleExpr: string | null; timezone?: string | null };
}): string {
    if (automation.schedule.kind === 'interval' && typeof automation.schedule.everyMs === 'number') {
        const minutes = Math.max(1, Math.round(automation.schedule.everyMs / 60_000));
        const tz = typeof automation.schedule.timezone === 'string' && automation.schedule.timezone.trim().length > 0
            ? ` (${automation.schedule.timezone.trim()})`
            : '';
        return `Every ${minutes}m${tz}`;
    }
    if (automation.schedule.kind === 'cron' && typeof automation.schedule.scheduleExpr === 'string') {
        const expr = automation.schedule.scheduleExpr.trim();
        const tz = typeof automation.schedule.timezone === 'string' && automation.schedule.timezone.trim().length > 0
            ? ` (${automation.schedule.timezone.trim()})`
            : '';
        return expr.length > 0 ? `Cron: ${expr}${tz}` : `Cron${tz}`;
    }
    return 'Schedule';
}

export function formatAutomationNextRun(nextRunAt: number | null): string {
    if (!nextRunAt) return 'No next run';
    try {
        return `Next: ${new Date(nextRunAt).toLocaleString()}`;
    } catch {
        return 'Next run pending';
    }
}
