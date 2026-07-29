import { describe, expect, it } from 'vitest';

import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 } from './limits.js';

describe('Agent session runtime limits candidate owner', () => {
  it('uses the shared indexed identifier owner and the ratified CORE-A candidates', () => {
    expect(AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.hostIndexedIdMaxCodeUnits).toBe(191);
    expect(AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.deltaTextMaxCodeUnits).toBe(65_536);
    expect(AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates).toEqual(expect.objectContaining({
      inputTextMaxCodeUnits: 512 * 1024,
      transcriptTextMaxCodeUnits: 512 * 1024,
      conversationRollbackMaxAffectedTurns: 4_096,
      preWatchReplayBufferMaxEvents: 1_024,
      preWatchReplayBufferMaxJsonBytes: 8 * 1024 * 1024,
    }));
  });

  it('does not expose the unpublished stable constant from the public agent-runtime module', async () => {
    const publicModule = await import('./index.js');
    expect(Object.hasOwn(publicModule, 'AGENT_SESSION_RUNTIME_LIMITS_V1')).toBe(false);
    expect(Object.hasOwn(publicModule, 'AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1')).toBe(false);
  });
});
