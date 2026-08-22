import { describe, expect, it } from 'vitest';

import { buildAutomationScheduleFromDraft } from '@/sync/domains/automations/automationValidation';

import { applyAutomationIntervalUnitValue } from './automationScheduleSentenceModel';
import { buildAutomationScheduleInputFromForm } from './buildAutomationScheduleInputFromForm';

const BASE_DRAFT = {
    enabled: true,
    name: 'Weekly digest',
    description: '',
    scheduleKind: 'interval' as const,
    everyMinutes: 60,
    cronExpr: '0 * * * *',
    timezone: null,
};

describe('automation interval cadence survives the save path', () => {
    it('submits the cadence the interval picker produced', () => {
        // The live picker (AutomationSettingsPopoverContent) writes the draft
        // through this exact owner.
        const draft = applyAutomationIntervalUnitValue(BASE_DRAFT, 7, 'days');
        expect(draft.everyMinutes).toBe(7 * 24 * 60);

        expect(buildAutomationScheduleInputFromForm(draft)).toEqual({
            kind: 'interval',
            everyMs: 7 * 24 * 60 * 60_000,
            timezone: null,
        });
    });

    it('agrees with the new-session submit owner for the same draft', () => {
        const draft = applyAutomationIntervalUnitValue(BASE_DRAFT, 7, 'days');
        expect(buildAutomationScheduleInputFromForm(draft))
            .toEqual(buildAutomationScheduleFromDraft(draft));
    });
});
