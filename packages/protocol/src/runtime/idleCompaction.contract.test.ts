import { describe, expect, it } from 'vitest';
import { AgentSessionCompactRequestV1Schema, AgentSessionRuntimeEventV1Schema } from './agentSessionV1.js';
import { UsageEventIngestRequestSchema } from '../usage/usageAnalyticsContracts.js';

const usage = {
  kind: 'usage-observed', sequence: 1, sessionId: 'session', emittedAtMs: 500,
  observationId: 'usage-1', source: 'provider', scope: 'turn_delta',
  tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
};
const capture = {
  sessionId: 'session', observedAt: 500, agentId: 'agent', source: 'provider', scope: 'turn_delta',
  isCumulative: false, tokens: usage.tokens, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
};

describe('public idle compaction contracts', () => {
  it('accepts cache-only evidence without an accounting measurement', () => {
    const event = {
      kind: 'usage-observed', sequence: 1, sessionId: 'session', emittedAtMs: 500,
      observationId: 'cache-only', source: 'provider', scope: 'turn_delta',
      promptCache: { lastUseAtMs: 100, ttlMs: 60_000 },
    };
    expect(AgentSessionRuntimeEventV1Schema.parse(event)).toEqual(event);
  });

  it.each([undefined, { lastUseAtMs: 0 }, { lastUseAtMs: 100, ttlMs: 60_000 }])(
    'preserves absent, clock-only and detected-window observations through runtime and capture', (promptCache) => {
      const field = promptCache ? { promptCache } : {};
      expect(AgentSessionRuntimeEventV1Schema.parse({ ...usage, ...field })).toEqual({ ...usage, ...field });
      expect(UsageEventIngestRequestSchema.parse({ ...capture, ...field })).toEqual({ ...capture, ...field });
    },
  );

  it.each([
    { ttlMs: 60_000 }, { lastUseAtMs: NaN }, { lastUseAtMs: Infinity },
    { lastUseAtMs: 100, ttlMs: 0 }, { lastUseAtMs: 100, ttlMs: -1 },
    { lastUseAtMs: 100, ttlMs: Infinity }, { lastUseAtMs: 100, receiptAtMs: 200 },
  ])('rejects invalid or undeclared request facts at both public boundaries', (promptCache) => {
    expect(AgentSessionRuntimeEventV1Schema.safeParse({ ...usage, promptCache }).success).toBe(false);
    expect(UsageEventIngestRequestSchema.safeParse({ ...capture, promptCache }).success).toBe(false);
  });

  it('admits idle control without changing admission results or requiring a foreground turn', () => {
    expect(AgentSessionCompactRequestV1Schema.parse({ compactionId: 'compact-1', trigger: 'idle' }))
      .toEqual({ compactionId: 'compact-1', trigger: 'idle' });
    const event = { kind: 'context-compaction', sequence: 2, sessionId: 'session', emittedAtMs: 600,
      compactionId: 'compact-1', trigger: 'idle', phase: 'completed', tokenCountBefore: 100, tokenCountAfter: 20, tokenCountSource: 'providerReported' as const };
    expect(AgentSessionRuntimeEventV1Schema.parse(event)).toEqual(event);
  });
});
