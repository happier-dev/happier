import { describe, expect, it } from 'vitest';
import { calculateTotals, type UsageDataPoint } from './apiUsage';

describe('calculateTotals', () => {
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
