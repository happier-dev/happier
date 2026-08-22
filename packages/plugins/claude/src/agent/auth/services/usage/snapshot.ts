import type {
    AgentAccountUsageMeter,
    AgentAccountUsageSnapshot,
} from '@happier-dev/plugin-sdk/agents/runtime';

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

export type MapClaudeProviderHttpUsageSnapshotInput = Readonly<{
    subject: ClaudeUsageSubjectRef;
    observedAtMs: number;
    fetchedAtMs: number;
    staleAfterMs: number;
    meters: readonly AgentAccountUsageMeter[];
    accountLabel?: string | null;
    planLabel?: string | null;
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
): AgentAccountUsageSnapshot['recordKey']['quotaScope'] {
    return value === 'provider' ? 'provider' : 'account';
}

function buildRecordKey(
    subject: ClaudeUsageSubjectRef,
    quotaScope?: AgentAccountUsageSnapshot['recordKey']['quotaScope'],
): AgentAccountUsageSnapshot['recordKey'] {
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

function runtimeMeterToQuotaMeter(meter: NormalizedClaudeRuntimeRateLimitMeter): AgentAccountUsageMeter {
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

function readUsageLimitCategory(details: NormalizedClaudeUsageLimitDetails): 'usage_limit' | 'rate_limit' | 'capacity' {
    return details.limitCategory ?? 'usage_limit';
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

function usageLimitDetailsToQuotaMeter(details: NormalizedClaudeUsageLimitDetails): AgentAccountUsageMeter {
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
    quotaScope?: AgentAccountUsageSnapshot['recordKey']['quotaScope'];
    source: AgentAccountUsageSnapshot['source'];
    state: AgentAccountUsageSnapshot['state'];
    observedAtMs: number;
    fetchedAtMs: number;
    staleAfterMs: number;
    meters: readonly AgentAccountUsageMeter[];
    accountLabel?: string | null;
    planLabel?: string | null;
}>): AgentAccountUsageSnapshot {
    const recordKey = buildRecordKey(params.subject, params.quotaScope);
    return {
        v: 1,
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
        meters: [...params.meters],
    };
}

export function mapClaudeRuntimeRateLimitsToProviderAccountUsageSnapshot(
    params: MapClaudeRuntimeRateLimitsToProviderAccountUsageSnapshotInput,
): AgentAccountUsageSnapshot | null {
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

/** Maps Claude's private provider-HTTP quota response to the public SDK shape. */
export function mapClaudeProviderHttpUsageSnapshot(
    params: MapClaudeProviderHttpUsageSnapshotInput,
): AgentAccountUsageSnapshot {
    return buildSnapshot({
        subject: params.subject,
        source: 'providerHttp',
        state: params.meters.length > 0 ? 'loaded_data' : 'loaded_empty',
        observedAtMs: params.observedAtMs,
        fetchedAtMs: params.fetchedAtMs,
        staleAfterMs: params.staleAfterMs,
        meters: params.meters,
        accountLabel: params.accountLabel,
        planLabel: params.planLabel,
    });
}

export function mapClaudeUsageLimitDetailsToProviderAccountUsageSnapshot(
    params: MapClaudeUsageLimitDetailsToProviderAccountUsageSnapshotInput,
): AgentAccountUsageSnapshot {
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
