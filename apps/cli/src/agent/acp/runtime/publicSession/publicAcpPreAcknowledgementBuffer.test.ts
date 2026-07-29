import { describe, expect, it } from 'vitest';

import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 } from '@happier-dev/protocol/runtime';

import type { AgentMessage } from '@/agent/core/AgentMessage';

import { createPublicAcpPreAcknowledgementBuffer } from './publicAcpPreAcknowledgementBuffer';

const LIMITS = AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates;

describe('createPublicAcpPreAcknowledgementBuffer', () => {
  it('applies the shared exact/+1 count contract to real ACP AgentMessage values', () => {
    const buffer = createPublicAcpPreAcknowledgementBuffer();
    const message: AgentMessage = { type: 'model-output', textDelta: 'x' };

    for (let index = 0; index < LIMITS.preWatchReplayBufferMaxEvents; index += 1) {
      expect(buffer.admit(message)).toEqual({ status: 'accepted' });
    }
    expect(buffer.admit(message)).toEqual({ status: 'overflow', reason: 'count' });
    expect(buffer.drain()).toHaveLength(LIMITS.preWatchReplayBufferMaxEvents);
  });
});
