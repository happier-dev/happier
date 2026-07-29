import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agent-runtime';
import type {
    SessionContextUsageSnapshotV1,
    UsageObservationScope,
} from '@happier-dev/plugin-sdk/experimental/usage';

import { estimateCodexUsageCost, type CodexUsageNumberMap } from './pricing.js';

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

function readUsageNumberMap(record: Record<string, unknown>): CodexUsageNumberMap | null {
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

    const computedTotal =
        total ??
        (input ?? 0) +
        (output ?? 0) +
        (cacheRead ?? 0) +
        (cacheCreation ?? 0) +
        (thought ?? 0);

    if (computedTotal <= 0) return null;

    return {
        total: computedTotal,
        ...(input != null ? { input } : {}),
        ...(output != null ? { output } : {}),
        ...(cacheRead != null ? { cache_read: cacheRead } : {}),
        ...(cacheCreation != null ? { cache_creation: cacheCreation } : {}),
        ...(thought != null ? { thought } : {}),
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
    const tokens = readUsageNumberMap(usageRecord);
    const modelId = typeof params.modelId === 'string' && params.modelId.trim().length > 0
        ? params.modelId.trim()
        : null;
    const contextWindowTokens = asFiniteNonNegativeNumber(
        tokenUsage.modelContextWindow ?? tokenUsage.model_context_window,
    );
    const lastUsageTokens = deltaUsage ? readUsageNumberMap(deltaUsage) : null;
    const cost = params.modelSource === 'provider'
        ? null
        : estimateCodexUsageCost({
            modelId,
            tokens,
        });
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
    const runtimeTokens = tokens ? {
        input: tokens.input ?? 0,
        output: tokens.output ?? 0,
        reasoning: tokens.thought ?? 0,
        cacheRead: tokens.cache_read ?? 0,
        cacheWrite: tokens.cache_creation ?? 0,
        total: tokens.total,
    } : null;
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
