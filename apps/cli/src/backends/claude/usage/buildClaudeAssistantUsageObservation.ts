import type { Usage } from '@/api/types';
import type { UsageObservation } from '@/usage/usageObservation';

import { estimateClaudeUsageCost } from './estimateClaudeUsageCost';

function asFiniteNonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function buildClaudeAssistantUsageObservation(params: Readonly<{
    modelId?: string | null;
    usage: Usage;
}>): UsageObservation | null {
    const inputTokens = asFiniteNonNegativeNumber(params.usage.input_tokens);
    const outputTokens = asFiniteNonNegativeNumber(params.usage.output_tokens);
    const cacheCreationTokens = asFiniteNonNegativeNumber(params.usage.cache_creation_input_tokens);
    const cacheReadTokens = asFiniteNonNegativeNumber(params.usage.cache_read_input_tokens);

    const anyPresent =
        inputTokens != null ||
        outputTokens != null ||
        cacheCreationTokens != null ||
        cacheReadTokens != null;
    if (!anyPresent) {
        return null;
    }

    const total =
        (inputTokens ?? 0) +
        (outputTokens ?? 0) +
        (cacheCreationTokens ?? 0) +
        (cacheReadTokens ?? 0);
    const costs = estimateClaudeUsageCost(params.usage, params.modelId ?? undefined);

    return {
        provider: 'claude',
        source: 'claude-assistant-usage',
        scope: 'turn_delta',
        key: 'claude-session',
        modelId: typeof params.modelId === 'string' && params.modelId.trim().length > 0 ? params.modelId.trim() : null,
        tokens: {
            total,
            ...(inputTokens != null ? { input: inputTokens } : {}),
            ...(outputTokens != null ? { output: outputTokens } : {}),
            ...(cacheCreationTokens != null ? { cache_creation: cacheCreationTokens } : {}),
            ...(cacheReadTokens != null ? { cache_read: cacheReadTokens } : {}),
        },
        cost: {
            estimatedUsd: costs.total,
            total: costs.total,
            input: costs.input,
            output: costs.output,
            billingContext: 'unknown',
            costSource: 'pricing_estimate',
        },
        contextUsedTokens: null,
        contextWindowTokens: null,
    };
}
