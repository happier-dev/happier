import { describe, expect, it } from 'vitest';

import {
    formatPercent,
    formatTokenCount,
    formatTokenCountLong,
    formatUsageCost,
} from './usageNumbers';

describe('usage number formatting', () => {
    it('formats compact token counts consistently across every magnitude', () => {
        expect(formatTokenCount(0)).toBe('0');
        expect(formatTokenCount(999)).toBe('999');
        expect(formatTokenCount(1_000)).toBe('1k');
        expect(formatTokenCount(1_500)).toBe('1.5k');
        expect(formatTokenCount(1_200_000)).toBe('1.2M');
        expect(formatTokenCount(1_499_999)).toBe('1.5M');
        expect(formatTokenCount(1_100_000_000)).toBe('1.1B');
    });

    it('uses an em dash for invalid token counts', () => {
        expect(formatTokenCount(-1)).toBe('—');
        expect(formatTokenCount(Number.NaN)).toBe('—');
        expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe('—');
        expect(formatTokenCountLong(-1)).toBe('—');
        expect(formatTokenCountLong(Number.NaN)).toBe('—');
    });

    it('formats long token counts with locale grouping', () => {
        expect(formatTokenCountLong(1_499_999)).toBe(
            new Intl.NumberFormat().format(1_499_999),
        );
    });

    it('uses one precision rule for usage cost', () => {
        expect(formatUsageCost(0, 'USD')).toBe('$0.00');
        expect(formatUsageCost(0.1587, 'USD')).toBe('$0.1587');
        expect(formatUsageCost(0.0012, 'USD')).toBe('$0.0012');
        expect(formatUsageCost(1, 'USD')).toBe('$1.00');
        expect(formatUsageCost(12.4567, 'USD')).toBe('$12.46');
        expect(formatUsageCost(-1, 'USD')).toBe('—');
        expect(formatUsageCost(Number.NaN, 'USD')).toBe('—');
    });

    it('formats finite non-negative percentages and rejects invalid values', () => {
        expect(formatPercent(0)).toBe('0%');
        expect(formatPercent(12.25)).toBe('12.3%');
        expect(formatPercent(100)).toBe('100%');
        expect(formatPercent(-1)).toBe('—');
        expect(formatPercent(Number.NaN)).toBe('—');
    });
});
