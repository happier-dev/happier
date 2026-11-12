import { describe, expect, it } from 'vitest';

import { lightTheme } from '@/theme';
import type { ConnectedServiceQuotaGaugeMeterRow, ConnectedServiceQuotaGaugeLabelFormatter } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';

import {
    resolveAccountHealthVariant,
    resolveAccountHealthDotColor,
    resolveAccountUsageRows,
    resolveAccountCapacityRings,
    resolveAccountCapacityView,
    resolveResetLimitLabels,
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

function NOOP_FORMATTER(base: ConnectedServiceQuotaGaugeLabelFormatter): ConnectedServiceQuotaGaugeLabelFormatter {
    const empty = () => '';
    return {
        ...base, unavailable: empty, remaining: empty, remainingWithReset: empty, used: empty,
        durationNow: empty, durationOutdated: empty, durationDaysHours: empty, durationHoursMinutes: empty,
        durationHours: empty, durationMinutes: empty, subscriptionEnds: empty, subscriptionEndsInDays: empty,
        subscriptionRenews: empty, subscriptionRenewsInDays: empty,
    };
}

describe('accountBlockModel', () => {
    it('keeps the account headline and rings in the canonical comparable family', () => {
        const formatter: ConnectedServiceQuotaGaugeLabelFormatter = {
            unavailable: () => '',
            remaining: () => '', remainingWithReset: () => '', used: () => '',
            durationNow: () => '', durationOutdated: () => '', durationDaysHours: () => '',
            durationHoursMinutes: () => '', durationHours: () => '', durationMinutes: () => '',
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
    it('keeps provider credits out of capacity and reports a spent account as credits-only', () => {
        const formatter = {} as ConnectedServiceQuotaGaugeLabelFormatter;
        const weekly = { meterId: 'weekly', label: 'Weekly', used: null, limit: null, unit: 'unknown' as const, utilizationPct: 100, resetsAt: null, status: 'ok' as const, details: {} };
        const credits = (remaining: number) => ({
            meterId: 'credits', label: 'Credits', used: null, limit: null, remaining, unit: 'credits' as const,
            utilizationPct: null, resetsAt: null, isExhausted: remaining <= 0, status: 'ok' as const, details: {},
        });
        const withCredits = resolveAccountCapacityView([weekly, credits(16_845)], 2_000, NOOP_FORMATTER(formatter));
        expect(withCredits).toMatchObject({ capacityPct: 0, credits: { available: true, balance: 16_845 }, creditsOnly: true });
        expect(resolveAccountCapacityView([weekly, credits(0)], 2_000, NOOP_FORMATTER(formatter)))
            .toMatchObject({ capacityPct: 0, credits: { available: false, balance: 0 }, creditsOnly: false });
        expect(resolveAccountCapacityView([weekly], 2_000, NOOP_FORMATTER(formatter)))
            .toMatchObject({ capacityPct: 0, credits: null, creditsOnly: false });
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
                    detailLabel: '60% left',
                },
                {
                    meterId: 'daily',
                    label: 'Daily',
                    tone: 'danger',
                    remaining: 0.08,
                    detailLabel: '8% left',
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

describe('resolveResetLimitLabels', () => {
    const familyLabels = { fiveHour: '5-hour limit', weekly: 'Weekly limit' };
    const meter = (meterId: string, label: string, providerLimitId?: string) => ({
        meterId, label, used: null, limit: null, unit: 'unknown' as const, utilizationPct: 0, resetsAt: null,
        status: 'ok' as const, details: {}, ...(providerLimitId ? { providerLimitId } : {}),
    });

    it('names cleared limits in the USAGE vocabulary and lists each limit once', () => {
        expect(resolveResetLimitLabels(
            ['five_hour', 'seven_day', 'seven_day_fable', 'spend_cap', 'five_hour'],
            [meter('seven_day_fable', 'Weekly (Fable)'), meter('spend', 'Spend', 'spend_cap')],
            familyLabels,
        )).toEqual(['5-hour limit', 'Weekly limit', 'Weekly (Fable)', 'Spend']);
    });

    it('keeps an unrecognized provider limit id visible rather than dropping it', () => {
        expect(resolveResetLimitLabels(['provider-special'], [], familyLabels)).toEqual(['provider-special']);
    });
});
