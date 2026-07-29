import { describe, expect, it } from 'vitest';

import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 } from './agentSessionLimitsV1.js';

describe('Agent session runtime limit candidate ownership', () => {
  it('owns the completion replay cache entry and JSON-byte capacities', () => {
    const completionReplay =
      AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates;

    expect(completionReplay.completionReplayCacheMaxEntries).toBe(1_024);
    expect(completionReplay.completionReplayCacheMaxJsonBytes)
      .toBe(8 * 1_024 * 1_024);
  });
});
