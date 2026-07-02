import { describe, expect, it } from 'vitest';
import type { ConnectedServiceQuotaMeterV1, ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import {
    type ConnectedServiceQuotaGaugeLabelFormatter,
    computeConnectedServiceQuotaGaugeViewModel,
    deriveConnectedServiceQuotaSnapshotFromRuntimeIssue,
    resolveConnectedServiceQuotaGaugeSource,
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
    remaining: ({ percent }) => `${percent} left`,
    remainingWithReset: ({ percent, reset }) => `${percent} left · resets in ${reset}`,
    used: ({ used, limit }) => `${used}/${limit} used`,
    durationNow: () => 'now',
    durationDaysHours: ({ days, hours }) => `${days}d ${hours}h`,
    durationHoursMinutes: ({ hours, minutes }) => `${hours}h ${minutes}m`,
    durationHours: ({ hours }) => `${hours}h`,
    durationMinutes: ({ minutes }) => `${minutes}m`,
};

describe('computeConnectedServiceQuotaGaugeViewModel', () => {
    it('selects the reliable meter with the least remaining quota for most_constrained mode', () => {
        const capacityDetails: ConnectedServiceQuotaMeterV1['details'] & { limitCategory: 'capacity' } = {
            limitCategory: 'capacity',
        };

        const viewModel = computeConnectedServiceQuotaGaugeViewModel({
            snapshot: snapshot([
                meter({ meterId: 'daily', label: 'Daily', used: 70, limit: 100 }),
                meter({ meterId: 'weekly', label: 'Weekly', used: 88, limit: 100 }),
                meter({ meterId: 'capacity', label: 'Capacity', used: 99, limit: 100, details: capacityDetails }),
                meter({ meterId: 'auth', label: 'Auth', used: 99, limit: 100, status: 'unavailable' }),
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
                meter({ meterId: 'server_capacity', label: 'Server capacity', used: 100, limit: 100, unit: 'requests', details: { limitCategory: 'capacity' } }),
            ]),
            windowMode: 'most_constrained',
            nowMs: 2_000,
            formatter,
        });

        expect(viewModel?.effectiveMeter.meterId).toBe('weekly');
        expect(viewModel?.allMeterRows.map((row) => row.meterId)).toEqual(['weekly', 'daily']);
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

    it('hides unsupported native and non-app-server sessions without reliable evidence', () => {
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

        expect(quotaSnapshot?.serviceId).toBe('anthropic');
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
        expect(quotaSnapshot?.accountLabel).toBeNull();
    });
});
