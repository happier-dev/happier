import { describe, expect, it } from 'vitest';

import {
    applyAutomationIntervalUnit,
    applyAutomationIntervalUnitValue,
    applyAutomationCronPreset,
    applyAutomationIntervalPreset,
    deriveAutomationIntervalUnit,
    formatAutomationCadenceLabel,
    formatIntervalPresetLabel,
    getAutomationIntervalUnitValue,
} from './automationScheduleSentenceModel';

describe('automationScheduleSentenceModel', () => {
    it('formats interval cadence labels with natural units', () => {
        expect(formatAutomationCadenceLabel({
            enabled: true,
            name: '',
            description: '',
            scheduleKind: 'interval',
            everyMinutes: 60,
            cronExpr: '0 * * * *',
            timezone: null,
        })).toBe('every hour');
        expect(formatAutomationCadenceLabel({
            enabled: true,
            name: '',
            description: '',
            scheduleKind: 'interval',
            everyMinutes: 120,
            cronExpr: '0 * * * *',
            timezone: null,
        })).toBe('every 2 hours');
        expect(formatAutomationCadenceLabel({
            enabled: true,
            name: '',
            description: '',
            scheduleKind: 'interval',
            everyMinutes: 4 * 24 * 60,
            cronExpr: '0 * * * *',
            timezone: null,
        })).toBe('every 4 days');
    });

    it('applies interval units, interval presets, and calendar presets to the existing automation draft shape', () => {
        const draft = {
            enabled: true,
            name: '',
            description: '',
            scheduleKind: 'interval' as const,
            everyMinutes: 60,
            cronExpr: '0 * * * *',
            timezone: null,
        };

        expect(deriveAutomationIntervalUnit(60)).toBe('hours');
        expect(getAutomationIntervalUnitValue(120, 'hours')).toBe(2);
        expect(applyAutomationIntervalUnit(draft, 'days')).toMatchObject({
            scheduleKind: 'interval',
            everyMinutes: 24 * 60,
        });
        expect(applyAutomationIntervalUnitValue(draft, 4, 'days')).toMatchObject({
            scheduleKind: 'interval',
            everyMinutes: 4 * 24 * 60,
        });
        expect(applyAutomationIntervalPreset(draft, 720)).toMatchObject({
            scheduleKind: 'interval',
            everyMinutes: 720,
        });
        expect(applyAutomationCronPreset(draft, 'weekdays-9am')).toMatchObject({
            scheduleKind: 'cron',
            cronExpr: '0 9 * * 1-5',
        });
        expect(formatIntervalPresetLabel(24 * 60)).toBe('1d');
    });
});
