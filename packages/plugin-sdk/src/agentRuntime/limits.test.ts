import { describe, expect, it } from 'vitest';

import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 } from './limits.js';

describe('Agent session runtime limits candidate owner', () => {
  it('uses the shared indexed identifier owner and retained replay candidates', () => {
    expect(AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.hostIndexedIdMaxCodeUnits).toBe(191);
    expect(AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates).toEqual(expect.objectContaining({
      conversationRollbackMaxAffectedTurns: 4_096,
      preWatchReplayBufferMaxEvents: 1_024,
      preWatchReplayBufferMaxJsonBytes: 8 * 1024 * 1024,
    }));
  });
});
