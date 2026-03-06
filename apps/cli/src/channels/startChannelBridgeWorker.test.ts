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
      limit: 20,
      cursor: undefined,
    });
    expect(fetchSessionsPage).toHaveBeenNthCalledWith(2, {
      token: credentials.token,
      activeOnly: false,
      limit: 20,
      cursor: 'cursor-1',
    });
    expect(sessions.map((row) => row.sessionId)).toEqual(['sess-1', 'sess-2']);

    await handle?.stop();
  });

  it('reuses cached session context between send and transcript fetch calls', async () => {
    vi.resetModules();

    const fetchSessionById = vi.fn(async () => ({
      id: 'sess-ctx-1',
      encryptionMode: 'plain',
      metadata: null,
      dataEncryptionKey: null,
    }));
    const fetchAfterSeq = vi.fn(async () => []);
    const sendCommitted = vi.fn(async () => undefined);

    let capturedDeps: {
      sendUserMessageToSession: (params: {
        sessionId: string;
        text: string;
        sentFrom: string;
        providerId: string;
        conversationId: string;
        threadId: string | null;
      }) => Promise<void>;
      fetchAgentMessagesAfterSeq: (params: { sessionId: string; afterSeq: number }) => Promise<Array<{ seq: number; text: string }>>;
    } | null = null;

    vi.doMock('@/sessionControl/sessionsHttp', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/sessionControl/sessionsHttp')>();
      return {
        ...actual,
        fetchSessionById,
      };
    });

    vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/api/session/fetchEncryptedTranscriptWindow')>();
      return {
        ...actual,
        fetchEncryptedTranscriptPageAfterSeq: fetchAfterSeq,
      };
    });

    vi.doMock('@/sessionControl/sessionSocketSendMessage', () => ({
      sendSessionMessageViaSocketCommitted: sendCommitted,
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

    await capturedDeps!.sendUserMessageToSession({
      sessionId: 'sess-ctx-1',
      text: 'hello from channel',
      sentFrom: 'channel-bridge',
      providerId: 'telegram',
      conversationId: '-100111',
      threadId: null,
    });
    await capturedDeps!.fetchAgentMessagesAfterSeq({
      sessionId: 'sess-ctx-1',
      afterSeq: 0,
    });

    expect(fetchSessionById).toHaveBeenCalledTimes(1);
    expect(sendCommitted).toHaveBeenCalledTimes(1);
    expect(fetchAfterSeq).toHaveBeenCalledTimes(1);

    await handle?.stop();
  });

  it('bypasses decryptTranscriptRows for plain sessions when fetching agent output', async () => {
    vi.resetModules();

    const fetchSessionById = vi.fn(async () => ({
      id: 'sess-plain-1',
      encryptionMode: 'plain',
      metadata: null,
      dataEncryptionKey: null,
    }));
    const fetchAfterSeq = vi.fn(async () => ([
      {
        seq: 11,
        createdAt: 1,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: {
              type: 'text',
              text: 'plain assistant output',
            },
          },
        },
      },
      {
        seq: 12,
        createdAt: 2,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: {
              type: 'text',
              text: 'user message',
            },
          },
        },
      },
    ]));
    const decryptRows = vi.fn(() => ([
      {
        seq: 99,
        createdAtMs: 1,
        role: 'agent',
        content: { type: 'text', text: 'should not be used' },
      },
    ]));

    let capturedDeps: {
      fetchAgentMessagesAfterSeq: (params: { sessionId: string; afterSeq: number }) => Promise<Array<{ seq: number; text: string }>>;
    } | null = null;

    vi.doMock('@/sessionControl/sessionsHttp', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/sessionControl/sessionsHttp')>();
      return {
        ...actual,
        fetchSessionById,
      };
    });

    vi.doMock('@/api/session/fetchEncryptedTranscriptWindow', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/api/session/fetchEncryptedTranscriptWindow')>();
      return {
        ...actual,
        fetchEncryptedTranscriptPageAfterSeq: fetchAfterSeq,
      };
    });

    vi.doMock('@/session/replay/decryptTranscriptRows', () => ({
      decryptTranscriptRows: decryptRows,
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

    const rows = await capturedDeps!.fetchAgentMessagesAfterSeq({
      sessionId: 'sess-plain-1',
      afterSeq: 0,
    });

    expect(rows).toEqual([
      {
        seq: 11,
        text: 'plain assistant output',
      },
    ]);
    expect(decryptRows).not.toHaveBeenCalled();

    await handle?.stop();
  });

  it('refreshes session runtime LRU order on cache hits', async () => {
    vi.resetModules();

    const fetchSessionById = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      id: sessionId,
      encryptionMode: 'plain',
      metadata: null,
      dataEncryptionKey: null,
    }));
    const sendCommitted = vi.fn(async () => undefined);

    let capturedDeps: {
      sendUserMessageToSession: (params: {
        sessionId: string;
        text: string;
        sentFrom: string;
        providerId: string;
        conversationId: string;
        threadId: string | null;
      }) => Promise<void>;
    } | null = null;

    vi.doMock('@/sessionControl/sessionsHttp', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/sessionControl/sessionsHttp')>();
      return {
        ...actual,
        fetchSessionById,
      };
    });

    vi.doMock('@/sessionControl/sessionSocketSendMessage', () => ({
      sendSessionMessageViaSocketCommitted: sendCommitted,
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

    for (let index = 0; index < 200; index += 1) {
      const sessionId = `sess-lru-${index}`;
      await capturedDeps!.sendUserMessageToSession({
        sessionId,
        text: 'prime cache',
        sentFrom: 'channel-bridge',
        providerId: 'telegram',
        conversationId: '-100111',
        threadId: null,
      });
    }

    await capturedDeps!.sendUserMessageToSession({
      sessionId: 'sess-lru-0',
      text: 'refresh oldest',
      sentFrom: 'channel-bridge',
      providerId: 'telegram',
      conversationId: '-100111',
      threadId: null,
    });

    await capturedDeps!.sendUserMessageToSession({
      sessionId: 'sess-lru-200',
      text: 'trigger eviction',
      sentFrom: 'channel-bridge',
      providerId: 'telegram',
      conversationId: '-100111',
      threadId: null,
    });

    await capturedDeps!.sendUserMessageToSession({
      sessionId: 'sess-lru-0',
      text: 'should stay cached',
      sentFrom: 'channel-bridge',
      providerId: 'telegram',
      conversationId: '-100111',
      threadId: null,
    });

    expect(fetchSessionById).toHaveBeenCalledTimes(201);

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
