import {
    SessionContextUsageSnapshotV1Schema,
    type SessionContextUsageSnapshotV1,
    type UsageObservationCost,
    type UsageObservationScope,
    type UsageObservationTokens,
} from '@happier-dev/protocol';
import type { RuntimeOutboundTranscriptUsageObservationV1 } from '@happier-dev/agents';

export type { UsageObservationScope } from '@happier-dev/protocol';
export type UsageNumberMap = UsageObservationTokens;
export type UsageBillingContext = NonNullable<UsageObservationCost['billingContext']>;
export type UsageCostSource = NonNullable<UsageObservationCost['costSource']>;
export type UsageCostMap = UsageObservationCost;

export type UsageObservation = {
    provider: string;
    source: string;
    scope: UsageObservationScope;
    key: string | null;
    modelId: string | null;
    tokens: UsageNumberMap | null;
    cost: UsageCostMap | null;
    contextUsedTokens: number | null;
    contextWindowTokens: number | null;
    contextSnapshot?: SessionContextUsageSnapshotV1;
};

export type UsageObservationBoundaryInput = RuntimeOutboundTranscriptUsageObservationV1 | UsageObservation;

function asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asFiniteNonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function asUsageBillingContext(value: unknown): UsageBillingContext | null {
    return value === 'api_usage' ||
        value === 'subscription_included' ||
        value === 'subscription_with_possible_overage' ||
        value === 'unknown'
        ? value
        : null;
}

