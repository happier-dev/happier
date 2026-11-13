import { AutomationScheduleSchema, type AutomationSchedulePreviewResult } from '@happier-dev/protocol/automations/automationSchedule';
import { AutomationValidationError, parseAutomationScheduleInput } from './automationValidation';
import { computeNextDueAtForAutomation } from './automationSchedulingService';

/** The same admission and timezone evaluator used when a schedule is saved, without persistence. */
export function previewAutomationSchedule(raw: unknown, now = new Date()): AutomationSchedulePreviewResult {
    const parsed = AutomationScheduleSchema.safeParse(raw);
    if (!parsed.success) return { status: 'invalid_schedule' };
    const value = parsed.data;
    try {
        const schedule = parseAutomationScheduleInput(value.kind === 'once' ? value
            : value.kind === 'cron' ? { kind: value.kind, scheduleExpr: value.scheduleExpr, timezone: value.timezone }
                : { kind: value.kind, everyMs: value.everyMs, timezone: value.timezone });
        const due = computeNextDueAtForAutomation({ now, scheduleKind: schedule.kind,
            everyMs: schedule.kind === 'interval' ? schedule.everyMs : null,
            scheduleExpr: schedule.kind === 'cron' ? schedule.scheduleExpr : null,
            timezone: schedule.timezone,
            scheduledAt: schedule.kind === 'once' ? new Date(schedule.scheduledAt) : null });
        return due === null ? { status: 'invalid_schedule' } : { status: 'ready', nextRunAt: due.getTime() };
    } catch (error) {
        if (error instanceof AutomationValidationError) return { status: 'invalid_schedule' };
        throw error;
    }
}
