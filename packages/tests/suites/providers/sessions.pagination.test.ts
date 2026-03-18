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

  it('includes scope and sidechainId query params when fetching sidechain messages', async () => {
    const fetchSpy = vi.fn(async (_url: string) =>
      new Response(JSON.stringify({ messages: [], nextAfterSeq: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchSpy as any;

    const params = {
      baseUrl: 'http://localhost:1234',
      token: 'token',
      sessionId: 'ses_1',
      afterSeq: 0,
      limit: 50,
      scope: 'sidechain',
      sidechainId: 'sc_1',
    } as const;

    await fetchMessagesPage(params);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String((fetchSpy.mock.calls[0] as [string] | undefined)?.[0] ?? '');
    expect(url).toContain('/v1/sessions/ses_1/messages?');
    expect(url).toContain('afterSeq=0');
    expect(url).toContain('limit=50');
    expect(url).toContain('scope=sidechain');
    expect(url).toContain('sidechainId=sc_1');
  });
});
