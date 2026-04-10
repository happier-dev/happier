import { buildTokenCountSessionMessageFromUsageObservation, extractUsageObservationFromTokenCountMessage } from '@/usage/usageObservation';
import { estimateCodexUsageCost } from './codexUsagePricing';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

export function buildCodexAppServerTokenCountSessionMessage(params: Readonly<{
    notificationParams: unknown;
    modelId?: string | null;
}>): ReturnType<typeof buildTokenCountSessionMessageFromUsageObservation> {
    const record = asRecord(params.notificationParams);
    if (!record) return null;
    const tokenUsage = asRecord(record.tokenUsage) ?? asRecord(record.token_usage);
    if (!tokenUsage) return null;

    const totalUsage = asRecord(tokenUsage.total) ?? asRecord(tokenUsage.totalTokenUsage);
    const deltaUsage = asRecord(tokenUsage.last) ?? asRecord(tokenUsage.lastTokenUsage);
    const usageRecord = totalUsage ?? deltaUsage;
    if (!usageRecord) return null;

    const scope = totalUsage ? 'session_cumulative' : 'turn_delta';
    const observation = extractUsageObservationFromTokenCountMessage({
        provider: 'codex',
        defaultSource: 'codex-app-server-token-usage',
        defaultScope: scope,
        body: {
            ...usageRecord,
            ...(params.modelId ? { modelId: params.modelId } : {}),
            source: 'codex-app-server-token-usage',
            scope,
            context_window_tokens: tokenUsage.modelContextWindow ?? tokenUsage.model_context_window,
        },
    });
    if (!observation) return null;

    const estimatedCost = estimateCodexUsageCost({
        modelId: observation.modelId ?? params.modelId ?? null,
        tokens: observation.tokens,
    });

    return buildTokenCountSessionMessageFromUsageObservation({
        ...observation,
        ...(estimatedCost ? { cost: estimatedCost } : {}),
        contextUsedTokens: observation.contextUsedTokens ?? observation.tokens?.total ?? null,
    });
}
