import { describe, expect, it } from 'vitest';

import {
  createTelegramBotApi,
  createTelegramPairingDeepLink,
  splitTelegramPlainText,
} from './telegramBotApi.js';

type RecordedRequest = Readonly<{
  url: string;
  method?: string;
  body?: Uint8Array;
  timeoutMs?: number;
}>;

function jsonResponse(value: unknown, status = 200): Readonly<{
  status: number;
  finalUrl: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}> {
  return {
    status,
    finalUrl: 'https://api.telegram.org/',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

describe('Telegram Bot API adapter', () => {
  it('creates the official direct-message pairing deep link only for a valid normalized token', () => {
    expect(createTelegramPairingDeepLink({ username: 'HappierBot', token: 'ABCD2345' })).toBe(
      'https://t.me/HappierBot?start=ABCD2345',
    );
    expect(createTelegramPairingDeepLink({ username: 'HappierBot', token: 'not valid' })).toBeNull();
  });

  it('chunks outbound plain text on grapheme boundaries within Telegram’s code-point limit', () => {
    const text = `${'a'.repeat(4_095)}😀e\u0301`;

    expect(splitTelegramPlainText(text)).toEqual([
      `${'a'.repeat(4_095)}😀`,
      'e\u0301',
    ]);
  });

  it('reports getUpdates 409 as a provider conflict without claiming its external cause', async () => {
    const api = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request() {
          return jsonResponse({
            ok: false,
            error_code: 409,
            description: 'Conflict: terminated by other getUpdates request',
          }, 409);
        },
      },
    });

    await expect(api.getUpdates({ offset: '42', limit: 50, timeoutSeconds: 30 })).resolves.toEqual({
      kind: 'providerConflict',
      diagnostic: 'Conflict: terminated by other getUpdates request',
    });
  });

  it('classifies an authenticated Bot API 400 read rejection as invalid configuration, not a transport failure', async () => {
    const api = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request() {
          return jsonResponse({
            ok: false,
            error_code: 400,
            description: 'Bad Request: chat not found',
          }, 400);
        },
      },
    });

    await expect(api.getChat({ chatId: '456' })).resolves.toEqual({
      kind: 'notReady',
      reason: 'invalidConfiguration',
      diagnostic: 'Bad Request: chat not found',
    });
  });

  it('does not accept a non-bot getMe response as the immutable integration identity', async () => {
    const api = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request() {
          return jsonResponse({
            ok: true,
            result: { id: 123, is_bot: false, first_name: 'Ada', username: 'Ada' },
          });
        },
      },
    });

    await expect(api.getMe()).resolves.toMatchObject({
      kind: 'notReady',
      reason: 'invalidConfiguration',
    });
  });

  it('bounds non-poll Bot API calls with a client-side HTTP deadline', async () => {
    const requests: RecordedRequest[] = [];
    const api = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request(input) {
          requests.push(input);
          return jsonResponse({
            ok: true,
            result: { id: 123, is_bot: true, first_name: 'Happier Bot', username: 'HappierBot' },
          });
        },
      },
    });

    await api.getMe();
    expect(requests[0]?.timeoutMs).toBe(15_000);
  });

  it('passes the caller cancellation signal through long-poll transport I/O', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const api = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request(_input, options) {
          receivedSignal = options?.signal;
          return jsonResponse({ ok: true, result: [] });
        },
      },
    });

    await api.getUpdates({ offset: '42', limit: 50, timeoutSeconds: 30 }, { signal: controller.signal });
    expect(receivedSignal).toBe(controller.signal);
  });

  it('propagates aborted transport I/O instead of misreporting it as a network result', async () => {
    const controller = new AbortController();
    const abort = new Error('poll retired');
    const api = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request() {
          controller.abort(abort);
          throw abort;
        },
      },
    });

    await expect(api.getUpdates(
      { offset: '42', limit: 50, timeoutSeconds: 30 },
      { signal: controller.signal },
    )).rejects.toBe(abort);
  });

  it('uses the core-committed checkpoint as the next polling offset and returns opaque update evidence', async () => {
    const requests: RecordedRequest[] = [];
    const api = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request(input) {
          requests.push(input);
          return jsonResponse({
            ok: true,
            result: [{
              update_id: 42,
              message: {
                message_id: 9,
                date: 1_700_000_000,
                chat: { id: 123, type: 'private' },
                from: { id: 456, is_bot: false, first_name: 'Ada' },
                text: 'hello',
              },
            }],
          });
        },
      },
    });

    await expect(api.getUpdates({ offset: '42', limit: 50, timeoutSeconds: 30 })).resolves.toMatchObject({
      kind: 'updates',
      updates: [{ updateId: '42', message: { messageId: '9', chatId: '123', senderId: '456' } }],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.telegram.org/botsecret-token/getUpdates');
    expect(JSON.parse(new TextDecoder().decode(requests[0]?.body))).toEqual({
      offset: 42,
      limit: 50,
      timeout: 30,
      allowed_updates: ['message', 'edited_message'],
    });
    expect(requests[0]?.timeoutMs).toBe(40_000);
  });

  it('uses Telegram’s explicit negative-offset tail mechanism only for an initial no-history baseline', async () => {
    const requests: RecordedRequest[] = [];
    const api = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request(input) {
          requests.push(input);
          return jsonResponse({
            ok: true,
            result: [{
              update_id: 999,
              message: {
                message_id: 9,
                date: 1_700_000_000,
                chat: { id: 123, type: 'private' },
                from: { id: 456, is_bot: false, first_name: 'Ada' },
                text: 'ignored historical update',
              },
            }],
          });
        },
      },
    });

    await expect(api.getUpdates({
      offset: '-1',
      initialBaseline: true,
      limit: 1,
      timeoutSeconds: 1,
    })).resolves.toMatchObject({ kind: 'updates', checkpointAfter: '1000' });
    expect(JSON.parse(new TextDecoder().decode(requests[0]?.body))).toMatchObject({ offset: -1, limit: 1 });
  });

  it('retains immutable group/addressing evidence for provider-owned admission decisions', async () => {
    const api = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request() {
          return jsonResponse({
            ok: true,
            result: [{
              update_id: 43,
              message: {
                message_id: 10,
                message_thread_id: 11,
                date: 1_700_000_010,
                chat: { id: -100123, type: 'supergroup' },
                from: { id: 456, is_bot: false, first_name: 'Ada' },
                reply_to_message: { message_id: 9, from: { id: 999, is_bot: true } },
                forward_origin: { type: 'user' },
                text: 'hello @HappierBot',
                entities: [{ type: 'mention', offset: 6, length: 11 }],
              },
            }],
          });
        },
      },
    });

    await expect(api.getUpdates({ offset: '43', limit: 50, timeoutSeconds: 30 })).resolves.toMatchObject({
      kind: 'updates',
      updates: [{
        kind: 'message',
        message: {
          chatId: '-100123',
          chatType: 'supergroup',
          messageThreadId: '11',
          senderId: '456',
          replyToMessageId: '9',
          replyToSenderId: '999',
          forwarded: true,
          textEntities: [{ type: 'mention', text: '@HappierBot' }],
        },
      }],
    });
  });

  it('resolves a Telegram chat to its immutable endpoint identity before a connection uses it', async () => {
    const requests: RecordedRequest[] = [];
    const api = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request(input) {
          requests.push(input);
          return jsonResponse({
            ok: true,
            result: { id: -100123, type: 'supergroup', title: 'Happier team' },
          });
        },
      },
    });

    await expect(api.getChat({ chatId: '-100123' })).resolves.toEqual({
      id: '-100123',
      type: 'supergroup',
      label: 'Happier team',
    });
    expect(JSON.parse(new TextDecoder().decode(requests[0]?.body))).toEqual({ chat_id: '-100123' });
  });

  it('sends link-preview suppression and retains Telegram returned-message evidence', async () => {
    const requests: RecordedRequest[] = [];
    const api = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request(input) {
          requests.push(input);
          return jsonResponse({
            ok: true,
            result: {
              message_id: 77,
              date: 1_700_000_100,
              chat: { id: 123, type: 'private' },
              text: 'reply',
            },
          });
        },
      },
    });

    await expect(api.sendMessage({ chatId: '123', text: 'reply', suppressLinkPreview: true })).resolves.toEqual({
      kind: 'sent',
      messageId: '77',
    });
    expect(JSON.parse(new TextDecoder().decode(requests[0]?.body))).toEqual({
      chat_id: '123',
      text: 'reply',
      link_preview_options: { is_disabled: true },
    });
  });

  it('keeps a topic delivery in its Telegram thread and permits a zero-wait poll', async () => {
    const requests: RecordedRequest[] = [];
    const api = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request(input) {
          requests.push(input);
          return jsonResponse(input.url.endsWith('/sendMessage')
            ? { ok: true, result: { message_id: 99 } }
            : { ok: true, result: [] });
        },
      },
    });

    await expect(api.sendMessage({
      chatId: '-1001',
      text: 'topic reply',
      suppressLinkPreview: true,
      replyToMessageId: '71',
      messageThreadId: '41',
    })).resolves.toEqual({ kind: 'sent', messageId: '99' });
    await expect(api.getUpdates({ offset: '42', limit: 1, timeoutSeconds: 0 })).resolves.toMatchObject({
      kind: 'updates',
      checkpointAfter: '42',
    });

    expect(JSON.parse(new TextDecoder().decode(requests[0]?.body))).toMatchObject({
      reply_parameters: { message_id: 71 },
      message_thread_id: 41,
    });
    expect(requests[1]?.timeoutMs).toBe(15_000);
  });

  it('maps bounded flood-control retry hints, keeps an undelayed 429 safely retryable, and treats a transport failure after dispatch as outcome unknown', async () => {
    const limitedApi = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request() {
          return jsonResponse({
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 3 },
          }, 429);
        },
      },
    });
    const unknownApi = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request() {
          throw new Error('connection reset');
        },
      },
    });
    const undelayedRateLimitedApi = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request() {
          return jsonResponse({
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
          }, 429);
        },
      },
    });
    const oversizedRateLimitedApi = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request() {
          return jsonResponse({
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 86_401 },
          }, 429);
        },
      },
    });

    await expect(limitedApi.sendMessage({ chatId: '123', text: 'reply', suppressLinkPreview: true })).resolves.toEqual({
      kind: 'notSent',
      retry: 'after',
      retryAfterMs: 3_000,
      diagnostic: 'Too Many Requests',
    });
    await expect(undelayedRateLimitedApi.sendMessage({
      chatId: '123',
      text: 'reply',
      suppressLinkPreview: true,
    })).resolves.toEqual({
      kind: 'notSent',
      retry: 'safe',
      diagnostic: 'Too Many Requests',
    });
    await expect(oversizedRateLimitedApi.getChat({ chatId: '123' })).resolves.toEqual({
      kind: 'notReady',
      reason: 'rateLimited',
      retryAfterMs: 86_400_000,
      diagnostic: 'Too Many Requests',
    });
    await expect(oversizedRateLimitedApi.sendMessage({
      chatId: '123',
      text: 'reply',
      suppressLinkPreview: true,
    })).resolves.toEqual({
      kind: 'notSent',
      retry: 'after',
      retryAfterMs: 86_400_000,
      diagnostic: 'Too Many Requests',
    });
    await expect(unknownApi.sendMessage({ chatId: '123', text: 'reply', suppressLinkPreview: true })).resolves.toEqual({
      kind: 'outcomeUnknown',
    });
  });

  it('does not claim that a Telegram 5xx failed before a user-visible send could take effect', async () => {
    const api = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request() {
          return jsonResponse({
            ok: false,
            error_code: 502,
            description: 'Bad Gateway',
          }, 502);
        },
      },
    });

    await expect(api.sendMessage({ chatId: '123', text: 'reply', suppressLinkPreview: true })).resolves.toEqual({
      kind: 'outcomeUnknown',
    });
  });
});
