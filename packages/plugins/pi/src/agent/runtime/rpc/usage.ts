import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { normalizePiPaidUsage } from '../../usage/paidUsage.js';

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
  if (!stats) return null;
  const paidTokens = readRecord(stats.tokens);
  const paid = paidTokens ? normalizePiPaidUsage({ ...paidTokens, totalTokens: paidTokens.total, cost: { total: stats.cost } }) : null;
  const usage = readRecord(stats.contextUsage);
  const usedTokens = readNonNegativeInteger(usage?.tokens);
  const windowTokens = readNonNegativeInteger(usage?.contextWindow);
  const nativeSessionId = typeof stats.sessionId === 'string' && stats.sessionId.trim()
    ? stats.sessionId.trim()
    : null;
  if (usedTokens === null && !paid) return null;
  return {
    kind: 'usage-observed',
    sessionId: params.sessionId,
    emittedAtMs: params.observedAtMs,
    observationId: params.observationId,
    ...(params.turnId ? { turnId: params.turnId } : {}),
    source: 'pi-session-stats',
    scope: 'session_cumulative',
    ...(paid ? {
      tokens: paid.tokens,
      ...(paid.cost ? { cost: paid.cost } : {}),
      accounting: {
        ...(nativeSessionId ? { nativeSessionId } : {}),
        inputIncludesCache: false,
        outputIncludesReasoning: false,
        // Native stats include copied fork history but expose no parent/entry IDs.
        historyComplete: false,
      },
    } : {}),
    ...(usedTokens === null ? {} : { context: {
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
    } }),
  };
}
