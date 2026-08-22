import type { SessionContextUsageSnapshotV1 } from '@happier-dev/plugin-sdk/agents/runtime';

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readNonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function buildClaudeLiveContextUsageSnapshot(params: Readonly<{
    response: unknown;
    observedAtMs: number;
}>): SessionContextUsageSnapshotV1 | null {
    const response = asRecord(params.response);
    const usedTokens = readNonNegativeNumber(response?.totalTokens);
    if (!response || usedTokens === null) return null;

    const categories = Array.isArray(response.categories)
        ? response.categories.flatMap((value) => {
            const category = asRecord(value);
            const key = readNonEmptyString(category?.name);
            const tokens = readNonNegativeNumber(category?.tokens);
            return key && tokens !== null ? [{ key, label: null, tokens }] : [];
        })
        : null;

    return {
        v: 1,
        modelId: readNonEmptyString(response.model),
        usedTokens,
        windowTokens: readNonNegativeNumber(response.maxTokens),
        totalProcessedTokens: null,
        baselineTokens: null,
        isAutoCompactEnabled: typeof response.isAutoCompactEnabled === 'boolean'
            ? response.isAutoCompactEnabled
            : null,
        categories,
        observedAtMs: params.observedAtMs,
        source: 'provider_live',
    };
}
