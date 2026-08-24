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
    resolveConnectedServiceQuotaGaugeSource,
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
        expect(viewModel?.detailRightLabel).toBe('18% left · resets in 2h');
        expect(viewModel?.usedLimitLabel).toBe('82/100 used');
        expect(viewModel?.allMeterRows[0]?.detailRightSemantics).toBe('remaining');
        expect(viewModel?.allMeterRows[0]?.usedLimitSemantics).toBe('used');
        expect(viewModel?.allMeterRows[0]?.detailRightLabel).toBe('18% left · resets in 2h');
        expect(viewModel?.allMeterRows[0]?.usedLimitLabel).toBe('82/100 used');
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
        expect(viewModel?.detailRightLabel).toBe('18% left · resets in 2h');
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
