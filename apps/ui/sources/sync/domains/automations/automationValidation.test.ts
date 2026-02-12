import { describe, expect, it } from 'vitest';

import {
    buildAutomationScheduleFromDraft,
    normalizeAutomationDescription,
    normalizeAutomationName,
    validateAutomationTemplateTarget,
} from './automationValidation';

describe('automationValidation', () => {
    it('normalizes automation name and description', () => {
        expect(normalizeAutomationName('  Nightly  ')).toBe('Nightly');
        expect(normalizeAutomationName('   ')).toBe('Scheduled Session');
        expect(normalizeAutomationDescription('  Run docs  ')).toBe('Run docs');
        expect(normalizeAutomationDescription('')).toBeNull();
    });

    it('builds interval schedules from draft', () => {
        expect(buildAutomationScheduleFromDraft({
            enabled: true,
            name: 'Interval',
            description: '',
            scheduleKind: 'interval',
            everyMinutes: 10,
            cronExpr: '0 * * * *',
            timezone: 'UTC',
        })).toEqual({
            kind: 'interval',
            everyMs: 600_000,
            timezone: 'UTC',
        });
    });

    it('builds cron schedules from draft', () => {
        expect(buildAutomationScheduleFromDraft({
            enabled: true,
            name: 'Cron',
            description: '',
            scheduleKind: 'cron',
            everyMinutes: 10,
            cronExpr: '*/5 * * * *',
            timezone: 'UTC',
        })).toEqual({
            kind: 'cron',
            scheduleExpr: '*/5 * * * *',
            timezone: 'UTC',
        });
    });

    it('requires existingSessionId for existing_session target', () => {
        expect(() => validateAutomationTemplateTarget({
            targetType: 'existing_session',
            template: {
                directory: '/tmp/project',
            },
        })).toThrow(/existingSessionId/i);

        expect(() => validateAutomationTemplateTarget({
            targetType: 'existing_session',
            template: {
                directory: '/tmp/project',
                existingSessionId: 'session-1',
            },
        })).not.toThrow();
    });
});
