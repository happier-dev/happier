import { describe, expect, it, vi } from 'vitest';

import { getAutomationChipLabel } from '@/components/sessions/new/modules/automationChipModel';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => {
            switch (key) {
                case 'newSession.automationChip.default':
                    return 'Automate';
                case 'newSession.automationChip.interval':
                    return `Every ${String(params?.minutes ?? '')}m`;
                case 'newSession.automationChip.cron':
                    return 'Cron schedule';
                default:
                    return key;
            }
        },
    });
});

describe('automation chip label', () => {
    it('shows a neutral label when automation is disabled', () => {
        expect(getAutomationChipLabel({
            enabled: false,
            name: '',
            description: '',
            scheduleKind: 'interval',
            everyMinutes: 30,
            cronExpr: '0 * * * *',
            timezone: null,
        })).toBe('Automate');
    });

    it('summarizes an enabled interval automation', () => {
        expect(getAutomationChipLabel({
            enabled: true,
            name: 'Nightly',
            description: 'Run nightly work',
            scheduleKind: 'interval',
            everyMinutes: 15,
            cronExpr: '0 * * * *',
            timezone: null,
        })).toBe('Every 15m');
    });

    it('summarizes an enabled cron automation', () => {
        expect(getAutomationChipLabel({
            enabled: true,
            name: 'Morning summary',
            description: '',
            scheduleKind: 'cron',
            everyMinutes: 60,
            cronExpr: '0 9 * * *',
            timezone: 'UTC',
        })).toBe('Cron schedule');
    });
});
