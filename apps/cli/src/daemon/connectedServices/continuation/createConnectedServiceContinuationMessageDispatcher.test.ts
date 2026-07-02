import { describe, expect, it, vi } from 'vitest';

import { createConnectedServiceContinuationMessageDispatcher } from './createConnectedServiceContinuationMessageDispatcher';

describe('createConnectedServiceContinuationMessageDispatcher', () => {
  it('nudges the pending queue when a continuation prompt is committed through the socket path', async () => {
    const nudgePendingQueue = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async (params: {
      onCommittedViaSocket?: (input: { sessionId: string; localId: string }) => Promise<void> | void;
    }) => {
      await params.onCommittedViaSocket?.({
        sessionId: 'session-1',
        localId: 'connected-service-continuation:test',
      });
      return {
        ok: true as const,
        sessionId: 'session-1',
        localId: 'connected-service-continuation:test',
        waited: false,
      };
    });
    const retryOriginalUserMessage = vi.fn(async () => undefined);

    const dispatcher = createConnectedServiceContinuationMessageDispatcher({
      credentials: { token: 'token', secret: new Uint8Array(32) } as any,
      nudgePendingQueue,
      sendMessage,
      retryOriginalUserMessage,
    });

    await dispatcher.sendContinuationPrompt({
      sessionId: 'session-1',
      prompt: 'continue',
      localId: 'connected-service-continuation:test',
    });

    expect(nudgePendingQueue).toHaveBeenCalledWith({ sessionId: 'session-1' });
  });

  it('nudges the pending queue when original-user-message retry is committed through the socket path', async () => {
    const nudgePendingQueue = vi.fn(async () => undefined);
    const sendMessage = vi.fn();
    const retryOriginalUserMessage = vi.fn(async (params: {
      onCommittedViaSocket?: (input: { sessionId: string; localId: string }) => Promise<void> | void;
    }) => {
      await params.onCommittedViaSocket?.({
        sessionId: 'session-1',
        localId: 'connected-service-original-retry:test',
      });
    });

    const dispatcher = createConnectedServiceContinuationMessageDispatcher({
      credentials: { token: 'token', secret: new Uint8Array(32) } as any,
      nudgePendingQueue,
      sendMessage,
      retryOriginalUserMessage,
    });

    await dispatcher.retryOriginalUserMessage({
      sessionId: 'session-1',
      failureAtMs: 1_000,
      localId: 'connected-service-original-retry:test',
    });

    expect(nudgePendingQueue).toHaveBeenCalledWith({ sessionId: 'session-1' });
  });
});
