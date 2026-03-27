import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInMemoryChannelBindingStore, startChannelBridgeWorker } from './channelBridgeWorker';

describe('startChannelBridgeWorker (class-based adapters)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not drop prototype methods when wrapping adapters for single-flight pull', async () => {
    class PrototypeAdapter {
      providerId = 'proto';
      sent: Array<Readonly<{ conversationId: string; threadId: string | null; text: string }>> = [];

      async pullInboundMessages() {
        return [];
      }

      async sendMessage(params: Readonly<{ conversationId: string; threadId: string | null; text: string }>) {
        this.sent.push(params);
      }
    }

    const adapter = new PrototypeAdapter();
    const store = createInMemoryChannelBindingStore();
    await store.upsertBinding({
      providerId: 'proto',
      conversationId: 'conv-1',
      threadId: null,
      sessionId: 'sess-1',
      lastForwardedSeq: 0,
      ownerSenderId: 'owner-1',
      inboundMode: 'ownerOnly',
      allowMissingSenderId: false,
    });

    const onWarning = vi.fn();

    const worker = startChannelBridgeWorker({
      store,
      adapters: [adapter],
      deps: {
        listSessions: async () => [],
        resolveSessionIdOrPrefix: async () => ({ ok: false, code: 'unsupported' }),
        resolveLatestSessionSeq: async () => 0,
        fetchAgentMessagesAfterSeq: async ({ afterSeq }) => {
          if (afterSeq >= 1) return { messages: [], highestSeenSeq: afterSeq };
          return {
            messages: [{ seq: 1, text: 'hello from agent' }],
            highestSeenSeq: 1,
          };
        },
        sendUserMessageToSession: async () => {},
        onWarning,
      },
      tickMs: 250,
    });

    await worker.stop();

    expect(onWarning).not.toHaveBeenCalled();
    expect(adapter.sent).toEqual([
      { conversationId: 'conv-1', threadId: null, text: 'hello from agent' },
    ]);
  });
});

