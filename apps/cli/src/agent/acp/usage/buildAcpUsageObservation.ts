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
    const amount =
        (typeof record.reportedUsd === 'number' && Number.isFinite(record.reportedUsd) && record.reportedUsd >= 0
            ? record.reportedUsd
            : null)
        ?? (typeof record.reported_usd === 'number' && Number.isFinite(record.reported_usd) && record.reported_usd >= 0
            ? record.reported_usd
            : null)
        ?? (typeof record.amount === 'number' && Number.isFinite(record.amount) && record.amount >= 0
            ? record.amount
            : null)
        ?? (typeof record.total === 'number' && Number.isFinite(record.total) && record.total >= 0
            ? record.total
            : null);
    if (amount == null) return raw;

    const { amount: _amount, reportedUsd: _reportedUsd, reported_usd: _reportedUsdSnake, total: _total, ...rest } = record;
    return {
        ...rest,
        reportedUsd: amount,
        total: amount,
        costSource: 'provider_reported',
    };
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
    projectUsage?: (input: Readonly<{
        usage: unknown;
        promptResponse: unknown;
    }>) => unknown;
}>): UsageObservation | null {
    const promptResponse = asRecord(params.promptResponse);
    if (!promptResponse) return null;
    const metadata = asRecord(promptResponse._meta);
    const usage = asRecord(promptResponse.usage) ?? asRecord(metadata?.usage);
    if (!usage) return null;
    const projectedUsage = params.projectUsage
        ? asRecord(params.projectUsage({ usage, promptResponse }))
        : usage;
    if (!projectedUsage) return null;
    return extractUsageObservationFromTokenCountMessage({
        provider: params.provider,
        defaultSource: 'acp-prompt-usage',
        defaultScope: 'turn_delta',
        body: {
            ...projectedUsage,
            key: 'acp-prompt-usage',
            modelId: promptResponse.modelId ?? promptResponse.model,
            source: 'acp-prompt-usage',
            scope: 'turn_delta',
        },
    });
}
