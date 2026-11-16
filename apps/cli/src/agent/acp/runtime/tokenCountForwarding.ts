import type { AgentSessionRuntimeEvent, SessionContextUsageSnapshotV1 } from '@happier-dev/protocol';

import {
  extractUsageObservationFromTokenCountMessage,
  type UsageObservation,
} from '../../../usage/usageObservation';
import { buildTokenCountSessionMessageFromUsageObservation } from '../../../usage/legacy/legacyUsageTransport';

/**
 * The measurement half of a canonical `usage-observed` runtime event: everything
 * the producer derives from the provider payload, without the host-owned
 * identity fields (`sequence`, `sessionId`, `emittedAtMs`, `observationId`,
 * `turnId`).
 */
export type UsageObservedRuntimeMeasurement = Readonly<Pick<
  Extract<AgentSessionRuntimeEvent, { kind: 'usage-observed' }>,
  'source' | 'scope' | 'modelId' | 'accounting' | 'tokens' | 'cost' | 'context'
>>;

function clampTokenCountCostForForwarding(
  cost: UsageObservation['cost'],
): UsageObservation['cost'] {
  if (!cost?.breakdown) return cost;
  const breakdown = Object.fromEntries(Object.entries(cost.breakdown)
    .filter(([key]) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype')
    .filter(([key]) => key.trim().length > 0 && key.length <= 64)
    .slice(0, 20));
  const { breakdown: _unboundedBreakdown, ...semanticCost } = cost;
  return Object.keys(breakdown).length === 0 ? semanticCost : { ...semanticCost, breakdown };
}

export function buildTokenCountSessionMessageForForwarding(
  agentMessage: Record<string, unknown>,
): ReturnType<typeof buildTokenCountSessionMessageFromUsageObservation> | null {
  const observation = extractUsageObservationFromTokenCountMessage({
    provider: 'unknown',
    body: agentMessage,
  });
  if (!observation) return null;

  return buildTokenCountSessionMessageFromUsageObservation({
    ...observation,
    cost: clampTokenCountCostForForwarding(observation.cost),
  });
}

function truncateNonNegative(value: number): number;
function truncateNonNegative(value: number | null): number | null;
function truncateNonNegative(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.trunc(value));
}

/**
 * The canonical runtime event carries context usage only as a full snapshot, so
 * a provider that reports bare used/window token counts needs one derived here.
 * A snapshot the provider supplied itself always wins.
 */
function resolveContextSnapshot(
  observation: UsageObservation,
  observedAtMs: number,
): SessionContextUsageSnapshotV1 | null {
  if (observation.contextSnapshot) return observation.contextSnapshot;
  if (observation.contextUsedTokens == null && observation.contextWindowTokens == null) return null;
  return {
    v: 1,
    modelId: observation.modelId,
    usedTokens: truncateNonNegative(observation.contextUsedTokens ?? 0),
    windowTokens: observation.contextWindowTokens == null
      ? null
      : truncateNonNegative(observation.contextWindowTokens),
    totalProcessedTokens: null,
    baselineTokens: null,
    isAutoCompactEnabled: null,
    categories: null,
    observedAtMs: truncateNonNegative(observedAtMs),
    source: 'provider_turn',
  };
}

/**
 * Projects a legacy `token_count` body onto the canonical `usage-observed`
 * measurement through the single usage-normalization owner, so the runtime
 * event carries the same tokens, cost and context the usage store and the
 * legacy transport already agree on.
 */
export function buildUsageObservedMeasurementFromTokenCountMessage(params: Readonly<{
  provider: string;
  body: unknown;
  observedAtMs: number;
  defaultSource?: string;
}>): UsageObservedRuntimeMeasurement | null {
  const observation = extractUsageObservationFromTokenCountMessage({
    provider: params.provider,
    body: params.body,
    ...(params.defaultSource ? { defaultSource: params.defaultSource } : {}),
  });
  if (!observation) return null;

  // The runtime event schema requires safe integers; the shared normalizer
  // tolerates the fractional counts some providers report.
  const tokens = observation.tokens
    ? {
        input: truncateNonNegative(observation.tokens.input),
        output: truncateNonNegative(observation.tokens.output),
        reasoning: truncateNonNegative(observation.tokens.reasoning),
        cacheRead: truncateNonNegative(observation.tokens.cacheRead),
        cacheWrite: truncateNonNegative(observation.tokens.cacheWrite),
        total: truncateNonNegative(observation.tokens.total),
      }
    : null;
  const context = resolveContextSnapshot(observation, params.observedAtMs);
  if (!tokens && !observation.cost && !context) return null;

  return {
    source: observation.source,
    scope: observation.scope,
    ...(observation.modelId ? { modelId: observation.modelId } : {}),
    ...(observation.accounting ? { accounting: observation.accounting } : {}),
    ...(tokens ? { tokens } : {}),
    ...(observation.cost ? { cost: observation.cost } : {}),
    ...(context ? { context } : {}),
  };
}
