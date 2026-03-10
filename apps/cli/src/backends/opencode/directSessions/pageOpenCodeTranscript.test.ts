import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pageOpenCodeTranscript } from './pageOpenCodeTranscript';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('pageOpenCodeTranscript', () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.HAPPIER_OPENCODE_SERVER_URL;

  beforeEach(() => {
    process.env.HAPPIER_OPENCODE_SERVER_URL = 'http://example.test';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (typeof originalUrl === 'string') {
      process.env.HAPPIER_OPENCODE_SERVER_URL = originalUrl;
    } else {
      delete process.env.HAPPIER_OPENCODE_SERVER_URL;
    }
  });

  it('pages OpenCode messages from newest backwards', async () => {
    const messages = [
      { id: 'm1', role: 'user', createdAt: '2026-01-01T00:00:00.000Z', parts: [{ type: 'text', text: 'one' }] },
      { id: 'm2', role: 'assistant', createdAt: '2026-01-01T00:00:01.000Z', parts: [{ type: 'text', text: 'a' }] },
      { id: 'm3', role: 'user', createdAt: '2026-01-01T00:00:02.000Z', parts: [{ type: 'text', text: 'two' }] },
      { id: 'm4', role: 'assistant', createdAt: '2026-01-01T00:00:03.000Z', parts: [{ type: 'text', text: 'b' }] },
    ];

    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? '');
      if (url.includes('/global/health')) {
        return jsonResponse({ healthy: true, version: '1.2.17' });
      }
      if (url.includes('/session/sess-1/message')) {
        return jsonResponse(messages);
      }
      return jsonResponse({});
    }) as any;

    const first = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      remoteSessionId: 'sess-1',
      direction: 'older',
      maxBytes: 1024 * 1024,
      maxItems: 2,
    });

    expect(first.items).toHaveLength(2);
    expect(((first.items[0]?.raw as any)?.content as any)?.text).toBe('two');
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect(first.tailCursor).toBeTruthy();

    const second = await pageOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      remoteSessionId: 'sess-1',
      direction: 'older',
      cursor: first.nextCursor ?? undefined,
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(second.items).toHaveLength(2);
    expect(((second.items[0]?.raw as any)?.content as any)?.text).toBe('one');
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });
});
