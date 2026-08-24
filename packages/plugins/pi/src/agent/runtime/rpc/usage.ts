import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

export function projectPiSessionStatsUsage(params: Readonly<{
  stats: unknown;
  sessionId: string;
  turnId: string | null;
  observationId: string;
  observedAtMs: number;
}>): Omit<Extract<AgentSessionRuntimeEvent, { kind: 'usage-observed' }>, 'sequence'> | null {
  const stats = readRecord(params.stats);
  if (!stats || !Object.prototype.hasOwnProperty.call(stats, 'contextUsage')) return null;
  const usage = readRecord(stats.contextUsage);
  if (!usage) return null;
  const usedTokens = readNonNegativeInteger(usage.tokens);
  const windowTokens = readNonNegativeInteger(usage.contextWindow);
  if (usedTokens === null) return null;
  return {
    kind: 'usage-observed',
    sessionId: params.sessionId,
    emittedAtMs: params.observedAtMs,
    observationId: params.observationId,
    ...(params.turnId ? { turnId: params.turnId } : {}),
    source: 'pi-session-stats',
    scope: 'session_cumulative',
    context: {
      v: 1,
      modelId: null,
      usedTokens,
      windowTokens: windowTokens && windowTokens > 0 ? windowTokens : null,
      totalProcessedTokens: null,
      baselineTokens: null,
      isAutoCompactEnabled: null,
      categories: null,
      observedAtMs: params.observedAtMs,
      source: 'provider_live',
    },
  };
}
