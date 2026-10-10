import { describe, expect, it } from 'vitest';

import { projectPiSessionStatsUsage } from './usage.js';

describe('projectPiSessionStatsUsage', () => {
  it('includes paid cumulative generations independently of current context', () => {
    // Pi 0.82.1 getSessionStats uses all getEntries(), unlike live getContextUsage.
    const observation = projectPiSessionStatsUsage({
      stats: { sessionId: 'native-pi-session', tokens: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, total: 19 }, cost: 0.3 },
      sessionId: 'session-1', turnId: null, observationId: 'paid-stats', observedAtMs: 10,
    });
    expect(observation).toMatchObject({ kind: 'usage-observed', scope: 'session_cumulative',
      tokens: { total: 19 }, cost: { estimatedUsd: 0.3, costSource: 'pricing_estimate' } });
    expect(observation?.accounting).toEqual({
      nativeSessionId: 'native-pi-session', inputIncludesCache: false, outputIncludesReasoning: false,
      historyComplete: false,
    });
  });
  it('projects Pi context usage into the canonical runtime usage event', () => {
    expect(projectPiSessionStatsUsage({
      stats: { contextUsage: { tokens: 1234, contextWindow: 128000 } },
      sessionId: 'session-1',
      turnId: 'turn-1',
      observationId: 'pi-usage-1',
      observedAtMs: 10,
    })).toMatchObject({
      kind: 'usage-observed',
      context: { usedTokens: 1234, windowTokens: 128000 },
    });
  });

  it('treats explicit null usage as authoritative', () => {
    expect(projectPiSessionStatsUsage({
      stats: { contextUsage: null },
      sessionId: 'session-1',
      turnId: null,
      observationId: 'pi-usage-2',
      observedAtMs: 10,
    })).toBeNull();
  });
});
