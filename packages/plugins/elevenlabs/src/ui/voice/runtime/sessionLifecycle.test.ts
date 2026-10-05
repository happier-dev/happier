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

  it('reports unsettled usage and retries the same retained identity before releasing custody', async () => {
    const complete = vi.fn().mockRejectedValueOnce(new Error('processing')).mockResolvedValue(undefined);
    const abort = vi.fn();
    const takeHostedConversation = vi.fn(() => ({ complete, abort }));
    const lifecycle = createElevenLabsSessionLifecycle({ takeHostedConversation });
    const prepared = {
      sessionConfig: {},
      sessionState: { billingMode: 'happier' as const, leaseId: 'lease-1', expiresAtMs: null },
    };
    lifecycle.prepared(1, prepared);
    lifecycle.started({ controlSessionId: 'control', conversationId: 'conversation-1', attemptId: 1, prepared });
    await expect(lifecycle.ended()).rejects.toThrow('processing');
    await lifecycle.ended();
    await lifecycle.ended();
    expect(complete.mock.calls).toEqual([
      [{ providerConversationId: 'conversation-1' }], [{ providerConversationId: 'conversation-1' }],
    ]);
    expect(takeHostedConversation).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
  });

  it.each(['releasePrepared', 'ended'] as const)('retains failed pre-identity abort custody through %s', async (operation) => {
    const abort = vi.fn().mockRejectedValueOnce(new Error('release unavailable')).mockResolvedValue(undefined);
    const lifecycle = createElevenLabsSessionLifecycle({
      takeHostedConversation: () => ({ complete: vi.fn(), abort }),
    });
    const prepared = {
      sessionConfig: {},
      sessionState: { billingMode: 'happier' as const, leaseId: 'lease-abort', expiresAtMs: null },
    };
    lifecycle.prepared(1, prepared);
    await expect(operation === 'ended' ? lifecycle.ended() : lifecycle.releasePrepared(1, prepared))
      .rejects.toThrow('release unavailable');
    await lifecycle.ended();
    await lifecycle.ended();
    expect(abort).toHaveBeenCalledTimes(2);
  });
});
