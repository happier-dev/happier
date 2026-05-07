import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createOpenCodeServerRuntimeClient } from './client';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createOpenCodeServerRuntimeClient session permissions', () => {
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

  it('includes permission ruleset when provided', async () => {
    const seenBodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? '');
      if (url.includes('/global/health')) {
        return jsonResponse({ healthy: true, version: '1.2.15' });
      }
      const pathname = (() => {
        try {
          return new URL(url).pathname;
        } catch {
          return '';
        }
      })();
      if (pathname === '/session' && init?.method === 'POST') {
        const raw = typeof init.body === 'string' ? init.body : '';
        seenBodies.push(raw ? JSON.parse(raw) : null);
        return jsonResponse({ id: 'ses_1', directory: '/repo' });
      }
      return jsonResponse({});
    }) as any;

    const client = await createOpenCodeServerRuntimeClient({
      directory: '/repo',
      messageBuffer: new MessageBuffer(),
    });

    const ruleset = [
      { permission: 'edit', pattern: '../*', action: 'ask' },
      { permission: 'edit', pattern: '*', action: 'allow' },
    ];

    await (client as any).sessionCreate({ permission: ruleset });

    expect(seenBodies).toHaveLength(1);
    expect(seenBodies[0]).toMatchObject({ permission: ruleset });
  });

  it('updates an existing session with the provided permission ruleset', async () => {
    const seenRequests: Array<{ pathname: string; method: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? '');
      if (url.includes('/global/health')) {
        return jsonResponse({ healthy: true, version: '1.2.15' });
      }
      const pathname = (() => {
        try {
          return new URL(url).pathname;
        } catch {
          return '';
        }
      })();
      if (pathname === '/session/ses_1' && init?.method === 'PATCH') {
        const raw = typeof init.body === 'string' ? init.body : '';
        seenRequests.push({ pathname, method: init.method, body: raw ? JSON.parse(raw) : null });
        return jsonResponse({ id: 'ses_1', directory: '/repo' });
      }
      return jsonResponse({});
    }) as typeof fetch;

    const client = await createOpenCodeServerRuntimeClient({
      directory: '/repo',
      messageBuffer: new MessageBuffer(),
    });

    const ruleset = [
      { permission: '*', pattern: '*', action: 'deny' },
      { permission: 'read', pattern: '*', action: 'allow' },
    ];
    await client.sessionUpdate({ sessionId: 'ses_1', permission: ruleset });

    expect(seenRequests).toEqual([
      {
        pathname: '/session/ses_1',
        method: 'PATCH',
        body: { permission: ruleset },
      },
    ]);
  });
});
