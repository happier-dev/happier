import { describe, expect, it } from 'vitest';
import { resolveUsagePeriodStartTimeSeconds } from './usagePeriods';

describe('usage period calendar boundary', () => {
    it('uses the selected fixed-offset day rather than the executing host midnight', () => {
        const nowMs = Date.parse('2026-10-09T00:30:00Z');
        expect(resolveUsagePeriodStartTimeSeconds('today', nowMs, 120)).toBe(Date.parse('2026-10-08T22:00:00Z') / 1000);
        expect(resolveUsagePeriodStartTimeSeconds('today', nowMs, -300)).toBe(Date.parse('2026-10-08T05:00:00Z') / 1000);
    });
});
