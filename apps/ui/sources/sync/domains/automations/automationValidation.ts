import {
    clampAutomationIntervalMinutes,
    LEGACY_DEFAULT_NEW_SESSION_AUTOMATION_NAME,
    type NewSessionAutomationDraft,
} from './automationDraft';
import type { AutomationTargetType, AutomationTemplate } from './automationTypes';

export type AutomationScheduleInput =
    | Readonly<{ kind: 'interval'; everyMs: number; scheduleExpr?: undefined; timezone?: string | null }>
    | Readonly<{ kind: 'cron'; scheduleExpr: string; everyMs?: undefined; timezone?: string | null }>;

export const DEFAULT_AUTOMATION_NAME_FALLBACK = 'Scheduled automation';

// The interval-cadence clamp lives with the draft type it normalizes; re-exported
// here so the schedule surfaces keep importing their one clamp from this module.
export { clampAutomationIntervalMinutes, MAX_AUTOMATION_INTERVAL_MINUTES } from './automationDraft';

export function normalizeAutomationName(input: string, fallback: string = DEFAULT_AUTOMATION_NAME_FALLBACK): string {
    const normalized = typeof input === 'string' ? input.trim() : '';
    if (normalized === LEGACY_DEFAULT_NEW_SESSION_AUTOMATION_NAME) {
        return fallback;
    }
    return normalized.length > 0 ? normalized : fallback;
}

export function normalizeAutomationDescription(input: string): string | null {
    const normalized = typeof input === 'string' ? input.trim() : '';
    return normalized.length > 0 ? normalized : null;
}

export function buildAutomationScheduleFromDraft(draft: NewSessionAutomationDraft): AutomationScheduleInput {
    const timezone = draft.timezone ?? null;
    if (draft.scheduleKind === 'cron') {
        const scheduleExpr = typeof draft.cronExpr === 'string' ? draft.cronExpr.trim() : '';
        return {
            kind: 'cron',
            scheduleExpr: scheduleExpr.length > 0 ? scheduleExpr : '0 * * * *',
            timezone,
        };
    }

    const intervalMinutes = clampAutomationIntervalMinutes(draft.everyMinutes);
    return {
        kind: 'interval',
        everyMs: intervalMinutes * 60_000,
        timezone,
    };
}

export function validateAutomationTemplateTarget(params: {
    targetType: AutomationTargetType;
    template: AutomationTemplate;
}): void {
    if (params.targetType !== 'existing_session') return;

    const existingSessionId = params.template.existingSessionId?.trim() ?? '';
    if (!existingSessionId) {
        throw new Error('Existing-session automations require existingSessionId');
    }
}
