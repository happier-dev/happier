import type { UsageEventIngestRequest } from '@happier-dev/protocol';

import {
    normalizeUsageObservation,
    type UsageObservation,
    type UsageObservationBoundaryInput,
    type UsageObservationScope,
} from './usageObservation';

function asNullableTrimmedString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function clampNonNegative(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function inferIsCumulative(scope: UsageObservationScope): boolean {
    return scope !== 'turn_delta';
}

function resolveUsageTokens(observation: UsageObservation): UsageEventIngestRequest['tokens'] {
    return observation.tokens ?? {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
    };
}

function resolveUsageCost(observation: UsageObservation): UsageEventIngestRequest['cost'] {
    return observation.cost
        ? {
              ...observation.cost,
              breakdown: observation.cost.breakdown ?? {},
          }
        : {
              reportedUsd: 0,
              estimatedUsd: 0,
              currency: 'USD',
              breakdown: {},
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
    observation: UsageObservationBoundaryInput;
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

    const observation = normalizeUsageObservation(params.observation);
    if (!observation) return null;

    const tokens = resolveUsageTokens(observation);
    const cost = resolveUsageCost(observation);
    const context =
        observation.contextUsedTokens != null || observation.contextWindowTokens != null
            ? {
                  usedTokens:
                      observation.contextUsedTokens != null
                          ? clampNonNegative(observation.contextUsedTokens)
                          : null,
                  windowTokens:
                      observation.contextWindowTokens != null
                          ? clampNonNegative(observation.contextWindowTokens)
                          : null,
              }
            : undefined;

    if (!hasUsageData({ tokens, cost, context })) {
        return null;
    }

    const metadata = {
        ...(observation.key ? { observationKey: observation.key } : {}),
        ...(params.metadata ?? {}),
    };

    return {
        sessionId,
        observedAt: Math.max(0, Math.trunc(params.observedAt)),
        agentId: observation.provider,
        backendMode: asNullableTrimmedString(params.backendMode),
        modelId: asNullableTrimmedString(observation.modelId),
        projectKey: asNullableTrimmedString(params.projectKey),
        workspaceId: asNullableTrimmedString(params.workspaceId),
        machineId: asNullableTrimmedString(params.machineId),
        source: observation.source,
        scope: observation.scope,
        externalKey: asNullableTrimmedString(params.externalKey),
        turnId: asNullableTrimmedString(params.turnId),
        isCumulative: inferIsCumulative(observation.scope),
        tokens,
        cost,
        context,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
}
