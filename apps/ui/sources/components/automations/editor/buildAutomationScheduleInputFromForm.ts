import type { AutomationScheduleInput } from '@/sync/domains/automations/automationValidation';

import type { AutomationSettingsValue } from './AutomationSettingsForm';

export function buildAutomationScheduleInputFromForm(form: AutomationSettingsValue): AutomationScheduleInput {
    const timezone = form.timezone ?? null;
    if (form.scheduleKind === 'cron') {
        const scheduleExpr = form.cronExpr.trim().length > 0 ? form.cronExpr.trim() : '0 * * * *';
        return { kind: 'cron', scheduleExpr, timezone };
    }

    const minutes = Math.min(Math.max(Math.floor(form.everyMinutes), 1), 24 * 60);
    return { kind: 'interval', everyMs: minutes * 60_000, timezone };
}
