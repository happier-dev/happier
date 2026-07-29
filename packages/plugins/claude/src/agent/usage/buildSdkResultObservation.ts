import { estimateClaudeUsageCost } from './cost.js';
import type { ClaudeUsageModelSource, ClaudeUsageObservation } from './types.js';

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

    return readContextWindowFromModelUsageEntry(modelUsage[params.modelId]);
}

function readLastMessageIterationContextTokens(usage: Record<string, unknown>): number | null {
    const iterations = usage.iterations;
    if (!Array.isArray(iterations)) return null;
    for (let index = iterations.length - 1; index >= 0; index -= 1) {
        const iteration = asRecord(iterations[index]);
        if (iteration?.type !== 'message') continue;
        const input = asFiniteNonNegativeNumber(iteration.input_tokens);
        const output = asFiniteNonNegativeNumber(iteration.output_tokens);
        const cacheRead = asFiniteNonNegativeNumber(iteration.cache_read_input_tokens);
        const cacheCreation = asFiniteNonNegativeNumber(iteration.cache_creation_input_tokens);
        if (input == null && output == null && cacheRead == null && cacheCreation == null) return null;
        return (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0);
    }
    return null;
}

export function buildClaudeSdkResultUsageObservation(params: Readonly<{
    modelId: string;
    modelSource?: ClaudeUsageModelSource;
    result: unknown;
    observedAtMs?: number;
}>): ClaudeUsageObservation | null {
    const result = asRecord(params.result);
    if (!result || result.type !== 'result' || result.subtype !== 'success') return null;
    const usage = asRecord(result.usage);
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
    const reportedCost = asFiniteNonNegativeNumber(result.total_cost_usd);
    const contextWindowTokens = readContextWindowTokensFromModelUsage({
        modelUsage: result.modelUsage,
        modelId: params.modelId,
    });
    const contextUsedTokens = readLastMessageIterationContextTokens(usage);
    const tokens: ClaudeUsageObservation['tokens'] = {
        total,
        input: inputTokens ?? 0,
        output: outputTokens ?? 0,
        reasoning: 0,
        cacheRead: cacheReadTokens ?? 0,
        cacheWrite: cacheCreationTokens ?? 0,
    };
    const estimatedCost = params.modelSource === 'provider'
        ? null
        : estimateClaudeUsageCost({
            input_tokens: inputTokens ?? undefined,
            output_tokens: outputTokens ?? undefined,
            cache_read_input_tokens: cacheReadTokens ?? undefined,
            cache_creation_input_tokens: cacheCreationTokens ?? undefined,
        }, params.modelId);
    const cost = reportedCost != null
        ? {
            reportedUsd: reportedCost,
            estimatedUsd: 0,
            billingContext: 'unknown' as const,
            costSource: 'provider_reported' as const,
            currency: 'USD',
        }
        : estimatedCost
            ? {
                estimatedUsd: estimatedCost.total,
                ...(estimatedCost.breakdown ? { breakdown: estimatedCost.breakdown } : {}),
                reportedUsd: 0,
                billingContext: 'unknown' as const,
                costSource: 'pricing_estimate' as const,
                currency: 'USD',
            }
            : null;
    if (
        total <= 0
        && (cost?.reportedUsd ?? 0) <= 0
        && (cost?.estimatedUsd ?? 0) <= 0
        && contextUsedTokens == null
    ) return null;

    return {
        provider: 'claude',
        source: 'claude-sdk-result',
        scope: 'session_final',
        key: 'claude-session',
        modelId: params.modelId,
        tokens,
        cost,
        contextUsedTokens,
        contextWindowTokens,
        ...(contextUsedTokens != null ? {
            contextSnapshot: {
                v: 1,
                modelId: params.modelId,
                usedTokens: contextUsedTokens,
                windowTokens: contextWindowTokens,
                totalProcessedTokens: total,
                baselineTokens: null,
                isAutoCompactEnabled: null,
                categories: null,
                observedAtMs: params.observedAtMs ?? Date.now(),
                source: 'provider_turn',
            },
        } : {}),
    };
}
