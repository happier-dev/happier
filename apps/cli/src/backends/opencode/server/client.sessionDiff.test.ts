import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createOpenCodeServerRuntimeClient } from './client';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createOpenCodeServerRuntimeClient (session diff)', () => {
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

  it('fetches GET /session/:id/diff with messageID when provided', async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? '');
      urls.push(url);

      if (url.includes('/global/health')) {
        return jsonResponse({ healthy: true, version: '1.2.15' });
      }

      if (url.includes('/session/s1/diff')) {
        return jsonResponse([{ path: 'src/a.ts', diff: 'diff --git a/src/a.ts b/src/a.ts' }]);
      }

      return jsonResponse({});
    }) as any;

    const client = await createOpenCodeServerRuntimeClient({
      directory: '',
      messageBuffer: new MessageBuffer(),
    });

    const diff = await client.sessionDiff({ sessionId: 's1', messageId: 'msg_1' });
    expect(diff).toEqual([{ path: 'src/a.ts', diff: 'diff --git a/src/a.ts b/src/a.ts' }]);
    expect(urls.some((url) => url.includes('/session/s1/diff') && url.includes('messageID=msg_1'))).toBe(true);
  });
});
