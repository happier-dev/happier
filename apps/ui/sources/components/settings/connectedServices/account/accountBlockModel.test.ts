import { describe, expect, it } from 'vitest';

import { lightTheme } from '@/theme';
import type { ConnectedServiceQuotaGaugeMeterRow, ConnectedServiceQuotaGaugeLabelFormatter } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';

import {
    resolveAccountHealthVariant,
    resolveAccountHealthDotColor,
    resolveAccountUsageRows,
    resolveAccountCapacityRings,
    resolveAccountCapacityView,
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
        resetAtMs: null,
        resetLabel: null,
        tone: 'neutral',
        ...overrides,
    };
}

describe('accountBlockModel', () => {
    it('keeps the account headline and rings in the canonical comparable family', () => {
        const formatter: ConnectedServiceQuotaGaugeLabelFormatter = {
            unavailable: () => '',
            remaining: () => '', remainingWithReset: () => '', used: () => '',
            durationNow: () => '', durationOutdated: () => '', durationDaysHours: () => '',
            durationHoursMinutes: () => '', durationMinutes: () => '',
            durationHoursMinutesSeconds: () => '', durationMinutesSeconds: () => '',
            subscriptionEnds: () => '', subscriptionEndsInDays: () => '',
            subscriptionRenews: () => '', subscriptionRenewsInDays: () => '',
        };
        const capacity = resolveAccountCapacityView([
            { meterId: 'weekly', label: 'Weekly', used: 82, limit: 100, unit: 'count', utilizationPct: null, resetsAt: null, status: 'ok', details: {} },
            { meterId: 'requests', label: 'Requests', used: 97, limit: 100, unit: 'count', utilizationPct: null, resetsAt: null, status: 'ok', details: { limitCategory: 'rate_limit' } },
        ], 2_000, formatter);
        expect(capacity.capacityPct).toBe(18);
        expect(capacity.rings).toEqual([{ ratio: 0.18, tone: 'warning' }]);
    });
    describe('resolveAccountUsageRows', () => {
        it('preserves unknown percentages in details without inventing a capacity ring', () => {
            const rows = resolveAccountUsageRows([meterRow({ remainingPct: null, usedPct: null })]);
            expect(rows[0]?.remaining).toBeNull();
            expect(resolveAccountCapacityRings(rows)).toEqual([]);
        });
        it('maps gauge meter rows to MeterTone-driven usage rows with a single remaining-first fill', () => {
            const rows = resolveAccountUsageRows([
                meterRow({ meterId: 'weekly', label: 'Weekly', remainingPct: 60, detailRightLabel: '60% left' }),
                meterRow({ meterId: 'daily', label: 'Daily', remainingPct: 8, usedPct: 92, detailRightLabel: '8% left' }),
            ]);

            expect(rows).toEqual([
                {
                    meterId: 'weekly',
                    label: 'Weekly',
                    tone: 'success',
                    remaining: 0.6,
                    remainingPct: 60,
                    resetAtMs: null,
                },
                {
                    meterId: 'daily',
                    label: 'Daily',
                    tone: 'danger',
                    remaining: 0.08,
                    remainingPct: 8,
                    resetAtMs: null,
                },
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
