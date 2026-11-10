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

/**
 * Preserve inference categories when present; otherwise encode context occupancy
 * for legacy transcript telemetry. Accounting callers must first require measured tokens.
 */
function getCompatibleLegacyTokens(observation: UsageObservation): Record<string, number> | null {
    if (observation.tokens) {
        const out = createLegacyNumberMap();
        if (observation.tokens.total != null) out.total = observation.tokens.total;
        if (observation.tokens.input != null) {
            out.input = observation.tokens.input;
        }
        if (observation.tokens.output != null) {
            out.output = observation.tokens.output;
        }
        if (observation.tokens.reasoning != null) out.thought = observation.tokens.reasoning;
        if (observation.tokens.cacheRead != null) out.cache_read = observation.tokens.cacheRead;
        if (observation.tokens.cacheWrite != null) out.cache_creation = observation.tokens.cacheWrite;
        return out;
    }
    if (observation.contextUsedTokens == null && observation.contextWindowTokens == null) return null;
    const out = createLegacyNumberMap();
    if (observation.contextUsedTokens != null) out.total = observation.contextUsedTokens;
    if (observation.contextUsedTokens != null) out.used = observation.contextUsedTokens;
    if (observation.contextWindowTokens != null) out.size = observation.contextWindowTokens;
    return out;
}

function getCompatibleLegacyCost(
    observation: UsageObservation,
    input: UsageObservationBoundaryInput,
): LegacyUsageCostMap | undefined {
    if (!observation.cost) return undefined;
    const total = observation.cost.reportedUsd ?? observation.cost.estimatedUsd ?? observation.cost.invoiceUsd;
    if (total == null) return undefined;
    const inputCost = input.cost && typeof input.cost === 'object' ? input.cost : null;
    const carries = (key: string) => inputCost != null && Object.prototype.hasOwnProperty.call(inputCost, key);
    const out = createLegacyNumberMap() as LegacyUsageCostMap;
    Object.assign(out, observation.cost.breakdown ?? {});
    out.total = total;
    if (carries('reportedUsd') && observation.cost.reportedUsd != null) out.reportedUsd = observation.cost.reportedUsd;
    if (carries('estimatedUsd') && observation.cost.estimatedUsd != null) out.estimatedUsd = observation.cost.estimatedUsd;
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
    tokens: Record<string, number>;
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
    tokens: Record<string, number>;
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

/**
 * Project measured token snapshots onto the legacy full-row replacement contract.
 * Tokenless costs remain available to v2 accounting; emitting them as zero tokens
 * would erase an earlier same-key measurement, while a separate key could double costs.
 */
export function buildLegacyUsageReportFromUsageObservation(params: Readonly<{
    sessionId: string;
    observation: UsageObservationBoundaryInput;
}>): UsageReportV1 | null {
    const observation = normalizeLegacyInput(params.observation);
    if (!observation) return null;
    // Exact Codex responses supplement the existing cumulative stream. Scalar
    // servers replace the session key and cannot reconcile the two; retain
    // their unchanged cumulative report instead of letting a delta replace it.
    if (observation.source === 'codex-app-server-response-usage') return null;
    if (observation.tokens?.total == null) return null;
    const tokens = getCompatibleLegacyTokens(observation);
    if (!tokens) return null;
    const costTotal = observation.cost?.reportedUsd ?? observation.cost?.estimatedUsd ?? observation.cost?.invoiceUsd;
    if (costTotal == null) return null;
    const cost = createLegacyNumberMap();
    Object.assign(cost, observation.cost?.breakdown ?? {});
    cost.total = costTotal;
    return {
        key: observation.key ?? `${observation.provider}-session`,
        sessionId: params.sessionId,
        tokens: { ...tokens, total: observation.tokens.total },
        cost: cost as LegacyUsageNumberMap,
    };
}
