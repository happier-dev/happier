import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  createTelegramBotApi,
  TELEGRAM_MAX_DOWNLOAD_FILE_BYTES,
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
  it('enforces the native 128-character topic-name boundary before requesting HTTP', async () => {
    const request = vi.fn(async () => jsonResponse({ ok: true, result: { message_thread_id: 17 } }));
    const api = createTelegramBotApi({ token: 'fixture-token', http: { request } });
    for (const name of ['', ' ', 'x'.repeat(129)]) {
      await expect(api.createForumTopic({ chatId: '-100456', name })).resolves.toMatchObject({ kind: 'notSent', retry: 'never' });
    }
    expect(request).not.toHaveBeenCalled();
    await expect(api.createForumTopic({ chatId: '-100456', name: 'x'.repeat(128) })).resolves.toMatchObject({ kind: 'created' });
    expect(request).toHaveBeenCalledOnce();
  });

  it('creates a forum topic through the Bot API and preserves its native thread id', async () => {
    const controller = new AbortController();
    const requests: RecordedRequest[] = [];
    const api = createTelegramBotApi({ token: 'fixture-token', http: { async request(input, options) {
      requests.push(input);
      expect(options?.signal).toBe(controller.signal);
      return jsonResponse({ ok: true, result: { message_thread_id: 17, name: 'Brief' } });
    } } });
    await expect(api.createForumTopic({ chatId: '-100456', name: 'Brief' }, { signal: controller.signal }))
      .resolves.toEqual({ kind: 'created', messageThreadId: '17' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toMatch(/\/createForumTopic$/u);
    expect(JSON.parse(new TextDecoder().decode(requests[0]?.body))).toEqual({ chat_id: '-100456', name: 'Brief' });
  });

  it.each([
    { value: { ok: false, error_code: 403, description: 'Forbidden' }, expected: { kind: 'notSent', retry: 'never' } },
    { value: { ok: false, error_code: 429, description: 'Wait', parameters: { retry_after: 9 } }, expected: { kind: 'notSent', retry: 'after', retryAfterMs: 9000 } },
    { value: { ok: false, error_code: 500, description: 'Failed' }, expected: { kind: 'outcomeUnknown' } },
    { value: { ok: true, result: {} }, expected: { kind: 'outcomeUnknown' } },
  ])('classifies native topic creation without retrying the HTTP request ($expected.kind)', async ({ value, expected }) => {
    const request = vi.fn(async () => jsonResponse(value));
    const api = createTelegramBotApi({ token: 'fixture-token', http: { request } });
    await expect(api.createForumTopic({ chatId: '-100456', name: 'Brief' })).resolves.toMatchObject(expected);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(['getFile', 'download'])('propagates host retirement during %s instead of reporting a provider network failure', async phase => {
    const retired = new PluginError({ code: 'plugin_final_generation_retired', message: 'The provider generation is retired.' });
    const api = createTelegramBotApi({ token: 'secret-token', http: { async request(input) {
      if (phase === 'getFile' || input.method === 'GET') throw retired;
      return jsonResponse({ ok: true, result: { file_path: 'documents/file.txt' } });
    } } });
    await expect(api.downloadFile({ fileId: 'native-file' }, { signal: new AbortController().signal })).rejects.toBe(retired);
  });

  it('renews getFile paths on each materialization and passes cancellation to both HTTP phases', async () => {
    let renewal = 0;
    const controller = new AbortController();
    const requests: RecordedRequest[] = [];
    const api = createTelegramBotApi({ token: 'secret-token', http: { async request(input, options) {
      requests.push(input);
      expect(options?.signal).toBe(controller.signal);
      if (input.method === 'POST') {
        renewal += 1;
        expect(JSON.parse(new TextDecoder().decode(input.body))).toEqual({ file_id: 'native-file' });
        return jsonResponse({ ok: true, result: { file_id: 'native-file', file_path: `documents/fresh-${renewal}.txt`, file_size: 5 } });
      }
      expect(input.redirect).toBe('error');
      expect(input.timeoutMs).toBeUndefined();
      return { ...jsonResponse(null), finalUrl: input.url, body: new TextEncoder().encode('hello') };
    } } });
    for (let count = 0; count < 2; count += 1) {
      await expect(api.downloadFile({ fileId: 'native-file' }, { signal: controller.signal })).resolves.toEqual({
        kind: 'downloaded', bytes: new TextEncoder().encode('hello'),
      });
    }
    expect(requests.filter(request => request.method === 'GET').map(request => request.url)).toEqual([
      'https://api.telegram.org/file/botsecret-token/documents/fresh-1.txt',
      'https://api.telegram.org/file/botsecret-token/documents/fresh-2.txt',
    ]);
  });

  it.each(['../other/file', '%2e%2e/other/file', '//outside.example/file', 'https://outside.example/file', 'documents/%2fsecret', 'documents/file?token=secret'])('refuses an unsafe native download path %s without a GET', async path => {
    const calls: string[] = [];
    const api = createTelegramBotApi({ token: 'secret-token', http: { async request(input) {
      calls.push(input.method ?? '');
      return jsonResponse({ ok: true, result: { file_path: path } });
    } } });
    await expect(api.downloadFile({ fileId: 'native-file' })).resolves.toMatchObject({ kind: 'notReady', reason: 'unsupported' });
    expect(calls).toEqual(['POST']);
  });

  it('retains the exact Cloud boundary and reports overlimit descriptors without requesting bytes', async () => {
    const requests: RecordedRequest[] = [];
    const api = createTelegramBotApi({ token: 'secret-token', http: { async request(input) {
      requests.push(input);
      return input.method === 'GET'
        ? { ...jsonResponse(null), finalUrl: input.url, body: new Uint8Array(0) }
        : jsonResponse({ ok: true, result: { file_path: 'documents/file.txt', file_size: TELEGRAM_MAX_DOWNLOAD_FILE_BYTES } });
    } } });
    await expect(api.downloadFile({ fileId: 'big', byteLength: TELEGRAM_MAX_DOWNLOAD_FILE_BYTES + 1 })).resolves.toMatchObject({ kind: 'notReady', reason: 'unsupported' });
    expect(requests).toHaveLength(0);
    await expect(api.downloadFile({ fileId: 'allowed', byteLength: TELEGRAM_MAX_DOWNLOAD_FILE_BYTES })).resolves.toMatchObject({ kind: 'downloaded' });
    expect(requests).toHaveLength(2);
  });

  it('sanitizes getFile and download failures instead of exposing token-bearing URLs', async () => {
    for (const failurePhase of ['lookup', 'download', 'redirect']) {
      const api = createTelegramBotApi({ token: 'secret-token', http: { async request(input) {
        if (input.method === 'POST') return failurePhase === 'lookup'
          ? jsonResponse({ ok: false, error_code: 400, description: 'https://api.telegram.org/file/botsecret-token/secret' }, 400)
          : jsonResponse({ ok: true, result: { file_path: 'documents/file.txt' } });
        if (failurePhase === 'redirect') return { ...jsonResponse(null), status: 302, finalUrl: 'https://outside.example/secret-token' };
        throw new Error('https://api.telegram.org/file/botsecret-token/secret');
      } } });
      const result = await api.downloadFile({ fileId: 'native-file' });
      expect(result).toMatchObject({ kind: 'notReady' });
      expect(JSON.stringify(result)).not.toContain('secret-token');
    }
  });

  it('propagates cancellation during file download', async () => {
    const controller = new AbortController();
    const reason = new Error('materialization retired');
    const api = createTelegramBotApi({ token: 'secret-token', http: { async request(input) {
      if (input.method === 'POST') return jsonResponse({ ok: true, result: { file_path: 'documents/file.txt' } });
      controller.abort(reason);
      throw reason;
    } } });
    await expect(api.downloadFile({ fileId: 'native-file' }, { signal: controller.signal })).rejects.toBe(reason);
  });

  it('retains captions, caption entities and the largest valid photo without downloading during observation', async () => {
    const calls: string[] = [];
    const api = createTelegramBotApi({ token: 'secret-token', http: { async request(input) {
      calls.push(input.url);
      return jsonResponse({ ok: true, result: [{ update_id: 1, message: {
        message_id: 2, date: 1700000000, chat: { id: 456, type: 'private' },
        from: { id: 789, is_bot: false }, caption: '@HappierBot inspect',
        caption_entities: [{ type: 'mention', offset: 0, length: 11 }],
        photo: [
          { file_id: 'large', width: 800, height: 600, file_size: 1000 },
          { file_id: 'small', width: 80, height: 60, file_size: 100 },
          { file_id: 'invalid', width: -1, height: 900 },
        ],
      } }] });
    } } });
    const result = await api.getUpdates({ offset: '1', limit: 1, timeoutSeconds: 0 });
    expect(result).toMatchObject({ kind: 'updates', updates: [{ message: {
      text: '@HappierBot inspect', textEntities: [{ type: 'mention', text: '@HappierBot' }],
      attachments: [{ fileId: 'large', name: 'photo-2.jpg', mediaType: 'image/jpeg', byteLength: 1000 }],
    } }] });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['document', 'notes.txt', 'text/plain'], ['audio', 'song.mp3', 'audio/mpeg'],
    ['voice', 'voice-2.ogg', 'audio/ogg'], ['video', 'clip.mp4', 'video/mp4'],
    ['animation', 'animation.gif', 'image/gif'],
  ])('observes a %s file and deduplicates the animation document alias', async (kind, name, mediaType) => {
    const media = { file_id: 'native-file', file_unique_id: 'unique', file_name: name, mime_type: mediaType, file_size: 30000000 };
    const api = createTelegramBotApi({ token: 'secret-token', http: { async request() {
      return jsonResponse({ ok: true, result: [{ update_id: 1, message: {
        message_id: 2, date: 1700000000, chat: { id: 456, type: 'private' },
        [kind]: media, ...(kind === 'animation' ? { document: { ...media, file_id: 'document-alias' } } : {}),
      } }] });
    } } });
    const result = await api.getUpdates({ offset: '1', limit: 1, timeoutSeconds: 0 });
    expect(result).toMatchObject({ kind: 'updates', updates: [{ message: {
      attachments: [{ fileId: 'native-file', name, mediaType, byteLength: 30000000 }],
    } }] });
    if (result.kind === 'updates') expect(result.updates[0]?.message?.attachments).toHaveLength(1);
  });

  it('leaves native text-size admission to the core splitter and the provider response', async () => {
    const text = 'x'.repeat(4_097);
    const requests: RecordedRequest[] = [];
    const api = createTelegramBotApi({ token: 'secret-token', http: { async request(input) {
      requests.push(input);
      return jsonResponse({ ok: false, error_code: 400, description: 'MESSAGE_TOO_LONG' });
    } } });
    await expect(api.sendMessage({ chatId: '456', text, suppressLinkPreview: true }))
      .resolves.toMatchObject({ kind: 'notSent', retry: 'never', diagnostic: 'MESSAGE_TOO_LONG' });
    expect(requests).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(requests[0]?.body))).toMatchObject({ text });
  });

  it('reports a getUpdates 409 as the exclusive-poll conflict without claiming a retry hint Telegram did not send', async () => {
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

    // The bounded restart-overlap retry is Channels policy driven by the
    // shared backoff curve. The conflict result itself carries no delay: a
    // local policy constant must not masquerade as provider-supplied
    // `retryAfterMs` evidence.
    await expect(api.getUpdates({ offset: '42', limit: 50, timeoutSeconds: 30 })).resolves.toEqual({
      kind: 'providerConflict',
      diagnostic: 'Conflict: terminated by other getUpdates request',
    });
  });

  it('does not turn a retry_after attached to getUpdates 409 into provider delay evidence', async () => {
    const api = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request() {
          return jsonResponse({
            ok: false,
            error_code: 409,
            description: 'Conflict: terminated by other getUpdates request',
            parameters: { retry_after: 3 },
          }, 409);
        },
      },
    });

    await expect(api.getUpdates({ offset: '42', limit: 50, timeoutSeconds: 30 })).resolves.toEqual({
      kind: 'providerConflict',
      diagnostic: 'Conflict: terminated by other getUpdates request',
    });
  });

  it('keeps a 409 on every other Bot API read a permanent provider conflict', async () => {
    const api = createTelegramBotApi({
      token: 'secret-token',
      http: {
        async request() {
          return jsonResponse({
            ok: false,
            error_code: 409,
            description: 'Conflict: terminated by other request',
          }, 409);
        },
      },
    });

    await expect(api.getWebhookInfo()).resolves.toEqual({
      kind: 'providerConflict',
      diagnostic: 'Conflict: terminated by other request',
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

  it.each(['identity', 'longPoll'] as const)('lets the caller own cancellation of slow %s requests', async phase => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const api = createTelegramBotApi({
        token: 'secret-token',
        http: {
          request(input, options) {
            expect(options?.signal).toBe(controller.signal);
            return new Promise((resolve, reject) => {
              const responseTimer = setTimeout(() => resolve(jsonResponse({ ok: true, result: phase === 'identity'
                ? { id: 123, is_bot: true, first_name: 'Happier Bot', username: 'HappierBot' }
                : [] })), 60_001);
              if (input.timeoutMs !== undefined) setTimeout(() => {
                clearTimeout(responseTimer);
                reject(new Error('HTTP deadline exceeded'));
              }, input.timeoutMs);
            });
          },
        },
      });
      const result = phase === 'identity'
        ? api.getMe({ signal: controller.signal })
        : api.getUpdates({ offset: '42', limit: 1, timeoutSeconds: 50 }, { signal: controller.signal });
      await vi.advanceTimersByTimeAsync(60_001);
      await expect(result).resolves.toMatchObject(phase === 'identity' ? { id: '123' } : { kind: 'updates' });
    } finally {
      vi.useRealTimers();
    }
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

  it('cancels pending transport I/O instead of misreporting it as a network result', async () => {
    const controller = new AbortController();
    const abort = new Error('poll retired');
    const api = createTelegramBotApi({
      token: 'secret-token',
      http: {
        request(_input, options) {
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
          });
        },
      },
    });

    const result = api.getUpdates(
      { offset: '42', limit: 50, timeoutSeconds: 30 },
      { signal: controller.signal },
    );
    controller.abort(abort);
    await expect(result).rejects.toBe(abort);
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
    expect(requests[0]?.timeoutMs).toBeUndefined();
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
      isForum: false,
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
    expect(requests[1]?.timeoutMs).toBeUndefined();
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
      retryAfterMs: 86_401_000,
      diagnostic: 'Too Many Requests',
    });
    await expect(oversizedRateLimitedApi.sendMessage({
      chatId: '123',
      text: 'reply',
      suppressLinkPreview: true,
    })).resolves.toEqual({
      kind: 'notSent',
      retry: 'after',
      retryAfterMs: 86_401_000,
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
