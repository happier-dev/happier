import { describe, expect, it } from 'vitest';
import type {
    ConnectedServiceQuotaMeterV1,
    ConnectedServiceQuotaRecoveryCreditsV1,
    ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import {
    type ConnectedServiceQuotaGaugeLabelFormatter,
    computeConnectedServiceQuotaGaugeViewModel,
    deriveConnectedServiceQuotaSnapshotFromRuntimeIssue,
    selectConnectedServiceSessionProviderUsageSnapshot,
    summarizeConnectedServiceQuotaRecoveryCredits,
} from './connectedServiceQuotaGauge';
import {
    QUOTA_REMAINING_CRITICAL_THRESHOLD_PCT,
    QUOTA_REMAINING_WARNING_THRESHOLD_PCT,
} from './resolveQuotaTone';

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
    remaining: ({ percent }) => `${percent} left`,
    remainingWithReset: ({ percent, reset }) => `${percent} left · resets in ${reset}`,
    used: ({ used, limit }) => `${used}/${limit} used`,
    durationNow: () => 'now',
    durationOutdated: () => 'outdated',
    durationDaysHours: ({ days, hours }) => `${days}d ${hours}h`,
    durationHoursMinutes: ({ hours, minutes }) => `${hours}h ${minutes}m`,
    durationHours: ({ hours }) => `${hours}h`,
    durationMinutes: ({ minutes }) => `${minutes}m`,
};

describe('gauge tone boundaries derive from the canonical resolveQuotaTone owner', () => {
    function toneAtRemaining(remainingPct: number) {
        const used = 100 - remainingPct;
        return computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([meter({ meterId: 'daily', label: 'Daily', used, limit: 100, remainingPct })]),
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        })?.tone;
    }

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
            .toEqual([['daily-fable', '60'], ['weekly-fable', '40'], ['short-fable', '80']]);
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

    it('flips warning/critical exactly at the shared threshold constants (no local copies)', () => {
        // Guards against re-introducing duplicated threshold literals: the gauge
        // must reuse `resolveQuotaTone`'s constants, so these boundaries move in
        // lockstep with the canonical owner if it ever changes.
        expect(toneAtRemaining(QUOTA_REMAINING_WARNING_THRESHOLD_PCT + 1)).toBe('neutral');
        expect(toneAtRemaining(QUOTA_REMAINING_WARNING_THRESHOLD_PCT)).toBe('warning');
        expect(toneAtRemaining(QUOTA_REMAINING_CRITICAL_THRESHOLD_PCT + 1)).toBe('warning');
        expect(toneAtRemaining(QUOTA_REMAINING_CRITICAL_THRESHOLD_PCT)).toBe('critical');
    });
});

