import { describe, expect, it } from 'vitest';

import { WEBSOCKET_FIXTURE } from '../__fixtures__/localharness-0.1.4.js';
import { parseLocalharnessOutputEvent } from './protocol.js';

describe('Antigravity localharness protocol parser', () => {
  it('parses step-only output frames', () => {
    expect(parseLocalharnessOutputEvent(WEBSOCKET_FIXTURE.outputConversationStep)).toEqual([
      {
        type: 'conversation_id',
        conversationId: 'conv-1',
      },
      {
        type: 'step_update',
        trajectoryId: 'traj-1',
        textDelta: 'Hello',
      },
      {
        type: 'thinking_delta',
        trajectoryId: 'traj-1',
        textDelta: 'Plan',
      },
    ]);
  });

  it('parses usage-only output frames', () => {
    expect(parseLocalharnessOutputEvent(WEBSOCKET_FIXTURE.outputUsage)).toEqual([
      {
        type: 'usage_metadata',
        totalTokens: 7,
        inputTokens: 3,
        outputTokens: 4,
      },
    ]);
  });

  it('parses step updates and usage metadata from the same output frame', () => {
    expect(parseLocalharnessOutputEvent({
      ...WEBSOCKET_FIXTURE.outputConversationStep,
      ...WEBSOCKET_FIXTURE.outputUsage,
    })).toEqual([
      {
        type: 'conversation_id',
        conversationId: 'conv-1',
      },
      {
        type: 'step_update',
        trajectoryId: 'traj-1',
        textDelta: 'Hello',
      },
      {
        type: 'thinking_delta',
        trajectoryId: 'traj-1',
        textDelta: 'Plan',
      },
      {
        type: 'usage_metadata',
        totalTokens: 7,
        inputTokens: 3,
        outputTokens: 4,
      },
    ]);
  });
});
