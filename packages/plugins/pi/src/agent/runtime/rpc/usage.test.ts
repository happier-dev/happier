import { describe, expect, it } from 'vitest';

import { projectPiSessionStatsUsage } from './usage.js';

describe('projectPiSessionStatsUsage', () => {
  it('includes paid cumulative generations independently of current context', () => {
    // Pi 0.82.1 getSessionStats uses all getEntries(), unlike live getContextUsage.
    const observation = projectPiSessionStatsUsage({
      stats: { sessionId: 'native-pi-session', tokens: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, total: 19 }, cost: 0.3 },
      sessionId: 'session-1', observationId: 'paid-stats', observedAtMs: 10,
    });
    expect(observation).toMatchObject({ kind: 'usage-observed', scope: 'session_cumulative',
      tokens: { total: 19 }, cost: { estimatedUsd: 0.3, costSource: 'pricing_estimate' } });
    expect(observation?.accounting).toEqual({
      nativeSessionId: 'native-pi-session', inputIncludesCache: false, outputIncludesReasoning: false,
      historyComplete: false,
    });
  });
  it('treats explicit null usage as authoritative', () => {
    expect(projectPiSessionStatsUsage({
      stats: { contextUsage: null },
      sessionId: 'session-1',
      observationId: 'pi-usage-2',
      observedAtMs: 10,
    })).toBeNull();
  });
  it('retains partial paid counters without borrowing them as a total or current context', () => {
    expect(projectPiSessionStatsUsage({ stats: { tokens: { input: 12, output: 0 } },
      sessionId: 'session-1', observationId: 'partial', observedAtMs: 10,
    })).toMatchObject({ tokens: { input: 12, output: 0, total: null, reasoning: null } });
    expect(projectPiSessionStatsUsage({ stats: { tokens: { total: 0 }, cost: 0 },
      sessionId: 'session-1', observationId: 'zero', observedAtMs: 10,
    })).toMatchObject({ tokens: { total: 0 }, cost: { estimatedUsd: 0, reportedUsd: null } });
    expect(projectPiSessionStatsUsage({ stats: { cost: 0.2 },
      sessionId: 'session-1', observationId: 'cost-only', observedAtMs: 10,
    })).toMatchObject({ tokens: { total: null }, cost: { estimatedUsd: 0.2 } });
  });
});
