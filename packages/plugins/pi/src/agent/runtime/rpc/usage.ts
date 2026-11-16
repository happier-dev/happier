import type { AgentSessionRuntimeEvent, UsageObservationTokens } from '@happier-dev/plugin-sdk/agents/runtime';
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

export function createPiSessionStatsUsageProjector() {
  const totals: UsageObservationTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, reasoning: 0 };
  let modelId: string | null | undefined;
  return {
    observeRecord(value: unknown) {
      const record = readRecord(value);
      const message = readRecord(record?.message);
      if (record?.type !== 'message_end' || message?.role !== 'assistant') return;
      const paid = normalizePiPaidUsage(message.usage, message.stopReason);
      if (!paid) return;
      const model = typeof message.model === 'string' && message.model.trim() ? message.model.trim() : null;
      modelId = modelId === undefined ? model : modelId === model ? modelId : null;
      for (const field of Object.keys(totals) as (keyof UsageObservationTokens)[]) {
        const previous = totals[field];
        const next = paid.tokens[field];
        totals[field] = previous === null || next === null ? null : previous + next;
      }
    },
    project(params: Parameters<typeof projectPiSessionStatsUsage>[0]) {
      const event = projectPiSessionStatsUsage(params);
      // Stats include resumed/fork history and paid summaries. Attribute only when
      // every paid counter is accounted for by this runtime's completed messages.
      // Keep constant-size totals, never retain or re-read message bodies.
      if (!event?.tokens || modelId === undefined || !(['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const)
        .every(field => totals[field] !== null && event.tokens![field] === totals[field])) return event;
      return { ...event, ...(modelId ? { modelId } : {}), tokens: { ...event.tokens, reasoning: totals.reasoning },
        accounting: { ...event.accounting, historyComplete: true } };
    },
  };
}

export function projectPiSessionStatsUsage(params: Readonly<{
  stats: unknown;
  sessionId: string;
  observationId: string;
  observedAtMs: number;
  promptCache?: Extract<AgentSessionRuntimeEvent, { kind: 'usage-observed' }>['promptCache'];
}>): Omit<Extract<AgentSessionRuntimeEvent, { kind: 'usage-observed' }>, 'sequence'> | null {
  const stats = readRecord(params.stats);
  if (!stats) return null;
  const paidTokens = readRecord(stats.tokens);
  // getSessionStats sums model-price costs without reporting a provider charge.
  const paid = normalizePiPaidUsage({ ...paidTokens, totalTokens: paidTokens?.total,
    cost: { total: stats.cost, totalFromProvider: false } });
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
    // Stats are Session-wide and arrive asynchronously after the turn terminal.
    source: 'pi-session-stats',
    scope: 'session_cumulative',
    ...(params.promptCache ? { promptCache: params.promptCache } : {}),
    ...(paid ? {
      tokens: paid.tokens,
      ...(paid.cost ? { cost: paid.cost } : {}),
      accounting: {
        ...(nativeSessionId ? { nativeSessionId } : {}),
        inputIncludesCache: false,
        outputIncludesReasoning: true,
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
