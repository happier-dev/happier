import {
    clampAutomationIntervalMinutes,
    type AutomationScheduleInput,
} from '@/sync/domains/automations/automationValidation';

import type { AutomationSettingsValue } from './AutomationSettingsForm';

export function buildAutomationScheduleInputFromForm(form: AutomationSettingsValue): AutomationScheduleInput {
    const timezone = form.timezone ?? null;
    if (form.scheduleKind === 'cron') {
        const scheduleExpr = form.cronExpr.trim().length > 0 ? form.cronExpr.trim() : '0 * * * *';
        return { kind: 'cron', scheduleExpr, timezone };
    }

    return { kind: 'interval', everyMs: clampAutomationIntervalMinutes(form.everyMinutes) * 60_000, timezone };
}