function asUsageCostSource(value: unknown): UsageCostSource | null {
    return value === 'provider_reported' ||
        value === 'provider_reported_api_equivalent' ||
        value === 'pricing_estimate' ||
        value === 'invoice' ||
        value === 'none'
        ? value
        : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function normalizeTokensMap(raw: unknown): UsageNumberMap | null {
    const record = asRecord(raw);
    if (!record) return null;

    // This table is the only raw provider-token vocabulary in the CLI. Everything
    // returned below uses the protocol's canonical camelCase token keys.
    const input =
        asFiniteNonNegativeNumber(record.input_tokens) ??
        asFiniteNonNegativeNumber(record.input) ??
        asFiniteNonNegativeNumber(record.prompt_tokens) ??
        asFiniteNonNegativeNumber(record.promptTokens) ??
        asFiniteNonNegativeNumber(record.inputTokens);
    const output =
        asFiniteNonNegativeNumber(record.output_tokens) ??
        asFiniteNonNegativeNumber(record.output) ??
        asFiniteNonNegativeNumber(record.completion_tokens) ??
        asFiniteNonNegativeNumber(record.completionTokens) ??
        asFiniteNonNegativeNumber(record.outputTokens);
    const cacheWrite =
        asFiniteNonNegativeNumber(record.cacheWrite) ??
        asFiniteNonNegativeNumber(record.cache_creation_input_tokens) ??
        asFiniteNonNegativeNumber(record.cache_creation_tokens) ??
        asFiniteNonNegativeNumber(record.cached_write_tokens) ??
        asFiniteNonNegativeNumber(record.cachedWriteTokens) ??
        asFiniteNonNegativeNumber(record.cache_creation) ??
        asFiniteNonNegativeNumber(record.cacheCreationTokens);
    const cacheRead =
        asFiniteNonNegativeNumber(record.cacheRead) ??
        asFiniteNonNegativeNumber(record.cache_read_input_tokens) ??
        asFiniteNonNegativeNumber(record.cache_read_tokens) ??
        asFiniteNonNegativeNumber(record.cached_input_tokens) ??
        asFiniteNonNegativeNumber(record.cached_read_tokens) ??
        asFiniteNonNegativeNumber(record.cachedReadTokens) ??
        asFiniteNonNegativeNumber(record.cache_read) ??
        asFiniteNonNegativeNumber(record.cacheReadTokens);
    const reasoning =
        asFiniteNonNegativeNumber(record.reasoning) ??
        asFiniteNonNegativeNumber(record.thought_tokens) ??
        asFiniteNonNegativeNumber(record.reasoning_output_tokens) ??
        asFiniteNonNegativeNumber(record.reasoningOutputTokens) ??
        asFiniteNonNegativeNumber(record.thoughtTokens) ??
        asFiniteNonNegativeNumber(record.thought);
    const totalExplicit =
        asFiniteNonNegativeNumber(record.total_tokens) ??
        asFiniteNonNegativeNumber(record.totalTokens) ??
        asFiniteNonNegativeNumber(record.total);

    const anyPresent =
        totalExplicit != null ||
        input != null ||
        output != null ||
        cacheWrite != null ||
        cacheRead != null ||
        reasoning != null;
    if (!anyPresent) return null;

    const canonical = {
        input: input ?? 0,
        output: output ?? 0,
        reasoning: reasoning ?? 0,
        cacheRead: cacheRead ?? 0,
        cacheWrite: cacheWrite ?? 0,
        total: totalExplicit ??
            (input ?? 0) +
            (output ?? 0) +
            (reasoning ?? 0) +
            (cacheRead ?? 0) +
            (cacheWrite ?? 0),
    } satisfies UsageObservationTokens;
    return canonical;
}

function normalizeTopLevelTokens(record: Record<string, unknown>): UsageNumberMap | null {
    return normalizeTokensMap(record);
}

function normalizeCodexInfoTokens(record: Record<string, unknown>): UsageNumberMap | null {
    const info = asRecord(record.info);
    if (!info) return null;
    const usageRecord =
        asRecord(info.total_token_usage) ??
        asRecord(info.totalTokenUsage) ??
        asRecord(info.last_token_usage) ??
        asRecord(info.lastTokenUsage);
    if (!usageRecord) return null;
    return normalizeTopLevelTokens(usageRecord);
}

function normalizeCostBreakdown(record: Record<string, unknown>): Record<string, number> | undefined {
    const semanticKeys = new Set([
        'total',
        'reportedUsd',
        'reported_usd',
        'reported',
        'estimatedUsd',
        'estimated_usd',
        'estimated',
        'invoiceUsd',
        'effectiveUsd',
        'billingContext',
        'costSource',
        'currency',
        'breakdown',
    ]);
    const breakdown = Object.create(null) as Record<string, number>;
    const nestedBreakdown = asRecord(record.breakdown);
    for (const [key, value] of [
        ...Object.entries(nestedBreakdown ?? {}),
        ...Object.entries(record).filter(([key]) => !semanticKeys.has(key)),
    ]) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const numeric = asFiniteNonNegativeNumber(value);
        if (numeric != null) breakdown[key] = numeric;
    }
    return Object.keys(breakdown).length > 0 ? breakdown : undefined;
}

function normalizeCostMap(raw: unknown, source: string): UsageCostMap | null {
    if (raw == null) return null;
    const direct = asFiniteNonNegativeNumber(raw);
    if (direct != null) {
        return {
            reportedUsd: 0,
            estimatedUsd: direct,
            currency: 'USD',
        };
    }
    const record = asRecord(raw);
    if (!record) return null;

    const total = asFiniteNonNegativeNumber(record.total);
    const reportedUsd =
        asFiniteNonNegativeNumber(record.reportedUsd) ??
        asFiniteNonNegativeNumber(record.reported_usd) ??
        asFiniteNonNegativeNumber(record.reported) ??
        (source === 'claude-sdk-result' ? total : null) ??
        0;
    const estimatedUsd =
        asFiniteNonNegativeNumber(record.estimatedUsd) ??
        asFiniteNonNegativeNumber(record.estimated_usd) ??
        asFiniteNonNegativeNumber(record.estimated) ??
        (reportedUsd > 0 ? 0 : total) ??
        0;
    const invoiceUsd = asFiniteNonNegativeNumber(record.invoiceUsd);
    const effectiveUsd = asFiniteNonNegativeNumber(record.effectiveUsd);
    const billingContext = asUsageBillingContext(record.billingContext);
    const costSource = asUsageCostSource(record.costSource);
    const breakdown = normalizeCostBreakdown(record);
    const hasCostData =
        reportedUsd > 0 ||
        estimatedUsd > 0 ||
        invoiceUsd != null ||
        effectiveUsd != null ||
        billingContext != null ||
        costSource != null ||
        breakdown != null;
    if (!hasCostData) return null;

    return {
        reportedUsd,
        estimatedUsd,
        ...(invoiceUsd != null ? { invoiceUsd } : {}),
        ...(billingContext ? { billingContext } : {}),
        ...(costSource ? { costSource } : {}),
        currency: asNonEmptyString(record.currency) ?? 'USD',
        ...(breakdown ? { breakdown } : {}),
        ...(effectiveUsd != null ? { effectiveUsd } : {}),
    };
}

