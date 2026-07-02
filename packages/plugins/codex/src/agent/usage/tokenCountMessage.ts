import type { UsageObservationScope } from '@happier-dev/protocol';

import { estimateCodexUsageCost, type CodexUsageNumberMap } from './pricing.js';

export type CodexAppServerTokenCountObservationInput = Readonly<{
    provider: 'codex';
    defaultSource: 'codex-app-server-token-usage';
    defaultScope: UsageObservationScope;
    body: Readonly<Record<string, unknown>>;
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
    const cost = estimateCodexUsageCost({
        modelId: params.modelId ?? null,
        tokens,
    });

    return {
        provider: 'codex',
        defaultSource: 'codex-app-server-token-usage',
        defaultScope,
        body: {
            ...usageRecord,
            ...(params.modelId ? { modelId: params.modelId } : {}),
            source: 'codex-app-server-token-usage',
            scope: defaultScope,
            context_window_tokens: tokenUsage.modelContextWindow ?? tokenUsage.model_context_window,
            ...(cost ? { cost } : {}),
        },
    };
}
