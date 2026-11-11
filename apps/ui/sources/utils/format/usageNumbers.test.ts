import { describe, expect, it } from 'vitest';
import { getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';

import {
    formatPercent,
    formatTokenCount,
    formatTokenCountLong,
    formatUsageCost,
} from './usageNumbers';

describe('usage number formatting', () => {
    it('uses the selected app language for money and compact counts', async () => {
        const previous = getPreferredLanguage();
        try {
            setPreferredLanguageFromSettings('fr');
            await preloadTranslations();
            expect(getPreferredLanguage()).toBe('fr');
            expect(formatUsageCost(21.76, 'USD')).toBe('21,76\u00a0$US');
            expect(formatUsageCost(0.0012, 'USD')).toBe('0,0012\u00a0$US');
            expect(formatTokenCount(321_900_000)).toBe('321,9\u00a0M');
            expect(formatTokenCountLong(321_900_000)).toBe('321\u202f900\u202f000');
        } finally { setPreferredLanguageFromSettings(previous); await preloadTranslations(); }
    });
    it('formats compact token counts consistently across every magnitude', () => {
        expect(formatTokenCount(0)).toBe('0');
        expect(formatTokenCount(999)).toBe('999');
        expect(formatTokenCount(1_000)).toBe('1K');
        expect(formatTokenCount(1_500)).toBe('1.5K');
        expect(formatTokenCount(1_200_000)).toBe('1.2M');
        expect(formatTokenCount(1_499_999)).toBe('1.5M');
        expect(formatTokenCount(1_100_000_000)).toBe('1.1B');
    });

    it('uses localized explicit text for unknown or invalid token counts', () => {
        const missingMeasurementText = t('usage.board.plans.cellUnknown');
        expect(formatTokenCount(null)).toBe(missingMeasurementText);
        expect(formatTokenCountLong(null)).toBe(missingMeasurementText);
        expect(formatUsageCost(null, 'USD')).toBe(missingMeasurementText);
        expect(formatTokenCount(-1)).toBe(missingMeasurementText);
        expect(formatTokenCount(Number.NaN)).toBe(missingMeasurementText);
        expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe(missingMeasurementText);
        expect(formatTokenCountLong(-1)).toBe(missingMeasurementText);
        expect(formatTokenCountLong(Number.NaN)).toBe(missingMeasurementText);
    });

    it('formats long token counts with locale grouping', () => {
        expect(formatTokenCountLong(1_499_999)).toBe(
            new Intl.NumberFormat().format(1_499_999),
        );
        expect(formatTokenCountLong(1_499_999, 'en-US')).toBe(new Intl.NumberFormat('en-US').format(1_499_999));
        expect(formatTokenCountLong(1_499_999, 'de-DE')).toBe(new Intl.NumberFormat('de-DE').format(1_499_999));
    });

    it('uses one precision rule for usage cost', () => {
        expect(formatUsageCost(0, 'USD')).toBe('$0.00');
        // Cents from a dime up; sub-dime amounts keep the digits that make them non-zero.
        expect(formatUsageCost(0.6344, 'USD')).toBe('$0.63');
        expect(formatUsageCost(0.1587, 'USD')).toBe('$0.16');
        expect(formatUsageCost(0.0587, 'USD')).toBe('$0.0587');
        expect(formatUsageCost(0.0012, 'USD')).toBe('$0.0012');
        expect(formatUsageCost(1, 'USD')).toBe('$1.00');
        expect(formatUsageCost(12.4567, 'USD')).toBe('$12.46');
        expect(formatUsageCost(-1, 'USD')).toBe(t('usage.board.plans.cellUnknown'));
        expect(formatUsageCost(Number.NaN, 'USD')).toBe(t('usage.board.plans.cellUnknown'));
    });

    it('formats finite non-negative percentages and rejects invalid values', () => {
        expect(formatPercent(0)).toBe('0%');
        expect(formatPercent(12.25)).toBe('12.3%');
        expect(formatPercent(100)).toBe('100%');
        expect(formatPercent(-1)).toBe('—');
        expect(formatPercent(Number.NaN)).toBe('—');
    });
});
