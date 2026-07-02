import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';

vi.mock('@/utils/timing/time', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/timing/time')>();
  const immediate = async <T,>(callback: () => Promise<T>): Promise<T> => await callback();
  return {
    ...actual,
    backoff: immediate,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const credentials: AuthCredentials = { token: 't', secret: 's' };

function mockServerConfig() {
  vi.doMock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
      serverId: 'test',
      serverUrl: 'https://api.example.test',
      kind: 'custom',
      generation: 1,
    }),
  }));
}

describe('apiAccountEncryptionMode', () => {
  it('fails closed to e2ee when the server does not implement /v1/account/encryption', async () => {
    mockServerConfig();
    vi.stubGlobal('fetch', (vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/health')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.endsWith('/v1/auth/ping')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.endsWith('/v1/account/encryption')) {
        return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
      }
      throw new Error(`Unexpected fetch to ${url}`);
    })) as unknown as typeof fetch);

    const { fetchAccountEncryptionMode } = await import('./apiAccountEncryptionMode');
    const res = await fetchAccountEncryptionMode(credentials);
    expect(res).toEqual({ mode: 'e2ee', updatedAt: 0 });
  });

  it('coalesces concurrent account-mode GETs for the same server and credentials', async () => {
    mockServerConfig();
    let resolveFetch!: (response: Response) => void;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const serverFetch = vi.fn(async () => await responsePromise);
    vi.doMock('@/sync/http/client', () => ({ serverFetch }));

    const { fetchAccountEncryptionMode } = await import('./apiAccountEncryptionMode');

    const first = fetchAccountEncryptionMode(credentials);
    const second = fetchAccountEncryptionMode(credentials);
    await Promise.resolve();

    expect(serverFetch).toHaveBeenCalledTimes(1);

    resolveFetch(new Response(JSON.stringify({ mode: 'plain', updatedAt: 42 }), { status: 200 }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { mode: 'plain', updatedAt: 42 },
      { mode: 'plain', updatedAt: 42 },
    ]);
  });

  it('does not reuse a cached account mode after updating the account mode', async () => {
    mockServerConfig();
    const serverFetch = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 2 }), { status: 200 });
      }
      return new Response(JSON.stringify({
        mode: serverFetch.mock.calls.filter(([path]) => path === '/v1/account/encryption').length === 1
          ? 'e2ee'
          : 'plain',
        updatedAt: Date.now(),
      }), { status: 200 });
    });
    vi.doMock('@/sync/http/client', () => ({ serverFetch }));

    const { fetchAccountEncryptionMode, updateAccountEncryptionMode } = await import('./apiAccountEncryptionMode');

    await expect(fetchAccountEncryptionMode(credentials)).resolves.toMatchObject({ mode: 'e2ee' });
    await expect(updateAccountEncryptionMode(credentials, 'plain')).resolves.toMatchObject({ mode: 'plain' });
    await expect(fetchAccountEncryptionMode(credentials)).resolves.toMatchObject({ mode: 'plain' });

    const getCalls = serverFetch.mock.calls.filter(([path, init]) =>
      path === '/v1/account/encryption' && (init as RequestInit | undefined)?.method === 'GET',
    );
    expect(getCalls).toHaveLength(2);
  });

  it('does not let a stale in-flight account mode GET repopulate cache after an update invalidates it', async () => {
    mockServerConfig();
    let resolveFirstGet!: (response: Response) => void;
    const firstGetResponse = new Promise<Response>((resolve) => {
      resolveFirstGet = resolve;
    });
    let getCount = 0;
    const serverFetch = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 2 }), { status: 200 });
      }
      getCount += 1;
      if (getCount === 1) {
        return await firstGetResponse;
      }
      return new Response(JSON.stringify({ mode: 'plain', updatedAt: 3 }), { status: 200 });
    });
    vi.doMock('@/sync/http/client', () => ({ serverFetch }));

    const { fetchAccountEncryptionMode, updateAccountEncryptionMode } = await import('./apiAccountEncryptionMode');

    const staleFetch = fetchAccountEncryptionMode(credentials);
    await Promise.resolve();

    await expect(updateAccountEncryptionMode(credentials, 'plain')).resolves.toMatchObject({ mode: 'plain' });

    resolveFirstGet(new Response(JSON.stringify({ mode: 'e2ee', updatedAt: 1 }), { status: 200 }));
    await expect(staleFetch).resolves.toMatchObject({ mode: 'e2ee' });
    await expect(fetchAccountEncryptionMode(credentials)).resolves.toMatchObject({ mode: 'plain', updatedAt: 3 });

    const getCalls = serverFetch.mock.calls.filter(([path, init]) =>
      path === '/v1/account/encryption' && (init as RequestInit | undefined)?.method === 'GET',
    );
    expect(getCalls).toHaveLength(2);
  });
});
