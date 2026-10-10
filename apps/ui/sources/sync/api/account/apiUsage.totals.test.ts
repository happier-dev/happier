import { describe, expect, it, vi } from 'vitest';
import { calculateTotals, type UsageDataPoint } from './apiUsage';

describe('calculateTotals', () => {
    it('uses an explicit captured offset while preserving the absent-offset native calendar', () => {
        vi.stubEnv('TZ', 'America/New_York');
        try {
            const usage: UsageDataPoint[] = ['2026-07-01T23:00:00Z', '2026-07-02T01:00:00Z']
                .map(instant => ({ timestamp: Date.parse(instant) / 1000, tokens: { total: 10 }, cost: { total: 1 }, reportCount: 1 }));
            expect(calculateTotals(usage).activeDays).toBe(1);
            expect(calculateTotals(usage, 0).activeDays).toBe(2);
            expect(calculateTotals(usage, 120).activeDays).toBe(1);
        } finally {
            vi.unstubAllEnvs();
        }
    });
    it('uses the explicit total fields instead of summing all token and cost buckets', () => {
        const usage: UsageDataPoint[] = [
            {
                timestamp: 1000,
                tokens: { total: 100, input: 80, output: 20 },
                cost: { total: 1.5, input: 1.0, output: 0.5 },
                reportCount: 1,
            },
            {
                timestamp: 2000,
                tokens: { total: 25, input: 10, output: 15 },
                cost: { total: 0.4, input: 0.25, output: 0.15 },
                reportCount: 1,
            },
        ];

        const totals = calculateTotals(usage);

        expect(totals.totalTokens).toBe(125);
        expect(totals.totalCost).toBeCloseTo(1.9);
    });
});
