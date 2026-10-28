import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createManagedOpenCodeClientFixture } from './managedOpenCodeClient.testkit';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createOpenCodeServerRuntimeClient (session diff)', () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.HAPPIER_OPENCODE_SERVER_URL;

  let fixture: Awaited<ReturnType<typeof createManagedOpenCodeClientFixture>>;
  beforeEach(async () => {
    fixture = await createManagedOpenCodeClientFixture();
    process.env.HAPPIER_OPENCODE_SERVER_URL = 'http://example.test';
  });

  afterEach(async () => {
    await fixture.close();
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

    const client = await fixture.createClient({
      directory: '',
      messageBuffer: new MessageBuffer(),
    });

    const diff = await client.sessionDiff({ sessionId: 's1', messageId: 'msg_1' });
    expect(diff).toEqual([{ path: 'src/a.ts', diff: 'diff --git a/src/a.ts b/src/a.ts' }]);
    expect(urls.some((url) => url.includes('/session/s1/diff') && url.includes('messageID=msg_1'))).toBe(true);
  });

  it('retries session diff after a transient managed-server fetch failure', async () => {
    delete process.env.HAPPIER_OPENCODE_SERVER_URL;


    const urls: string[] = [];
    let diffAttempts = 0;
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? '');
      urls.push(url);

      if (url.includes('127.0.0.1:9999/global/health')) {
        return jsonResponse({ healthy: true, version: '1.2.15' });
      }

      if (url.includes('127.0.0.1:10000/global/health')) {
        return jsonResponse({ healthy: true, version: '1.2.15' });
      }

      if (url.includes('/session/s1/diff')) {
        diffAttempts += 1;
        if (diffAttempts === 1) {
          await fixture.publish({ baseUrl: 'http://127.0.0.1:10000', ownerToken: 'gen-B', startedAtMs: 2 });
          throw new TypeError('fetch failed');
        }
        return jsonResponse([{ path: 'src/a.ts', diff: 'diff --git a/src/a.ts b/src/a.ts' }]);
      }

      return jsonResponse({});
    }) as any;

    const client = await fixture.createClient({
      directory: '',
      messageBuffer: new MessageBuffer(),
    });

    await expect(client.sessionDiff({ sessionId: 's1', messageId: 'msg_1' })).resolves.toEqual([
      { path: 'src/a.ts', diff: 'diff --git a/src/a.ts b/src/a.ts' },
    ]);

    const diffUrls = urls.filter((url) => url.includes('/session/s1/diff'));
    expect(diffUrls).toEqual([
      expect.stringContaining('127.0.0.1:9999/session/s1/diff'),
      expect.stringContaining('127.0.0.1:10000/session/s1/diff'),
    ]);
  });
});