function normalizeScope(value: unknown): UsageObservationScope | null {
    if (value === 'turn_delta' || value === 'session_cumulative' || value === 'session_final') {
        return value;
    }
    return null;
}

export function extractUsageObservationFromTokenCountMessage(params: Readonly<{
    provider: string;
    body: unknown;
    defaultSource?: string;
    defaultScope?: UsageObservationScope;
}>): UsageObservation | null {
    const record = asRecord(params.body);
    if (!record) return null;

    const tokens =
        normalizeTokensMap(record.tokens) ??
        normalizeTopLevelTokens(record) ??
        normalizeCodexInfoTokens(record);
    const info = asRecord(record.info);
    const lastUsage = asRecord(info?.last_token_usage) ?? asRecord(info?.lastTokenUsage);
    const scope = normalizeScope(record.scope) ?? params.defaultScope ?? 'turn_delta';
    const source = asNonEmptyString(record.source) ?? params.defaultSource ?? 'token_count';
    const contextUsedExplicit =
        asFiniteNonNegativeNumber(record.context_used_tokens) ??
        asFiniteNonNegativeNumber(record.contextUsedTokens) ??
        asFiniteNonNegativeNumber(record.used) ??
        asFiniteNonNegativeNumber(lastUsage?.total_tokens) ??
        asFiniteNonNegativeNumber(lastUsage?.totalTokens);
    const contextWindowExplicit =
        asFiniteNonNegativeNumber(record.context_window_tokens) ??
        asFiniteNonNegativeNumber(record.contextWindowTokens) ??
        asFiniteNonNegativeNumber(record.size) ??
        asFiniteNonNegativeNumber(asRecord(record.info)?.model_context_window) ??
        asFiniteNonNegativeNumber(asRecord(record.info)?.modelContextWindow);
    const contextUsedTokens =
        contextUsedExplicit ??
        (scope === 'turn_delta' && contextWindowExplicit != null && tokens ? tokens.total : null);
    const contextWindowTokens = contextWindowExplicit ?? null;
    const cost = normalizeCostMap(record.cost, source);
    const parsedContextSnapshot = SessionContextUsageSnapshotV1Schema.safeParse(record.contextSnapshot);
    const contextSnapshot = parsedContextSnapshot.success ? parsedContextSnapshot.data : null;
    const hasData = tokens != null || cost != null || contextUsedTokens != null || contextWindowTokens != null;
    if (!hasData) return null;

    return {
        provider: params.provider,
        source,
        scope,
        key: asNonEmptyString(record.key),
        modelId: asNonEmptyString(record.modelId ?? record.model),
        tokens,
        cost,
        contextUsedTokens,
        contextWindowTokens,
        ...(contextSnapshot ? { contextSnapshot } : {}),
    };
}

export function normalizeUsageObservation(
    input: UsageObservationBoundaryInput,
): UsageObservation | null {
    return extractUsageObservationFromTokenCountMessage({
        provider: input.provider,
        body: input,
        defaultSource: input.source,
        defaultScope: input.scope,
    });
}
