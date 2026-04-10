import type { UsageEventIngestRequest } from '@happier-dev/protocol';

import type { UsageObservation, UsageObservationScope } from './usageObservation';

function asNullableTrimmedString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function clampNonNegative(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function asBillingContext(value: unknown): UsageEventIngestRequest['cost']['billingContext'] {
    return value === 'api_usage' ||
        value === 'subscription_included' ||
        value === 'subscription_with_possible_overage' ||
        value === 'unknown'
        ? value
        : undefined;
}

function asCostSource(value: unknown): UsageEventIngestRequest['cost']['costSource'] {
    return value === 'provider_reported' ||
        value === 'provider_reported_api_equivalent' ||
        value === 'pricing_estimate' ||
        value === 'invoice' ||
        value === 'none'
        ? value
        : undefined;
}

function inferIsCumulative(scope: UsageObservationScope): boolean {
    return scope !== 'turn_delta';
}

function resolveUsageTokens(observation: UsageObservation): UsageEventIngestRequest['tokens'] {
    const tokens = observation.tokens;
    const input = clampNonNegative(tokens?.input);
    const output = clampNonNegative(tokens?.output);
    const reasoning = clampNonNegative(tokens?.reasoning ?? tokens?.thought);
    const cacheRead = clampNonNegative(tokens?.cacheRead ?? tokens?.cache_read);
    const cacheWrite = clampNonNegative(tokens?.cacheWrite ?? tokens?.cache_write ?? tokens?.cache_creation);
    const total =
        clampNonNegative(tokens?.total) ||
        input + output + reasoning + cacheRead + cacheWrite;

    return {
        input,
        output,
        reasoning,
        cacheRead,
        cacheWrite,
        total,
    };
}

function resolveUsageCost(observation: UsageObservation): UsageEventIngestRequest['cost'] {
    const cost = observation.cost;
    const reportedUsd =
        clampNonNegative(
            cost?.reportedUsd ??
            cost?.reported_usd ??
            cost?.reported ??
            (observation.source === 'claude-sdk-result' ? cost?.total : undefined),
        );
    const estimatedUsd =
        clampNonNegative(
            cost?.estimatedUsd ??
            cost?.estimated_usd ??
            cost?.estimated ??
            (reportedUsd > 0 ? undefined : cost?.total),
        );
    const invoiceUsd = clampNonNegative(cost?.invoiceUsd);
    const hasInvoiceUsd = cost != null && Object.prototype.hasOwnProperty.call(cost, 'invoiceUsd');
    const billingContext = asBillingContext(cost?.billingContext);
    const costSource = asCostSource(cost?.costSource);
    const breakdown = Object.fromEntries(
        Object.entries(cost ?? {})
            .filter(([key, value]) => {
                if (
                    key === 'total' ||
                    key === 'reportedUsd' ||
                    key === 'reported_usd' ||
                    key === 'reported' ||
                    key === 'estimatedUsd' ||
                    key === 'estimated_usd' ||
                    key === 'estimated' ||
                    key === 'invoiceUsd' ||
                    key === 'billingContext' ||
                    key === 'costSource' ||
                    key === 'currency'
                ) {
                    return false;
                }
                return typeof value === 'number' && Number.isFinite(value) && value >= 0;
            })
            .map(([key, value]) => [key, clampNonNegative(value)]),
    );

    return {
        reportedUsd,
        estimatedUsd,
        ...(hasInvoiceUsd ? { invoiceUsd } : {}),
        ...(billingContext ? { billingContext } : {}),
        ...(costSource ? { costSource } : {}),
        currency: asNullableTrimmedString(cost?.currency) ?? 'USD',
        breakdown,
    };
}

function hasUsageData(request: Readonly<{
    tokens: UsageEventIngestRequest['tokens'];
    cost: UsageEventIngestRequest['cost'];
    context: UsageEventIngestRequest['context'];
}>): boolean {
    return (
        request.tokens.total > 0 ||
        request.cost.reportedUsd > 0 ||
        request.cost.estimatedUsd > 0 ||
        request.context?.usedTokens != null ||
        request.context?.windowTokens != null
    );
}

export function buildUsageEventIngestRequest(params: Readonly<{
    sessionId: string;
    observedAt: number;
    observation: UsageObservation;
    backendMode?: string | null;
    projectKey?: string | null;
    workspaceId?: string | null;
    machineId?: string | null;
    turnId?: string | null;
    externalKey?: string | null;
    metadata?: Record<string, unknown>;
}>): UsageEventIngestRequest | null {
    const sessionId = asNullableTrimmedString(params.sessionId);
    if (!sessionId) return null;

    const tokens = resolveUsageTokens(params.observation);
    const cost = resolveUsageCost(params.observation);
    const context =
        params.observation.contextUsedTokens != null || params.observation.contextWindowTokens != null
            ? {
                  usedTokens:
                      params.observation.contextUsedTokens != null
                          ? clampNonNegative(params.observation.contextUsedTokens)
                          : null,
                  windowTokens:
                      params.observation.contextWindowTokens != null
                          ? clampNonNegative(params.observation.contextWindowTokens)
                          : null,
              }
            : undefined;

    if (!hasUsageData({ tokens, cost, context })) {
        return null;
    }

    const metadata = {
        ...(params.observation.key ? { observationKey: params.observation.key } : {}),
        ...(params.metadata ?? {}),
    };

    return {
        sessionId,
        observedAt: Math.max(0, Math.trunc(params.observedAt)),
        providerId: params.observation.provider,
        backendMode: asNullableTrimmedString(params.backendMode),
        modelId: asNullableTrimmedString(params.observation.modelId),
        projectKey: asNullableTrimmedString(params.projectKey),
        workspaceId: asNullableTrimmedString(params.workspaceId),
        machineId: asNullableTrimmedString(params.machineId),
        source: params.observation.source,
        scope: params.observation.scope,
        externalKey: asNullableTrimmedString(params.externalKey),
        turnId: asNullableTrimmedString(params.turnId),
        isCumulative: inferIsCumulative(params.observation.scope),
        tokens,
        cost,
        context,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
}
