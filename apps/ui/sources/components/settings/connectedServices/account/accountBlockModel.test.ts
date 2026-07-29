import { describe, expect, it } from 'vitest';

import { lightTheme } from '@/theme';
import type { ConnectedServiceQuotaGaugeMeterRow } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';

import {
    resolveAccountHealthVariant,
    resolveAccountHealthDotColor,
    resolveAccountUsageRows,
} from './accountBlockModel';

function meterRow(overrides: Partial<ConnectedServiceQuotaGaugeMeterRow>): ConnectedServiceQuotaGaugeMeterRow {
    return {
        meterId: 'weekly',
        label: 'Weekly',
        remainingPct: 60,
        usedPct: 40,
        detailRightSemantics: 'remaining',
        detailRightLabel: '60% left',
        usedLimitSemantics: null,
        usedLimitLabel: null,
        resetLabel: null,
        tone: 'neutral',
        ...overrides,
    };
}

describe('accountBlockModel', () => {
    describe('resolveAccountUsageRows', () => {
        it('maps gauge meter rows to MeterTone-driven usage rows (remaining as a 0..1 fraction)', () => {
            const rows = resolveAccountUsageRows([
                meterRow({ meterId: 'weekly', label: 'Weekly', remainingPct: 60, detailRightLabel: '60% left' }),
                meterRow({ meterId: 'daily', label: 'Daily', remainingPct: 8, detailRightLabel: '8% left' }),
            ]);

            expect(rows).toEqual([
                { meterId: 'weekly', label: 'Weekly', tone: 'success', remaining: 0.6, detailLabel: '60% left' },
                { meterId: 'daily', label: 'Daily', tone: 'danger', remaining: 0.08, detailLabel: '8% left' },
            ]);
        });

        it('returns no rows for null/empty input', () => {
            expect(resolveAccountUsageRows(null)).toEqual([]);
            expect(resolveAccountUsageRows(undefined)).toEqual([]);
            expect(resolveAccountUsageRows([])).toEqual([]);
        });

        it('preserves the 25%/10% tone boundaries from resolveQuotaTone', () => {
            const rows = resolveAccountUsageRows([
                meterRow({ meterId: 'a', remainingPct: 26 }),
                meterRow({ meterId: 'b', remainingPct: 25 }),
                meterRow({ meterId: 'c', remainingPct: 10 }),
            ]);
            expect(rows.map((r) => r.tone)).toEqual(['success', 'warning', 'danger']);
        });
    });

    describe('resolveAccountHealthVariant', () => {
        it('maps health to the corresponding status variant', () => {
            expect(resolveAccountHealthVariant('healthy')).toBe('success');
            expect(resolveAccountHealthVariant('attention')).toBe('warning');
            expect(resolveAccountHealthVariant('error')).toBe('danger');
        });
    });

    describe('resolveAccountHealthDotColor', () => {
        it('resolves the themed state foreground for the health variant', () => {
            expect(resolveAccountHealthDotColor(lightTheme, 'error')).toBe(lightTheme.colors.state.danger.foreground);
            expect(resolveAccountHealthDotColor(lightTheme, 'attention')).toBe(lightTheme.colors.state.warning.foreground);
            expect(resolveAccountHealthDotColor(lightTheme, 'healthy')).toBe(lightTheme.colors.state.success.foreground);
        });
    });
});
