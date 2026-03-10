import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createOpenCodeServerRuntimeClient } from './client';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createOpenCodeServerRuntimeClient (session list)', () => {
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

  it('fetches GET /session', async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? '');
      urls.push(url);

      if (url.includes('/global/health')) {
        return jsonResponse({ healthy: true, version: '1.2.15' });
      }

      if (url.includes('/session') && !url.includes('/session/status') && !url.includes('/message')) {
        return jsonResponse([{ id: 's1' }, { id: 's2' }]);
      }

      return jsonResponse({});
    }) as any;

    const client = await createOpenCodeServerRuntimeClient({
      directory: '',
      messageBuffer: new MessageBuffer(),
    });

    const sessions = await client.sessionList();
    expect(sessions.map((s) => (s as any).id)).toEqual(['s1', 's2']);

    const sessionUrls = urls.filter((u) => u.includes('/session') && !u.includes('/global/health'));
    expect(sessionUrls.length).toBeGreaterThanOrEqual(1);
    expect((globalThis.fetch as any).mock.calls.find((c: any[]) => String(c[0]).includes('/session'))?.[1]?.method).toBe('GET');
  });
});

