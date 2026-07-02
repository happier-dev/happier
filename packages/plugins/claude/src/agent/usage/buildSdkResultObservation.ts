import type { SDKResultMessage } from '../sdk/types.js';
import type { ClaudeUsageObservation } from './types.js';

function asFiniteNonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readContextWindowFromModelUsageEntry(entry: unknown): number | null {
    const record = asRecord(entry);
    if (!record) return null;
    return asFiniteNonNegativeNumber(record.contextWindow);
}

function readContextWindowTokensFromModelUsage(params: Readonly<{
    modelUsage: unknown;
    modelId: string;
}>): number | null {
    const modelUsage = asRecord(params.modelUsage);
    if (!modelUsage) return null;

    const directContextWindow = asFiniteNonNegativeNumber(modelUsage.contextWindow);
    if (directContextWindow != null) return directContextWindow;

    const preferredModelContextWindow = readContextWindowFromModelUsageEntry(modelUsage[params.modelId]);
    if (preferredModelContextWindow != null) return preferredModelContextWindow;

    let largestContextWindow: number | null = null;
    for (const value of Object.values(modelUsage)) {
        const candidate = readContextWindowFromModelUsageEntry(value);
        if (candidate == null) continue;
        if (largestContextWindow == null || candidate > largestContextWindow) {
            largestContextWindow = candidate;
        }
    }
    return largestContextWindow;
}

export function buildClaudeSdkResultUsageObservation(params: Readonly<{
    modelId: string;
    result: SDKResultMessage;
    contextUsedTokens?: number | null;
}>): ClaudeUsageObservation | null {
    const usage = asRecord(params.result.usage);
    if (!usage) return null;

    const inputTokens = asFiniteNonNegativeNumber(usage.input_tokens);
    const outputTokens = asFiniteNonNegativeNumber(usage.output_tokens);
    const cacheReadTokens = asFiniteNonNegativeNumber(usage.cache_read_input_tokens);
    const cacheCreationTokens = asFiniteNonNegativeNumber(usage.cache_creation_input_tokens);
    const anyPresent =
        inputTokens != null ||
        outputTokens != null ||
        cacheReadTokens != null ||
        cacheCreationTokens != null;
    if (!anyPresent) return null;

    const total =
        (inputTokens ?? 0) +
        (outputTokens ?? 0) +
        (cacheReadTokens ?? 0) +
        (cacheCreationTokens ?? 0);
    const cost = asFiniteNonNegativeNumber(params.result.total_cost_usd);
    const contextWindowTokens = readContextWindowTokensFromModelUsage({
        modelUsage: params.result.modelUsage,
        modelId: params.modelId,
    });
    const contextUsedTokens = contextWindowTokens != null
        ? asFiniteNonNegativeNumber(params.contextUsedTokens)
        : null;
    const tokens: ClaudeUsageObservation['tokens'] = { total };
    if (inputTokens != null) tokens.input = inputTokens;
    if (outputTokens != null) tokens.output = outputTokens;
    if (cacheReadTokens != null) tokens.cache_read = cacheReadTokens;
    if (cacheCreationTokens != null) tokens.cache_creation = cacheCreationTokens;

    return {
        provider: 'claude',
        source: 'claude-sdk-result',
        scope: 'session_final',
        key: 'claude-session',
        modelId: params.modelId,
        tokens,
        cost: cost != null ? { reportedUsd: cost, total: cost } : null,
        contextUsedTokens,
        contextWindowTokens,
    };
}
