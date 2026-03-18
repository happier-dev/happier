import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchMessagesPage } from './sessions';

function createFakeResponse(body: unknown, opts?: { status?: number }) {
  const status = opts?.status ?? 200;
  return {
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  } as any;
}

describe('fetchMessagesPage', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('includes scope and sidechainId query params when provided', async () => {
    const fetchSpy = vi.fn(async (_url: string) =>
      createFakeResponse({ messages: [], hasMore: false, nextAfterSeq: null }, { status: 200 }),
    );
    globalThis.fetch = fetchSpy as any;

    await fetchMessagesPage({
      baseUrl: 'http://localhost:1234',
      token: 'token',
      sessionId: 'ses_1',
      afterSeq: 0,
      limit: 50,
      scope: 'sidechain',
      sidechainId: 'sc_1',
    } as any);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('/v1/sessions/ses_1/messages?');
    expect(url).toContain('afterSeq=0');
    expect(url).toContain('limit=50');
    expect(url).toContain('scope=sidechain');
    expect(url).toContain('sidechainId=sc_1');
  });
});
