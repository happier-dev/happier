import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerWarn } = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    warn: loggerWarn,
  },
}));

import { createTelegramChannelAdapter } from './telegramAdapter';

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createTelegramChannelAdapter', () => {
  beforeEach(() => {
    loggerWarn.mockReset();
  });

  it('parses inbound topic updates and ignores self-authored bot messages', async () => {
    const api = {
      getMe: vi.fn(async () => ({ id: 777, username: 'happier_bot' })),
      getUpdates: vi.fn(async () => ([
        {
          update_id: 101,
          message: {
            message_id: 5001,
            text: 'hello from topic',
            message_thread_id: 9001,
            chat: { id: -100555, type: 'supergroup' },
            from: { id: 42, is_bot: false, first_name: 'Ada' },
          },
        },
        {
          update_id: 102,
          message: {
            message_id: 5002,
            text: 'echo from self',
            chat: { id: -100555, type: 'supergroup' },
            from: { id: 777, is_bot: true, username: 'happier_bot' },
          },
        },
      ])),
      sendMessage: vi.fn(async () => undefined),
    };

    const adapter = createTelegramChannelAdapter({
      botToken: 'test-token',
      api,
      allowedChatIds: new Set(['-100555']),
    });

    const inbound = await adapter.pullInboundMessages();
    expect(inbound).toEqual([
      {
        providerId: 'telegram',
        conversationId: '-100555',
        threadId: '9001',
        senderId: '42',
        text: 'hello from topic',
        messageId: '5001',
      },
    ]);
  });

  it('ignores non-private chats by default unless allowlisted or allowAllSharedChats is enabled', async () => {
    const api = {
      getMe: vi.fn(async () => ({ id: 777, username: 'happier_bot' })),
      getUpdates: vi.fn(async () => ([
        {
          update_id: 101,
          message: {
            message_id: 5001,
            text: 'hello from dm',
            chat: { id: 1234, type: 'private' },
            from: { id: 42, is_bot: false, first_name: 'Ada' },
          },
        },
        {
          update_id: 102,
          message: {
            message_id: 5002,
            text: 'hello from group',
            chat: { id: -100555, type: 'supergroup' },
            from: { id: 43, is_bot: false, first_name: 'Grace' },
          },
        },
      ])),
      sendMessage: vi.fn(async () => undefined),
    };

    const adapter = createTelegramChannelAdapter({
      botToken: 'test-token',
      api,
    });

    const inbound = await adapter.pullInboundMessages();
    expect(inbound).toEqual([
      {
        providerId: 'telegram',
        conversationId: '1234',
        threadId: null,
        senderId: '42',
        text: 'hello from dm',
        messageId: '5001',
      },
    ]);
  });

  it('allows non-private chats when allowAllSharedChats is enabled', async () => {
    const api = {
      getMe: vi.fn(async () => ({ id: 777, username: 'happier_bot' })),
      getUpdates: vi.fn(async () => ([
        {
          update_id: 101,
          message: {
            message_id: 5001,
            text: 'hello from group',
            chat: { id: -100555, type: 'supergroup' },
            from: { id: 42, is_bot: false, first_name: 'Ada' },
          },
        },
      ])),
      sendMessage: vi.fn(async () => undefined),
    };

    const adapter = createTelegramChannelAdapter({
      botToken: 'test-token',
      api,
      allowAllSharedChats: true,
    });

    const inbound = await adapter.pullInboundMessages();
    expect(inbound).toEqual([
      {
        providerId: 'telegram',
        conversationId: '-100555',
        threadId: null,
        senderId: '42',
        text: 'hello from group',
        messageId: '5001',
      },
    ]);
  });

  it('sends outbound messages with thread targeting when threadId is present', async () => {
    const api = {
      getMe: vi.fn(async () => ({ id: 9, username: 'happier_bot' })),
      getUpdates: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined),
    };

    const adapter = createTelegramChannelAdapter({
      botToken: 'test-token',
      api,
    });

    await adapter.sendMessage({
      conversationId: '-100777',
      threadId: '451',
      text: 'assistant says hi',
    });

    expect(api.sendMessage).toHaveBeenCalledWith({
      chatId: '-100777',
      threadId: '451',
      text: 'assistant says hi',
    });
  });

  it('accepts webhook updates through enqueueWebhookUpdate without polling', async () => {
    const api = {
      getMe: vi.fn(async () => ({ id: 9, username: 'happier_bot' })),
      getUpdates: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined),
    };

    const adapter = createTelegramChannelAdapter({
      botToken: 'test-token',
      api,
      webhookMode: true,
    });

    adapter.enqueueWebhookUpdate({
      update_id: 777,
      message: {
        message_id: 88,
        text: '/sessions',
        chat: { id: 1234, type: 'private' },
        from: { id: 456, is_bot: false, first_name: 'Grace' },
      },
    });

    const inbound = await adapter.pullInboundMessages();
    expect(inbound).toEqual([
      {
        providerId: 'telegram',
        conversationId: '1234',
        threadId: null,
        senderId: '456',
        text: '/sessions',
        messageId: '88',
      },
    ]);
    expect(api.getUpdates).not.toHaveBeenCalled();

    const pendingReplay = await adapter.pullInboundMessages();
    expect(pendingReplay).toHaveLength(1);

    await adapter.ackInboundMessages?.(inbound);
    await expect(adapter.pullInboundMessages()).resolves.toEqual([]);
  });

  it('keeps webhook updates queued when parsing fails and retries later', async () => {
    const api = {
      getMe: vi
        .fn()
        .mockRejectedValueOnce(new Error('temporary getMe failure'))
        .mockResolvedValue({ id: 9, username: 'happier_bot' }),
      getUpdates: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined),
    };

    const adapter = createTelegramChannelAdapter({
      botToken: 'test-token',
      api,
      webhookMode: true,
    });

    adapter.enqueueWebhookUpdate({
      update_id: 801,
      message: {
        message_id: 9001,
        text: 'retry me',
        chat: { id: 1234, type: 'private' },
        from: { id: 456, is_bot: false, first_name: 'Grace' },
      },
    });

    await expect(adapter.pullInboundMessages()).rejects.toThrow('temporary getMe failure');

    const inbound = await adapter.pullInboundMessages();
    expect(inbound).toEqual([
      {
        providerId: 'telegram',
        conversationId: '1234',
        threadId: null,
        senderId: '456',
        text: 'retry me',
        messageId: '9001',
      },
    ]);
  });

  it('bounds webhook queue size to prevent unbounded growth', async () => {
    const api = {
      getMe: vi.fn(async () => ({ id: 9, username: 'happier_bot' })),
      getUpdates: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined),
    };

    const adapter = createTelegramChannelAdapter({
      botToken: 'test-token',
      api,
      webhookMode: true,
    });

    for (let i = 0; i < 2_100; i += 1) {
      adapter.enqueueWebhookUpdate({
        update_id: i,
        message: {
          message_id: i,
          text: `message ${i}`,
          chat: { id: 4321, type: 'private' },
          from: { id: 222, is_bot: false, first_name: 'Ada' },
        },
      });
    }

    const inbound = await adapter.pullInboundMessages();
    expect(inbound).toHaveLength(2_000);
    expect(inbound[0]?.messageId).toBe('100');
    expect(inbound[1_999]?.messageId).toBe('2099');
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn.mock.calls[0]?.[0]).toContain('dropped 100 oldest update(s)');
  });

  it('does not drop updates enqueued while webhook parsing is in flight', async () => {
    const gate = createDeferredPromise<void>();
    const api = {
      getMe: vi.fn(async () => {
        await gate.promise;
        return { id: 9, username: 'happier_bot' };
      }),
      getUpdates: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined),
    };

    const adapter = createTelegramChannelAdapter({
      botToken: 'test-token',
      api,
      webhookMode: true,
    });

    adapter.enqueueWebhookUpdate({
      update_id: 901,
      message: {
        message_id: 901,
        text: 'first',
        chat: { id: 1234, type: 'private' },
        from: { id: 456, is_bot: false, first_name: 'Grace' },
      },
    });

    const firstPull = adapter.pullInboundMessages();

    adapter.enqueueWebhookUpdate({
      update_id: 902,
      message: {
        message_id: 902,
        text: 'second',
        chat: { id: 1234, type: 'private' },
        from: { id: 456, is_bot: false, first_name: 'Grace' },
      },
    });

    gate.resolve();

    const firstInbound = await firstPull;
    expect(firstInbound).toHaveLength(1);
    expect(firstInbound[0]?.messageId).toBe('901');

    await adapter.ackInboundMessages?.(firstInbound);

    const secondInbound = await adapter.pullInboundMessages();
    expect(secondInbound).toHaveLength(1);
    expect(secondInbound[0]?.messageId).toBe('902');
  });

  it('truncates outbound telegram messages above provider limit', async () => {
    type SendMessageParams = Readonly<{ chatId: string; threadId: string | null; text: string }>;

    const api = {
      getMe: vi.fn(async () => ({ id: 9, username: 'happier_bot' })),
      getUpdates: vi.fn(async () => []),
      sendMessage: vi.fn(async (_params: SendMessageParams) => undefined),
    };

    const adapter = createTelegramChannelAdapter({
      botToken: 'test-token',
      api,
    });

    const oversized = 'x'.repeat(4_500);
    await adapter.sendMessage({
      conversationId: '1234',
      threadId: null,
      text: oversized,
    });

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const calls = api.sendMessage.mock.calls as SendMessageParams[][];
    expect(calls[0]?.[0]?.text).toHaveLength(4_096);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Truncated Telegram outbound message for conversation 1234 to 4096 characters'),
    );
  });

  it('truncates outbound telegram messages by Unicode code points without splitting surrogate pairs', async () => {
    type SendMessageParams = Readonly<{ chatId: string; threadId: string | null; text: string }>;

    const api = {
      getMe: vi.fn(async () => ({ id: 9, username: 'happier_bot' })),
      getUpdates: vi.fn(async () => []),
      sendMessage: vi.fn(async (_params: SendMessageParams) => undefined),
    };

    const adapter = createTelegramChannelAdapter({
      botToken: 'test-token',
      api,
    });

    const nearBoundary = 'a'.repeat(4_095) + '🎉';
    await adapter.sendMessage({
      conversationId: '1234',
      threadId: null,
      text: nearBoundary,
    });

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const calls = api.sendMessage.mock.calls as SendMessageParams[][];
    expect(calls[0]?.[0]?.text).toBe(nearBoundary);
    expect(Array.from(calls[0]?.[0]?.text ?? '').length).toBe(4_096);
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('advances polling offset only after adapter acknowledgements in polling mode', async () => {
    const getMe = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary getMe failure'))
      .mockResolvedValue({ id: 9, username: 'happier_bot' });
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([
        {
          update_id: 11,
          message: {
            message_id: 111,
            text: 'hello',
            chat: { id: -100555, type: 'private' },
            from: { id: 42, is_bot: false, first_name: 'Ada' },
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          update_id: 11,
          message: {
            message_id: 111,
            text: 'hello',
            chat: { id: -100555, type: 'private' },
            from: { id: 42, is_bot: false, first_name: 'Ada' },
          },
        },
      ])
      .mockResolvedValueOnce([]);

    const api = {
      getMe,
      getUpdates,
      sendMessage: vi.fn(async () => undefined),
    };

    const adapter = createTelegramChannelAdapter({
      botToken: 'test-token',
      api,
      webhookMode: false,
    });

    await expect(adapter.pullInboundMessages()).rejects.toThrow('temporary getMe failure');
    expect(getUpdates).toHaveBeenNthCalledWith(1, { offset: null, limit: 100 });

    const parsed = await adapter.pullInboundMessages();
    expect(parsed).toHaveLength(1);
    expect(getUpdates).toHaveBeenNthCalledWith(2, { offset: null, limit: 100 });

    const replayBeforeAck = await adapter.pullInboundMessages();
    expect(replayBeforeAck).toEqual(parsed);
    expect(getUpdates).toHaveBeenCalledTimes(2);

    await adapter.ackInboundMessages?.(parsed);

    await adapter.pullInboundMessages();
    expect(getUpdates).toHaveBeenNthCalledWith(3, { offset: 12, limit: 100 });
  });

  it('includes Telegram API error descriptions when available', async () => {
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 400,
      data: {
        ok: false,
        description: 'Bad Request: chat not found',
      },
    } as never);

    try {
      const adapter = createTelegramChannelAdapter({
        botToken: 'test-token',
      });

      await expect(adapter.sendMessage({
        conversationId: '-100999',
        threadId: null,
        text: 'hello',
      })).rejects.toThrow('Bad Request: chat not found');
    } finally {
      postSpy.mockRestore();
    }
  });

  it('bounds getUpdates HTTP timeout under the worker IO timeout to avoid overlapping polls', async () => {
    const postSpy = vi.spyOn(axios, 'post').mockImplementation(async (url, data, config) => {
      if (typeof url === 'string' && url.includes('/getUpdates')) {
        return {
          status: 200,
          data: { ok: true, result: [] },
          __capturedConfig: config,
          __capturedBody: data,
        } as never;
      }
      if (typeof url === 'string' && url.includes('/getMe')) {
        return {
          status: 200,
          data: { ok: true, result: { id: 9, username: 'happier_bot' } },
          __capturedConfig: config,
          __capturedBody: data,
        } as never;
      }
      throw new Error(`Unexpected Telegram API call: ${String(url)}`);
    });

    try {
      const adapter = createTelegramChannelAdapter({
        botToken: 'test-token',
      });

      await expect(adapter.pullInboundMessages()).resolves.toEqual([]);

      const getUpdatesCall = postSpy.mock.calls.find((call) => String(call[0]).includes('/getUpdates'));
      expect(getUpdatesCall).toBeTruthy();
      const getUpdatesConfig = getUpdatesCall?.[2] as { timeout?: number } | undefined;
      expect(typeof getUpdatesConfig?.timeout).toBe('number');
      expect((getUpdatesConfig?.timeout ?? 0)).toBeLessThanOrEqual(30_000);
    } finally {
      postSpy.mockRestore();
    }
  });
});
