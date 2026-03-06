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
        updateLastForwardedSeq: async () => true,
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

  it('does not fail shutdown when relay stop throws after worker stop succeeds', async () => {
    vi.resetModules();

    const relayStop = vi.fn(async () => {
      throw new Error('relay stop failed');
    });
    const workerStop = vi.fn(async () => undefined);
    const warnSpy = vi.fn();

    vi.doMock('@/ui/logger', () => ({
      logger: {
        warn: warnSpy,
        info: vi.fn(),
        debug: vi.fn(),
      },
    }));

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
        updateLastForwardedSeq: async () => true,
        removeBinding: async () => false,
      })),
      startChannelBridgeWorker: vi.fn(() => ({
        trigger: vi.fn(),
        stop: workerStop,
      })),
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
        path: '/telegram/webhook/secret-1',
        stop: relayStop,
      })),
    }));

    const { startChannelBridgeFromEnv } = await import('./startChannelBridgeWorker');

    const handle = await startChannelBridgeFromEnv({
      credentials,
      env: {
        HAPPIER_TELEGRAM_BOT_TOKEN: 'bot-token',
        HAPPIER_TELEGRAM_WEBHOOK_ENABLED: 'true',
        HAPPIER_TELEGRAM_WEBHOOK_SECRET: 'secret-1',
      } as NodeJS.ProcessEnv,
    });

    expect(handle).not.toBeNull();
    await expect(handle!.stop()).resolves.toBeUndefined();
    expect(workerStop).toHaveBeenCalledTimes(1);
    expect(relayStop).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[channelBridge] Error stopping webhook relay during shutdown',
      expect.any(Error),
    );
  });
});
