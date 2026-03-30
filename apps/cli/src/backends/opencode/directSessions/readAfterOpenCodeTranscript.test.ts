import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readAfterOpenCodeTranscript } from './readAfterOpenCodeTranscript';
import { encodeOpenCodeDirectAfterCursor } from './openCodeDirectAfterCursor';

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

  it('advances the cursor only past returned items when maxItems truncates the page', async () => {
    const messages: any[] = [
      { id: 'm1', role: 'user', createdAt: '2026-01-01T00:00:00.000Z', parts: [{ type: 'text', text: 'one' }] },
      { id: 'm2', role: 'assistant', createdAt: '2026-01-01T00:00:01.000Z', parts: [{ type: 'text', text: 'two' }] },
      { id: 'm3', role: 'assistant', createdAt: '2026-01-01T00:00:02.000Z', parts: [{ type: 'text', text: 'three' }] },
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

    const first = await readAfterOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      remoteSessionId: 'sess-1',
      cursor: 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 100,
    });

    messages.push(
      { id: 'm4', role: 'assistant', createdAt: '2026-01-01T00:00:03.000Z', parts: [{ type: 'text', text: 'four' }] },
      { id: 'm5', role: 'assistant', createdAt: '2026-01-01T00:00:04.000Z', parts: [{ type: 'text', text: 'five' }] },
    );

    const limited = await readAfterOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      remoteSessionId: 'sess-1',
      cursor: first.nextCursor ?? 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 1,
    });

    expect(limited.items).toHaveLength(1);
    expect(((limited.items[0]?.raw as any)?.content as any)?.data?.message).toBe('four');
    expect(limited.truncated).toBe(true);

    const next = await readAfterOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      remoteSessionId: 'sess-1',
      cursor: limited.nextCursor ?? 'tail',
      maxBytes: 1024 * 1024,
      maxItems: 10,
    });

    expect(next.items).toHaveLength(1);
    expect(((next.items[0]?.raw as any)?.content as any)?.data?.message).toBe('five');
    expect(next.truncated).toBe(false);
  });

  it('respects maxBytes when reading after the cursor', async () => {
    const messages: any[] = [
      { id: 'm1', role: 'assistant', createdAt: '2026-01-01T00:00:00.000Z', parts: [{ type: 'text', text: '12345678901234567890' }] },
      { id: 'm2', role: 'assistant', createdAt: '2026-01-01T00:00:01.000Z', parts: [{ type: 'text', text: 'abcdefghijabcdefghij' }] },
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

    const cursor = encodeOpenCodeDirectAfterCursor({ v: 1, kind: 'opencodeAfter', nextIndex: 0 });

    const after = await readAfterOpenCodeTranscript({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      remoteSessionId: 'sess-1',
      cursor,
      maxBytes: 140,
      maxItems: 100,
    });

    expect(after.items).toHaveLength(1);
    expect(after.truncated).toBe(true);
  });
});
