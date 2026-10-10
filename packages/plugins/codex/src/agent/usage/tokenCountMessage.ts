import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    SessionContextUsageSnapshotV1,
    UsageObservationScope,
    UsageObservationTokens,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { estimateUsageModelCost, resolveUsageTokenCategories } from '@happier-dev/protocol';

export type CodexAppServerUsageObservationInput = Omit<
    Extract<AgentSessionRuntimeEvent, { kind: 'usage-observed' }>,
    'sequence' | 'sessionId' | 'emittedAtMs' | 'observationId' | 'turnId'
>;

export type CodexAppServerTokenCountObservationInput = Readonly<{
    provider: 'codex';
    defaultSource: 'codex-app-server-token-usage';
    defaultScope: UsageObservationScope;
    body: Readonly<Record<string, unknown>>;
    runtimeObservation: CodexAppServerUsageObservationInput | null;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function asFiniteNonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Codex input includes cached input; output includes reasoning output. Keep
 * those original overlapping counters while deriving total only once. Native
 * rollout adapters and live app-server notifications share this boundary. */
export function normalizeCodexTokenUsage(value: unknown): UsageObservationTokens | null {
    const record = asRecord(value);
    if (!record) return null;
    const input =
        asFiniteNonNegativeNumber(record.input_tokens) ??
        asFiniteNonNegativeNumber(record.input) ??
        asFiniteNonNegativeNumber(record.prompt_tokens) ??
        asFiniteNonNegativeNumber(record.promptTokens) ??
        asFiniteNonNegativeNumber(record.inputTokens);
    const output =
        asFiniteNonNegativeNumber(record.output_tokens) ??
        asFiniteNonNegativeNumber(record.output) ??
        asFiniteNonNegativeNumber(record.completion_tokens) ??
        asFiniteNonNegativeNumber(record.completionTokens) ??
        asFiniteNonNegativeNumber(record.outputTokens);
    const cacheRead =
        asFiniteNonNegativeNumber(record.cache_read_input_tokens) ??
        asFiniteNonNegativeNumber(record.cache_read_tokens) ??
        asFiniteNonNegativeNumber(record.cached_input_tokens) ??
        asFiniteNonNegativeNumber(record.cached_read_tokens) ??
        asFiniteNonNegativeNumber(record.cachedInputTokens) ??
        asFiniteNonNegativeNumber(record.cachedReadTokens) ??
        asFiniteNonNegativeNumber(record.cache_read) ??
        asFiniteNonNegativeNumber(record.cacheReadTokens);
    const cacheCreation =
        asFiniteNonNegativeNumber(record.cache_write_input_tokens) ??
        asFiniteNonNegativeNumber(record.cacheWriteInputTokens) ??
        asFiniteNonNegativeNumber(record.cache_creation_input_tokens) ??
        asFiniteNonNegativeNumber(record.cache_creation_tokens) ??
        asFiniteNonNegativeNumber(record.cached_write_tokens) ??
        asFiniteNonNegativeNumber(record.cachedWriteTokens) ??
        asFiniteNonNegativeNumber(record.cache_creation) ??
        asFiniteNonNegativeNumber(record.cacheCreationTokens);
    const thought =
        asFiniteNonNegativeNumber(record.thought_tokens) ??
        asFiniteNonNegativeNumber(record.reasoning_output_tokens) ??
        asFiniteNonNegativeNumber(record.reasoningOutputTokens) ??
        asFiniteNonNegativeNumber(record.thoughtTokens) ??
        asFiniteNonNegativeNumber(record.thought);
    const total =
        asFiniteNonNegativeNumber(record.total_tokens) ??
        asFiniteNonNegativeNumber(record.totalTokens) ??
        asFiniteNonNegativeNumber(record.total);

    if (total == null && input == null && output == null && cacheRead == null
        && cacheCreation == null && thought == null) return null;

    return {
        total: total ?? (input ?? 0) + (output ?? 0),
        input: input ?? 0,
        output: output ?? 0,
        cacheRead: cacheRead ?? 0,
        cacheWrite: cacheCreation ?? 0,
        reasoning: thought ?? 0,
    };
}

export function buildCodexAppServerTokenCountObservationInput(params: Readonly<{
    notificationParams: unknown;
    modelId?: string | null;
    modelSource?: 'codex-native' | 'provider';
    observedAtMs?: number;
}>): CodexAppServerTokenCountObservationInput | null {
    const record = asRecord(params.notificationParams);
    if (!record) return null;
    const tokenUsage = asRecord(record.tokenUsage) ?? asRecord(record.token_usage);
    if (!tokenUsage) return null;

    const totalUsage = asRecord(tokenUsage.total) ?? asRecord(tokenUsage.totalTokenUsage);
    const deltaUsage = asRecord(tokenUsage.last) ?? asRecord(tokenUsage.lastTokenUsage);
    const usageRecord = totalUsage ?? deltaUsage;
    if (!usageRecord) return null;

    const defaultScope: UsageObservationScope = totalUsage ? 'session_cumulative' : 'turn_delta';
    const tokens = normalizeCodexTokenUsage(usageRecord);
    const modelId = typeof params.modelId === 'string' && params.modelId.trim().length > 0
        ? params.modelId.trim()
        : null;
    const contextWindowTokens = asFiniteNonNegativeNumber(
        tokenUsage.modelContextWindow ?? tokenUsage.model_context_window,
    );
    const lastUsageTokens = deltaUsage ? normalizeCodexTokenUsage(deltaUsage) : null;
    const cost = params.modelSource === 'provider'
        ? null
        : estimateUsageModelCost(modelId, tokens
            ? resolveUsageTokenCategories(tokens, { inputIncludesCache: true, outputIncludesReasoning: true }) : null);
    const contextSnapshot = lastUsageTokens ? {
        v: 1,
        modelId,
        usedTokens: lastUsageTokens.total,
        windowTokens: contextWindowTokens,
        totalProcessedTokens: totalUsage ? tokens?.total ?? null : null,
        baselineTokens: 12_000,
        isAutoCompactEnabled: null,
        categories: null,
        observedAtMs: params.observedAtMs ?? Date.now(),
        source: 'provider_turn',
    } satisfies SessionContextUsageSnapshotV1 : null;
    const runtimeTokens = tokens;
    const runtimeCost = cost ? {
        reportedUsd: 0,
        estimatedUsd: cost.estimatedUsd,
        billingContext: 'unknown' as const,
        costSource: 'pricing_estimate' as const,
        currency: 'USD',
        ...(cost.breakdown ? { breakdown: cost.breakdown } : {}),
    } : null;
    const runtimeObservation: CodexAppServerUsageObservationInput | null =
        runtimeTokens || runtimeCost || contextSnapshot
            ? {
                kind: 'usage-observed',
                source: 'codex-app-server-token-usage',
                scope: defaultScope,
                accounting: { inputIncludesCache: true, outputIncludesReasoning: true },
                ...(modelId ? { modelId } : {}),
                ...(runtimeTokens ? { tokens: runtimeTokens } : {}),
                ...(runtimeCost ? { cost: runtimeCost } : {}),
                ...(contextSnapshot ? { context: contextSnapshot } : {}),
            }
            : null;

    return {
        provider: 'codex',
        defaultSource: 'codex-app-server-token-usage',
        defaultScope,
        body: {
            ...usageRecord,
            ...(tokens ? { tokens } : {}),
            ...(modelId ? { modelId } : {}),
            source: 'codex-app-server-token-usage',
            scope: defaultScope,
            ...(contextWindowTokens != null ? {
                context_used_tokens: lastUsageTokens?.total ?? null,
                context_window_tokens: contextWindowTokens,
            } : {}),
            ...(contextSnapshot ? { contextSnapshot } : {}),
            ...(cost ? { cost } : {}),
        },
        runtimeObservation,
    };
}
