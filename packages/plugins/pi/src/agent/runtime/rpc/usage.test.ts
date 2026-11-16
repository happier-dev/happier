import { describe, expect, it } from 'vitest';

import { createPiSessionStatsUsageProjector, projectPiSessionStatsUsage } from './usage.js';
import { estimateUsageModelCost } from '@happier-dev/protocol';

describe('projectPiSessionStatsUsage', () => {
  it('prices witnessed assistant counters without attributing unseen history or mixed models', () => {
    const projector = createPiSessionStatsUsageProjector();
    const stats = { tokens: { input: 3245, output: 4, cacheRead: 0, cacheWrite: 0, total: 3249 }, cost: 0 };
    const params = { stats, sessionId: 'session-1', observationId: 'paid', observedAtMs: 10 };
    // Pi 0.82.1 getSessionStats omits model and reasoning; message_end retains both.
    projector.observeRecord({ type: 'message_end', message: { role: 'assistant', model: 'openai/gpt-4.1-mini',
      usage: { input: 3245, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 3249 } } });
    const event = projector.project(params);
    expect(event).toMatchObject({ modelId: 'openai/gpt-4.1-mini', tokens: { reasoning: 0, total: 3249 } });
    expect(estimateUsageModelCost(event?.modelId, event?.tokens ?? null)?.total).toBeGreaterThan(0);
    const unseen = projector.project({ ...params, stats: { tokens: { ...stats.tokens, input: 3250, total: 3254 } } });
    expect(unseen?.modelId).toBeUndefined();
    expect(unseen?.tokens?.reasoning).toBeNull();
    projector.observeRecord({ type: 'message_end', message: { role: 'assistant', model: 'other-model',
      usage: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5 } } });
    const mixed = projector.project({ ...params, stats: { tokens: { ...stats.tokens, input: 3250, total: 3254 } } });
    expect(mixed?.modelId).toBeUndefined();
    expect(mixed?.tokens?.reasoning).toBe(0);
  });
  it('preserves absent reasoning even when model and all paid counters are witnessed', () => {
    const projector = createPiSessionStatsUsageProjector();
    projector.observeRecord({ type: 'message_end', message: { role: 'assistant', model: 'model',
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 } } });
    expect(projector.project({ stats: { tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } },
      sessionId: 'session-1', observationId: 'partial', observedAtMs: 10 }))
      .toMatchObject({ modelId: 'model', tokens: { reasoning: null } });
  });
  it('includes paid cumulative generations independently of current context', () => {
    // Pi 0.82.1 getSessionStats uses all getEntries(), unlike live getContextUsage.
    const observation = projectPiSessionStatsUsage({
      stats: { sessionId: 'native-pi-session', tokens: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, total: 19 }, cost: 0.3 },
      sessionId: 'session-1', observationId: 'paid-stats', observedAtMs: 10,
    });
    expect(observation).toMatchObject({ kind: 'usage-observed', scope: 'session_cumulative',
      tokens: { total: 19 }, cost: { estimatedUsd: 0.3, costSource: 'pricing_estimate' } });
    expect(observation?.accounting).toEqual({
      nativeSessionId: 'native-pi-session', inputIncludesCache: false, outputIncludesReasoning: true,
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
    })).toMatchObject({ tokens: { total: 0 } });
    expect(projectPiSessionStatsUsage({ stats: { tokens: { total: 3263 }, cost: 0 },
      sessionId: 'session-1', observationId: 'unpriced', observedAtMs: 10,
    })).not.toHaveProperty('cost');
    expect(projectPiSessionStatsUsage({ stats: { cost: 0.2 },
      sessionId: 'session-1', observationId: 'cost-only', observedAtMs: 10,
    })).toMatchObject({ tokens: { total: null }, cost: { estimatedUsd: 0.2 } });
  });
});
