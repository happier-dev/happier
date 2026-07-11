/**
 * Compatibility for deployed pre-v2 servers and clients that still consume the
 * `usage-report`, `token-count`, and `token_count` shapes. Remove this module
 * only after the minimum supported server/client versions ingest and render the
 * canonical v2 usage observation contract without these fallback messages.
 */
import type { SessionContextUsageSnapshotV1 } from '@happier-dev/protocol';

import {
    normalizeUsageObservation,
    type UsageObservation,
    type UsageObservationBoundaryInput,
    type UsageObservationScope,
} from '../usageObservation';

export type LegacyUsageNumberMap = {
    total: number;
    [key: string]: number;
};

type LegacyUsageCostMap = {
    total: number;
    [key: string]: number | string | undefined;
};

export type UsageReportV1 = {
    key: string;
    sessionId: string;
    tokens: LegacyUsageNumberMap;
    cost: LegacyUsageNumberMap;
};

function createLegacyNumberMap(): Record<string, number> {
    return Object.create(null) as Record<string, number>;
}

function getCompatibleLegacyTokens(observation: UsageObservation): LegacyUsageNumberMap | null {
    if (observation.tokens) {
        const out = createLegacyNumberMap();
        out.total = observation.tokens.total;
        if (observation.tokens.input > 0) out.input = observation.tokens.input;
        if (observation.tokens.output > 0) out.output = observation.tokens.output;
        if (observation.tokens.reasoning > 0) out.thought = observation.tokens.reasoning;
        if (observation.tokens.cacheRead > 0) out.cache_read = observation.tokens.cacheRead;
        if (observation.tokens.cacheWrite > 0) out.cache_creation = observation.tokens.cacheWrite;
        return out as LegacyUsageNumberMap;
    }
    if (observation.contextUsedTokens == null && observation.contextWindowTokens == null) return null;
    const out = createLegacyNumberMap();
    out.total = observation.contextUsedTokens ?? 0;
    if (observation.contextUsedTokens != null) out.used = observation.contextUsedTokens;
    if (observation.contextWindowTokens != null) out.size = observation.contextWindowTokens;
    return out as LegacyUsageNumberMap;
}

function getCompatibleLegacyCost(
    observation: UsageObservation,
    input: UsageObservationBoundaryInput,
): LegacyUsageCostMap | undefined {
    if (!observation.cost) return undefined;
    const inputCost = input.cost && typeof input.cost === 'object' ? input.cost : null;
    const carries = (key: string) => inputCost != null && Object.prototype.hasOwnProperty.call(inputCost, key);
    const out = createLegacyNumberMap() as LegacyUsageCostMap;
    Object.assign(out, observation.cost.breakdown ?? {});
    out.total = observation.cost.reportedUsd || observation.cost.estimatedUsd || observation.cost.invoiceUsd || 0;
    if (carries('reportedUsd') && observation.cost.reportedUsd > 0) out.reportedUsd = observation.cost.reportedUsd;
    if (carries('estimatedUsd') && observation.cost.estimatedUsd > 0) out.estimatedUsd = observation.cost.estimatedUsd;
    if (carries('invoiceUsd') && observation.cost.invoiceUsd != null) out.invoiceUsd = observation.cost.invoiceUsd;
    if (carries('billingContext') && observation.cost.billingContext) out.billingContext = observation.cost.billingContext;
    if (carries('costSource') && observation.cost.costSource) out.costSource = observation.cost.costSource;
    if (carries('currency')) out.currency = observation.cost.currency;
    return out;
}

function normalizeLegacyInput(input: UsageObservationBoundaryInput): UsageObservation | null {
    return normalizeUsageObservation(input);
}

export function buildTokenCountAgentMessageFromUsageObservation(
    input: UsageObservationBoundaryInput,
): ({
    type: 'token-count';
    tokens: LegacyUsageNumberMap;
    source: string;
    scope: UsageObservationScope;
    key?: string;
    modelId?: string;
    cost?: LegacyUsageCostMap;
    context_used_tokens?: number;
    context_window_tokens?: number;
    contextSnapshot?: SessionContextUsageSnapshotV1;
}) | null {
    const observation = normalizeLegacyInput(input);
    if (!observation) return null;
    const tokens = getCompatibleLegacyTokens(observation);
    if (!tokens) return null;
    const cost = getCompatibleLegacyCost(observation, input);
    return {
        type: 'token-count',
        tokens,
        source: observation.source,
        scope: observation.scope,
        ...(observation.key ? { key: observation.key } : {}),
        ...(observation.modelId ? { modelId: observation.modelId } : {}),
        ...(cost ? { cost } : {}),
        ...(observation.contextUsedTokens != null ? { context_used_tokens: observation.contextUsedTokens } : {}),
        ...(observation.contextWindowTokens != null ? { context_window_tokens: observation.contextWindowTokens } : {}),
        ...(observation.contextSnapshot ? { contextSnapshot: observation.contextSnapshot } : {}),
    };
}

export function buildTokenCountSessionMessageFromUsageObservation(
    input: UsageObservationBoundaryInput,
): ({
    type: 'token_count';
    tokens: LegacyUsageNumberMap;
    source: string;
    scope: UsageObservationScope;
    key?: string;
    model?: string;
    cost?: LegacyUsageCostMap;
    context_used_tokens?: number;
    context_window_tokens?: number;
    contextSnapshot?: SessionContextUsageSnapshotV1;
}) | null {
    const observation = normalizeLegacyInput(input);
    if (!observation) return null;
    const tokens = getCompatibleLegacyTokens(observation);
    if (!tokens) return null;
    const cost = getCompatibleLegacyCost(observation, input);
    return {
        type: 'token_count',
        tokens,
        source: observation.source,
        scope: observation.scope,
        ...(observation.key ? { key: observation.key } : {}),
        ...(observation.modelId ? { model: observation.modelId } : {}),
        ...(cost ? { cost } : {}),
        ...(observation.contextUsedTokens != null ? { context_used_tokens: observation.contextUsedTokens } : {}),
        ...(observation.contextWindowTokens != null ? { context_window_tokens: observation.contextWindowTokens } : {}),
        ...(observation.contextSnapshot ? { contextSnapshot: observation.contextSnapshot } : {}),
    };
}

export function buildLegacyUsageReportFromUsageObservation(params: Readonly<{
    sessionId: string;
    observation: UsageObservationBoundaryInput;
}>): UsageReportV1 | null {
    const observation = normalizeLegacyInput(params.observation);
    if (!observation) return null;
    const tokens = getCompatibleLegacyTokens(observation);
    if (!tokens) return null;
    const cost = createLegacyNumberMap();
    Object.assign(cost, observation.cost?.breakdown ?? {});
    cost.total = observation.cost?.reportedUsd || observation.cost?.estimatedUsd || observation.cost?.invoiceUsd || 0;
    return {
        key: observation.key ?? `${observation.provider}-session`,
        sessionId: params.sessionId,
        tokens,
        cost: cost as LegacyUsageNumberMap,
    };
}
