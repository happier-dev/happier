import { describe, expect, it, vi } from 'vitest';

const credentials = {
  token: 'token-1',
  encryption: {
    type: 'legacy' as const,
    secret: new Uint8Array([1, 2, 3]),
  },
};

describe('startChannelBridgeFromEnv startup failures', () => {
  it('stops relay if worker creation throws', async () => {
    vi.resetModules();

    const relayStop = vi.fn(async () => undefined);

    vi.doMock('./core/channelBridgeWorker', () => ({
      createInMemoryChannelBindingStore: vi.fn(() => ({
        listBindings: async () => [],
        getBinding: async () => null,
        upsertBinding: async () => ({
          providerId: 'telegram',
          conversationId: 'conv-1',
          threadId: null,
          sessionId: 'sess-1',
          lastForwardedSeq: 0,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        }),
        updateLastForwardedSeq: async () => undefined,
        removeBinding: async () => false,
      })),
      startChannelBridgeWorker: vi.fn(() => {
        throw new Error('worker start failed');
      }),
    }));

    vi.doMock('./telegram/telegramAdapter', () => ({
      createTelegramChannelAdapter: vi.fn(() => ({
        providerId: 'telegram',
        pullInboundMessages: async () => [],
        sendMessage: async () => undefined,
        enqueueWebhookUpdate: vi.fn(),
      })),
    }));

    vi.doMock('./telegram/telegramWebhookRelay', () => ({
      startTelegramWebhookRelay: vi.fn(async () => ({
        port: 8787,
        stop: relayStop,
      })),
    }));

    const { startChannelBridgeFromEnv } = await import('./startChannelBridgeWorker');

    await expect(startChannelBridgeFromEnv({
      credentials,
      env: {
        HAPPIER_TELEGRAM_BOT_TOKEN: 'bot-token',
        HAPPIER_TELEGRAM_WEBHOOK_ENABLED: 'true',
        HAPPIER_TELEGRAM_WEBHOOK_SECRET: 'secret-1',
      } as NodeJS.ProcessEnv,
    })).rejects.toThrow('worker start failed');

    expect(relayStop).toHaveBeenCalledTimes(1);
  });
});
