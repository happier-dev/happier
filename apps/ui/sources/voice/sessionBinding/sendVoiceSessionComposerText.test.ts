import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol';
import { RpcError } from '@happier-dev/protocol/rpcErrors';

import { storage } from '@/sync/domains/state/storage';
import { appendVoiceConversationUserText } from './voiceConversationTranscript';
import { createVoiceSessionBindingStore } from './voiceSessionBindingStore';
import { submitDurableVoiceTextTurn } from './sendVoiceSessionComposerText';

function createAcceptedPendingPort() {
  return {
    enqueuePendingMessage: vi.fn(async ({ localId }: Readonly<{ localId: string }>) => ({
      localId,
      accepted: true,
      externalHandoffClaimed: true,
    } as const)),
    markPendingDeliveryHandled: vi.fn(async () => undefined),
    blockPendingDelivery: vi.fn(async () => undefined),
  };
}

describe('sendVoiceSessionComposerText', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves an opaque caller-owned Pending local id byte-for-byte', async () => {
    const enqueuePendingMessage = vi.fn(async ({ localId }: Readonly<{ localId: string }>) => ({
      localId,
      accepted: true,
      externalHandoffClaimed: true,
    } as const));
    const dispatch = vi.fn(async () => undefined);

    await expect(submitDurableVoiceTextTurn({
      conversationSessionId: 'carrier-s1',
      text: 'hello',
      localId: ' opaque-local-id ',
      pendingPort: {
        enqueuePendingMessage,
        markPendingDeliveryHandled: vi.fn(async () => undefined),
        blockPendingDelivery: vi.fn(async () => undefined),
      },
      dispatch,
    })).resolves.toMatchObject({ ok: true, localId: ' opaque-local-id ' });

    expect(enqueuePendingMessage).toHaveBeenCalledWith(expect.objectContaining({
      localId: ' opaque-local-id ',
    }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      localId: ' opaque-local-id ',
    }));
  });

  it('durably enqueues before adapter handoff and reuses one local id', async () => {
    const store = createVoiceSessionBindingStore();
    store.getState().bind({
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      transcriptMode: 'synthetic',
      targetSessionId: 's1',
      updatedAt: 123,
    });

    const events: string[] = [];
    const enqueuePendingMessage = vi.fn(async (params: Readonly<{ localId: string }>) => {
      events.push(`enqueue:${params.localId}`);
      return { localId: params.localId, accepted: true, externalHandoffClaimed: true } as const;
    });
    const sendTextTurn = vi.fn(async (params: Readonly<{ localId: string }>) => {
      events.push(`dispatch:${params.localId}`);
    });
    const { sendVoiceSessionComposerText } = await import('./sendVoiceSessionComposerText');
    const params = {
      conversationSessionId: 'carrier-s1',
      text: 'hello',
      localId: 'voice-local-1',
      store,
      pendingPort: {
        enqueuePendingMessage,
        markPendingDeliveryHandled: vi.fn(async () => undefined),
        blockPendingDelivery: vi.fn(async () => undefined),
      },
      getAdapter: () => ({
        id: 'realtime_elevenlabs',
        start: vi.fn(),
        stop: vi.fn(),
        toggle: vi.fn(),
        interrupt: vi.fn(),
        sendContextUpdate: vi.fn(),
        getSnapshot: vi.fn(),
        sendTextTurn,
      }),
    };

    const result = await sendVoiceSessionComposerText(params);

    expect(result).toEqual({ ok: true, localId: 'voice-local-1', disposition: 'handoff_acknowledged' });
    expect(enqueuePendingMessage).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'hello',
      localId: 'voice-local-1',
    });
    expect(sendTextTurn).toHaveBeenCalledWith({
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      text: 'hello',
      localId: 'voice-local-1',
      handoffMode: 'interrupt_and_send',
    });
    expect(events).toEqual([
      'enqueue:voice-local-1',
      'dispatch:voice-local-1',
    ]);
  });

  it('reconciles a whitespace-distinct opaque enqueue identity through the stored transcript projection unchanged', async () => {
    const store = createVoiceSessionBindingStore();
    store.getState().bind({
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      transcriptMode: 'synthetic',
      targetSessionId: 's1',
      updatedAt: 123,
    });
    const enqueuePendingMessage = vi.fn(async ({ localId }: Readonly<{ localId: string }>) => ({
      localId,
      accepted: true,
      externalHandoffClaimed: true,
    } as const));
    const applyMessages = vi.spyOn(storage.getState(), 'applyMessages');
    const { sendVoiceSessionComposerText } = await import('./sendVoiceSessionComposerText');

    await expect(sendVoiceSessionComposerText({
      conversationSessionId: 'carrier-s1',
      text: 'hello',
      localId: ' request-1 ',
      store,
      pendingPort: {
        enqueuePendingMessage,
        markPendingDeliveryHandled: vi.fn(async () => undefined),
        blockPendingDelivery: vi.fn(async () => undefined),
      },
      getAdapter: () => ({
        id: 'realtime_elevenlabs',
        start: vi.fn(),
        stop: vi.fn(),
        toggle: vi.fn(),
        interrupt: vi.fn(),
        sendContextUpdate: vi.fn(),
        getSnapshot: vi.fn(),
        sendTextTurn: async (params) => {
          appendVoiceConversationUserText({
            conversationSessionId: params.conversationSessionId,
            text: params.text,
            localId: params.localId,
          });
        },
      }),
    })).resolves.toEqual({
      ok: true,
      localId: ' request-1 ',
      disposition: 'handoff_acknowledged',
    });

    expect(enqueuePendingMessage).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'hello',
      localId: ' request-1 ',
    });
    expect(applyMessages).toHaveBeenCalledWith(
      'carrier-s1',
      [expect.objectContaining({ localId: ' request-1 ' })],
    );
  });

  it('routes synthetic voice conversation sessions through adapter text turns', async () => {
    const store = createVoiceSessionBindingStore();
    store.getState().bind({
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      transcriptMode: 'synthetic',
      targetSessionId: 's1',
      updatedAt: 123,
    });

    const sendTextTurn = vi.fn(async () => {});
    const { sendVoiceSessionComposerText } = await import('./sendVoiceSessionComposerText');

    const result = await sendVoiceSessionComposerText({
      conversationSessionId: 'carrier-s1',
      text: 'hello',
      store,
      pendingPort: createAcceptedPendingPort(),
      getAdapter: () => ({
        id: 'realtime_elevenlabs',
        start: vi.fn(),
        stop: vi.fn(),
        toggle: vi.fn(),
        interrupt: vi.fn(),
        sendContextUpdate: vi.fn(),
        getSnapshot: vi.fn(),
        sendTextTurn,
      }) as any,
    });

    expect(result).toMatchObject({ ok: true, disposition: 'handoff_acknowledged' });
    expect(sendTextTurn).toHaveBeenCalledWith({
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      text: 'hello',
      localId: expect.any(String),
      handoffMode: 'interrupt_and_send',
    });
  });

  it('routes native hidden voice sessions through adapter text turns too', async () => {
    const store = createVoiceSessionBindingStore();
    store.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      transcriptMode: 'native_session',
      targetSessionId: null,
      updatedAt: 123,
    });

    const sendTextTurn = vi.fn(async () => {});
    const { sendVoiceSessionComposerText } = await import('./sendVoiceSessionComposerText');
    const result = await sendVoiceSessionComposerText({
      conversationSessionId: 'carrier-s1',
      text: 'hello',
      store,
      pendingPort: createAcceptedPendingPort(),
      getAdapter: () => ({
        id: 'local_conversation',
        start: vi.fn(),
        stop: vi.fn(),
        toggle: vi.fn(),
        interrupt: vi.fn(),
        sendContextUpdate: vi.fn(),
        getSnapshot: vi.fn(),
        sendTextTurn,
      }) as any,
    });

    expect(result).toMatchObject({ ok: true, disposition: 'handoff_acknowledged' });
    expect(sendTextTurn).toHaveBeenCalledWith({
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      text: 'hello',
      localId: expect.any(String),
      handoffMode: 'interrupt_and_send',
    });
  });

  it('keeps an unconfirmed durable row pending without adapter dispatch', async () => {
    const store = createVoiceSessionBindingStore();
    store.getState().bind({
      adapterId: 'realtime_elevenlabs',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      transcriptMode: 'synthetic',
      targetSessionId: 's1',
      updatedAt: 123,
    });
    const sendTextTurn = vi.fn(async () => {});
    const { sendVoiceSessionComposerText } = await import('./sendVoiceSessionComposerText');
    const params = {
      conversationSessionId: 'carrier-s1',
      text: 'hello',
      localId: 'voice-local-1',
      store,
      pendingPort: {
        enqueuePendingMessage: vi.fn(async () => ({ localId: 'voice-local-1', accepted: false } as const)),
        markPendingDeliveryHandled: vi.fn(async () => undefined),
        blockPendingDelivery: vi.fn(async () => undefined),
      },
      getAdapter: () => ({
        id: 'realtime_elevenlabs',
        start: vi.fn(),
        stop: vi.fn(),
        toggle: vi.fn(),
        interrupt: vi.fn(),
        sendContextUpdate: vi.fn(),
        getSnapshot: vi.fn(),
        sendTextTurn,
      }),
    };

    await expect(sendVoiceSessionComposerText(params)).resolves.toEqual({
      ok: true,
      localId: 'voice-local-1',
      disposition: 'pending',
    });
    expect(sendTextTurn).not.toHaveBeenCalled();
  });

  it('fails visibly without dispatch when durable enqueue quarantines the user turn', async () => {
    const dispatch = vi.fn(async () => {});

    await expect(submitDurableVoiceTextTurn({
      conversationSessionId: 'carrier-s1',
      text: 'keep this text',
      localId: 'voice-local-1',
      pendingPort: {
        enqueuePendingMessage: vi.fn(async () => ({
          localId: 'voice-local-1',
          accepted: false,
          terminal: true,
        } as const)),
        markPendingDeliveryHandled: vi.fn(async () => undefined),
        blockPendingDelivery: vi.fn(async () => undefined),
      },
      dispatch,
    })).resolves.toEqual({
      ok: false,
      reason: 'terminal_rejected',
      localId: 'voice-local-1',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps a wire-mode wait as accepted durable pending without dispatch', async () => {
    const dispatch = vi.fn(async () => {});

    await expect(submitDurableVoiceTextTurn({
      conversationSessionId: 'carrier-s1',
      text: 'wait for the server contract',
      localId: 'voice-local-1',
      pendingPort: {
        enqueuePendingMessage: vi.fn(async () => ({
          localId: 'voice-local-1',
          accepted: false,
          waitingForWireMode: true,
        } as const)),
        markPendingDeliveryHandled: vi.fn(async () => undefined),
        blockPendingDelivery: vi.fn(async () => undefined),
      },
      dispatch,
    })).resolves.toEqual({
      ok: true,
      localId: 'voice-local-1',
      disposition: 'pending',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('normalizes an already-settled duplicate as a successful no-op', async () => {
    const dispatch = vi.fn(async () => {});

    await expect(submitDurableVoiceTextTurn({
      conversationSessionId: 'carrier-s1',
      text: 'already delivered',
      localId: 'voice-local-1',
      pendingPort: {
        enqueuePendingMessage: vi.fn(async () => ({
          localId: 'voice-local-1',
          accepted: true,
          settled: true,
        } as const)),
        markPendingDeliveryHandled: vi.fn(async () => undefined),
        blockPendingDelivery: vi.fn(async () => undefined),
      },
      dispatch,
    })).resolves.toEqual({
      ok: true,
      localId: 'voice-local-1',
      disposition: 'settled',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('returns typed cancellation and never dispatches the cancelled id', async () => {
    const store = createVoiceSessionBindingStore();
    store.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      transcriptMode: 'native_session',
      targetSessionId: null,
      updatedAt: 123,
    });
    const sendTextTurn = vi.fn(async () => {});
    const { sendVoiceSessionComposerText } = await import('./sendVoiceSessionComposerText');
    const params = {
      conversationSessionId: 'carrier-s1',
      text: 'hello',
      localId: 'voice-local-1',
      store,
      pendingPort: {
        enqueuePendingMessage: vi.fn(async () => ({ localId: 'voice-local-1', accepted: true, cancelled: true } as const)),
        markPendingDeliveryHandled: vi.fn(async () => undefined),
        blockPendingDelivery: vi.fn(async () => undefined),
      },
      getAdapter: () => ({
        id: 'local_conversation',
        start: vi.fn(),
        stop: vi.fn(),
        toggle: vi.fn(),
        interrupt: vi.fn(),
        sendContextUpdate: vi.fn(),
        getSnapshot: vi.fn(),
        sendTextTurn,
      }),
    };

    await expect(sendVoiceSessionComposerText(params)).resolves.toEqual({
      ok: false,
      reason: 'cancelled',
      localId: 'voice-local-1',
    });
    expect(sendTextTurn).not.toHaveBeenCalled();
  });

  it('blocks a typed missing V2 RPC before provider acceptance and rejects the submit', async () => {
    const blockPendingDelivery = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => {
      throw new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
    });

    await expect(submitDurableVoiceTextTurn({
      conversationSessionId: 'carrier-s1',
      text: 'keep this text',
      localId: 'voice-local-1',
      pendingPort: {
        enqueuePendingMessage: vi.fn(async () => ({
          localId: 'voice-local-1',
          accepted: true,
          externalHandoffClaimed: true,
        } as const)),
        markPendingDeliveryHandled: vi.fn(async () => undefined),
        blockPendingDelivery,
      },
      dispatch,
    })).resolves.toEqual({
      ok: false,
      reason: 'send_failed',
      localId: 'voice-local-1',
      message: 'RPC method not available',
    });
    expect(blockPendingDelivery).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      localId: 'voice-local-1',
      reason: 'provider_unavailable_before_acceptance',
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not turn a definite pre-provider rejection into success when row blocking fails', async () => {
    const dispatch = vi.fn(async () => {
      throw new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
    });

    await expect(submitDurableVoiceTextTurn({
      conversationSessionId: 'carrier-s1',
      text: 'keep this text',
      localId: 'voice-local-1',
      pendingPort: {
        enqueuePendingMessage: vi.fn(async () => ({
          localId: 'voice-local-1',
          accepted: true,
          externalHandoffClaimed: true,
        } as const)),
        markPendingDeliveryHandled: vi.fn(async () => undefined),
        blockPendingDelivery: vi.fn(async () => {
          throw new Error('pending_delivery_block_failed');
        }),
      },
      dispatch,
    })).resolves.toEqual({
      ok: false,
      reason: 'send_failed',
      localId: 'voice-local-1',
      message: 'pending_delivery_block_failed',
    });
  });

  it('blocks an unknown-effect adapter failure as uncertain while retaining ambiguous semantics', async () => {
    const store = createVoiceSessionBindingStore();
    store.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: 'voice-global',
      conversationSessionId: 'carrier-s1',
      transcriptMode: 'native_session',
      targetSessionId: 's1',
      updatedAt: 123,
    });

    const sendTextTurn = vi.fn(async () => {
      throw new Error('send_failed');
    });
    const { sendVoiceSessionComposerText } = await import('./sendVoiceSessionComposerText');

    const enqueuePendingMessage = vi.fn(async () => ({ localId: 'voice-local-1', accepted: true, externalHandoffClaimed: true } as const));
    const blockPendingDelivery = vi.fn(async () => undefined);
    const params = {
      conversationSessionId: 'carrier-s1',
      text: 'hello',
      localId: 'voice-local-1',
      store,
      pendingPort: { enqueuePendingMessage, blockPendingDelivery, markPendingDeliveryHandled: vi.fn(async () => undefined) },
      getAdapter: () => ({
        id: 'local_conversation',
        start: vi.fn(),
        stop: vi.fn(),
        toggle: vi.fn(),
        interrupt: vi.fn(),
        sendContextUpdate: vi.fn(),
        getSnapshot: vi.fn(),
        sendTextTurn,
      }),
    };
    const result = await sendVoiceSessionComposerText(params);

    expect(result).toEqual({
      ok: true,
      localId: 'voice-local-1',
      disposition: 'ambiguous',
      message: 'send_failed',
    });
    expect(blockPendingDelivery).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      localId: 'voice-local-1',
      reason: 'delivery_outcome_uncertain',
    });
    expect(sendTextTurn).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the durable row was not atomically fenced for external handoff', async () => {
    const dispatch = vi.fn(async () => {});
    const { submitDurableVoiceTextTurn } = await import('./sendVoiceSessionComposerText');

    await expect(submitDurableVoiceTextTurn({
      conversationSessionId: 'carrier-s1',
      text: 'hello',
      localId: 'voice-local-1',
      pendingPort: {
        enqueuePendingMessage: vi.fn(async () => ({ localId: 'voice-local-1', accepted: true } as const)),
        markPendingDeliveryHandled: vi.fn(async () => undefined),
        blockPendingDelivery: vi.fn(async () => undefined),
      },
      dispatch,
    })).resolves.toEqual({
      ok: false,
      reason: 'send_failed',
      localId: 'voice-local-1',
      message: 'voice_pending_external_handoff_not_claimed',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