describe('computeConnectedServiceQuotaGaugeViewModel', () => {
    it('uses readable stored window labels for composer rows and rings without changing raw snapshots', () => {
        const ids = ['five_hour', 'seven_day', 'seven_day_all', 'seven_day_fable', 'spend', 'future_api_window'];
        const usage = snapshot(ids.map((meterId) => meter({ meterId, label: meterId, utilizationPct: 20 })));
        const vm = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: usage, windowMode: 'most_constrained', additionalMeterIds: ids,
            nowMs: 2_000, formatter,
        });
        const labels = ['5-hour', 'Weekly', 'Weekly (all models)', 'Weekly (Fable)', 'Spend', 'Future API Window'];
        expect(vm?.allMeterRows.map((row) => row.label)).toEqual(labels);
        expect(vm?.usageRings.map((ring) => ring.label)).toEqual(labels);
        expect(vm?.effectiveMeter.label).toBe('5-hour');
        expect(usage.meters.map((meter) => meter.label)).toEqual(ids);
    });

    it('hides empty quota placeholders while keeping valid zeroes, resets, and pins', () => {
        const vm = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({ meterId: 'full', label: 'Full', utilizationPct: 0 }),
                meter({ meterId: 'empty', label: 'Empty', utilizationPct: 100 }),
                meter({ meterId: 'placeholder', label: 'Placeholder', status: 'unavailable' }),
                meter({ meterId: 'reset', label: 'Reset', status: 'unavailable', resetAtMs: 62_000 }),
                meter({ meterId: 'expired', label: 'Expired', status: 'unavailable', resetsAt: 1_000 }),
                meter({ meterId: 'pinned', label: 'Pinned', status: 'unavailable' }),
            ]),
            windowMode: 'most_constrained', nowMs: 2_000, formatter,
        });
        expect(vm?.allMeterRows.map((row) => row.meterId)).toEqual(['full', 'empty', 'reset']);
        expect(vm?.remainingPct).toBe(0);
        expect(vm?.usageRings.map((ring) => ring.meterId)).toEqual(['empty']);
    });

    it('keeps the aggregate available count authoritative when detail rows are capped', () => {
        expect(summarizeConnectedServiceQuotaRecoveryCredits({
            availableCount: 3,
            credits: [{ id: 'detail-1', kind: 'usage_limit_reset', status: 'available' }],
        }, 1_000)).toEqual({
            availableCount: 3,
            nextExpiresAtMs: null,
            providerCreditId: 'detail-1',
        });
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
        expect(viewModel?.tone).toBe('warning');
        expect(viewModel?.allMeterRows.map((row) => row.meterId)).toEqual(['daily', 'weekly']);
    });

    it('does not compare quota windows against rate or capacity families in most-constrained mode', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({ meterId: 'weekly', label: 'Weekly', used: 82, limit: 100, unit: 'count', details: { limitCategory: 'usage_limit' } }),
                meter({ meterId: 'daily', label: 'Daily', used: 50, limit: 100, unit: 'count', details: { limitCategory: 'usage_limit' } }),
                meter({ meterId: 'requests', label: 'Requests', used: 99, limit: 100, unit: 'requests', details: { limitCategory: 'rate_limit' } }),
                meter({ meterId: 'reached', label: 'Reached', status: 'unavailable', resetsAt: 9_000, details: { limitCategory: 'usage_limit' } }),
                meter({ meterId: 'server_capacity', label: 'Server capacity', used: 100, limit: 100, unit: 'requests', details: { limitCategory: 'capacity' } }),
            ]),
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.effectiveMeter.meterId).toBe('weekly');
        expect(viewModel?.allMeterRows.map((row) => row.meterId)).toEqual(['weekly', 'daily', 'requests', 'reached']);
        expect(viewModel?.allMeterRows.find((row) => row.meterId === 'reached')).toMatchObject({ remainingPct: null, usedPct: null, resetsAt: 9_000 });
        expect(viewModel?.usageRings.map((ring) => ring.meterId)).toEqual(['weekly']);
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

    it('reads Claude seven_day windows as weekly, not daily', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({ meterId: 'five_hour', label: '5-hour', used: 10, limit: 100 }),
                meter({ meterId: 'seven_day', label: 'Weekly', used: 40, limit: 100 }),
            ]),
            windowMode: 'weekly',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.effectiveMeter.meterId).toBe('seven_day');
        expect(viewModel?.badgeLabel).toBe('w. 60% left');
    });

    it('shows one most-constrained ring by default and selected global windows, remaining-first', () => {
        const usageSnapshot = snapshot([
            meter({ meterId: 'five_hour', label: '5-hour', utilizationPct: 10, unit: 'unknown' }),
            meter({ meterId: 'seven_day', label: 'Weekly', utilizationPct: 25, unit: 'unknown' }),
            meter({ meterId: 'seven_day_fable', label: 'Weekly (Fable)', utilizationPct: 61, unit: 'unknown' }),
        ]);
        const params = { snapshot: usageSnapshot, windowMode: 'most_constrained' as const, nowMs: 2_000, formatter };
        expect(computeConnectedServiceQuotaGaugeViewModel(params)?.usageRings.map((ring) => ring.meterId))
            .toEqual(['seven_day_fable']);
        const rings = computeConnectedServiceQuotaGaugeViewModel({
            ...params, windowModes: ['weekly', 'session', 'session'],
        })?.usageRings;
        expect(rings?.map((ring) => [ring.meterId, ring.ringValueLabel, ring.valueLabel])).toEqual([
            ['seven_day_fable', '39', '39% left'],
            ['five_hour', '90', '90% left'],
        ]);
    });

    it('formats remaining-first detail rows with reset and usage labels', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: 82,
                    limit: 100,
                    resetsAt: 2_000 + 2 * 60 * 60 * 1_000,
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
        expect(viewModel?.detailRightLabel).toBe('18% left · resets in 2h');
        expect(viewModel?.usedLimitLabel).toBe('82/100 used');
        expect(viewModel?.allMeterRows[0]?.detailRightSemantics).toBe('remaining');
        expect(viewModel?.allMeterRows[0]?.usedLimitSemantics).toBe('used');
        expect(viewModel?.allMeterRows[0]?.detailRightLabel).toBe('18% left · resets in 2h');
        expect(viewModel?.allMeterRows[0]?.usedLimitLabel).toBe('82/100 used');
    });

    it('formats past reset timestamps as outdated instead of now', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: 82,
                    limit: 100,
                    resetsAt: 1_000,
                }),
            ]),
            windowMode: 'weekly',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.detailRightLabel).toBe('18% left · resets in outdated');
        expect(viewModel?.allMeterRows[0]?.resetLabel).toBe('outdated');
        // The row keeps the reset instant so a quota row can say when it comes back.
        expect(viewModel?.allMeterRows[0]?.resetsAt).toBe(1_000);
    });

    it('summarizes available recovery credits on the canonical quota gauge view-model', () => {
        const quotaSnapshot = {
            ...snapshot([
                meter({ meterId: 'weekly', label: 'Weekly', used: 82, limit: 100 }),
            ]),
            recoveryCredits: {
                availableCount: 2,
                credits: [
                    {
                        id: 'reset-credit-1',
                        kind: 'usage_limit_reset',
                        status: 'available',
                        expiresAtMs: 3_000,
                    },
                    {
                        id: 'reset-credit-2',
                        kind: 'usage_limit_reset',
                        status: 'available',
                        expiresAtMs: 5_000,
                    },
                    {
                        id: 'reset-credit-3',
                        kind: 'usage_limit_reset',
                        status: 'redeemed',
                        expiresAtMs: 2_500,
                    },
                ],
            },
        } satisfies ConnectedServiceQuotaSnapshotV1;

        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: quotaSnapshot,
            windowMode: 'weekly',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.recoveryCreditSummary).toEqual({
            availableCount: 2,
            nextExpiresAtMs: 3_000,
            providerCreditId: 'reset-credit-1',
        });
    });

    it('preserves reset credits on runtime-evidence session gauges', () => {
        const recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 = {
            availableCount: 1,
            credits: [
                {
                    id: 'reset-credit-1',
                    kind: 'usage_limit_reset',
                    status: 'available',
                    expiresAtMs: 9_000,
                },
            ],
        };
        const quotaSnapshot = {
            ...snapshot([
                meter({ meterId: 'weekly', label: 'Weekly', used: 82, limit: 100 }),
            ]),
            recoveryCredits,
        };
        const params: Parameters<typeof selectConnectedServiceSessionProviderUsageSnapshot>[0] & {
            recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1;
        } = {
            connectedServiceSnapshot: quotaSnapshot,
            recoveryCredits,
            runtimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'usage_limit',
                source: 'usage_limit',
                occurredAt: 1_000,
                agentId: 'codex',
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

        const selectedSnapshot = selectConnectedServiceSessionProviderUsageSnapshot(params);

        expect(selectedSnapshot?.source).toBe('runtime_event');
        expect(selectedSnapshot?.recoveryCredits).toBe(recoveryCredits);
        expect(computeConnectedServiceQuotaGaugeViewModel({
            snapshot: selectedSnapshot,
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        })?.recoveryCreditSummary).toEqual({
            availableCount: 1,
            nextExpiresAtMs: 9_000,
            providerCreditId: 'reset-credit-1',
        });
    });

    it('does not reattach stale recovery credits when the same connected-service snapshot has none', () => {
        const staleRecoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 = {
            availableCount: 1,
            credits: [
                {
                    id: 'stale-reset-credit',
                    kind: 'usage_limit_reset',
                    status: 'available',
                    expiresAtMs: 9_000,
                },
            ],
        };
        const quotaSnapshot = snapshot([
            meter({ meterId: 'weekly', label: 'Weekly', used: 82, limit: 100 }),
        ]);

        const selectedSnapshot = selectConnectedServiceSessionProviderUsageSnapshot({
            connectedServiceSnapshot: quotaSnapshot,
            recoveryCredits: staleRecoveryCredits,
            runtimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'usage_limit',
                source: 'usage_limit',
                occurredAt: 1_000,
                agentId: 'codex',
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

        expect(selectedSnapshot?.source).toBe('runtime_event');
        expect(selectedSnapshot?.recoveryCredits).toBeUndefined();
    });

    it('prefers a fresher connected-service snapshot over stale runtime issue evidence', () => {
        const connectedSnapshot = {
            ...snapshot([
                meter({ meterId: 'weekly', label: 'Weekly', used: 20, limit: 100, remainingPct: 80 }),
            ]),
            fetchedAt: 120_000,
        };

        const selectedSnapshot = selectConnectedServiceSessionProviderUsageSnapshot({
            connectedServiceSnapshot: connectedSnapshot,
            runtimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'usage_limit',
                source: 'usage_limit',
                occurredAt: 1_000,
                agentId: 'codex',
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
                        fetchedAtMs: 1_000,
                    },
                    effectiveMeterId: 'weekly',
                    effectiveRemainingPct: 7,
                },
            },
        });

        expect(selectedSnapshot).toBe(connectedSnapshot);
    });

    it('uses first-class remaining and used percentages from provider quota meters', () => {
        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({
                    meterId: 'weekly',
                    label: 'Weekly',
                    usedPct: 82,
                    remainingPct: 18,
                    resetAtMs: 2_000 + 2 * 60 * 60 * 1_000,
                }),
            ]),
            windowMode: 'weekly',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.remainingPct).toBe(18);
        expect(viewModel?.usedPct).toBe(82);
        expect(viewModel?.detailRightLabel).toBe('18% left · resets in 2h');
        expect(viewModel?.allMeterRows[0]?.remainingPct).toBe(18);
        expect(viewModel?.allMeterRows[0]?.usedPct).toBe(82);
    });

    it('derives a provider usage projection from runtime quota windows', () => {
        const quotaSnapshot = deriveConnectedServiceQuotaSnapshotFromRuntimeIssue({
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            occurredAt: 1_000,
            agentId: 'codex',
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

    it('projects a qualified runtime snapshot ref onto its released scalar quota identity', () => {
        const quotaSnapshot = deriveConnectedServiceQuotaSnapshotFromRuntimeIssue({
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            occurredAt: 1_000,
            agentId: 'codex',
            usageLimit: {
                v: 1,
                resetAtMs: 8_200_000,
                retryAfterMs: null,
                quotaScope: 'account',
                recoverability: 'wait',
                limitCategory: 'usage_limit',
                // What the canonical runtime-issue ingress actually produces.
                quotaSnapshotRef: { serviceId: 'happier.agent.codex/openai-codex', profileId: 'work', fetchedAtMs: 2_000 },
                effectiveMeterId: 'weekly',
                effectiveRemainingPct: 7,
            },
        });

        expect(quotaSnapshot?.serviceId).toBe('openai-codex');
        expect(quotaSnapshot?.profileId).toBe('work');
    });

    it('projects a qualified runtime connected-service key onto its released scalar quota identity', () => {
        const quotaSnapshot = deriveConnectedServiceQuotaSnapshotFromRuntimeIssue({
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            occurredAt: 1_000,
            agentId: 'claude',
            usageLimit: {
                v: 1,
                resetAtMs: 8_200_000,
                retryAfterMs: null,
                quotaScope: 'account',
                recoverability: 'wait',
                limitCategory: 'usage_limit',
                effectiveMeterId: 'five_hour',
                effectiveRemainingPct: 12,
                connectedService: {
                    serviceId: 'happier.agent.claude/claude-subscription',
                    profileId: 'work',
                    groupId: null,
                },
            },
        });

        expect(quotaSnapshot?.serviceId).toBe('claude-subscription');
    });

    it('does not attribute a novel external service quota to the agent default service', () => {
        const quotaSnapshot = deriveConnectedServiceQuotaSnapshotFromRuntimeIssue({
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            occurredAt: 1_000,
            agentId: 'codex',
            usageLimit: {
                v: 1,
                resetAtMs: 8_200_000,
                retryAfterMs: null,
                quotaScope: 'account',
                recoverability: 'wait',
                limitCategory: 'usage_limit',
                quotaSnapshotRef: { serviceId: 'acme.review/reviewer-service', profileId: 'work', fetchedAtMs: 2_000 },
                effectiveMeterId: 'weekly',
                effectiveRemainingPct: 7,
            },
        });

        expect(quotaSnapshot).toBeNull();
    });

    it('derives a provisional native provider usage projection from runtime quota evidence without a connected-service ref', () => {
        const quotaSnapshot = deriveConnectedServiceQuotaSnapshotFromRuntimeIssue({
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            occurredAt: 1_000,
            agentId: 'claude',
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

    it('resolves runtime issue provider aliases through the agent registry', () => {
        const quotaSnapshot = deriveConnectedServiceQuotaSnapshotFromRuntimeIssue({
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            occurredAt: 1_000,
            agentId: 'codex-acp',
            usageLimit: {
                v: 1,
                resetAtMs: 8_200_000,
                retryAfterMs: null,
                quotaScope: 'account',
                recoverability: 'wait',
                limitCategory: 'usage_limit',
                effectiveMeterId: 'weekly',
                effectiveRemainingPct: 7,
            },
        });

        expect(quotaSnapshot?.serviceId).toBe('openai-codex');
        expect(quotaSnapshot?.providerId).toBe('codex-acp');
    });

    it('derives native Claude usage projections from runtime connected-service evidence when no snapshot ref exists', () => {
        const quotaSnapshot = deriveConnectedServiceQuotaSnapshotFromRuntimeIssue({
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            occurredAt: 1_000,
            agentId: 'claude',
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

    it('does not present connected-service group ids as account labels for runtime projections', () => {
        const quotaSnapshot = deriveConnectedServiceQuotaSnapshotFromRuntimeIssue({
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'usage_limit',
            source: 'usage_limit',
            occurredAt: 1_000,
            agentId: 'codex',
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
        expect(quotaSnapshot?.accountLabel).toBeNull();
    });
});
