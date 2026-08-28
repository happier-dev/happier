import { describe, expect, it, vi } from 'vitest';

import { getAutomationChipLabel } from '@/components/sessions/new/modules/automationChipModel';
import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';

installNewSessionScreenModelCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key) => {
                switch (key) {
                    case 'newSession.automationChip.default':
                        return 'Automate';
                    default:
                        return key;
                }
            },
        });
    },
});

describe('automation chip label', () => {
    it('shows a neutral label when automation is disabled', () => {
        expect(getAutomationChipLabel({
            pendingAutomationId: null,
            enabled: false,
            name: '',
            description: '',
            triggers: [],
        })).toBe('Automate');
    });

    it('shows the name of an enabled automation with plural trigger rows', () => {
        expect(getAutomationChipLabel({
            pendingAutomationId: 'automation-nightly',
            enabled: true,
            name: 'Nightly',
            description: 'Run nightly work',
            triggers: [
                {
                    clientId: 'nightly-interval',
                    definition: {
                        kind: 'schedule',
                        enabled: true,
                        schedule: { kind: 'interval', everyMs: 900_000, scheduleExpr: null, timezone: null },
                    },
                },
                {
                    clientId: 'morning-cron',
                    definition: {
                        kind: 'schedule',
                        enabled: true,
                        schedule: { kind: 'cron', everyMs: null, scheduleExpr: '0 9 * * *', timezone: 'UTC' },
                    },
                },
            ],
        })).toBe('Nightly');
    });

    it('uses the neutral label when an enabled automation has no name', () => {
        expect(getAutomationChipLabel({
            pendingAutomationId: 'automation-unnamed',
            enabled: true,
            name: '   ',
            description: '',
            triggers: [{
                clientId: 'stable-schedule-row',
                definition: {
                    kind: 'schedule',
                    enabled: true,
                    schedule: { kind: 'cron', everyMs: null, scheduleExpr: '0 9 * * *', timezone: 'UTC' },
                },
            }],
        })).toBe('Automate');
    });
});
