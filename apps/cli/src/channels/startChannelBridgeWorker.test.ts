import { afterEach, describe, expect, it, vi } from 'vitest';

import { startChannelBridgeFromEnv } from './startChannelBridgeWorker';
import type { ChannelBridgeDeps } from '@/channels/core/channelBridgeWorker';

type SendCommittedFn = typeof import('@/session/transport/socket/sessionSocketSendMessage').sendSessionMessageViaSocketCommitted;

const credentials = {
  token: 'token-1',
  encryption: {
    type: 'legacy' as const,
    secret: new Uint8Array([1, 2, 3]),
  },
};

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.resetModules();

  for (const modulePath of [
    '@/session/transport/http/sessionsHttp',
    '@/api/session/fetchEncryptedTranscriptWindow',
    '@/session/transport/socket/sessionSocketSendMessage',
    '@/session/replay/decryptTranscriptRows',
    '@/ui/logger',
    '@/channels/core/channelBridgeWorker',
    '@/channels/providers/telegram/telegramAdapter',
    '@/channels/providers/telegram/telegramWebhookRelay',
    '@/channels/state/localBindingStore',
  ]) {
    vi.doUnmock(modulePath);
  }
});

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

  it('fetches only the first sessions page in default bridge deps', async () => {
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

    let capturedDeps: ChannelBridgeDeps | null = null;

    vi.doMock('@/session/transport/http/sessionsHttp', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>();
      return {
        ...actual,
        fetchSessionsPage,
      };
    });

    vi.doMock('@/channels/core/channelBridgeWorker', () => ({
      createInMemoryChannelBindingStore: vi.fn(() => ({
        listBindings: async () => [],
        getBinding: async () => null,
        upsertBinding: async () => ({
          providerId: 'telegram',
          conversationId: 'conv-1',
          threadId: null,
          sessionId: 'sess-1',
          lastForwardedSeq: 0,
          ownerSenderId: 'user-1',
          inboundMode: 'ownerOnly',
          allowMissingSenderId: false,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        }),
        updateLastForwardedSeq: async () => true,
        removeBinding: async () => false,
      })),
      startChannelBridgeWorker: vi.fn((params: { deps: ChannelBridgeDeps }) => {
        capturedDeps = params.deps;
        return {
          trigger: vi.fn(),
          stop: vi.fn(async () => undefined),
        };
      }),
    }));

    vi.doMock('@/channels/providers/telegram/telegramAdapter', () => ({
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
    expect(fetchSessionsPage).toHaveBeenCalledTimes(1);
    expect(fetchSessionsPage).toHaveBeenNthCalledWith(1, {
      token: credentials.token,
      activeOnly: false,
      limit: 20,
      cursor: undefined,
    });
    expect(sessions.map((row) => row.sessionId)).toEqual(['sess-1']);

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
    const sendCommitted = vi.fn<SendCommittedFn>(async (_params) => undefined);

    let capturedDeps: ChannelBridgeDeps | null = null;

    vi.doMock('@/session/transport/http/sessionsHttp', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>();
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

    vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
      sendSessionMessageViaSocketCommitted: sendCommitted,
    }));

    vi.doMock('@/channels/core/channelBridgeWorker', () => ({
      createInMemoryChannelBindingStore: vi.fn(() => ({
        listBindings: async () => [],
        getBinding: async () => null,
        upsertBinding: async () => ({
          providerId: 'telegram',
          conversationId: 'conv-1',
          threadId: null,
          sessionId: 'sess-1',
          lastForwardedSeq: 0,
          ownerSenderId: 'user-1',
          inboundMode: 'ownerOnly',
          allowMissingSenderId: false,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        }),
        updateLastForwardedSeq: async () => true,
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

    vi.doMock('@/channels/providers/telegram/telegramAdapter', () => ({
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
      messageId: 'msg-ctx-1',
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
      fetchAgentMessagesAfterSeq: (params: { sessionId: string; afterSeq: number }) => Promise<unknown>;
    } | null = null;

    vi.doMock('@/session/transport/http/sessionsHttp', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>();
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

    vi.doMock('@/channels/core/channelBridgeWorker', () => ({
      createInMemoryChannelBindingStore: vi.fn(() => ({
        listBindings: async () => [],
        getBinding: async () => null,
        upsertBinding: async () => ({
          providerId: 'telegram',
          conversationId: 'conv-1',
          threadId: null,
          sessionId: 'sess-1',
          lastForwardedSeq: 0,
          ownerSenderId: 'user-1',
          inboundMode: 'ownerOnly',
          allowMissingSenderId: false,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        }),
        updateLastForwardedSeq: async () => true,
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

    vi.doMock('@/channels/providers/telegram/telegramAdapter', () => ({
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

    expect(rows).toEqual({
      messages: [
        {
          seq: 11,
          text: 'plain assistant output',
        },
      ],
      highestSeenSeq: 12,
    });
    expect(decryptRows).not.toHaveBeenCalled();

    await handle?.stop();
  });

  it('uses deterministic localId for retried channel messages and rejects missing message ids', async () => {
    vi.resetModules();

    const fetchSessionById = vi.fn(async () => ({
      id: 'sess-local-id-1',
      encryptionMode: 'plain',
      metadata: null,
      dataEncryptionKey: null,
    }));
    const sendCommitted = vi.fn<SendCommittedFn>(async (_params) => undefined);

    let capturedDeps: {
      sendUserMessageToSession: (params: {
        sessionId: string;
        text: string;
        sentFrom: string;
        providerId: string;
        conversationId: string;
        threadId: string | null;
        messageId?: string;
      }) => Promise<void>;
    } | null = null;

    vi.doMock('@/session/transport/http/sessionsHttp', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>();
      return {
        ...actual,
        fetchSessionById,
      };
    });

    vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
      sendSessionMessageViaSocketCommitted: sendCommitted,
    }));

    vi.doMock('@/channels/core/channelBridgeWorker', () => ({
      createInMemoryChannelBindingStore: vi.fn(() => ({
        listBindings: async () => [],
        getBinding: async () => null,
        upsertBinding: async () => ({
          providerId: 'telegram',
          conversationId: 'conv-1',
          threadId: null,
          sessionId: 'sess-1',
          lastForwardedSeq: 0,
          ownerSenderId: 'user-1',
          inboundMode: 'ownerOnly',
          allowMissingSenderId: false,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        }),
        updateLastForwardedSeq: async () => true,
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

    vi.doMock('@/channels/providers/telegram/telegramAdapter', () => ({
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
      sessionId: 'sess-local-id-1',
      text: 'first attempt',
      sentFrom: 'telegram',
      providerId: 'telegram',
      conversationId: '-100local',
      threadId: '42',
      messageId: 'msg-1',
    });
    await capturedDeps!.sendUserMessageToSession({
      sessionId: 'sess-local-id-1',
      text: 'retry same message',
      sentFrom: 'telegram',
      providerId: 'telegram',
      conversationId: '-100local',
      threadId: '42',
      messageId: 'msg-1',
    });
    await capturedDeps!.sendUserMessageToSession({
      sessionId: 'sess-local-id-1',
      text: 'different message',
      sentFrom: 'telegram',
      providerId: 'telegram',
      conversationId: '-100local',
      threadId: '42',
      messageId: 'msg-2',
    });

    await expect(capturedDeps!.sendUserMessageToSession({
      sessionId: 'sess-local-id-1',
      text: 'missing message id',
      sentFrom: 'telegram',
      providerId: 'telegram',
      conversationId: '-100local',
      threadId: '42',
    })).rejects.toThrow('inbound messageId is required');

    await expect(capturedDeps!.sendUserMessageToSession({
      sessionId: 'sess-local-id-1',
      text: 'blank message id',
      sentFrom: 'telegram',
      providerId: 'telegram',
      conversationId: '-100local',
      threadId: '42',
      messageId: '   ',
    })).rejects.toThrow('inbound messageId is required');

    expect(sendCommitted).toHaveBeenCalledTimes(3);
    const firstLocalId = sendCommitted.mock.calls[0]?.[0]?.localId;
    const secondLocalId = sendCommitted.mock.calls[1]?.[0]?.localId;
    const thirdLocalId = sendCommitted.mock.calls[2]?.[0]?.localId;

    expect(firstLocalId).toBe(secondLocalId);
    expect(thirdLocalId).not.toBe(firstLocalId);

    await handle?.stop();
  });

  it('warns when agent transcript rows cannot be mapped to bridge text output', async () => {
    vi.resetModules();

    const warnSpy = vi.fn();
    const fetchSessionById = vi.fn(async () => ({
      id: 'sess-plain-unextractable',
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
              type: 'output',
              data: {
                message: 123,
              },
            },
          },
        },
      },
    ]));

    let capturedDeps: {
      fetchAgentMessagesAfterSeq: (params: { sessionId: string; afterSeq: number }) => Promise<unknown>;
    } | null = null;

    vi.doMock('@/ui/logger', () => ({
      logger: {
        warn: warnSpy,
        info: vi.fn(),
        debug: vi.fn(),
      },
    }));

    vi.doMock('@/session/transport/http/sessionsHttp', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>();
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

    vi.doMock('@/channels/core/channelBridgeWorker', () => ({
      createInMemoryChannelBindingStore: vi.fn(() => ({
        listBindings: async () => [],
        getBinding: async () => null,
        upsertBinding: async () => ({
          providerId: 'telegram',
          conversationId: 'conv-1',
          threadId: null,
          sessionId: 'sess-1',
          lastForwardedSeq: 0,
          ownerSenderId: 'user-1',
          inboundMode: 'ownerOnly',
          allowMissingSenderId: false,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        }),
        updateLastForwardedSeq: async () => true,
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

    vi.doMock('@/channels/providers/telegram/telegramAdapter', () => ({
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
      sessionId: 'sess-plain-unextractable',
      afterSeq: 0,
    });

    expect(rows).toEqual({
      messages: [],
      highestSeenSeq: 11,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[channelBridge] Skipped agent transcript row with unsupported content'),
    );

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
    const sendCommitted = vi.fn<SendCommittedFn>(async (_params) => undefined);

    let capturedDeps: ChannelBridgeDeps | null = null;

    vi.doMock('@/session/transport/http/sessionsHttp', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>();
      return {
        ...actual,
        fetchSessionById,
      };
    });

    vi.doMock('@/session/transport/socket/sessionSocketSendMessage', () => ({
      sendSessionMessageViaSocketCommitted: sendCommitted,
    }));

    vi.doMock('@/channels/core/channelBridgeWorker', () => ({
      createInMemoryChannelBindingStore: vi.fn(() => ({
        listBindings: async () => [],
        getBinding: async () => null,
        upsertBinding: async () => ({
          providerId: 'telegram',
          conversationId: 'conv-1',
          threadId: null,
          sessionId: 'sess-1',
          lastForwardedSeq: 0,
          ownerSenderId: 'user-1',
          inboundMode: 'ownerOnly',
          allowMissingSenderId: false,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        }),
        updateLastForwardedSeq: async () => true,
        removeBinding: async () => false,
      })),
      startChannelBridgeWorker: vi.fn((params: { deps: ChannelBridgeDeps }) => {
        capturedDeps = params.deps;
        return {
          trigger: vi.fn(),
          stop: vi.fn(async () => undefined),
        };
      }),
    }));

    vi.doMock('@/channels/providers/telegram/telegramAdapter', () => ({
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
        messageId: `msg-${sessionId}`,
      });
    }

    await capturedDeps!.sendUserMessageToSession({
      sessionId: 'sess-lru-0',
      text: 'refresh oldest',
      sentFrom: 'channel-bridge',
      providerId: 'telegram',
      conversationId: '-100111',
      threadId: null,
      messageId: 'msg-sess-lru-0-refresh',
    });

    await capturedDeps!.sendUserMessageToSession({
      sessionId: 'sess-lru-200',
      text: 'trigger eviction',
      sentFrom: 'channel-bridge',
      providerId: 'telegram',
      conversationId: '-100111',
      threadId: null,
      messageId: 'msg-sess-lru-200-evict',
    });

    await capturedDeps!.sendUserMessageToSession({
      sessionId: 'sess-lru-0',
      text: 'should stay cached',
      sentFrom: 'channel-bridge',
      providerId: 'telegram',
      conversationId: '-100111',
      threadId: null,
      messageId: 'msg-sess-lru-0-stay',
    });

    expect(fetchSessionById).toHaveBeenCalledTimes(201);

    await handle?.stop();
  });

  it('warns when webhook mode is enabled without webhook secret', async () => {
    vi.resetModules();

    const warnSpy = vi.fn();
    const startRelay = vi.fn();
    const createTelegramChannelAdapter = vi.fn(() => ({
      providerId: 'telegram',
      pullInboundMessages: async () => [],
      sendMessage: async () => undefined,
      enqueueWebhookUpdate: vi.fn(),
      stop: async () => undefined,
    }));

    vi.doMock('@/ui/logger', () => ({
      logger: {
        warn: warnSpy,
        info: vi.fn(),
        debug: vi.fn(),
      },
    }));

    vi.doMock('@/channels/core/channelBridgeWorker', () => ({
      createInMemoryChannelBindingStore: vi.fn(() => ({
        listBindings: async () => [],
        getBinding: async () => null,
        upsertBinding: async () => ({
          providerId: 'telegram',
          conversationId: 'conv-1',
          threadId: null,
          sessionId: 'sess-1',
          lastForwardedSeq: 0,
          ownerSenderId: 'user-1',
          inboundMode: 'ownerOnly',
          allowMissingSenderId: false,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        }),
        updateLastForwardedSeq: async () => true,
        removeBinding: async () => false,
      })),
      startChannelBridgeWorker: vi.fn(() => ({
        trigger: vi.fn(),
        stop: vi.fn(async () => undefined),
      })),
    }));

    vi.doMock('@/channels/providers/telegram/telegramAdapter', () => ({
      createTelegramChannelAdapter,
    }));

    vi.doMock('@/channels/providers/telegram/telegramWebhookRelay', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/channels/providers/telegram/telegramWebhookRelay')>();
      return {
        ...actual,
        startTelegramWebhookRelay: startRelay,
      };
    });

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
    expect(startRelay).not.toHaveBeenCalled();
    expect(createTelegramChannelAdapter).toHaveBeenCalledWith(expect.objectContaining({ webhookMode: false }));

    await handle?.stop();
  });

	  it('stops webhook relay when binding store initialization fails before worker startup', async () => {
	    vi.resetModules();

	    const relayStop = vi.fn(async () => undefined);
	    const startWorker = vi.fn(() => ({
	      trigger: vi.fn(),
	      stop: vi.fn(async () => undefined),
	    }));
	    const storeInitError = new Error('binding store init failed');

    vi.doMock('@/ui/logger', () => ({
      logger: {
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      },
    }));

    vi.doMock('@/channels/core/channelBridgeWorker', () => ({
      createInMemoryChannelBindingStore: vi.fn(() => ({
        listBindings: async () => [],
        getBinding: async () => null,
        upsertBinding: async () => ({
          providerId: 'telegram',
          conversationId: 'conv-1',
          threadId: null,
          sessionId: 'sess-1',
          lastForwardedSeq: 0,
          ownerSenderId: 'user-1',
          inboundMode: 'ownerOnly',
          allowMissingSenderId: false,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        }),
        updateLastForwardedSeq: async () => true,
        removeBinding: async () => false,
      })),
      startChannelBridgeWorker: startWorker,
    }));

    vi.doMock('@/channels/providers/telegram/telegramAdapter', () => ({
      createTelegramChannelAdapter: vi.fn(() => ({
        providerId: 'telegram',
        pullInboundMessages: async () => [],
        sendMessage: async () => undefined,
        enqueueWebhookUpdate: vi.fn(),
        stop: async () => undefined,
      })),
    }));

	    vi.doMock('@/channels/providers/telegram/telegramWebhookRelay', async (importOriginal) => {
	      const actual = await importOriginal<typeof import('@/channels/providers/telegram/telegramWebhookRelay')>();
	      return {
	        ...actual,
	        startTelegramWebhookRelay: vi.fn(async () => ({
	          port: 8787,
	          stop: relayStop,
	        })),
	      };
	    });

	    vi.doMock('@/channels/state/localBindingStore', () => ({
	      createLocalChannelBindingStore: vi.fn(() => {
	        throw storeInitError;
	      }),
	    }));

	    const { startChannelBridgeFromEnv } = await import('./startChannelBridgeWorker');

	    await expect(startChannelBridgeFromEnv({
	      credentials,
	      serverId: 'server-a',
	      accountId: 'acct-a',
	      env: {
	        HAPPIER_TELEGRAM_BOT_TOKEN: 'bot-token',
	        HAPPIER_TELEGRAM_WEBHOOK_ENABLED: 'true',
	        HAPPIER_TELEGRAM_WEBHOOK_SECRET: 'secret-token',
	      } as NodeJS.ProcessEnv,
	    })).rejects.toThrow('binding store init failed');

	    expect(relayStop).toHaveBeenCalledTimes(0);
	    expect(startWorker).not.toHaveBeenCalled();
	  });

  it('starts with in-memory bindings when only serverId is provided', async () => {
    vi.resetModules();

    const startWorker = vi.fn(() => ({
      trigger: vi.fn(),
      stop: vi.fn(async () => undefined),
    }));
    const createLocalChannelBindingStore = vi.fn();
    const createInMemoryChannelBindingStore = vi.fn(() => ({
      listBindings: async () => [],
      getBinding: async () => null,
      upsertBinding: async () => ({
        providerId: 'telegram',
        conversationId: 'conv-1',
        threadId: null,
        sessionId: 'sess-1',
        lastForwardedSeq: 0,
        ownerSenderId: 'user-1',
        inboundMode: 'ownerOnly',
        allowMissingSenderId: false,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      }),
      updateLastForwardedSeq: async () => true,
      removeBinding: async () => false,
    }));

    vi.doMock('@/channels/core/channelBridgeWorker', () => ({
      createInMemoryChannelBindingStore,
      startChannelBridgeWorker: startWorker,
    }));

    vi.doMock('@/channels/state/localBindingStore', () => ({
      createLocalChannelBindingStore,
    }));

    vi.doMock('@/channels/providers/telegram/telegramAdapter', () => ({
      createTelegramChannelAdapter: vi.fn(() => ({
        providerId: 'telegram',
        pullInboundMessages: async () => [],
        sendMessage: async () => undefined,
        enqueueWebhookUpdate: vi.fn(),
        stop: async () => undefined,
      })),
    }));

    const { startChannelBridgeFromEnv } = await import('./startChannelBridgeWorker');

    const worker = await startChannelBridgeFromEnv({
      credentials,
      serverId: 'server-only',
      env: {
        HAPPIER_TELEGRAM_BOT_TOKEN: 'bot-token',
      } as NodeJS.ProcessEnv,
    });

    expect(worker).not.toBeNull();
    expect(createInMemoryChannelBindingStore).toHaveBeenCalledTimes(1);
    expect(createLocalChannelBindingStore).not.toHaveBeenCalled();
    expect(startWorker).toHaveBeenCalledTimes(1);
  });

  it('uses local bindings when accountId is provided (server scope comes from activeServerDir)', async () => {
    vi.resetModules();

    const startWorker = vi.fn(() => ({
      trigger: vi.fn(),
      stop: vi.fn(async () => undefined),
    }));
    const createInMemoryChannelBindingStore = vi.fn();
    const createLocalChannelBindingStore = vi.fn(() => ({
      listBindings: async () => [],
      getBinding: async () => null,
      upsertBinding: async () => ({
        providerId: 'telegram',
        conversationId: 'conv-1',
        threadId: null,
        sessionId: 'sess-1',
        lastForwardedSeq: 0,
        ownerSenderId: 'user-1',
        inboundMode: 'ownerOnly',
        allowMissingSenderId: false,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      }),
      updateLastForwardedSeq: async () => true,
      removeBinding: async () => false,
    }));

    vi.doMock('@/channels/core/channelBridgeWorker', () => ({
      createInMemoryChannelBindingStore,
      startChannelBridgeWorker: startWorker,
    }));

    vi.doMock('@/channels/state/localBindingStore', () => ({
      createLocalChannelBindingStore,
    }));

    vi.doMock('@/channels/providers/telegram/telegramAdapter', () => ({
      createTelegramChannelAdapter: vi.fn(() => ({
        providerId: 'telegram',
        pullInboundMessages: async () => [],
        sendMessage: async () => undefined,
        enqueueWebhookUpdate: vi.fn(),
        stop: async () => undefined,
      })),
    }));

    const { startChannelBridgeFromEnv } = await import('./startChannelBridgeWorker');

    const worker = await startChannelBridgeFromEnv({
      credentials,
      accountId: 'acct_123',
      env: {
        HAPPIER_TELEGRAM_BOT_TOKEN: 'bot-token',
      } as NodeJS.ProcessEnv,
    });

    expect(worker).not.toBeNull();
    expect(createLocalChannelBindingStore).toHaveBeenCalledTimes(1);
    expect(createInMemoryChannelBindingStore).not.toHaveBeenCalled();
    expect(startWorker).toHaveBeenCalledTimes(1);
  });
});
