import { describe, expect, it } from 'vitest';
import { previewAutomationSchedule } from './automationSchedulePreview';

describe('proposed schedule occurrence', () => {
    it.each([
        ['2026-02-12T13:00:00Z', '2026-02-12T14:00:00Z'],
        ['2026-07-12T12:00:00Z', '2026-07-12T13:00:00Z'],
    ])('uses the saved scheduler timezone from %s', (now, expected) => {
        expect(previewAutomationSchedule({ kind: 'cron', scheduleExpr: '0 9 * * *',
            everyMs: null, timezone: 'America/New_York' }, new Date(now))).toEqual({
            status: 'ready', nextRunAt: Date.parse(expected),
        });
    });
    it.each([
        { kind: 'cron', scheduleExpr: 'broken', everyMs: null, timezone: 'UTC' },
        { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: 'Invalid/Zone' },
        { kind: 'interval', scheduleExpr: null, everyMs: -1, timezone: null },
    ])('returns a typed invalid result for an unsavable schedule', schedule => {
        expect(previewAutomationSchedule(schedule, new Date('2026-03-07T15:00:00Z')))
            .toEqual({ status: 'invalid_schedule' });
    });
    it('previews interval and once schedules without writing a saved trigger', () => {
        const now = new Date('2026-03-07T15:00:00Z');
        expect(previewAutomationSchedule({ kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null }, now))
            .toEqual({ status: 'ready', nextRunAt: now.getTime() + 60_000 });
        expect(previewAutomationSchedule({ kind: 'once', scheduledAt: now.getTime() + 120_000 }, now))
            .toEqual({ status: 'ready', nextRunAt: now.getTime() + 120_000 });
    });
});
