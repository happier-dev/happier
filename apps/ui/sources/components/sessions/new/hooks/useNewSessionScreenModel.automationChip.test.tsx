import { describe, expect, it } from 'vitest';

import { getAutomationChipLabel } from '@/components/sessions/new/modules/automationChipModel';

describe('automation chip label', () => {
    it('uses stable Automate label regardless of draft', () => {
        expect(getAutomationChipLabel({
            enabled: false,
            name: '',
            description: '',
            scheduleKind: 'interval',
            everyMinutes: 30,
            cronExpr: '0 * * * *',
            timezone: null,
        })).toBe('Automate');

        expect(getAutomationChipLabel({
            enabled: true,
            name: 'Nightly',
            description: '',
            scheduleKind: 'cron',
            everyMinutes: 15,
            cronExpr: '0 9 * * *',
            timezone: 'UTC',
        })).toBe('Automate');
    });
});
