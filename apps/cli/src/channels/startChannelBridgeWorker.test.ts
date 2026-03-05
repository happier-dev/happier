import { describe, expect, it, vi } from 'vitest';

import { startChannelBridgeFromEnv } from './startChannelBridgeWorker';

const credentials = {
  token: 'token-1',
  encryption: {
    type: 'legacy' as const,
    secret: new Uint8Array([1, 2, 3]),
  },
};

describe('startChannelBridgeFromEnv', () => {
  it('returns null when telegram token is not configured and no custom adapters are provided', async () => {
    const handle = await startChannelBridgeFromEnv({
      credentials,
      env: {},
    });

    expect(handle).toBeNull();
  });

  it('starts with injected adapters/deps even without telegram env configuration', async () => {
    const stopSpy = vi.fn();
    const adapter = {
      providerId: 'fake',
      pullInboundMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined),
      stop: stopSpy,
    };

    const deps = {
      listSessions: vi.fn(async () => []),
      resolveSessionIdOrPrefix: vi.fn(async () => ({ ok: false as const, code: 'session_not_found' as const })),
      sendUserMessageToSession: vi.fn(async () => undefined),
      resolveLatestSessionSeq: vi.fn(async () => 0),
      fetchAgentMessagesAfterSeq: vi.fn(async () => []),
      onWarning: vi.fn(),
    };

    const handle = await startChannelBridgeFromEnv({
      credentials,
      env: { HAPPIER_CHANNEL_BRIDGE_TICK_MS: '500' } as NodeJS.ProcessEnv,
      adapters: [adapter],
      deps,
    });

    expect(handle).not.toBeNull();
    handle?.trigger();
    await handle?.stop();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('paginates listSessions across cursored pages in default bridge deps', async () => {
    vi.resetModules();

    const fetchSessionsPage = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [{ id: 'sess-1', metadata: null }],
        nextCursor: 'cursor-1',
        hasNext: true,
      })
      .mockResolvedValueOnce({
        sessions: [{ id: 'sess-2', metadata: null }],
        nextCursor: null,
        hasNext: false,
      });

    let capturedDeps: {
      listSessions: () => Promise<Array<{ sessionId: string; label: string | null }>>;
    } | null = null;

    vi.doMock('@/sessionControl/sessionsHttp', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/sessionControl/sessionsHttp')>();
      return {
        ...actual,
        fetchSessionsPage,
      };
    });

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
      startChannelBridgeWorker: vi.fn((params: { deps: typeof capturedDeps }) => {
        capturedDeps = params.deps as typeof capturedDeps;
        return {
          trigger: vi.fn(),
          stop: vi.fn(async () => undefined),
        };
      }),
    }));

    vi.doMock('./telegram/telegramAdapter', () => ({
      createTelegramChannelAdapter: vi.fn(() => ({
        providerId: 'telegram',
        pullInboundMessages: async () => [],
        sendMessage: async () => undefined,
        enqueueWebhookUpdate: vi.fn(),
        stop: async () => undefined,
      })),
    }));

    const { startChannelBridgeFromEnv } = await import('./startChannelBridgeWorker');

    const handle = await startChannelBridgeFromEnv({
      credentials,
      env: {
        HAPPIER_TELEGRAM_BOT_TOKEN: 'bot-token',
      } as NodeJS.ProcessEnv,
    });

    expect(handle).not.toBeNull();
    expect(capturedDeps).not.toBeNull();

    const sessions = await capturedDeps!.listSessions();
    expect(fetchSessionsPage).toHaveBeenCalledTimes(2);
    expect(fetchSessionsPage).toHaveBeenNthCalledWith(1, {
      token: credentials.token,
      activeOnly: false,
      limit: 100,
      cursor: undefined,
    });
    expect(fetchSessionsPage).toHaveBeenNthCalledWith(2, {
      token: credentials.token,
      activeOnly: false,
      limit: 100,
      cursor: 'cursor-1',
    });
    expect(sessions.map((row) => row.sessionId)).toEqual(['sess-1', 'sess-2']);

    await handle?.stop();
  });

  it('warns when webhook mode is enabled without webhook secret', async () => {
    vi.resetModules();

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
        updateLastForwardedSeq: async () => undefined,
        removeBinding: async () => false,
      })),
      startChannelBridgeWorker: vi.fn(() => ({
        trigger: vi.fn(),
        stop: vi.fn(async () => undefined),
      })),
    }));

    vi.doMock('./telegram/telegramAdapter', () => ({
      createTelegramChannelAdapter: vi.fn(() => ({
        providerId: 'telegram',
        pullInboundMessages: async () => [],
        sendMessage: async () => undefined,
        enqueueWebhookUpdate: vi.fn(),
        stop: async () => undefined,
      })),
    }));

    const { startChannelBridgeFromEnv } = await import('./startChannelBridgeWorker');

    const handle = await startChannelBridgeFromEnv({
      credentials,
      env: {
        HAPPIER_TELEGRAM_BOT_TOKEN: 'bot-token',
        HAPPIER_TELEGRAM_WEBHOOK_ENABLED: 'true',
      } as NodeJS.ProcessEnv,
    });

    expect(handle).not.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      '[channelBridge] Telegram webhook.enabled=true but webhook.secret is missing; falling back to polling mode',
    );

    await handle?.stop();
  });
});
