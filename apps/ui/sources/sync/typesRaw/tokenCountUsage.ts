import type { UsageData } from './schemas';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function asFiniteNonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function pickUsageNumber(record: Record<string, unknown>, ...keys: readonly string[]): number | null {
    for (const key of keys) {
        const value = asFiniteNonNegativeNumber(record[key]);
        if (value != null) return value;
    }
    return null;
}

function buildUsageData(parts: Readonly<{
    input: number | null;
    output: number | null;
    cacheCreation?: number | null;
    cacheRead?: number | null;
}>): UsageData | null {
    if (parts.input == null || parts.output == null) return null;

    return {
        input_tokens: parts.input,
        output_tokens: parts.output,
        ...(parts.cacheCreation != null ? { cache_creation_input_tokens: parts.cacheCreation } : {}),
        ...(parts.cacheRead != null ? { cache_read_input_tokens: parts.cacheRead } : {}),
    };
}

function pickUsageNumberFromRecords(records: readonly (Record<string, unknown> | null)[], ...keys: readonly string[]): number | null {
    for (const record of records) {
        if (!record) continue;
        const value = pickUsageNumber(record, ...keys);
        if (value != null) return value;
    }
    return null;
}

function pickContextSnapshotFromRecords(
    records: readonly (Record<string, unknown> | null)[],
): unknown | undefined {
    for (const record of records) {
        if (!record) continue;
        if ('contextSnapshot' in record) return record.contextSnapshot;
        if ('context_snapshot' in record) return record.context_snapshot;
    }
    return undefined;
}

function withContextTelemetry(usage: UsageData, records: readonly (Record<string, unknown> | null)[]): UsageData {
    const contextUsedTokens = pickUsageNumberFromRecords(records, 'context_used_tokens', 'contextUsedTokens', 'used');
    const contextWindowTokens = pickUsageNumberFromRecords(records, 'context_window_tokens', 'contextWindowTokens', 'contextWindow', 'size');
    const contextSnapshot = pickContextSnapshotFromRecords(records);

    return {
        ...usage,
        ...(contextUsedTokens != null ? { context_used_tokens: contextUsedTokens } : {}),
        ...(contextWindowTokens != null ? { context_window_tokens: contextWindowTokens } : {}),
        ...(contextSnapshot !== undefined ? { contextSnapshot } : {}),
    };
}

function extractUsageDataFromTokenMap(raw: unknown): UsageData | null {
    const record = asRecord(raw);
    if (!record) return null;

    return buildUsageData({
        input: pickUsageNumber(record, 'input'),
        output: pickUsageNumber(record, 'output'),
        cacheCreation: pickUsageNumber(record, 'cache_creation'),
        cacheRead: pickUsageNumber(record, 'cache_read'),
    });
}

function extractUsageDataFromNestedInfo(raw: unknown): UsageData | null {
    const record = asRecord(raw);
    if (!record) return null;

    const total = asRecord(record.total_token_usage);
    const last = asRecord(record.last_token_usage);
    const source = total ?? last;
    if (!source) return null;

    return buildUsageData({
        input: pickUsageNumber(source, 'input_tokens', 'input'),
        output: pickUsageNumber(source, 'output_tokens', 'output'),
        cacheCreation: pickUsageNumber(source, 'cache_creation_input_tokens', 'cache_creation'),
        cacheRead: pickUsageNumber(source, 'cache_read_input_tokens', 'cache_read', 'cached_input_tokens'),
    });
}

export function extractUsageDataFromTokenCountRecord(raw: unknown): UsageData | null {
    const record = asRecord(raw);
    if (!record) return null;

    const info = asRecord(record.info);
    const nestedInfoTotal = asRecord(info?.total_token_usage);
    const nestedInfoLast = asRecord(info?.last_token_usage);
    const tokens = asRecord(record.tokens);
    const contextTelemetryRecords = [record, tokens, info, nestedInfoTotal, nestedInfoLast];

    const nestedInfoUsage = extractUsageDataFromNestedInfo(record.info);
    if (nestedInfoUsage) return withContextTelemetry(nestedInfoUsage, contextTelemetryRecords);

    const nestedTokenMapUsage = extractUsageDataFromTokenMap(record.tokens);
    if (nestedTokenMapUsage) return withContextTelemetry(nestedTokenMapUsage, contextTelemetryRecords);

    const usage = buildUsageData({
        input: pickUsageNumber(record, 'input_tokens', 'input', 'prompt_tokens'),
        output: pickUsageNumber(record, 'output_tokens', 'output', 'completion_tokens'),
        cacheCreation: pickUsageNumber(record, 'cache_creation_input_tokens', 'cache_creation'),
        cacheRead: pickUsageNumber(record, 'cache_read_input_tokens', 'cache_read', 'cached_input_tokens'),
    });
    if (usage) return withContextTelemetry(usage, contextTelemetryRecords);

    // Context-only token_count records (e.g. Claude's on-demand/live
    // `getContextUsage()` snapshot) carry NO token counts — only context
    // telemetry. Dropping them would silently lose the provider context truth
    // (observed live 2026-07-10). Emit a zero-token usage flagged
    // `context_only` so the reducer can merge the context fields without
    // clobbering the previous turn's token totals.
    const contextOnly = withContextTelemetry(
        { input_tokens: 0, output_tokens: 0, context_only: true },
        contextTelemetryRecords,
    );
    const hasContextTelemetry = 'contextSnapshot' in contextOnly
        || 'context_used_tokens' in contextOnly
        || 'context_window_tokens' in contextOnly;
    return hasContextTelemetry ? contextOnly : null;
}
