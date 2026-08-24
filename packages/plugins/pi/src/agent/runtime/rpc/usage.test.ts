import { describe, expect, it } from 'vitest';

import { projectPiSessionStatsUsage } from './usage.js';

describe('projectPiSessionStatsUsage', () => {
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
