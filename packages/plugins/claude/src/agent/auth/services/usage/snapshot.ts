import {
    ProviderAccountUsageSnapshotV1Schema,
    buildProviderAccountUsageRecordId,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/plugin-sdk/experimental/cloud/usage';
import {
    normalizeConnectedServiceLimitCategoryV1,
    type ConnectedServiceLimitCategoryV1,
    type ConnectedServiceQuotaMeterV1,
    type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import type {
    ClaudeUsageSubjectRef,
} from './identity.js';
import type {
    NormalizedClaudeUsageLimitDetails,
    NormalizedClaudeRuntimeRateLimitMeter,
    NormalizedClaudeRuntimeRateLimitsObservation,
} from '../runtime/usage.js';

export const CLAUDE_RUNTIME_RATE_LIMITS_STALE_AFTER_MS = 5 * 60 * 1000;

type ClaudeConnectedServiceId = 'claude-subscription' | 'anthropic';
type ClaudeRuntimeMeterScope = 'five_hour' | 'seven_day' | 'unknown';

export type MapClaudeRuntimeRateLimitsToProviderAccountUsageSnapshotInput = Readonly<{
    subject: ClaudeUsageSubjectRef;
    observation: NormalizedClaudeRuntimeRateLimitsObservation;
    observedAtMs: number;
    fetchedAtMs: number;
    staleAfterMs?: number;
    accountLabel?: string | null;
    planLabel?: string | null;
}>;

export type MapClaudeQuotaSnapshotToProviderAccountUsageSnapshotInput = Readonly<{
    subject: ClaudeUsageSubjectRef;
    quotaSnapshot: ConnectedServiceQuotaSnapshotV1;
    observedAtMs?: number;
}>;

export type MapClaudeUsageLimitDetailsToProviderAccountUsageSnapshotInput = Readonly<{
    subject: ClaudeUsageSubjectRef;
    details: NormalizedClaudeUsageLimitDetails;
    observedAtMs: number;
    fetchedAtMs: number;
    staleAfterMs?: number;
    accountLabel?: string | null;
    planLabel?: string | null;
}>;

function normalizeTimestampMs(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function normalizeQuotaScope(
    value: NormalizedClaudeUsageLimitDetails['quotaScope'] | undefined,
): ProviderAccountUsageSnapshotV1['recordKey']['quotaScope'] {
    return value === 'provider' ? 'provider' : 'account';
}

function buildRecordKey(
    subject: ClaudeUsageSubjectRef,
    quotaScope?: ProviderAccountUsageSnapshotV1['recordKey']['quotaScope'],
): ProviderAccountUsageSnapshotV1['recordKey'] {
    return {
        providerId: 'claude',
        accountSubjectId: subject.accountSubjectId,
        subjectKind: subject.kind === 'providerSubject' ? subject.subjectKind : 'unknown',
        quotaScope: quotaScope ?? (subject.kind === 'providerSubject' && subject.subjectKind === 'organization'
            ? 'organization'
            : 'account'),
    };
}

function readRuntimeMeterScope(meterId: string): ClaudeRuntimeMeterScope {
    if (meterId === 'five_hour' || meterId === 'seven_day') return meterId;
    return 'unknown';
}

function runtimeMeterToQuotaMeter(meter: NormalizedClaudeRuntimeRateLimitMeter): ConnectedServiceQuotaMeterV1 {
    const remainingPct = meter.utilizationPct === null
        ? null
        : Math.max(0, Math.min(100, 100 - meter.utilizationPct));
    return {
        meterId: meter.meterId,
        label: meter.label,
        used: null,
        limit: null,
        remainingPct,
        resetAtMs: meter.resetsAtMs,
        providerLimitId: meter.meterId,
        unit: 'unknown',
        utilizationPct: meter.utilizationPct,
        resetsAt: meter.resetsAtMs,
        status: meter.utilizationPct === null && meter.resetsAtMs === null ? 'unavailable' : 'ok',
        source: 'in_band_provider_snapshot',
        scope: readRuntimeMeterScope(meter.meterId),
        limitScope: 'account',
        confidence: meter.utilizationPct === null ? 'unknown' : 'exact',
        details: {},
    };
}

function normalizeUtilizationPct(value: number | null): number | null {
    return value === null ? null : Math.max(0, Math.min(100, value));
}

function readUsageLimitCategory(details: NormalizedClaudeUsageLimitDetails): ConnectedServiceLimitCategoryV1 {
    return normalizeConnectedServiceLimitCategoryV1(details.limitCategory ?? 'usage_limit');
}

function readUsageLimitMeterId(details: NormalizedClaudeUsageLimitDetails): string {
    return details.providerLimitId ?? readUsageLimitCategory(details);
}

function usageLimitMeterLabel(details: NormalizedClaudeUsageLimitDetails): string {
    const limitCategory = readUsageLimitCategory(details);
    if (limitCategory === 'capacity') return 'Provider capacity';
    if (limitCategory === 'rate_limit') return 'Rate limit';
    return 'Usage limit';
}

function usageLimitDetailsToQuotaMeter(details: NormalizedClaudeUsageLimitDetails): ConnectedServiceQuotaMeterV1 {
    const utilizationPct = normalizeUtilizationPct(details.utilization);
    const meterId = readUsageLimitMeterId(details);
    const resetAtMs = details.resetAtMs;
    const limitCategory = readUsageLimitCategory(details);
    return {
        meterId,
        label: usageLimitMeterLabel(details),
        used: null,
        limit: null,
        remainingPct: utilizationPct === null ? null : Math.max(0, Math.min(100, 100 - utilizationPct)),
        resetAtMs,
        resetSource: resetAtMs !== null ? 'provider_event' : details.retryAfterMs !== null ? 'retry_after' : 'unknown',
        providerLimitId: meterId,
        isExhausted: limitCategory === 'usage_limit' || limitCategory === 'rate_limit',
        isCapacityLimited: limitCategory === 'capacity',
        unit: 'unknown',
        utilizationPct,
        resetsAt: resetAtMs,
        status: utilizationPct === null && resetAtMs === null && details.retryAfterMs === null ? 'unavailable' : 'ok',
        source: 'runtime_event',
        scope: 'unknown',
        limitScope: details.quotaScope,
        confidence: utilizationPct === null ? 'estimated' : 'exact',
        details: {
            providerLimitId: meterId,
            limitCategory,
        },
    };
}

function buildSnapshot(params: Readonly<{
    subject: ClaudeUsageSubjectRef;
    quotaScope?: ProviderAccountUsageSnapshotV1['recordKey']['quotaScope'];
    source: ProviderAccountUsageSnapshotV1['source'];
    state: ProviderAccountUsageSnapshotV1['state'];
    observedAtMs: number;
    fetchedAtMs: number;
    staleAfterMs: number;
    meters: readonly ConnectedServiceQuotaMeterV1[];
    accountLabel?: string | null;
    planLabel?: string | null;
}>): ProviderAccountUsageSnapshotV1 {
    const recordKey = buildRecordKey(params.subject, params.quotaScope);
    return ProviderAccountUsageSnapshotV1Schema.parse({
        v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey,
        providerId: 'claude',
        accountSubject: {
            kind: params.subject.kind,
            id: params.subject.accountSubjectId,
        },
        observedAtMs: normalizeTimestampMs(params.observedAtMs),
        fetchedAtMs: normalizeTimestampMs(params.fetchedAtMs),
        staleAfterMs: params.staleAfterMs,
        source: params.source,
        confidence: params.subject.kind === 'providerSubject' ? 'confirmed' : 'unknown',
        state: params.state,
        planLabel: params.planLabel ?? null,
        accountLabel: params.accountLabel ?? null,
        meters: params.meters,
    });
}

export function mapClaudeRuntimeRateLimitsToProviderAccountUsageSnapshot(
    params: MapClaudeRuntimeRateLimitsToProviderAccountUsageSnapshotInput,
): ProviderAccountUsageSnapshotV1 | null {
    if (params.observation.status === 'not_loaded') return null;
    return buildSnapshot({
        subject: params.subject,
        source: 'runtimeSignal',
        state: params.observation.status,
        observedAtMs: params.observedAtMs,
        fetchedAtMs: params.fetchedAtMs,
        staleAfterMs: params.staleAfterMs ?? CLAUDE_RUNTIME_RATE_LIMITS_STALE_AFTER_MS,
        meters: params.observation.status === 'loaded_data'
            ? params.observation.meters.map(runtimeMeterToQuotaMeter)
            : [],
        accountLabel: params.accountLabel,
        planLabel: params.planLabel,
    });
}

export function mapClaudeQuotaSnapshotToProviderAccountUsageSnapshot(
    params: MapClaudeQuotaSnapshotToProviderAccountUsageSnapshotInput,
): ProviderAccountUsageSnapshotV1 {
    return buildSnapshot({
        subject: params.subject,
        source: 'providerHttp',
        state: params.quotaSnapshot.meters.length > 0 ? 'loaded_data' : 'loaded_empty',
        observedAtMs: params.observedAtMs ?? params.quotaSnapshot.fetchedAt,
        fetchedAtMs: params.quotaSnapshot.fetchedAt,
        staleAfterMs: params.quotaSnapshot.staleAfterMs,
        meters: params.quotaSnapshot.meters,
        accountLabel: params.quotaSnapshot.accountLabel,
        planLabel: params.quotaSnapshot.planLabel,
    });
}

export function mapClaudeUsageLimitDetailsToProviderAccountUsageSnapshot(
    params: MapClaudeUsageLimitDetailsToProviderAccountUsageSnapshotInput,
): ProviderAccountUsageSnapshotV1 {
    return buildSnapshot({
        subject: params.subject,
        quotaScope: normalizeQuotaScope(params.details.quotaScope),
        source: 'runtimeSignal',
        state: 'loaded_data',
        observedAtMs: params.observedAtMs,
        fetchedAtMs: params.fetchedAtMs,
        staleAfterMs: params.staleAfterMs ?? CLAUDE_RUNTIME_RATE_LIMITS_STALE_AFTER_MS,
        meters: [usageLimitDetailsToQuotaMeter(params.details)],
        accountLabel: params.accountLabel,
        planLabel: params.planLabel,
    });
}
