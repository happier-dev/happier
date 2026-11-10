import { PROMPT_CACHE_DURATIONS } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    ClaudeTokenUsage,
    ClaudeUsageModelSource,
    ClaudeUsageObservation,
} from './types.js';

export const CLAUDE_ASSISTANT_USAGE_SOURCE = 'claude-assistant-usage';

function asFiniteNonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function buildClaudeAssistantUsageObservation(params: Readonly<{
    modelId?: string | null;
    modelSource?: ClaudeUsageModelSource;
    nativeRecordId?: string | null;
    inferenceId?: string | null;
    nativeSessionId?: string | null;
    turnId?: string | null;
    observedAtMs?: number;
    requestStartedAtMs?: number;
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

    const total = inputTokens === null || outputTokens === null
        || cacheCreationTokens === null || cacheReadTokens === null
        ? null : inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
    const tokens: ClaudeUsageObservation['tokens'] = {
        total,
        input: inputTokens,
        output: outputTokens,
        reasoning: null,
        cacheWrite: cacheCreationTokens,
        cacheRead: cacheReadTokens,
    };

    return {
        provider: 'claude',
        source: CLAUDE_ASSISTANT_USAGE_SOURCE,
        scope: 'turn_delta',
        key: 'claude-session',
        ...(params.nativeRecordId ? { nativeRecordId: params.nativeRecordId } : {}),
        ...(params.inferenceId ? { inferenceId: params.inferenceId } : {}),
        ...(params.nativeSessionId ? { nativeSessionId: params.nativeSessionId } : {}),
        ...(params.turnId ? { turnId: params.turnId } : {}),
        ...(params.observedAtMs === undefined ? {} : { observedAtMs: params.observedAtMs }),
        ...(params.requestStartedAtMs === undefined ? {} : { promptCache: {
            lastUseAtMs: params.requestStartedAtMs,
            ...((asFiniteNonNegativeNumber(params.usage.cache_creation?.ephemeral_1h_input_tokens) ?? 0) > 0
                ? { ttlMs: PROMPT_CACHE_DURATIONS.anthropic.longTtlMs } : {}),
        } }),
        modelId: typeof params.modelId === 'string' && params.modelId.trim().length > 0 ? params.modelId.trim() : null,
        tokens,
        // Claude does not report the separate reasoning category required by tariff pricing.
        cost: null,
        contextUsedTokens: null,
        contextWindowTokens: null,
    };
}
