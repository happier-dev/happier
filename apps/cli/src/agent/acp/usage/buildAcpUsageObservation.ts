import {
    extractUsageObservationFromTokenCountMessage,
    type UsageObservation,
} from '@/usage/usageObservation';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function normalizeAcpUsageUpdateCost(raw: unknown): unknown {
    const record = asRecord(raw);
    if (!record) return raw;
    const amount = typeof record.amount === 'number' && Number.isFinite(record.amount) && record.amount >= 0
        ? record.amount
        : null;
    return amount != null ? { total: amount } : raw;
}

export function buildAcpUsageUpdateObservation(params: Readonly<{
    provider: string;
    update: unknown;
}>): UsageObservation | null {
    const record = asRecord(params.update);
    if (!record) return null;
    return extractUsageObservationFromTokenCountMessage({
        provider: params.provider,
        defaultSource: 'acp-usage-update',
        defaultScope: 'session_cumulative',
        body: {
            ...record,
            ...(record.cost !== undefined ? { cost: normalizeAcpUsageUpdateCost(record.cost) } : {}),
            key: 'acp-usage-update',
            source: 'acp-usage-update',
            scope: 'session_cumulative',
        },
    });
}

export function buildAcpSessionUpdateUsageObservation(params: Readonly<{
    provider: string;
    usage: unknown;
}>): UsageObservation | null {
    const record = asRecord(params.usage);
    if (!record) return null;
    return extractUsageObservationFromTokenCountMessage({
        provider: params.provider,
        defaultSource: 'acp-session-update-usage',
        defaultScope: 'turn_delta',
        body: {
            ...record,
            key: 'acp-session-update-usage',
            source: 'acp-session-update-usage',
            scope: 'turn_delta',
        },
    });
}

export function buildAcpPromptUsageObservation(params: Readonly<{
    provider: string;
    promptResponse: unknown;
}>): UsageObservation | null {
    const promptResponse = asRecord(params.promptResponse);
    if (!promptResponse) return null;
    const usage = asRecord(promptResponse.usage);
    if (!usage) return null;
    return extractUsageObservationFromTokenCountMessage({
        provider: params.provider,
        defaultSource: 'acp-prompt-usage',
        defaultScope: 'turn_delta',
        body: {
            ...usage,
            key: 'acp-prompt-usage',
            modelId: promptResponse.modelId ?? promptResponse.model,
            source: 'acp-prompt-usage',
            scope: 'turn_delta',
        },
    });
}
