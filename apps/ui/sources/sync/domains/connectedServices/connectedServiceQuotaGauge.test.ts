import { describe, expect, it } from 'vitest';
import type {
    ConnectedServiceQuotaMeterV1,
    ConnectedServiceQuotaRecoveryCreditsV1,
    ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import {
    type ConnectedServiceQuotaGaugeLabelFormatter,
    computeConnectedServiceQuotaGaugeViewModel,
    buildConnectedServiceQuotaGaugeMeterRows,
    deriveConnectedServiceQuotaSnapshotFromRuntimeIssue,
    resolveConnectedServiceQuotaGaugeSource,
    resolveConnectedServiceQuotaMeterDetailLabel,
    selectConnectedServiceSessionProviderUsageGaugeSource,
} from './connectedServiceQuotaGauge';

function meter(
    patch: Partial<ConnectedServiceQuotaMeterV1> & Pick<ConnectedServiceQuotaMeterV1, 'meterId' | 'label'>,
): ConnectedServiceQuotaMeterV1 {
    return {
        used: null,
        limit: null,
        unit: 'count',
        utilizationPct: null,
        resetsAt: null,
        status: 'ok',
        details: {},
        ...patch,
    };
}

function snapshot(meters: readonly ConnectedServiceQuotaMeterV1[]): ConnectedServiceQuotaSnapshotV1 {
    return {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: 1_000,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [...meters],
    };
}

const formatter: ConnectedServiceQuotaGaugeLabelFormatter = {
    unavailable: () => 'Unavailable',
    remaining: ({ percent }) => `${percent} left`,
    remainingWithReset: ({ percent, reset }) => `${percent} left · resets in ${reset}`,
    used: ({ used, limit }) => `${used}/${limit} used`,
    durationNow: () => 'now',
    durationOutdated: () => 'outdated',
    durationDaysHours: ({ days, hours }) => `${days}d ${hours}h`,
    durationHoursMinutes: ({ hours, minutes }) => `${hours}h ${minutes}m`,
    durationMinutes: ({ minutes }) => `${minutes}m`,
    durationHoursMinutesSeconds: ({ hours, minutes, seconds }) => `${hours}h ${minutes}m ${seconds}s`,
    durationMinutesSeconds: ({ minutes, seconds }) => `${minutes}m ${seconds}s`,
    subscriptionEnds: ({ date }) => `Ends ${date}`,
    subscriptionEndsInDays: ({ days }) => `Ends in ${days} day${days === 1 ? '' : 's'}`,
    subscriptionRenews: ({ date }) => `Renews ${date}`,
    subscriptionRenewsInDays: ({ days }) => `Renews in ${days} day${days === 1 ? '' : 's'}`,
};

describe('computeConnectedServiceQuotaGaugeViewModel', () => {
    it.each([['five_hour', 'weekly'], ['primary', 'secondary']])(
        'shows both %s and %s by default while allowing a single-limit choice',
        (shortId, longId) => {
            const input = {
                snapshot: snapshot([
                    meter({ meterId: shortId, label: shortId, used: 40, limit: 100, windowDurationMs: 18_000_000 }),
                    meter({ meterId: longId, label: longId, used: 100, limit: 100, windowDurationMs: 604_800_000 }),
                ]),
                windowMode: 'most_constrained' as const,
                windowModes: null,
                nowMs: 2_000,
                formatter,
            };
            const automatic = computeConnectedServiceQuotaGaugeViewModel(input);
            expect(automatic?.usageRings.map((ring) => ring.meterId)).toEqual([longId, shortId]);
            expect(automatic?.remainingPct).toBe(0);
            const single = computeConnectedServiceQuotaGaugeViewModel({ ...input, windowModes: ['most_constrained'] });
            expect(single?.usageRings.map((ring) => ring.meterId)).toEqual([longId]);
        },
    );

    it('projects Antigravity quota onto the exact active model without borrowing another version', () => {
        const usage = { ...snapshot([
            meter({ meterId: 'model:gemini-2.5-flash', modelId: 'gemini-2.5-flash', utilizationPct: 80, label: 'Gemini 2.5 Flash' }),
            meter({ meterId: 'model:gemini-3-flash', modelId: 'gemini-3-flash', utilizationPct: 20, label: 'Gemini 3 Flash' }),
        ]), serviceId: 'antigravity' as const };
        const params = { snapshot: usage, windowMode: 'most_constrained' as const, activeModelId: 'gemini-3-flash', nowMs: 2000, formatter };
        expect(computeConnectedServiceQuotaGaugeViewModel(params)?.remainingPct).toBe(80);
        expect(computeConnectedServiceQuotaGaugeViewModel({ ...params, activeModelId: 'gemini-4-flash' })).toBeNull();
        expect(computeConnectedServiceQuotaGaugeViewModel({ ...params, activeModelId: null })).toBeNull();
        expect(usage.meters).toHaveLength(2);
    });
    it('retains shared account windows without inferring their membership from model names', () => {
        const usage = { ...snapshot([
            meter({ meterId: 'gemini-5h', providerLimitId: 'gemini-5h', utilizationPct: 20, label: 'Gemini' }),
            meter({ meterId: '3p-5h', providerLimitId: '3p-5h', utilizationPct: 99, label: 'Other models' }),
        ]), serviceId: 'antigravity' as const };
        const params = { snapshot: usage, windowMode: 'most_constrained' as const, activeModelId: 'gemini-3-flash', nowMs: 2000, formatter };
        expect(computeConnectedServiceQuotaGaugeViewModel(params)?.allMeterRows.map(row => row.meterId)).toEqual(['gemini-5h', '3p-5h']);
        expect(computeConnectedServiceQuotaGaugeViewModel({ ...params, activeModelId: 'unknown-provider-model' })?.allMeterRows.map(row => row.meterId))
            .toEqual(['gemini-5h', '3p-5h']);
    });
    it('selects global windows from the pool allowances across raw usage sources', () => {
        const usage = snapshot([
            meter({ meterId: 'daily-other', label: 'Daily other', providerLimitId: 'other', windowDurationMs: 86_400_000, utilizationPct: 99 }),
            meter({ meterId: 'weekly-other', label: 'Weekly other', providerLimitId: 'other', windowDurationMs: 604_800_000, utilizationPct: 98 }),
            meter({ meterId: 'daily-fable', label: 'Daily Fable', providerLimitId: 'fable', windowDurationMs: 86_400_000, utilizationPct: 40 }),
            meter({ meterId: 'weekly-fable', label: 'Weekly Fable', providerLimitId: 'fable', windowDurationMs: 604_800_000, utilizationPct: 60 }),
            meter({ meterId: 'short-fable', label: 'Short Fable', providerLimitId: 'fable', windowDurationMs: 18_000_000, utilizationPct: 20 }),
            meter({ meterId: 'unknown-fable', label: 'Unknown Fable', providerLimitId: 'fable', status: 'unavailable' }),
        ]);
        const params = {
            snapshot: usage, windowMode: 'most_constrained' as const,
            windowModes: ['daily', 'weekly'] as const,
            additionalMeterIds: ['weekly-fable', 'short-fable', 'daily-other', 'unknown-fable'],
            quotaLimitSelection: { mode: 'selected' as const, providerLimitIds: ['fable'] },
            nowMs: 2_000, formatter,
        };
        const vm = computeConnectedServiceQuotaGaugeViewModel(params);
        expect(vm?.usageRings.map((ring) => [ring.meterId, ring.ringValueLabel]))
            .toEqual([['weekly-fable', '40'], ['daily-fable', '60'], ['short-fable', '80']]);
        expect(vm?.allMeterRows.map((row) => row.meterId)).toEqual(['daily-fable', 'weekly-fable', 'short-fable', 'unknown-fable']);
        expect(computeConnectedServiceQuotaGaugeViewModel({
            ...params, quotaLimitSelection: { mode: 'selected', providerLimitIds: ['unreported'] },
        })).toBeNull();
        expect(computeConnectedServiceQuotaGaugeViewModel({ ...params, windowModes: ['secondary'] })?.usageRings.map((ring) => ring.meterId)).toEqual(['weekly-fable', 'short-fable']);
        expect(usage.meters).toHaveLength(6);
        expect(computeConnectedServiceQuotaGaugeViewModel({ ...params, quotaLimitSelection: null })).toBeNull();
    });

    it('omits an unavailable globally selected period instead of showing another period', () => {
        const params = {
            snapshot: snapshot([meter({ meterId: 'weekly', label: 'Weekly', utilizationPct: 70 })]),
            windowMode: 'most_constrained' as const, windowModes: ['daily'] as const,
            nowMs: 2_000, formatter,
        };
        expect(computeConnectedServiceQuotaGaugeViewModel(params)).toBeNull();
    });

    it('hides empty placeholders while retaining measured, reset-only, and pinned windows', () => {
        const meters = [
            meter({ meterId: 'full', label: 'Full', utilizationPct: 0 }),
            meter({ meterId: 'empty', label: 'Empty', utilizationPct: 100 }),
            meter({ meterId: 'placeholder', label: 'Placeholder', status: 'unavailable' }),
            meter({ meterId: 'reset', label: 'Reset', status: 'unavailable', resetsAt: 62_000 }),
            meter({ meterId: 'expired', label: 'Expired', status: 'unavailable', resetsAt: 1_000 }),
            meter({ meterId: 'pinned', label: 'Pinned', status: 'unavailable' }),
        ];
        const displayFormatter = formatter;
        const rows = buildConnectedServiceQuotaGaugeMeterRows(meters, 2_000, displayFormatter, ['pinned']);
        expect(rows.map((row) => row.meterId)).toEqual(['full', 'empty', 'reset', 'pinned']);
        expect(rows.map((row) => row.remainingPct)).toEqual([100, 0, null, null]);
        expect(rows.find((row) => row.meterId === 'pinned')?.detailRightLabel).toBe('Unavailable');
        expect(rows.find((row) => row.meterId === 'reset')?.resetLabel).toBe('1m 0s');

        const vm = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot(meters), windowMode: 'most_constrained', nowMs: 2_000,
            formatter: displayFormatter,
        });
        expect(vm?.allMeterRows.map((row) => row.meterId)).toEqual(['full', 'empty', 'reset']);
        expect(vm?.remainingPct).toBe(0);
        expect(vm?.usageRings.map((ring) => ring.meterId)).toEqual(['empty', 'full']);
        expect(buildConnectedServiceQuotaGaugeMeterRows([meters[2]!], 2_000, displayFormatter)).toEqual([]);
        expect(buildConnectedServiceQuotaGaugeMeterRows([
            meter({ meterId: 'counts', label: 'Counts', used: 0, limit: 0 }),
        ], 2_000, displayFormatter)).toMatchObject([{ meterId: 'counts', usedLimitLabel: '0/0 used' }]);
    });
    it('shows unavailable provider meters neutrally even when the provider reports zero remaining', () => {
        const disabled = meter({ meterId: 'disabled', label: 'Disabled', status: 'unavailable',
            remainingPct: 0, utilizationPct: 100, used: 100, limit: 100, resetsAt: 62_000 });
        expect(buildConnectedServiceQuotaGaugeMeterRows([disabled], 2_000, formatter)).toMatchObject([
            { remainingPct: null, usedPct: null, usedLimitLabel: null, usedLimitSemantics: null,
                resetLabel: '1m 0s', tone: 'neutral' },
        ]);
        expect(buildConnectedServiceQuotaGaugeMeterRows([{ ...disabled, resetsAt: null }], 2_000, formatter, ['disabled']))
            .toMatchObject([{ remainingPct: null, usedPct: null, detailRightLabel: 'Unavailable', tone: 'neutral' }]);
        expect(computeConnectedServiceQuotaGaugeViewModel({ snapshot: snapshot([disabled]),
            windowMode: 'most_constrained', nowMs: 2_000, formatter })).toBeNull();
    });
    it('keeps unmeasured reported windows in details even when no composer ring can be ranked', () => {
        const unknown = meter({ meterId: 'reached', label: 'Reached', status: 'unavailable', resetsAt: 62_000, details: { limitCategory: 'usage_limit' } });
        expect(buildConnectedServiceQuotaGaugeMeterRows([unknown], 2_000, formatter)).toMatchObject([
            { meterId: 'reached', remainingPct: null, usedPct: null, resetLabel: '1m 0s' },
        ]);
        const vm = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([meter({ meterId: 'weekly', label: 'Weekly', used: 82, limit: 100 }), unknown]),
            windowMode: 'most_constrained', nowMs: 2_000, formatter,
        });
        expect(vm?.allMeterRows.map((row) => row.meterId)).toEqual(['weekly', 'reached']);
        expect(vm?.usageRings.map((ring) => ring.meterId)).toEqual(['weekly']);
    });
    it('retains subscription lifecycle independently of fresh quota meters', () => {
        const subscription = {
            status: 'subscribed' as const,
            renewal: 'off' as const,
            observedAtMs: 1_000,
            staleAfterMs: 500,
            currentPeriodStartAtMs: 500,
            currentPeriodEndAtMs: 50_000,
        };
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: { ...snapshot([meter({ meterId: 'daily', label: 'Daily', used: 30, limit: 100 })]), subscription },
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        });
        expect(viewModel?.isStale).toBe(false);
        expect(viewModel?.subscription).toMatchObject({ renewal: 'off', isLastKnown: false });
        expect(viewModel?.subscription?.summary).toBe('Ends in 1 day');
    });

    it('selects the reliable meter with the least remaining quota for most_constrained mode', () => {
        const capacityDetails: ConnectedServiceQuotaMeterV1['details'] & { limitCategory: 'capacity' } = {
            limitCategory: 'capacity',
        };

        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({ meterId: 'daily', label: 'Daily', used: 70, limit: 100 }),
                meter({ meterId: 'weekly', label: 'Weekly', used: 88, limit: 100 }),
                meter({ meterId: 'capacity', label: 'Capacity', used: 99, limit: 100, details: capacityDetails }),
                meter({ meterId: 'auth', label: 'Auth', used: 99, limit: 100, status: 'unavailable', details: { limitCategory: 'auth_invalid' } }),
            ]),
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.effectiveMeter.meterId).toBe('weekly');
        expect(viewModel?.remainingPct).toBe(12);
        expect(viewModel?.badgeLabel).toBe('12% left');
        // Remaining-first ring number (battery model, user decision 2026-07-10).
        expect(viewModel?.ringValueLabel).toBe('12');
        expect(viewModel?.tone).toBe('warning');
        expect(viewModel?.allMeterRows.map((row) => row.meterId)).toEqual(['daily', 'weekly']);
    });

    it('keeps model-specific Claude usage windows visible in account usage rows', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: {
                ...snapshot([
                    meter({ meterId: 'five_hour', label: '5-hour', utilizationPct: 10, unit: 'unknown' }),
                    meter({ meterId: 'seven_day', label: 'Weekly', utilizationPct: 25, unit: 'unknown' }),
                    meter({ meterId: 'seven_day_fable', label: 'Weekly (Fable)', utilizationPct: 61, unit: 'unknown' }),
                ]),
                serviceId: 'claude-subscription',
            },
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.effectiveMeter.meterId).toBe('seven_day_fable');
        expect(viewModel?.allMeterRows.map((row) => row.meterId)).toEqual([
            'five_hour',
            'seven_day',
            'seven_day_fable',
        ]);
        expect(viewModel?.allMeterRows.find((row) => row.meterId === 'seven_day_fable')).toMatchObject({
            label: 'Weekly (Fable)',
            detailRightLabel: '39% left',
        });
    });

    it('shows available periods by default and honors selected global windows, remaining-first', () => {
        const usageSnapshot = snapshot([
            meter({ meterId: 'five_hour', label: '5-hour', utilizationPct: 10, unit: 'unknown' }),
            meter({ meterId: 'seven_day', label: 'Weekly', utilizationPct: 25, unit: 'unknown' }),
            meter({ meterId: 'seven_day_fable', label: 'Weekly (Fable)', utilizationPct: 61, unit: 'unknown' }),
        ]);
        const params = { snapshot: usageSnapshot, windowMode: 'most_constrained' as const, nowMs: 2_000, formatter };
        expect(computeConnectedServiceQuotaGaugeViewModel(params)?.usageRings.map((ring) => ring.meterId))
            .toEqual(['seven_day_fable', 'five_hour']);
        const rings = computeConnectedServiceQuotaGaugeViewModel({
            ...params, windowModes: ['weekly', 'session', 'session'],
        })?.usageRings;
        expect(rings?.map((ring) => [ring.meterId, ring.ringValueLabel, ring.valueLabel])).toEqual([
            ['seven_day_fable', '39', '39% left'],
            ['five_hour', '90', '90% left'],
        ]);
    });

    it('classifies seven_day as weekly, not daily, for the weekly window mode', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({ meterId: 'five_hour', label: '5-hour', utilizationPct: 90, unit: 'unknown' }),
                meter({ meterId: 'seven_day', label: 'Weekly', utilizationPct: 25, unit: 'unknown' }),
            ]),
            windowMode: 'weekly', windowModes: ['weekly', 'session'], nowMs: 2_000, formatter,
        });
        expect(viewModel?.effectiveMeter.meterId).toBe('seven_day');
        expect(viewModel?.scopePrefix).toBe('w.');
        expect(viewModel?.usageRings.map((ring) => ring.meterId)).toEqual(['seven_day', 'five_hour']);
    });

    it('does not compare quota windows against rate or capacity families in most-constrained mode', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({ meterId: 'weekly', label: 'Weekly', used: 82, limit: 100, unit: 'count', details: { limitCategory: 'usage_limit' } }),
                meter({ meterId: 'daily', label: 'Daily', used: 50, limit: 100, unit: 'count', details: { limitCategory: 'usage_limit' } }),
                meter({ meterId: 'requests', label: 'Requests', used: 99, limit: 100, unit: 'requests', details: { limitCategory: 'rate_limit' } }),
                meter({ meterId: 'server_capacity', label: 'Server capacity', used: 100, limit: 100, unit: 'requests', details: { limitCategory: 'capacity' } }),
            ]),
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.effectiveMeter.meterId).toBe('weekly');
        expect(viewModel?.allMeterRows.map((row) => row.meterId)).toEqual(['weekly', 'daily', 'requests']);
    });

    it('keeps daily and weekly windows separate when explicitly selected', () => {
        const quotaSnapshot = snapshot([
            meter({ meterId: 'daily', label: 'Daily', used: 85, limit: 100 }),
            meter({ meterId: 'weekly', label: 'Weekly', used: 5, limit: 100 }),
        ]);

        const daily = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: quotaSnapshot,
            windowMode: 'daily',
            nowMs: 2_000,
            formatter,
        });
        const weekly = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: quotaSnapshot,
            windowMode: 'weekly',
            nowMs: 2_000,
            formatter,
            providerDisplayName: 'OpenAI',
            activeAccountDisplayLabel: 'Work account',
        });

        expect(daily?.effectiveMeter.meterId).toBe('daily');
        expect(daily?.badgeLabel).toBe('d. 15% left');
        expect(weekly?.effectiveMeter.meterId).toBe('weekly');
        expect(weekly?.badgeLabel).toBe('w. 95% left');
    });

    it('uses compact selected-window prefixes for daily and weekly meters', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({ meterId: 'daily', label: 'Daily window', used: 85, limit: 100 }),
                meter({ meterId: 'weekly', label: 'Weekly window', used: 20, limit: 100 }),
            ]),
            windowMode: 'daily',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.effectiveMeter.meterId).toBe('daily');
        expect(viewModel?.scopePrefix).toBe('d.');
        expect(viewModel?.badgeLabel).toBe('d. 15% left');
    });

    it('formats remaining-first detail rows with reset and usage labels', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: 82,
                    limit: 100,
                    resetsAt: 2_000 + 2 * 60 * 60 * 1000,
                }),
            ]),
            windowMode: 'weekly',
            nowMs: 2_000,
            formatter,
            providerDisplayName: 'OpenAI',
            activeAccountDisplayLabel: 'Work account',
        });

        expect(viewModel?.serviceId).toBe('openai-codex');
        expect(viewModel?.providerDisplayName).toBe('OpenAI');
        expect(viewModel?.activeAccountDisplayLabel).toBe('Work account');
        expect(viewModel?.primaryValueSemantics).toBe('remaining');
        expect(viewModel?.badgeLabel).toBe('w. 18% left');
        expect(viewModel?.detailRightLabel).toBe('18% left · resets in 2h 0m 0s');
        expect(viewModel?.usedLimitLabel).toBe('82/100 used');
        expect(viewModel?.allMeterRows[0]?.detailRightSemantics).toBe('remaining');
        expect(viewModel?.allMeterRows[0]?.usedLimitSemantics).toBe('used');
        expect(viewModel?.allMeterRows[0]?.detailRightLabel).toBe('18% left · resets in 2h 0m 0s');
        expect(viewModel?.allMeterRows[0]?.usedLimitLabel).toBe('82/100 used');
    });

    it('shows seconds only after the usage limit is reached', () => {
        const resetAtMs = 2_000 + 2 * 60 * 60 * 1000;
        const label = (remainingPct: number | null, nowMs: number) => resolveConnectedServiceQuotaMeterDetailLabel({
            remainingPct, resetAtMs, nowMs, formatter,
        });
        expect(label(18, 2_000)).toBe('18% left · resets in 2h 0m');
        expect(label(18, 3_000)).toBe('18% left · resets in 1h 59m');
        expect(label(null, 3_000)).toBe('— left · resets in 1h 59m');
        expect(label(0, 2_000)).toBe('0% left · resets in 2h 0m 0s');
        expect(label(0, 3_000)).toBe('0% left · resets in 1h 59m 59s');
        expect(label(0, resetAtMs + 1)).toBe('0% left');
    });

    it('exposes the reset instant on each meter row so a live consumer can re-derive its label', () => {
        const resetAtMs = 2_000 + 2 * 60 * 60 * 1000;
        const rows = buildConnectedServiceQuotaGaugeMeterRows([
            meter({ meterId: 'session', label: 'Session', used: 82, limit: 100, utilizationPct: 82, resetsAt: resetAtMs }),
        ], 2_000, formatter);
        expect(rows[0]?.resetAtMs).toBe(resetAtMs);
    });

    it('drops the reset clause when the reset boundary already elapsed instead of composing "resets in outdated"', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: 35,
                    limit: 100,
                    // Snapshot predates its own reset boundary: the reset timestamp is in the past.
                    resetsAt: 1_000,
                }),
            ]),
            windowMode: 'weekly',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.detailRightLabel).toBe('65% left');
        expect(viewModel?.allMeterRows[0]?.detailRightLabel).toBe('65% left');
    });

    it('uses first-class remaining and used percentages from provider quota meters', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({
                    meterId: 'weekly',
                    label: 'Weekly',
                    usedPct: 82,
                    remainingPct: 18,
                    resetAtMs: 2_000 + 2 * 60 * 60 * 1000,
                }),
            ]),
            windowMode: 'weekly',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.remainingPct).toBe(18);
        expect(viewModel?.usedPct).toBe(82);
        expect(viewModel?.detailRightLabel).toBe('18% left · resets in 2h 0m 0s');
        expect(viewModel?.allMeterRows[0]?.remainingPct).toBe(18);
        expect(viewModel?.allMeterRows[0]?.usedPct).toBe(82);
    });

    it('summarizes available recovery credits with the next expiry', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: {
                ...snapshot([
                    meter({ meterId: 'weekly', label: 'Weekly', used: 82, limit: 100 }),
                ]),
                recoveryCredits: {
                    kind: 'usage_limit_resets',
                    availableCount: 2,
                    nextExpiresAtMs: 12_000,
                    credits: [
                        { providerCreditId: 'reset-credit-1', kind: 'usage_limit_reset', status: 'available', expiresAtMs: 11_000 },
                        { providerCreditId: 'reset-credit-2', kind: 'usage_limit_reset', status: 'available', expiresAtMs: 13_000 },
                        { kind: 'usage_limit_reset', status: 'redeemed', expiresAtMs: 9_000 },
                        { kind: 'usage_limit_reset', status: 'available', expiresAtMs: 1_500 },
                    ],
                },
            },
            windowMode: 'weekly',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.recoveryCreditSummary).toEqual({
            availableCount: 2,
            nextExpiresAtMs: 11_000,
            providerCreditId: 'reset-credit-1',
        });
    });

    it('uses the authoritative aggregate recovery summary when detailed credits are incomplete', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: {
                ...snapshot([
                    meter({ meterId: 'weekly', label: 'Weekly', used: 82, limit: 100 }),
                ]),
                recoveryCredits: {
                    kind: 'usage_limit_resets',
                    availableCount: 2,
                    nextExpiresAtMs: 12_000,
                    credits: [
                        { kind: 'usage_limit_reset', status: 'redeemed', expiresAtMs: 13_000 },
                        { kind: 'usage_limit_reset', status: 'available', expiresAtMs: 1_500 },
                    ],
                },
            },
            windowMode: 'weekly',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.recoveryCreditSummary).toEqual({
            availableCount: 2,
            nextExpiresAtMs: 12_000,
            providerCreditId: null,
        });
    });

    it('returns null when no reliable quota meter exists', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({ meterId: 'capacity', label: 'Capacity', used: 99, limit: 100, status: 'unavailable' }),
            ]),
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel).toBeNull();
    });

    it('hides unsupported sessions and native auth without reliable evidence', () => {
        expect(resolveConnectedServiceQuotaGaugeSource({
            providerId: 'codex',
            sourceKind: 'unsupported',
            reason: 'codex_non_app_server',
            snapshot: null,
        })).toBeNull();

        expect(resolveConnectedServiceQuotaGaugeSource({
            providerId: 'claude',
            sourceKind: 'native_auth',
            snapshot: null,
        })).toBeNull();
    });

    it('accepts connected groups, single profiles, native auth snapshots, and Codex native app-server snapshots', () => {
        const quotaSnapshot = snapshot([
            meter({ meterId: 'weekly', label: 'Weekly', used: 82, limit: 100 }),
        ]);

        expect(resolveConnectedServiceQuotaGaugeSource({
            providerId: 'codex',
            sourceKind: 'connected_service_group',
            snapshot: quotaSnapshot,
        })?.snapshot).toBe(quotaSnapshot);
        expect(resolveConnectedServiceQuotaGaugeSource({
            providerId: 'claude',
            sourceKind: 'connected_service_profile',
            snapshot: quotaSnapshot,
        })?.snapshot).toBe(quotaSnapshot);
        expect(resolveConnectedServiceQuotaGaugeSource({
            providerId: 'codex',
            sourceKind: 'codex_app_server_native',
            snapshot: quotaSnapshot,
        })?.snapshot).toBe(quotaSnapshot);
        const nativeAuthSource = resolveConnectedServiceQuotaGaugeSource({
            providerId: 'claude',
            sourceKind: 'native_auth',
            snapshot: quotaSnapshot,
        });
        expect(nativeAuthSource?.snapshot).toBe(quotaSnapshot);
        expect(nativeAuthSource?.checkNowSupported).toBe(false);
    });

    it('allows Claude native only after runtime quota evidence exists', () => {
        const quotaSnapshot = snapshot([
            meter({ meterId: 'five_hour', label: '5 hour', used: 60, limit: 100 }),
        ]);

        expect(resolveConnectedServiceQuotaGaugeSource({
            providerId: 'claude',
            sourceKind: 'native_runtime_evidence',
            snapshot: quotaSnapshot,
        })?.snapshot).toBe(quotaSnapshot);
    });

    it('preserves reset credits on runtime-evidence session gauges', () => {
        const recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 = {
            kind: 'usage_limit_resets',
            availableCount: 1,
            credits: [
                { kind: 'usage_limit_reset', status: 'available', expiresAtMs: 9_000 },
            ],
            nextExpiresAtMs: 9_000,
        };
        const quotaSnapshot = {
            ...snapshot([
                meter({ meterId: 'weekly', label: 'Weekly', used: 82, limit: 100 }),
            ]),
            recoveryCredits,
        };
        const params: Parameters<typeof selectConnectedServiceSessionProviderUsageGaugeSource>[0] & {
            recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1;
        } = {
            providerId: 'codex',
            connectedServiceSnapshot: quotaSnapshot,
            connectedServiceRefProvenance: 'connected_binding_profile',
            sessionCheckNowSupported: true,
            recoveryCredits,
            runtimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'usage_limit',
                source: 'usage_limit',
                occurredAt: 1_000,
                provider: 'codex',
                usageLimit: {
                    v: 1,
                    resetAtMs: 8_200_000,
                    retryAfterMs: null,
                    quotaScope: 'account',
                    recoverability: 'manual',
                    limitCategory: 'usage_limit',
                    quotaSnapshotRef: {
                        serviceId: 'openai-codex',
                        profileId: 'work',
                        fetchedAtMs: 2_000,
                    },
                    effectiveMeterId: 'weekly',
                    effectiveRemainingPct: 7,
                },
            },
        };

        const source = selectConnectedServiceSessionProviderUsageGaugeSource(params);

        expect(source?.snapshot.source).toBe('runtime_event');
        expect(source?.snapshot.recoveryCredits).toBe(recoveryCredits);
        expect(computeConnectedServiceQuotaGaugeViewModel({
            snapshot: source?.snapshot ?? null,
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        })?.recoveryCreditSummary).toEqual({
            availableCount: 1,
            nextExpiresAtMs: 9_000,
            providerCreditId: null,
        });
    });

    it('lets a same-profile connected-service snapshot with no credits beat stale metadata credits', () => {
        const staleMetadataCredits: ConnectedServiceQuotaRecoveryCreditsV1 = {
            kind: 'usage_limit_resets',
            availableCount: 1,
            credits: [
                { kind: 'usage_limit_reset', status: 'available', expiresAtMs: 9_000 },
            ],
            nextExpiresAtMs: 9_000,
        };
        const consumedSnapshot = snapshot([
            meter({ meterId: 'weekly', label: 'Weekly', used: 82, limit: 100 }),
        ]);

        const source = selectConnectedServiceSessionProviderUsageGaugeSource({
            providerId: 'codex',
            connectedServiceSnapshot: consumedSnapshot,
            connectedServiceRefProvenance: 'connected_binding_profile',
            sessionCheckNowSupported: true,
            recoveryCredits: staleMetadataCredits,
            runtimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'usage_limit',
                source: 'usage_limit',
                occurredAt: 1_000,
                provider: 'codex',
                usageLimit: {
                    v: 1,
                    resetAtMs: 8_200_000,
                    retryAfterMs: null,
                    quotaScope: 'account',
                    recoverability: 'manual',
                    limitCategory: 'usage_limit',
                    quotaSnapshotRef: {
                        serviceId: 'openai-codex',
                        profileId: 'work',
                        fetchedAtMs: 2_000,
                    },
                    effectiveMeterId: 'weekly',
                    effectiveRemainingPct: 7,
                },
            },
        });

        expect(source?.snapshot.source).toBe('runtime_event');
        expect(source?.snapshot.recoveryCredits).toBeUndefined();
        expect(computeConnectedServiceQuotaGaugeViewModel({
            snapshot: source?.snapshot ?? null,
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        })?.recoveryCreditSummary).toBeNull();
    });

    it('still applies metadata recovery credits when no connected-service snapshot is available', () => {
        const metadataCredits: ConnectedServiceQuotaRecoveryCreditsV1 = {
            kind: 'usage_limit_resets',
            availableCount: 1,
            credits: [
                { kind: 'usage_limit_reset', status: 'available', expiresAtMs: 9_000 },
            ],
            nextExpiresAtMs: 9_000,
        };

        const source = selectConnectedServiceSessionProviderUsageGaugeSource({
            providerId: 'codex',
            connectedServiceSnapshot: null,
            connectedServiceRefProvenance: null,
            sessionCheckNowSupported: true,
            recoveryCredits: metadataCredits,
            runtimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'usage_limit',
                source: 'usage_limit',
                occurredAt: 1_000,
                provider: 'codex',
                usageLimit: {
                    v: 1,
                    resetAtMs: 8_200_000,
                    retryAfterMs: null,
                    quotaScope: 'account',
                    recoverability: 'manual',
                    limitCategory: 'usage_limit',
                    quotaSnapshotRef: {
                        serviceId: 'openai-codex',
                        profileId: 'work',
                        fetchedAtMs: 2_000,
                    },
                    effectiveMeterId: 'weekly',
                    effectiveRemainingPct: 7,
                },
            },
        });

        expect(source?.snapshot.recoveryCredits).toBe(metadataCredits);
    });

    it('marks Gemini check-now support only for connected-service sources', () => {
        const quotaSnapshot = snapshot([
            meter({ meterId: 'daily', label: 'Daily', used: 40, limit: 100 }),
        ]);

        expect(resolveConnectedServiceQuotaGaugeSource({
            providerId: 'gemini',
            sourceKind: 'connected_service_profile',
            snapshot: quotaSnapshot,
        })?.checkNowSupported).toBe(true);
        expect(resolveConnectedServiceQuotaGaugeSource({
            providerId: 'gemini',
            sourceKind: 'native_runtime_evidence',
            snapshot: quotaSnapshot,
        })?.checkNowSupported).toBe(false);
    });

    it('derives a reliable provider usage projection from runtime quota windows', () => {
        const quotaSnapshot = deriveConnectedServiceQuotaSnapshotFromRuntimeIssue({
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            occurredAt: 1_000,
            provider: 'codex',
            usageLimit: {
                v: 1,
                resetAtMs: 8_200_000,
                retryAfterMs: null,
                quotaScope: 'account',
                recoverability: 'wait',
                limitCategory: 'usage_limit',
                quotaSnapshotRef: { serviceId: 'openai-codex', profileId: 'work', groupId: 'codex-main', fetchedAtMs: 2_000 },
                effectiveMeterId: 'weekly',
                effectiveRemainingPct: 7,
                allWindows: [
                    { meterId: 'daily', scope: 'daily', remainingPct: 42, resetAtMs: 3_000, status: 'ok' },
                    { meterId: 'weekly', scope: 'weekly', remainingPct: 7, resetAtMs: 4_000, status: 'ok' },
                ],
            },
        });

        expect(quotaSnapshot?.serviceId).toBe('openai-codex');
        expect(quotaSnapshot?.profileId).toBe('work');
        expect(quotaSnapshot?.accountLabel).toBe('codex-main');
        expect(quotaSnapshot?.meters.map((quotaMeter) => quotaMeter.meterId)).toEqual(['daily', 'weekly']);

        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: quotaSnapshot,
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        });
        expect(viewModel?.effectiveMeter.meterId).toBe('weekly');
        expect(viewModel?.badgeLabel).toBe('7% left');
    });

    it('derives a provisional native provider usage projection from runtime quota evidence without a connected-service ref', () => {
        const quotaSnapshot = deriveConnectedServiceQuotaSnapshotFromRuntimeIssue({
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            occurredAt: 1_000,
            provider: 'claude',
            usageLimit: {
                v: 1,
                resetAtMs: 8_200_000,
                retryAfterMs: null,
                quotaScope: 'account',
                recoverability: 'wait',
                limitCategory: 'usage_limit',
                planType: 'max',
                effectiveMeterId: 'five_hour',
                effectiveRemainingPct: 12,
            },
        });

        // Resolved through the agents registry: the first supported connected
        // service id is the provider's canonical native default (matches the
        // CLI adapters' defaultNativeServiceId for Claude).
        expect(quotaSnapshot?.serviceId).toBe('claude-subscription');
        expect(quotaSnapshot?.profileId).toBe('native');
        expect(quotaSnapshot?.providerId).toBe('claude');
        expect(quotaSnapshot?.accountLabel).toBeNull();
        expect(quotaSnapshot?.source).toBe('runtime_event');
        expect(quotaSnapshot?.meters[0]?.meterId).toBe('five_hour');

        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: quotaSnapshot,
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        });
        expect(viewModel?.effectiveMeter.meterId).toBe('five_hour');
        expect(viewModel?.badgeLabel).toBe('12% left');
    });

    it('keeps an exhausted gauge (0% left) when a usage-limit issue carries no percentage', () => {
        const quotaSnapshot = deriveConnectedServiceQuotaSnapshotFromRuntimeIssue({
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            occurredAt: 1_000,
            provider: 'codex',
            usageLimit: {
                v: 1,
                resetAtMs: 8_200_000,
                retryAfterMs: null,
                quotaScope: 'account',
                recoverability: 'wait',
                limitCategory: 'usage_limit',
            },
        });

        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: quotaSnapshot,
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        });
        expect(viewModel?.remainingPct).toBe(0);
        expect(viewModel?.ringValueLabel).toBe('0');
    });

    it('orders nested rings outermost-first by window length', () => {
        const vm = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({ meterId: 'seven_day', label: 'Weekly', utilizationPct: 20 }),
                meter({ meterId: 'five_hour', label: 'Session', utilizationPct: 70 }),
            ]),
            windowMode: 'most_constrained',
            windowModes: ['session', 'weekly'],
            nowMs: 2_000,
            formatter,
        });
        // Longest period outermost, so the shorter 5-hour window is the inner ring.
        expect(vm?.usageRings.map((ring) => ring.meterId)).toEqual(['seven_day', 'five_hour']);
    });

    it('ignores a usage-limit issue whose reset time has already passed', () => {
        const issue = {
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            occurredAt: 1_000,
            provider: 'codex',
            usageLimit: {
                v: 1,
                resetAtMs: 5_000,
                retryAfterMs: null,
                quotaScope: 'account',
                recoverability: 'wait',
                limitCategory: 'usage_limit',
            },
        } as const;

        expect(selectConnectedServiceSessionProviderUsageGaugeSource({
            providerId: 'codex', connectedServiceSnapshot: null, connectedServiceRefProvenance: null,
            runtimeIssue: issue, nowMs: 4_000,
        })?.snapshot.meters[0]?.remainingPct).toBe(0);
        expect(selectConnectedServiceSessionProviderUsageGaugeSource({
            providerId: 'codex', connectedServiceSnapshot: null, connectedServiceRefProvenance: null,
            runtimeIssue: issue, nowMs: 6_000,
        })).toBeNull();
    });

    it('resolves runtime-evidence service ids through the agents registry for every connected-services provider', () => {
        const buildIssue = (provider: string) => ({
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            occurredAt: 1_000,
            provider,
            usageLimit: {
                v: 1,
                resetAtMs: 8_200_000,
                retryAfterMs: null,
                quotaScope: 'account',
                recoverability: 'wait',
                limitCategory: 'usage_limit',
                effectiveMeterId: 'five_hour',
                effectiveRemainingPct: 12,
            },
        } as const);

        expect(deriveConnectedServiceQuotaSnapshotFromRuntimeIssue(buildIssue('codex'))?.serviceId).toBe('openai-codex');
        expect(deriveConnectedServiceQuotaSnapshotFromRuntimeIssue(buildIssue('gemini'))?.serviceId).toBe('gemini');
        // Multi-vendor agents fall back to their first supported service id when
        // the runtime issue carries no connected-service ref.
        expect(deriveConnectedServiceQuotaSnapshotFromRuntimeIssue(buildIssue('opencode'))?.serviceId).toBe('openai-codex');
        expect(deriveConnectedServiceQuotaSnapshotFromRuntimeIssue(buildIssue('pi'))?.serviceId).toBe('openai-codex');
        // Providers without connected-services support stay gauge-less.
        expect(deriveConnectedServiceQuotaSnapshotFromRuntimeIssue(buildIssue('auggie'))).toBeNull();
        expect(deriveConnectedServiceQuotaSnapshotFromRuntimeIssue(buildIssue('not-a-real-provider'))).toBeNull();
    });

    it('derives native Claude usage projections from runtime connected-service evidence when no snapshot ref exists', () => {
        const quotaSnapshot = deriveConnectedServiceQuotaSnapshotFromRuntimeIssue({
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            occurredAt: 1_000,
            provider: 'claude',
            usageLimit: {
                v: 1,
                resetAtMs: 8_200_000,
                retryAfterMs: null,
                quotaScope: 'account',
                recoverability: 'wait',
                limitCategory: 'usage_limit',
                planType: 'max',
                effectiveMeterId: 'daily_tokens',
                effectiveRemainingPct: 0,
                connectedService: {
                    serviceId: 'claude-subscription',
                    profileId: 'native:1234567890abcdef1234567890abcdef1234567890abcdef',
                    groupId: null,
                },
            },
        });

        expect(quotaSnapshot?.serviceId).toBe('claude-subscription');
        expect(quotaSnapshot?.profileId).toBe('native:1234567890abcdef1234567890abcdef1234567890abcdef');
        expect(quotaSnapshot?.accountLabel).toBeNull();
    });

    it('derives runtime quota projections from utilization-only usage evidence', () => {
        const quotaSnapshot = deriveConnectedServiceQuotaSnapshotFromRuntimeIssue({
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            occurredAt: 1_000,
            provider: 'claude',
            usageLimit: {
                v: 1,
                resetAtMs: 8_200_000,
                retryAfterMs: null,
                quotaScope: 'account',
                recoverability: 'wait',
                limitCategory: 'usage_limit',
                providerLimitId: 'daily_tokens',
                utilization: 73,
                connectedService: {
                    serviceId: 'claude-subscription',
                    profileId: 'native:1234567890abcdef1234567890abcdef1234567890abcdef',
                    groupId: null,
                },
            },
        });

        expect(quotaSnapshot?.serviceId).toBe('claude-subscription');
        expect(quotaSnapshot?.profileId).toBe('native:1234567890abcdef1234567890abcdef1234567890abcdef');
        expect(quotaSnapshot?.meters).toEqual([
            expect.objectContaining({
                meterId: 'daily_tokens',
                remainingPct: 27,
                utilizationPct: 73,
                resetAtMs: 8_200_000,
            }),
        ]);
    });

    it('does not present connected-service group ids as account labels for runtime projections', () => {
        const quotaSnapshot = deriveConnectedServiceQuotaSnapshotFromRuntimeIssue({
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            occurredAt: 1_000,
            provider: 'codex',
            usageLimit: {
                v: 1,
                resetAtMs: 3_000,
                retryAfterMs: null,
                quotaScope: 'account',
                recoverability: 'wait',
                limitCategory: 'usage_limit',
                quotaSnapshotRef: { serviceId: 'openai-codex', groupId: 'codex-main', fetchedAtMs: 2_000 },
                effectiveMeterId: 'weekly',
                effectiveRemainingPct: 18,
            },
        });

        expect(quotaSnapshot?.profileId).toBe('runtime');
        expect(quotaSnapshot?.accountLabel).toBe('codex-main');
    });

    it('prefers session runtime quota evidence over launch-time connected profile polling', () => {
        const launchTimeProfileSnapshot = snapshot([
            meter({ meterId: 'weekly', label: 'Weekly', used: 10, limit: 100 }),
        ]);
        const selected = selectConnectedServiceSessionProviderUsageGaugeSource({
            providerId: 'codex',
            connectedServiceSnapshot: launchTimeProfileSnapshot,
            connectedServiceRefProvenance: 'connected_binding_profile',
            runtimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'usage_limit',
                source: 'usage_limit',
                occurredAt: 2_000,
                provider: 'codex',
                usageLimit: {
                    v: 1,
                    resetAtMs: 3_000,
                    retryAfterMs: null,
                    quotaScope: 'account',
                    recoverability: 'wait',
                    limitCategory: 'usage_limit',
                    quotaSnapshotRef: { serviceId: 'openai-codex', profileId: 'backup', groupId: 'main', fetchedAtMs: 2_000 },
                    effectiveMeterId: 'weekly',
                    effectiveRemainingPct: 18,
                },
            },
        });

        expect(selected?.sourceKind).toBe('native_runtime_evidence');
        expect(selected?.snapshot.profileId).toBe('backup');
        expect(selected?.snapshot.meters[0]?.remainingPct).toBe(18);
    });

    it('keeps fresher connected account usage ahead of stale runtime quota evidence', () => {
        const freshProfileSnapshot: ConnectedServiceQuotaSnapshotV1 = {
            ...snapshot([
                meter({ meterId: 'weekly', label: 'Weekly', used: 10, limit: 100, remainingPct: 90 }),
            ]),
            fetchedAt: 100_000,
            staleAfterMs: 60_000,
        };

        const selected = selectConnectedServiceSessionProviderUsageGaugeSource({
            providerId: 'codex',
            connectedServiceSnapshot: freshProfileSnapshot,
            connectedServiceRefProvenance: 'connected_binding_profile',
            runtimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'usage_limit',
                source: 'usage_limit',
                occurredAt: 1_000,
                provider: 'codex',
                usageLimit: {
                    v: 1,
                    resetAtMs: 30_000,
                    retryAfterMs: null,
                    quotaScope: 'account',
                    recoverability: 'wait',
                    limitCategory: 'usage_limit',
                    quotaSnapshotRef: { serviceId: 'openai-codex', profileId: 'backup', groupId: 'main', fetchedAtMs: 1_000 },
                    effectiveMeterId: 'weekly',
                    effectiveRemainingPct: 18,
                },
            },
        });

        expect(selected?.sourceKind).toBe('connected_service_profile');
        expect(selected?.snapshot.profileId).toBe('work');
        expect(selected?.snapshot.meters[0]?.remainingPct).toBe(90);
    });

    it('shows a newly refreshed shared snapshot instead of an older runtime report for the same profile', () => {
        const shared = { ...snapshot([meter({ meterId: 'weekly', label: 'Weekly', remainingPct: 90 })]), fetchedAt: 2_000 };
        const issue = {
            v: 1 as const, scope: 'primary_session' as const, status: 'failed' as const,
            code: 'usage_limit' as const, source: 'usage_limit' as const, occurredAt: 1_000, provider: 'codex',
            usageLimit: {
                v: 1 as const, resetAtMs: 30_000, retryAfterMs: null, quotaScope: 'account' as const,
                recoverability: 'wait' as const, limitCategory: 'usage_limit' as const,
                quotaSnapshotRef: { serviceId: 'openai-codex' as const, profileId: 'work', fetchedAtMs: 1_000 },
                effectiveMeterId: 'weekly', effectiveRemainingPct: 18,
            },
        };
        const selected = selectConnectedServiceSessionProviderUsageGaugeSource({
            providerId: 'codex', connectedServiceSnapshot: shared,
            connectedServiceRefProvenance: 'connected_binding_profile', runtimeIssue: issue,
        });
        expect(selected?.snapshot.meters[0]?.remainingPct).toBe(90);

        const { quotaSnapshotRef: _ref, ...nativeLimit } = issue.usageLimit;
        const native = selectConnectedServiceSessionProviderUsageGaugeSource({
            providerId: 'codex', connectedServiceSnapshot: { ...shared, profileId: 'acct:shared' },
            connectedServiceRefProvenance: 'published_quota_ref', runtimeIssue: { ...issue, usageLimit: nativeLimit },
        });
        expect(native?.snapshot.meters[0]?.remainingPct).toBe(90);
    });

    it('classifies session gauge sources from ref provenance through the gauge-source matrix', () => {
        const polledSnapshot = snapshot([
            meter({ meterId: 'weekly', label: 'Weekly', used: 10, limit: 100 }),
        ]);

        expect(selectConnectedServiceSessionProviderUsageGaugeSource({
            providerId: 'codex',
            connectedServiceSnapshot: polledSnapshot,
            connectedServiceRefProvenance: 'connected_binding_group',
            runtimeIssue: null,
        })?.sourceKind).toBe('connected_service_group');

        expect(selectConnectedServiceSessionProviderUsageGaugeSource({
            providerId: 'claude',
            connectedServiceSnapshot: polledSnapshot,
            connectedServiceRefProvenance: 'connected_binding_profile',
            runtimeIssue: null,
        })?.sourceKind).toBe('connected_service_profile');

        const nativeSnapshot = { ...polledSnapshot, profileId: 'acct:1234' };
        const appServerNative = selectConnectedServiceSessionProviderUsageGaugeSource({
            providerId: 'codex',
            connectedServiceSnapshot: nativeSnapshot,
            connectedServiceRefProvenance: 'published_quota_ref',
            sessionCheckNowSupported: true,
            runtimeIssue: null,
        });
        expect(appServerNative?.sourceKind).toBe('codex_app_server_native');
        expect(appServerNative?.checkNowSupported).toBe(true);

        const nativeAuth = selectConnectedServiceSessionProviderUsageGaugeSource({
            providerId: 'claude',
            connectedServiceSnapshot: { ...polledSnapshot, profileId: 'native:5678' },
            connectedServiceRefProvenance: 'published_quota_ref',
            sessionCheckNowSupported: false,
            runtimeIssue: null,
        });
        expect(nativeAuth?.sourceKind).toBe('native_auth');
        expect(nativeAuth?.checkNowSupported).toBe(false);

        expect(selectConnectedServiceSessionProviderUsageGaugeSource({
            providerId: 'codex',
            connectedServiceSnapshot: { ...polledSnapshot, profileId: 'work' },
            connectedServiceRefProvenance: 'published_quota_ref',
            runtimeIssue: null,
        })?.sourceKind).toBe('connected_service_profile');

        // No session ref provenance for the snapshot: suppress explicitly
        // instead of rendering a gauge with unknown provenance.
        expect(selectConnectedServiceSessionProviderUsageGaugeSource({
            providerId: 'codex',
            connectedServiceSnapshot: polledSnapshot,
            connectedServiceRefProvenance: null,
            runtimeIssue: null,
        })).toBeNull();

        expect(selectConnectedServiceSessionProviderUsageGaugeSource({
            providerId: 'codex',
            connectedServiceSnapshot: null,
            connectedServiceRefProvenance: null,
            runtimeIssue: null,
        })).toBeNull();
    });

    it('does not derive a provider usage projection for auth, plan, capacity, or validation runtime issues', () => {
        for (const limitCategory of ['auth_invalid', 'plan_invalid', 'capacity', 'validation_failed'] as const) {
            expect(deriveConnectedServiceQuotaSnapshotFromRuntimeIssue({
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'usage_limit',
                source: 'usage_limit',
                occurredAt: 1_000,
                usageLimit: {
                    v: 1,
                    resetAtMs: null,
                    retryAfterMs: null,
                    quotaScope: 'account',
                    recoverability: 'manual',
                    limitCategory,
                    quotaSnapshotRef: { serviceId: 'openai-codex' },
                    allWindows: [
                        { meterId: 'weekly', scope: 'weekly', remainingPct: 7, resetAtMs: 4_000, status: 'ok' },
                    ],
                },
            })).toBeNull();
        }
    });
});
