import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertBrowserCanAccessSession } from './assertBrowserCanAccessSession';

function createStorage(initial: Readonly<Record<string, string>>): Storage {
  const entries = new Map(Object.entries(initial));
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}

function createPage(): Pick<Page, 'evaluate'> {
  const localStorage = createStorage({
    'server-profiles:server-state-v1': JSON.stringify({ activeServerId: 'server-a' }),
    'auth_credentials__srv_server-a': JSON.stringify({ token: 'browser-token' }),
  });
  const sessionStorage = createStorage({ activeServerId: 'server-a' });

  return {
    evaluate: async <T,>(fn: () => T): Promise<T> => {
      const originalWindow = globalThis.window;
      vi.stubGlobal('window', { localStorage, sessionStorage });
      try {
        return fn();
      } finally {
        vi.stubGlobal('window', originalWindow);
      }
    },
  };
}

describe('assertBrowserCanAccessSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes when the browser account can read the daemon-created session', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/account/profile')) {
        return new Response(JSON.stringify({ id: 'browser-account' }), { status: 200 });
      }
      if (url.endsWith('/v2/sessions/session-123')) {
        return new Response(JSON.stringify({ session: { id: 'session-123' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      assertBrowserCanAccessSession({
        page: createPage(),
        serverUrl: 'http://127.0.0.1:3000',
        sessionId: 'session-123',
        timeoutMs: 50,
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/v2/sessions/session-123',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer browser-token' }),
      }),
    );
  });

  it('fails with account and session diagnostics when the browser account cannot read the session', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/account/profile')) {
        return new Response(JSON.stringify({ id: 'browser-account' }), { status: 200 });
      }
      if (url.endsWith('/v2/sessions/session-123')) {
        return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    }));

    await expect(
      assertBrowserCanAccessSession({
        page: createPage(),
        serverUrl: 'http://127.0.0.1:3000',
        sessionId: 'session-123',
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/sessionId=session-123.*browserAccountId=browser-account.*sessionStatus=404/s);
  });
});
