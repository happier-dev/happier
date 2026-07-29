import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchMessagesPage, fetchSessionsV2 } from '../../src/testkit/sessions';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('testkit: sessions helpers', () => {
  it('rejects malformed message rows with endpoint-aware diagnostics', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          messages: [{ id: 'm1', seq: 'not-a-number' }],
          nextAfterSeq: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as any;

    await expect(
      fetchMessagesPage({
        baseUrl: 'http://localhost:3333',
        token: 'token',
        sessionId: 'session-1',
        afterSeq: 0,
      }),
    ).rejects.toThrow('/v1/sessions/session-1/messages');
  });

  it('includes endpoint context when v2 sessions fetch fails', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as any;

    await expect(fetchSessionsV2('http://localhost:3333', 'token')).rejects.toThrow('/v2/sessions');
  });
});
