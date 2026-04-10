export type UsageObservationScope = 'turn_delta' | 'session_cumulative' | 'session_final';

export type UsageNumberMap = {
    total: number;
    [key: string]: number;
};

export type UsageBillingContext =
    | 'api_usage'
    | 'subscription_included'
    | 'subscription_with_possible_overage'
    | 'unknown';

export type UsageCostSource =
    | 'provider_reported'
    | 'provider_reported_api_equivalent'
    | 'pricing_estimate'
    | 'invoice'
    | 'none';

export type UsageCostMap = {
    total: number;
    reportedUsd?: number;
    estimatedUsd?: number;
    invoiceUsd?: number;
    billingContext?: UsageBillingContext;
    costSource?: UsageCostSource;
    currency?: string;
    [key: string]: number | string | undefined;
};

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
};

export type UsageReportV1 = {
    key: string;
    sessionId: string;
    tokens: UsageNumberMap;
    cost: UsageNumberMap;
};

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

function createSafeNumberMap(): Record<string, number> {
    return Object.create(null) as Record<string, number>;
}

function normalizeNumberMap(raw: unknown): Record<string, number> {
    const record = asRecord(raw);
    if (!record) return createSafeNumberMap();
    const out = createSafeNumberMap();
    for (const [key, value] of Object.entries(record)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const numeric = asFiniteNonNegativeNumber(value);
        if (numeric == null) continue;
        out[key] = numeric;
    }
    return out;
}

function computeTotalFromParts(parts: Readonly<{
    input?: number;
    output?: number;
    cache_creation?: number;
    cache_read?: number;
    thought?: number;
}>): number {
    return (
        (parts.input ?? 0) +
        (parts.output ?? 0) +
        (parts.cache_creation ?? 0) +
        (parts.cache_read ?? 0) +
        (parts.thought ?? 0)
    );
}

function normalizeTokensMap(raw: unknown): UsageNumberMap | null {
    const tokens = normalizeNumberMap(raw);
    if (Object.keys(tokens).length === 0) return null;
    if (tokens.total == null) {
        const hasParts =
            tokens.input != null ||
            tokens.output != null ||
            tokens.cache_creation != null ||
            tokens.cache_read != null ||
            tokens.thought != null;
        if (hasParts) {
            tokens.total = computeTotalFromParts({
                input: tokens.input,
                output: tokens.output,
                cache_creation: tokens.cache_creation,
                cache_read: tokens.cache_read,
                thought: tokens.thought,
            });
        }
    }
    return tokens.total == null ? null : (tokens as UsageNumberMap);
}

