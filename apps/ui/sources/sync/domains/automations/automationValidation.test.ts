import { AUTOMATION_INT_COLUMN_MAX } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
    buildAutomationScheduleFromDraft,
    clampAutomationIntervalMinutes,
    MAX_AUTOMATION_INTERVAL_MINUTES,
    normalizeAutomationDescription,
    normalizeAutomationName,
    validateAutomationTemplateTarget,
} from './automationValidation';

describe('automationValidation', () => {
    it('normalizes automation name and description', () => {
        expect(normalizeAutomationName('  Nightly  ')).toBe('Nightly');
        expect(normalizeAutomationName('   ')).toBe('Scheduled automation');
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

    it('never emits an everyMs the Automation.everyMs INTEGER column cannot hold', () => {
        const widest = buildAutomationScheduleFromDraft({
            enabled: true,
            name: 'Widest',
            description: '',
            scheduleKind: 'interval',
            everyMinutes: clampAutomationIntervalMinutes(Number.MAX_SAFE_INTEGER),
            cronExpr: '0 * * * *',
            timezone: null,
        });
        expect(widest.everyMs).toBe(MAX_AUTOMATION_INTERVAL_MINUTES * 60_000);
        expect(widest.everyMs).toBeLessThanOrEqual(AUTOMATION_INT_COLUMN_MAX);
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
