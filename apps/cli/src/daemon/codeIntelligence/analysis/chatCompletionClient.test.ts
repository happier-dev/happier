import { describe, expect, it } from 'vitest';

import { requestChatCompletion } from './chatCompletionClient';

describe('requestChatCompletion', () => {
  it('keeps the timeout armed until the response body has been read', async () => {
    const stalledFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const result = await requestChatCompletion({
      baseUrl: 'https://provider.example/v1',
      apiKey: null,
      modelId: 'm',
      system: 's',
      user: 'u',
      maxOutputTokens: 10,
      timeoutMs: 50,
      fetchImpl: stalledFetch,
      nowMs: Date.now,
    });

    expect(result).toMatchObject({ ok: false, kind: 'unavailable' });
  });
});
