import { describe, expect, it, vi } from 'vitest';

import { createElevenLabsSessionLifecycle } from './sessionLifecycle.js';

describe('createElevenLabsSessionLifecycle', () => {
  it('completes an active hosted lease exactly once and never completes BYO', async () => {
    const complete = vi.fn(async () => undefined);
    const abort = vi.fn(async () => undefined);
    const lifecycle = createElevenLabsSessionLifecycle({
      takeHostedConversation: vi.fn(() => ({ complete, abort })),
    });
    lifecycle.started({
      controlSessionId: 'control-hosted',
      conversationId: 'conversation-hosted',
      attemptId: 1,
      prepared: {
        sessionConfig: {},
        sessionState: { billingMode: 'happier', leaseId: 'lease-1', expiresAtMs: null },
      },
    });
    await lifecycle.ended();
    await lifecycle.ended();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({
      providerConversationId: 'conversation-hosted',
    });

    lifecycle.started({
      controlSessionId: 'control-byo',
      conversationId: 'conversation-byo',
      attemptId: 2,
      prepared: {
        sessionConfig: {},
        sessionState: { billingMode: 'byo', leaseId: null, expiresAtMs: null },
      },
    });
    await lifecycle.ended();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('aborts a prepared hosted attempt that never acquires provider identity', async () => {
    const abort = vi.fn(async () => undefined);
    const lifecycle = createElevenLabsSessionLifecycle({
      takeHostedConversation: vi.fn(() => ({ complete: vi.fn(), abort })),
    });
    lifecycle.prepared(1, {
      sessionConfig: {},
      sessionState: { billingMode: 'happier', leaseId: 'lease-abort', expiresAtMs: null },
    });
    await lifecycle.ended();
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
