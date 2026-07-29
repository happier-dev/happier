import { describe, expect, it } from 'vitest';

import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 } from '@happier-dev/protocol/runtime';

import { createAgentSessionPreAdmissionBuffer } from './preAdmissionBuffer.js';

const LIMITS = AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates;

describe('createAgentSessionPreAdmissionBuffer', () => {
  it('admits the exact item candidate and rejects +1 without evicting accepted entries', () => {
    const buffer = createAgentSessionPreAdmissionBuffer<number>();
    for (let index = 0; index < LIMITS.preWatchReplayBufferMaxEvents; index += 1) {
      expect(buffer.admit(index)).toEqual({ status: 'accepted' });
    }
    expect(buffer.admit(LIMITS.preWatchReplayBufferMaxEvents)).toEqual({
      status: 'overflow',
      reason: 'count',
    });
    expect(buffer.drain()).toEqual(
      Array.from({ length: LIMITS.preWatchReplayBufferMaxEvents }, (_, index) => index),
    );
  });

  it('admits the exact aggregate JSON byte candidate and rejects +1', () => {
    const exactBuffer = createAgentSessionPreAdmissionBuffer<string>();
    const exact = 'x'.repeat(LIMITS.preWatchReplayBufferMaxJsonBytes - 2);
    expect(exactBuffer.admit(exact)).toEqual({ status: 'accepted' });
    expect(exactBuffer.drain()).toEqual([exact]);

    const plusOneBuffer = createAgentSessionPreAdmissionBuffer<string>();
    const plusOne = 'x'.repeat(LIMITS.preWatchReplayBufferMaxJsonBytes - 1);
    expect(plusOneBuffer.admit(plusOne)).toEqual({ status: 'overflow', reason: 'bytes' });
    expect(plusOneBuffer.drain()).toEqual([]);
  });

  it('fails closed for non-JSON input and reports deterministic disposal loss', () => {
    const buffer = createAgentSessionPreAdmissionBuffer<unknown>();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(buffer.admit(cyclic)).toEqual({ status: 'invalid' });
    expect(buffer.admit({ ok: true })).toEqual({ status: 'accepted' });
    expect(buffer.dispose()).toEqual({ discardedItems: 1, discardedJsonBytes: 11 });
    expect(buffer.admit({ late: true })).toEqual({ status: 'disposed' });
    expect(buffer.drain()).toEqual([]);
  });
});
