import { describe, expect, it } from 'vitest';

import { buildAutomationScheduleInputFromForm } from './buildAutomationScheduleInputFromForm';

describe('buildAutomationScheduleInputFromForm', () => {
    it('normalizes cron schedules and falls back to the default expression when blank', () => {
        expect(buildAutomationScheduleInputFromForm({
            enabled: true,
            name: 'Nightly',
            description: '',
            scheduleKind: 'cron',
            everyMinutes: 60,
            cronExpr: '   ',
            timezone: 'Europe/Zurich',
        })).toEqual({
            kind: 'cron',
            scheduleExpr: '0 * * * *',
            timezone: 'Europe/Zurich',
        });
    });
});
