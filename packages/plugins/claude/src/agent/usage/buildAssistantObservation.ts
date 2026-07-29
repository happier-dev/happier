import { estimateClaudeUsageCost } from './cost.js';
import type {
    ClaudeTokenUsage,
    ClaudeUsageModelSource,
    ClaudeUsageObservation,
} from './types.js';

function asFiniteNonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function buildClaudeAssistantUsageObservation(params: Readonly<{
    modelId?: string | null;
    modelSource?: ClaudeUsageModelSource;
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
    const costs = params.modelSource === 'provider'
        ? null
        : estimateClaudeUsageCost(params.usage, params.modelId ?? undefined);
    const tokens: ClaudeUsageObservation['tokens'] = {
        total,
        input: inputTokens ?? 0,
        output: outputTokens ?? 0,
        reasoning: 0,
        cacheWrite: cacheCreationTokens ?? 0,
        cacheRead: cacheReadTokens ?? 0,
    };

    return {
        provider: 'claude',
        source: 'claude-assistant-usage',
        scope: 'turn_delta',
        key: 'claude-session',
        modelId: typeof params.modelId === 'string' && params.modelId.trim().length > 0 ? params.modelId.trim() : null,
        tokens,
        cost: costs
            ? {
                estimatedUsd: costs.total,
                ...(costs.breakdown ? { breakdown: costs.breakdown } : {}),
                reportedUsd: 0,
                billingContext: 'unknown',
                costSource: 'pricing_estimate',
                currency: 'USD',
            }
            : null,
        contextUsedTokens: null,
        contextWindowTokens: null,
    };
}
