import { afterEach, describe, expect, it, vi } from 'vitest';

import { postEncryptedUiTextMessage } from '../../src/testkit/uiMessages';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('testkit: uiMessages.postEncryptedUiTextMessage', () => {
  it('includes endpoint context on non-2xx responses', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 503 })) as any;

    await expect(
      postEncryptedUiTextMessage({
        baseUrl: 'http://localhost:3333',
        token: 'token',
        sessionId: 'session-1',
        secret: new Uint8Array(32),
        text: 'hello',
      }),
    ).rejects.toThrow('/v2/sessions/session-1/messages');
  });

  it('maps abort-like failures to timeout-aware diagnostics', async () => {
    globalThis.fetch = vi.fn(async () => {
      const err = new Error('aborted');
      (err as any).name = 'AbortError';
      throw err;
    }) as any;

    await expect(
      postEncryptedUiTextMessage({
        baseUrl: 'http://localhost:3333',
        token: 'token',
        sessionId: 'session-1',
        secret: new Uint8Array(32),
        text: 'hello',
        timeoutMs: 25,
      } as any),
    ).rejects.toThrow('timeout');
  });
});
