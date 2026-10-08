import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isServerFetchConnectivityProbeRequest } from '@/dev/testkit/mocks/serverFetch';

afterEach(async () => {
  const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
  await resetServerReachabilitySupervisors();
  const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
  await stopAllEndpointSupervisorsForTests();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const credentials: AuthCredentials = { token: 't', secret: 's' };

beforeEach(async () => {
  const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
  await upsertAndActivateServer({ serverUrl: 'https://api.example.test' });
});

function installNetworkBoundary(respond: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(respond);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isServerFetchConnectivityProbeRequest(input)) return Response.json({});
    return await fetchMock(input, init);
  });
  return fetchMock;
}

describe('apiAccountEncryptionMode', () => {
  it('reads strict migration currentness without fabricating missing fields', async () => {
    const fetchMock = installNetworkBoundary(async () => new Response(JSON.stringify({
      mode: 'plain',
      version: 17,
      signingKeyFingerprint: null,
      contentKeyFingerprint: null,
      updatedAt: 42,
    }), { status: 200 }));

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
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/account/encryption/currentness',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('refuses migration currentness from an older response instead of defaulting it', async () => {
    const fetchMock = installNetworkBoundary(async () => new Response(JSON.stringify({
      mode: 'plain',
      updatedAt: 42,
    }), { status: 200 }));

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
    const fetchMock = installNetworkBoundary(async () => Response.json({
      mode: 'e2ee', version: 19, signingKeyFingerprint: 'signing-19',
      contentKeyFingerprint: 'content-19', updatedAt: 43,
    }));
    const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
    const request = createServerFetchAtEndpoint({ endpointUrl: 'https://captured.example.test', credentials });
    const { fetchAccountEncryptionCurrentness } = await import('./apiAccountEncryptionMode');
    await expect(fetchAccountEncryptionCurrentness(credentials, { request })).resolves.toMatchObject({
      mode: 'e2ee', version: 19, contentKeyFingerprint: 'content-19',
    });
    expect(fetchMock.mock.calls.every(([input]) => new URL(String(input)).origin === 'https://captured.example.test')).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://captured.example.test/v1/account/encryption/currentness',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('fails closed to e2ee when the server does not implement /v1/account/encryption', async () => {
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

  it('preserves the explicit Account recovery response as a typed recovery error', async () => {
    const fetchMock = installNetworkBoundary(async () => new Response(JSON.stringify({
      error: 'account-encryption-recovery-required',
    }), { status: 400 }));

    const { fetchAccountEncryptionMode } = await import('./apiAccountEncryptionMode');

    await expect(fetchAccountEncryptionMode(credentials)).rejects.toMatchObject({
      status: 400,
      kind: 'server',
      code: 'account-encryption-recovery-required',
    });
  });

  it('keeps a generic migration-required response fail-closed instead of offering Secret Key recovery', async () => {
    const fetchMock = installNetworkBoundary(async () => new Response(JSON.stringify({
      error: 'migration-required',
    }), { status: 400 }));

    const { fetchAccountEncryptionMode } = await import('./apiAccountEncryptionMode');

    await expect(fetchAccountEncryptionMode(credentials)).rejects.toMatchObject({
      status: 400,
      kind: 'server',
    });
    await expect(fetchAccountEncryptionMode(credentials)).rejects.not.toMatchObject({
      code: 'account-encryption-recovery-required',
    });
  });

  it('answers the last read mode synchronously, and nothing before a read', async () => {
    const fetchMock = installNetworkBoundary(async () => new Response(JSON.stringify({ mode: 'plain', updatedAt: 42 }), { status: 200 }));

    const { fetchAccountEncryptionMode, getCachedAccountEncryptionMode } = await import('./apiAccountEncryptionMode');

    expect(getCachedAccountEncryptionMode(credentials)).toBeNull();
    await fetchAccountEncryptionMode(credentials);
    expect(getCachedAccountEncryptionMode(credentials)).toBe('plain');
    // A synchronous read never asks the server.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent account-mode GETs for the same server and credentials', async () => {
    let resolveFetch!: (response: Response) => void;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = installNetworkBoundary(async () => await responsePromise);

    const { fetchAccountEncryptionMode } = await import('./apiAccountEncryptionMode');

    const first = fetchAccountEncryptionMode(credentials);
    const second = fetchAccountEncryptionMode(credentials);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(new Response(JSON.stringify({ mode: 'plain', updatedAt: 42 }), { status: 200 }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { mode: 'plain', updatedAt: 42 },
      { mode: 'plain', updatedAt: 42 },
    ]);
  });

  it('does not coalesce account-mode GETs across distinct credential scopes that share a bearer token', async () => {
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = installNetworkBoundary(() => new Promise<Response>((resolve) => {
      responses.push(resolve);
    }));

    const { fetchAccountEncryptionMode } = await import('./apiAccountEncryptionMode');

    const first = fetchAccountEncryptionMode({
      token: 'shared-bearer-token',
      secret: 'account-a-secret',
    });
    const second = fetchAccountEncryptionMode({
      token: 'shared-bearer-token',
      secret: 'account-b-secret',
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const resolve of responses) {
      resolve(new Response(JSON.stringify({ mode: 'plain', updatedAt: 42 }), { status: 200 }));
    }
    await expect(Promise.all([first, second])).resolves.toEqual([
      { mode: 'plain', updatedAt: 42 },
      { mode: 'plain', updatedAt: 42 },
    ]);
  });

  it('does not reuse a cached account mode after updating the account mode', async () => {
    const fetchMock = installNetworkBoundary(async (_path: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 2 }), { status: 200 });
      }
      return new Response(JSON.stringify({
        mode: fetchMock.mock.calls.filter(([path]) => new URL(String(path)).pathname === '/v1/account/encryption').length === 1
          ? 'e2ee'
          : 'plain',
        updatedAt: Date.now(),
      }), { status: 200 });
    });

    const { fetchAccountEncryptionMode, updateAccountEncryptionMode } = await import('./apiAccountEncryptionMode');

    await expect(fetchAccountEncryptionMode(credentials)).resolves.toMatchObject({ mode: 'e2ee' });
    await expect(updateAccountEncryptionMode(credentials, 'plain')).resolves.toMatchObject({ mode: 'plain' });
    await expect(fetchAccountEncryptionMode(credentials)).resolves.toMatchObject({ mode: 'plain' });

    const getCalls = fetchMock.mock.calls.filter(([path, init]) =>
      new URL(String(path)).pathname === '/v1/account/encryption' && (init as RequestInit | undefined)?.method === 'GET',
    );
    expect(getCalls).toHaveLength(2);
  });

  it('publishes a new cache revision whenever the incumbent mode cache is invalidated', async () => {

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
    let resolveFirstGet!: (response: Response) => void;
    const firstGetResponse = new Promise<Response>((resolve) => {
      resolveFirstGet = resolve;
    });
    let getCount = 0;
    const fetchMock = installNetworkBoundary(async (_path: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 2 }), { status: 200 });
      }
      getCount += 1;
      if (getCount === 1) {
        return await firstGetResponse;
      }
      return new Response(JSON.stringify({ mode: 'plain', updatedAt: 3 }), { status: 200 });
    });

    const { fetchAccountEncryptionMode, updateAccountEncryptionMode } = await import('./apiAccountEncryptionMode');

    const staleFetch = fetchAccountEncryptionMode(credentials);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await expect(updateAccountEncryptionMode(credentials, 'plain')).resolves.toMatchObject({ mode: 'plain' });

    resolveFirstGet(new Response(JSON.stringify({ mode: 'e2ee', updatedAt: 1 }), { status: 200 }));
    await expect(staleFetch).resolves.toMatchObject({ mode: 'e2ee' });
    await expect(fetchAccountEncryptionMode(credentials)).resolves.toMatchObject({ mode: 'plain', updatedAt: 3 });

    const getCalls = fetchMock.mock.calls.filter(([path, init]) =>
      new URL(String(path)).pathname === '/v1/account/encryption' && (init as RequestInit | undefined)?.method === 'GET',
    );
    expect(getCalls).toHaveLength(2);
  });
});
