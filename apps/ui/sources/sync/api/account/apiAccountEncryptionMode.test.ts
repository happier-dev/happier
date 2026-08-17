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
  vi.doUnmock('@/sync/http/client');
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
  it('reads strict migration currentness without fabricating missing fields', async () => {
    mockServerConfig();
    const serverFetch = vi.fn(async () => new Response(JSON.stringify({
      mode: 'plain',
      version: 17,
      signingKeyFingerprint: null,
      contentKeyFingerprint: null,
      updatedAt: 42,
    }), { status: 200 }));
    vi.doMock('@/sync/http/client', () => ({ serverFetch }));

    const { fetchAccountEncryptionCurrentness } = await import(
      './apiAccountEncryptionMode'
    );

    await expect(fetchAccountEncryptionCurrentness(
      credentials,
    )).resolves.toEqual({
      mode: 'plain',
      version: 17,
      signingKeyFingerprint: null,
      contentKeyFingerprint: null,
      updatedAt: 42,
    });
    expect(serverFetch).toHaveBeenCalledWith(
      '/v1/account/encryption/currentness',
      expect.objectContaining({ method: 'GET' }),
      { includeAuth: false },
    );
  });

  it('refuses migration currentness from an older response instead of defaulting it', async () => {
    mockServerConfig();
    const serverFetch = vi.fn(async () => new Response(JSON.stringify({
      mode: 'plain',
      updatedAt: 42,
    }), { status: 200 }));
    vi.doMock('@/sync/http/client', () => ({ serverFetch }));

    const { fetchAccountEncryptionCurrentness } = await import(
      './apiAccountEncryptionMode'
    );

    await expect(fetchAccountEncryptionCurrentness(
      credentials,
    )).rejects.toMatchObject({
      code: 'account-encryption-currentness-unavailable',
    });
  });

  it('reads currentness through the supplied server-scoped request without consulting active-server transport', async () => {
    mockServerConfig();
    const serverFetch = vi.fn();
    vi.doMock('@/sync/http/client', () => ({ serverFetch }));
    const request = vi.fn(async () => new Response(JSON.stringify({
      mode: 'e2ee',
      version: 19,
      signingKeyFingerprint: 'signing-19',
      contentKeyFingerprint: 'content-19',
      updatedAt: 43,
    }), { status: 200 }));

    const { fetchAccountEncryptionCurrentness } = await import(
      './apiAccountEncryptionMode'
    );

    await expect(fetchAccountEncryptionCurrentness(credentials, {
      request,
    })).resolves.toMatchObject({
      mode: 'e2ee',
      version: 19,
      contentKeyFingerprint: 'content-19',
    });
    expect(request).toHaveBeenCalledWith(
      '/v1/account/encryption/currentness',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(serverFetch).not.toHaveBeenCalled();
  });

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

  it('does not coalesce account-mode GETs across distinct credential scopes that share a bearer token', async () => {
    mockServerConfig();
    const responses: Array<(response: Response) => void> = [];
    const serverFetch = vi.fn(() => new Promise<Response>((resolve) => {
      responses.push(resolve);
    }));
    vi.doMock('@/sync/http/client', () => ({ serverFetch }));

    const { fetchAccountEncryptionMode } = await import('./apiAccountEncryptionMode');

    const first = fetchAccountEncryptionMode({
      token: 'shared-bearer-token',
      secret: 'account-a-secret',
    });
    const second = fetchAccountEncryptionMode({
      token: 'shared-bearer-token',
      secret: 'account-b-secret',
    });
    await Promise.resolve();

    expect(serverFetch).toHaveBeenCalledTimes(2);
    for (const resolve of responses) {
      resolve(new Response(JSON.stringify({ mode: 'plain', updatedAt: 42 }), { status: 200 }));
    }
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

  it('publishes a new cache revision whenever the incumbent mode cache is invalidated', async () => {
    mockServerConfig();
    vi.doMock('@/sync/http/client', () => ({ serverFetch: vi.fn() }));

    const {
      getAccountEncryptionModeCacheRevision,
      invalidateAccountEncryptionModeCache,
      subscribeAccountEncryptionModeCacheInvalidation,
    } = await import('./apiAccountEncryptionMode');
    const revisions: number[] = [];
    const subscription = subscribeAccountEncryptionModeCacheInvalidation(() => {
      revisions.push(getAccountEncryptionModeCacheRevision());
    });
    const initialRevision = getAccountEncryptionModeCacheRevision();

    invalidateAccountEncryptionModeCache();

    expect(revisions).toEqual([initialRevision + 1]);
    expect(getAccountEncryptionModeCacheRevision()).toBe(initialRevision + 1);
    subscription();
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
