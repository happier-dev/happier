import { estimateClaudeUsageCost } from './cost.js';
import type { ClaudeTokenUsage, ClaudeUsageObservation } from './types.js';

function asFiniteNonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function buildClaudeAssistantUsageObservation(params: Readonly<{
    modelId?: string | null;
    usage: ClaudeTokenUsage;
}>): ClaudeUsageObservation | null {
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
    const tokens: ClaudeUsageObservation['tokens'] = { total };
    if (inputTokens != null) tokens.input = inputTokens;
    if (outputTokens != null) tokens.output = outputTokens;
    if (cacheCreationTokens != null) tokens.cache_creation = cacheCreationTokens;
    if (cacheReadTokens != null) tokens.cache_read = cacheReadTokens;

    return {
        provider: 'claude',
        source: 'claude-assistant-usage',
        scope: 'turn_delta',
        key: 'claude-session',
        modelId: typeof params.modelId === 'string' && params.modelId.trim().length > 0 ? params.modelId.trim() : null,
        tokens,
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