function normalizeTopLevelTokens(record: Record<string, unknown>): UsageNumberMap | null {
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
    const cacheCreation =
        asFiniteNonNegativeNumber(record.cache_creation_input_tokens) ??
        asFiniteNonNegativeNumber(record.cache_creation_tokens) ??
        asFiniteNonNegativeNumber(record.cached_write_tokens) ??
        asFiniteNonNegativeNumber(record.cachedWriteTokens) ??
        asFiniteNonNegativeNumber(record.cache_creation) ??
        asFiniteNonNegativeNumber(record.cacheCreationTokens);
    const cacheRead =
        asFiniteNonNegativeNumber(record.cache_read_input_tokens) ??
        asFiniteNonNegativeNumber(record.cache_read_tokens) ??
        asFiniteNonNegativeNumber(record.cached_input_tokens) ??
        asFiniteNonNegativeNumber(record.cached_read_tokens) ??
        asFiniteNonNegativeNumber(record.cachedReadTokens) ??
        asFiniteNonNegativeNumber(record.cache_read) ??
        asFiniteNonNegativeNumber(record.cacheReadTokens);
    const thought =
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
        cacheCreation != null ||
        cacheRead != null ||
        thought != null;
    if (!anyPresent) return null;

    const out = createSafeNumberMap();
    out.total =
        totalExplicit ??
        computeTotalFromParts({
            input: input ?? undefined,
            output: output ?? undefined,
            cache_creation: cacheCreation ?? undefined,
            cache_read: cacheRead ?? undefined,
            thought: thought ?? undefined,
        });
    if (input != null) out.input = input;
    if (output != null) out.output = output;
    if (cacheCreation != null) out.cache_creation = cacheCreation;
    if (cacheRead != null) out.cache_read = cacheRead;
    if (thought != null) out.thought = thought;
    return out as UsageNumberMap;
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

function normalizeCostMap(raw: unknown): UsageCostMap | null {
    if (raw == null) return null;
    const direct = asFiniteNonNegativeNumber(raw);
    if (direct != null) {
        const out = createSafeNumberMap() as UsageCostMap;
        out.total = direct;
        return out;
    }
    const normalized = normalizeNumberMap(raw);
    const record = asRecord(raw);
    if (Object.keys(normalized).length === 0 && !record) return null;
    if (normalized.total == null) {
        normalized.total = Object.entries(normalized)
            .filter(([key]) => key !== 'total')
            .reduce((sum, [, value]) => sum + value, 0);
    }
    const out = {
        ...(normalized as UsageCostMap),
        ...(record ? {
            ...(asUsageBillingContext(record.billingContext) ? { billingContext: asUsageBillingContext(record.billingContext) } : {}),
            ...(asUsageCostSource(record.costSource) ? { costSource: asUsageCostSource(record.costSource) } : {}),
            ...(asNonEmptyString(record.currency) ? { currency: asNonEmptyString(record.currency) ?? undefined } : {}),
        } : {}),
    } satisfies UsageCostMap;
    return out;
}

function normalizeScope(value: unknown): UsageObservationScope | null {
    if (value === 'turn_delta' || value === 'session_cumulative' || value === 'session_final') {
        return value;
    }
    return null;
}

function getCompatibleLegacyTokens(observation: UsageObservation): UsageNumberMap | null {
    if (observation.tokens) {
        return {
            ...observation.tokens,
        };
    }
    if (observation.contextUsedTokens == null && observation.contextWindowTokens == null) return null;
    const out = createSafeNumberMap();
    out.total = observation.contextUsedTokens ?? 0;
    if (observation.contextUsedTokens != null) out.used = observation.contextUsedTokens;
    if (observation.contextWindowTokens != null) out.size = observation.contextWindowTokens;
    return out as UsageNumberMap;
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
    const contextUsedExplicit =
        asFiniteNonNegativeNumber(record.context_used_tokens) ??
        asFiniteNonNegativeNumber(record.contextUsedTokens) ??
        asFiniteNonNegativeNumber(record.used);
    const contextWindowExplicit =
        asFiniteNonNegativeNumber(record.context_window_tokens) ??
        asFiniteNonNegativeNumber(record.contextWindowTokens) ??
        asFiniteNonNegativeNumber(record.size) ??
        asFiniteNonNegativeNumber(asRecord(record.info)?.model_context_window) ??
        asFiniteNonNegativeNumber(asRecord(record.info)?.modelContextWindow);
    const contextUsedTokens =
        contextUsedExplicit ??
        (contextWindowExplicit != null && tokens ? tokens.total : null);
    const contextWindowTokens = contextWindowExplicit ?? null;
    const cost = normalizeCostMap(record.cost);
    const hasData = tokens != null || cost != null || contextUsedTokens != null || contextWindowTokens != null;
    if (!hasData) return null;

    return {
        provider: params.provider,
        source: asNonEmptyString(record.source) ?? params.defaultSource ?? 'token_count',
        scope: normalizeScope(record.scope) ?? params.defaultScope ?? 'turn_delta',
        key: asNonEmptyString(record.key),
        modelId: asNonEmptyString(record.modelId ?? record.model),
        tokens,
        cost,
        contextUsedTokens,
        contextWindowTokens,
    };
}

export function buildTokenCountAgentMessageFromUsageObservation(
    observation: UsageObservation,
): ({
    type: 'token-count';
    tokens: UsageNumberMap;
    source: string;
    scope: UsageObservationScope;
    key?: string;
    modelId?: string;
    cost?: UsageCostMap;
    context_used_tokens?: number;
    context_window_tokens?: number;
}) | null {
    const tokens = getCompatibleLegacyTokens(observation);
    if (!tokens) return null;
    return {
        type: 'token-count',
        tokens,
        source: observation.source,
        scope: observation.scope,
        ...(observation.key ? { key: observation.key } : {}),
        ...(observation.modelId ? { modelId: observation.modelId } : {}),
        ...(observation.cost ? { cost: observation.cost } : {}),
        ...(observation.contextUsedTokens != null ? { context_used_tokens: observation.contextUsedTokens } : {}),
        ...(observation.contextWindowTokens != null ? { context_window_tokens: observation.contextWindowTokens } : {}),
    };
}

export function buildTokenCountSessionMessageFromUsageObservation(
    observation: UsageObservation,
): ({
    type: 'token_count';
    tokens: UsageNumberMap;
    source: string;
    scope: UsageObservationScope;
    key?: string;
    model?: string;
    cost?: UsageCostMap;
    context_used_tokens?: number;
    context_window_tokens?: number;
}) | null {
    const tokens = getCompatibleLegacyTokens(observation);
    if (!tokens) return null;
    return {
        type: 'token_count',
        tokens,
        source: observation.source,
        scope: observation.scope,
        ...(observation.key ? { key: observation.key } : {}),
        ...(observation.modelId ? { model: observation.modelId } : {}),
        ...(observation.cost ? { cost: observation.cost } : {}),
        ...(observation.contextUsedTokens != null ? { context_used_tokens: observation.contextUsedTokens } : {}),
        ...(observation.contextWindowTokens != null ? { context_window_tokens: observation.contextWindowTokens } : {}),
    };
}

export function buildLegacyUsageReportFromUsageObservation(params: Readonly<{
    sessionId: string;
    observation: UsageObservation;
}>): UsageReportV1 | null {
    const tokens = getCompatibleLegacyTokens(params.observation);
    if (!tokens) return null;
    const cost = Object.fromEntries(
        Object.entries(params.observation.cost ?? {})
            .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0),
    ) as UsageNumberMap;
    return {
        key: params.observation.key ?? `${params.observation.provider}-session`,
        sessionId: params.sessionId,
        tokens,
        cost: Object.keys(cost).length > 0 ? cost : ({ total: 0 } satisfies UsageNumberMap),
    };
}
