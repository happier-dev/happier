import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readAfterOpenCodeTranscript } from './readAfterOpenCodeTranscript';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('readAfterOpenCodeTranscript', () => {
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

  it('supports tail cursors and diff-by-index follow', async () => {
    const messages: any[] = [
      { id: 'm1', role: 'user', createdAt: '2026-01-01T00:00:00.000Z', parts: [{ type: 'text', text: 'one' }] },
      { id: 'm2', role: 'assistant', createdAt: '2026-01-01T00:00:01.000Z', parts: [{ type: 'text', text: 'a' }] },
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

    const tail = await readAfterOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      remoteSessionId: 'sess-1',
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(tail.items).toHaveLength(0);
    expect(tail.nextCursor).toBeTruthy();
    expect(tail.truncated).toBe(false);

    messages.push({ id: 'm3', role: 'assistant', createdAt: '2026-01-01T00:00:02.000Z', parts: [{ type: 'text', text: 'b' }] });

    const after = await readAfterOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      remoteSessionId: 'sess-1',
      cursor: tail.nextCursor ?? 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(after.items).toHaveLength(1);
    expect((after.items[0]?.raw as any)?.role).toBe('agent');
    expect(after.truncated).toBe(false);
  });

  it('returns truncated=true when the message list shrinks', async () => {
    let messages: any[] = [
      { id: 'm1', role: 'user', createdAt: '2026-01-01T00:00:00.000Z', parts: [{ type: 'text', text: 'one' }] },
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

    const tail = await readAfterOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      remoteSessionId: 'sess-1',
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    messages = []; // shrink

    const after = await readAfterOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      remoteSessionId: 'sess-1',
      cursor: tail.nextCursor ?? 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    expect(after.items).toHaveLength(0);
    expect(after.truncated).toBe(true);
  });
});

