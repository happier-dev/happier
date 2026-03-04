import { describe, expect, it, vi } from 'vitest';

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
    });

    const inbound = await adapter.pullInboundMessages();
    expect(inbound).toEqual([
      {
        providerId: 'telegram',
        conversationId: '-100555',
        threadId: '9001',
        text: 'hello from topic',
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
        text: '/sessions',
        messageId: '88',
      },
    ]);
    expect(api.getUpdates).not.toHaveBeenCalled();
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

    const secondInbound = await adapter.pullInboundMessages();
    expect(secondInbound).toHaveLength(1);
    expect(secondInbound[0]?.messageId).toBe('902');
  });

  it('advances polling offset only after successful parsing', async () => {
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

    await adapter.pullInboundMessages();
    expect(getUpdates).toHaveBeenNthCalledWith(3, { offset: 12, limit: 100 });
  });
});
