import { describe, expect, it } from 'vitest';

import { createClaudeUnifiedPromptInput } from './turnInput.js';

describe('createClaudeUnifiedPromptInput', () => {
  it('scales terminal-host write timeout for large prompt payloads', () => {
    const input = createClaudeUnifiedPromptInput({
      text: 'x'.repeat(128_000),
      sessionId: 'session-1',
      nonce: 1,
      isSteer: false,
    });

    expect(input.scheduling.timeoutMs).toBe(125_000);
  });

  it('guards queued prompts with a terminal quiet period but lets steers bypass it', () => {
    const queued = createClaudeUnifiedPromptInput({
      text: 'queued prompt',
      sessionId: 'session-1',
      nonce: 1,
      isSteer: false,
    });
    const steer = createClaudeUnifiedPromptInput({
      text: 'steer prompt',
      sessionId: 'session-1',
      nonce: 2,
      isSteer: true,
    });

    expect(queued.scheduling).toMatchObject({
      deferredUntilQuietMs: 800,
      deferReason: 'user_typing',
    });
    expect(steer.scheduling.deferredUntilQuietMs).toBeUndefined();
    expect(steer.scheduling.deferReason).toBeUndefined();
  });

  it('preserves only nonnegative integer userMessageSeq metadata', () => {
    expect(createClaudeUnifiedPromptInput({
      text: 'valid',
      sessionId: 'session-1',
      nonce: 1,
      isSteer: false,
      localId: 'local-12',
      localIds: ['local-12', 'local-13', 'local-12'],
      userMessageSeq: 12,
      userMessageSeqs: [12, 13, 12],
    }).origin).toMatchObject({
      localIds: ['local-12', 'local-13'],
      userMessageSeq: 12,
      userMessageSeqs: [12, 13],
    });

    expect(createClaudeUnifiedPromptInput({
      text: 'fractional',
      sessionId: 'session-1',
      nonce: 2,
      isSteer: false,
      userMessageSeq: 12.5,
    }).origin).not.toHaveProperty('userMessageSeq');

    expect(createClaudeUnifiedPromptInput({
      text: 'negative',
      sessionId: 'session-1',
      nonce: 3,
      isSteer: true,
      userMessageSeq: -1,
    }).origin).not.toHaveProperty('userMessageSeq');
  });
});
