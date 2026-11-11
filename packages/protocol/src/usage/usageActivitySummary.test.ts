import { describe, expect, it } from 'vitest';
import { resolveUsageDayStreaks } from './usageActivitySummary.js';

const ms = Date.parse;

describe('resolveUsageDayStreaks', () => {
    it('deduplicates days, clips the range and ignores future dates at the captured offset', () => {
        const result = resolveUsageDayStreaks({ days: ['2026-07-02', '2026-07-03', '2026-07-04', '2026-07-04', '2026-07-05', '2026-07-06']
            .map(date => ({ date, eventCount: 1 })), referenceMs: ms('2026-07-04T22:30Z'), timeZoneOffsetMinutes: 120,
            range: { startMs: ms('2026-07-02T22:00Z'), endMs: ms('2026-07-06T22:00Z') }, coverage: 'partial' });
        expect(result).toEqual({ activeDays: 3, currentStreakDays: 3, longestStreakDays: 3, coverage: 'partial' });
    });

    it('anchors current on today or yesterday and preserves gaps and period-local bests', () => {
        const days = ['2026-07-01', '2026-07-02', '2026-07-04', '2026-07-05'].map(date => ({ date, eventCount: 1 }));
        const read = (referenceMs: number) => resolveUsageDayStreaks({ days, referenceMs, timeZoneOffsetMinutes: 0, coverage: 'partial' });
        expect(read(ms('2026-07-06T23:59Z'))).toMatchObject({ activeDays: 4, currentStreakDays: 2, longestStreakDays: 2 });
        expect(read(ms('2026-07-07T00:00Z'))).toMatchObject({ currentStreakDays: 0, longestStreakDays: 2 });
    });

    it('distinguishes unavailable days from a supplied empty calendar and missing history', () => {
        const input = { referenceMs: ms('2026-07-06T12:00Z'), timeZoneOffsetMinutes: 0 };
        expect(resolveUsageDayStreaks(input)).toEqual({ activeDays: null, currentStreakDays: null, longestStreakDays: null, coverage: 'unknown' });
        expect(resolveUsageDayStreaks({ ...input, days: [], coverage: 'complete' })).toEqual({ activeDays: 0,
            currentStreakDays: 0, longestStreakDays: 0, coverage: 'complete' });
        expect(resolveUsageDayStreaks({ ...input, days: [{ date: '2026-07-06', eventCount: null }], coverage: 'unknown' }))
            .toEqual({ activeDays: null, currentStreakDays: null, longestStreakDays: null, coverage: 'unknown' });
        expect(resolveUsageDayStreaks({ ...input, days: [{ date: '2026-07-06', eventCount: 0 }], coverage: 'partial' }))
            .toEqual({ activeDays: 0, currentStreakDays: 0, longestStreakDays: 0, coverage: 'partial' });
        expect(resolveUsageDayStreaks({ ...input, days: [{ date: '2026-07-05', eventCount: 1 }, { date: '2026-07-06', eventCount: null }],
            coverage: 'complete' })).toEqual({ activeDays: 1, currentStreakDays: 1, longestStreakDays: 1, coverage: 'partial' });
    });
});
