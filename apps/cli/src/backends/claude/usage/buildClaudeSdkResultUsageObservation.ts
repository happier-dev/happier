import type { SDKResultMessage } from '@/backends/claude/sdk/types';
import type { UsageObservation } from '@/usage/usageObservation';

function asFiniteNonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function buildClaudeSdkResultUsageObservation(params: Readonly<{
    modelId: string;
    result: SDKResultMessage;
}>): UsageObservation | null {
    const usage = (params.result as any)?.usage;
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;

    const inputTokens = asFiniteNonNegativeNumber((usage as any).input_tokens);
    const outputTokens = asFiniteNonNegativeNumber((usage as any).output_tokens);
    const cacheReadTokens = asFiniteNonNegativeNumber((usage as any).cache_read_input_tokens);
    const cacheCreationTokens = asFiniteNonNegativeNumber((usage as any).cache_creation_input_tokens);
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
    const cost = asFiniteNonNegativeNumber((params.result as any)?.total_cost_usd);
    const contextWindowTokens = asFiniteNonNegativeNumber((params.result as any)?.modelUsage?.contextWindow);

    return {
        provider: 'claude',
        source: 'claude-sdk-result',
        scope: 'session_final',
        key: 'claude-session',
        modelId: params.modelId,
        tokens: {
            total,
            ...(inputTokens != null ? { input: inputTokens } : {}),
            ...(outputTokens != null ? { output: outputTokens } : {}),
            ...(cacheReadTokens != null ? { cache_read: cacheReadTokens } : {}),
            ...(cacheCreationTokens != null ? { cache_creation: cacheCreationTokens } : {}),
        },
        cost: cost != null ? { reportedUsd: cost, total: cost } : null,
        contextUsedTokens: null,
        contextWindowTokens,
    };
}
