import type { AgentUsageObservedPayloadV1 } from '@happier-dev/protocol/runtime/agentUsageObservedPayloadV1';
import type { UsageAccountingMetadata } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { UsageObservation } from './usageObservation';

export function toNativeAgentUsageObservation(
    event: AgentUsageObservedPayloadV1,
    provider: string,
): UsageObservation {
    const reportedCostUsd = event.cost?.reportedUsd != null
        && event.cost.currency === 'USD'
        && (event.cost.costSource === 'provider_reported'
            || event.cost.costSource === 'provider_reported_api_equivalent');
    return {
        provider,
        source: event.source,
        scope: event.scope,
        key: null,
        modelId: event.modelId ?? event.context?.modelId ?? null,
        tokens: event.tokens ?? null,
        cost: event.cost ?? null,
        contextUsedTokens: event.context?.usedTokens ?? null,
        contextWindowTokens: event.context?.windowTokens ?? null,
        availability: {
            inputTokens: event.tokens?.input != null,
            outputTokens: event.tokens?.output != null,
            reportedCostUsd,
        },
        ...(event.context ? { contextSnapshot: event.context } : {}),
        ...(event.promptCache ? { promptCache: event.promptCache } : {}),
    };
}

/** Native identity is evidence even when this event has no measured counters. */
export function buildNativeAgentUsageAccountingMetadata(
    event: AgentUsageObservedPayloadV1 & Readonly<{ emittedAtMs: number }>,
): { usageAccounting: UsageAccountingMetadata } {
    const { replayObservationId: _replayObservationId, ...accounting } = event.accounting ?? {};
    return { usageAccounting: {
        path: 'runtime',
        status: event.accounting?.historyComplete === false ? 'partial' : 'unknown',
        asOfMs: event.emittedAtMs,
        ...accounting,
    } };
}
