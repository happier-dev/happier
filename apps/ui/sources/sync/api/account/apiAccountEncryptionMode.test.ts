import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isServerFetchConnectivityProbeRequest } from '@/dev/testkit/mocks/serverFetch';

// Prepare the real dependency graph during collection. Cache invalidation owns
// per-case isolation; cold module transformation is not part of an HTTP test.
const accountEncryptionMode = await import('./apiAccountEncryptionMode');

afterEach(async () => {
  accountEncryptionMode.invalidateAccountEncryptionModeCache();
  const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
  await resetServerReachabilitySupervisors();
  const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
  await stopAllEndpointSupervisorsForTests();
  vi.unstubAllGlobals();
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
  it.each([{ status: 503, canTryAgain: true }, { status: 400, canTryAgain: false }])(
    'preserves currentness HTTP $status retryability through its error consumer', async ({ status, canTryAgain }) => {
      const { isExplicitlyRetryableError, shouldRetryError } = await import('@/sync/runtime/connectivity/transientConnectivityErrors');
      const error = await accountEncryptionMode.fetchAccountEncryptionCurrentness(credentials, {
        request: async () => Response.json({ error: 'unavailable' }, { status }),
      }).then(() => null, (error: unknown) => error);
      expect(error).toMatchObject({ status, canTryAgain });
      expect(shouldRetryError(error)).toBe(canTryAgain);
      expect(isExplicitlyRetryableError(error)).toBe(canTryAgain);
    });
  it.each([401, 403])('preserves mode-endpoint authorization denial as a typed HTTP %s error', async (status) => {
    const { fetchAccountEncryptionMode } = await import('./apiAccountEncryptionMode');
    await expect(fetchAccountEncryptionMode(credentials, {
      request: async () => Response.json({ error: 'denied' }, { status }),
    })).rejects.toMatchObject({ status, code: status === 401 ? 'unauthorized' : 'forbidden' });
  });

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
    installNetworkBoundary(async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }));

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

  it('does not present a standalone HTTP answer as a live socket observation', async () => {
    const fetchMock = installNetworkBoundary(async () => new Response(JSON.stringify({ mode: 'plain', updatedAt: 42 }), { status: 200 }));

    const { fetchAccountEncryptionMode, getCachedAccountEncryptionMode } = await import('./apiAccountEncryptionMode');

    expect(getCachedAccountEncryptionMode(credentials)).toBeNull();
    await fetchAccountEncryptionMode(credentials);
    expect(getCachedAccountEncryptionMode(credentials)).toBeNull();
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

  it('shares only live mode reads within the same captured request, then reads fresh', async () => {
    const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
    const request = createServerFetchAtEndpoint({ endpointUrl: 'https://captured-mode.test', credentials });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let mode = 'plain';
    const fetchMock = installNetworkBoundary(async () => {
      await pending;
      return Response.json({ mode, updatedAt: 42 });
    });
    const first = accountEncryptionMode.fetchAccountEncryptionMode(credentials, { request, usage: 'identity' });
    const second = accountEncryptionMode.fetchAccountEncryptionMode(credentials, { request, usage: 'identity' });
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { mode: 'plain', updatedAt: 42 }, { mode: 'plain', updatedAt: 42 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    mode = 'e2ee';
    await expect(accountEncryptionMode.fetchAccountEncryptionMode(credentials, { request }))
      .resolves.toEqual({ mode: 'e2ee', updatedAt: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not share captured mode reads across request lifetimes or credential material', async () => {
    const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
    const firstRequest = createServerFetchAtEndpoint({ endpointUrl: 'https://captured-mode.test', credentials });
    const otherRequest = createServerFetchAtEndpoint({ endpointUrl: 'https://captured-mode.test', credentials });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const fetchMock = installNetworkBoundary(async () => {
      await pending;
      return Response.json({ mode: 'plain', updatedAt: 42 });
    });
    const reads = [
      accountEncryptionMode.fetchAccountEncryptionMode(credentials, { request: firstRequest }),
      accountEncryptionMode.fetchAccountEncryptionMode(credentials, { request: otherRequest }),
      accountEncryptionMode.fetchAccountEncryptionMode({ ...credentials, secret: 'another-account-secret' }, { request: firstRequest }),
    ];
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    release();
    await expect(Promise.all(reads)).resolves.toHaveLength(3);
  });

  it('does not join a captured mode read begun before Account invalidation', async () => {
    const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
    const request = createServerFetchAtEndpoint({ endpointUrl: 'https://captured-mode.test', credentials });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const fetchMock = installNetworkBoundary(async () => {
      const previousMode = ++calls === 1;
      await pending;
      return Response.json({ mode: previousMode ? 'plain' : 'e2ee', updatedAt: calls });
    });
    const first = accountEncryptionMode.fetchAccountEncryptionMode(credentials, { request });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    accountEncryptionMode.invalidateAccountEncryptionModeCache();
    const second = accountEncryptionMode.fetchAccountEncryptionMode(credentials, { request });
    // Both reads settle even if a regression incorrectly joins the older read.
    release();
    const results = await Promise.all([first, second]);
    expect(results.map(result => result.mode)).toEqual(['plain', 'e2ee']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares a captured mode denial without caching it or retrying it', async () => {
    const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
    const request = createServerFetchAtEndpoint({ endpointUrl: 'https://captured-mode.test', credentials });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let denied = true;
    const fetchMock = installNetworkBoundary(async () => {
      await pending;
      return denied ? Response.json({ error: 'denied' }, { status: 403 })
        : Response.json({ mode: 'plain', updatedAt: 43 });
    });
    const outcomes = Promise.allSettled([
      accountEncryptionMode.fetchAccountEncryptionMode(credentials, { request, usage: 'identity' }),
      accountEncryptionMode.fetchAccountEncryptionMode(credentials, { request, usage: 'identity' }),
    ]);
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
    release();
    expect(await outcomes).toEqual([0, 1].map(() => ({ status: 'rejected',
      reason: expect.objectContaining({ status: 403, code: 'forbidden', canTryAgain: false }) })));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    denied = false;
    await expect(accountEncryptionMode.fetchAccountEncryptionMode(credentials, { request }))
      .resolves.toEqual({ mode: 'plain', updatedAt: 43 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it.each([undefined, { reason: 'scope-reset' }] as const)(
    'publishes a new cache revision whenever the incumbent mode cache is invalidated (%j)', async (options) => {

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

    invalidateAccountEncryptionModeCache(options);

    expect(revisions).toEqual([initialRevision + 1]);
    expect(getAccountEncryptionModeCacheRevision()).toBe(initialRevision + 1);
    subscription();
  });

  it('publishes scoped revisions only to the affected Home and keeps unknown withdrawals conservative', async () => {
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
    const homeA = getActiveServerSnapshot().serverId;
    const homeB = (await upsertServerProfile({ serverUrl: 'https://mode-revision-other.test' })).id;
    const { getAccountEncryptionModeCacheRevision: revision, invalidateAccountEncryptionModeCache: invalidate,
      subscribeAccountEncryptionModeCacheInvalidation: subscribe } = accountEncryptionMode;
    const settledA = revision(homeA);
    let notificationsA = 0;
    let notificationsB = 0;
    const stopA = subscribe(() => { notificationsA += 1; }, homeA);
    const stopB = subscribe(() => { notificationsB += 1; }, homeB);
    try {
      for (let index = 0; index < 20; index += 1) invalidate({ serverId: homeB, reason: 'transport-withdrawal' });
      expect(revision(homeA)).toBe(settledA);
      expect(notificationsA).toBe(0);
      expect(notificationsB).toBe(20);
      invalidate({ serverId: homeA });
      expect(notificationsA).toBe(1);
      expect(revision(homeA)).toBeGreaterThan(settledA);
      const changedA = revision(homeA);
      invalidate();
      expect(notificationsA).toBe(2);
      expect(notificationsB).toBe(21);
      expect(revision(homeA)).toBeGreaterThan(changedA);
    } finally { stopA(); stopB(); }
  });

  it('withdraws socket identity with the same conservative Home matching as disclosure revisions', async () => {
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { upsertServerProfile, setServerProfileIdentityForUrl, getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
    const { createPlainAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
    const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    await setServerProfileIdentityForUrl('https://api.example.test', 'srv_mode-observed-home');
    const homeA = getActiveServerSnapshot().serverId;
    const homeB = (await upsertServerProfile({ serverUrl: 'https://mode-unidentified-home.test' })).id;
    expect(getServerProfileById(homeA)?.serverIdentityId).toBe('srv_mode-observed-home');
    expect(getServerProfileById(homeB)?.serverIdentityId ?? null).toBeNull();
    let physicalReads = 0;
    const observation = accountEncryptionMode.createSocketAccountEncryptionObservation({
      credentials: { token: createAccountTokenForTests('mode-account') }, serverId: homeA,
      endpointUrl: 'https://api.example.test', runtimeOrigin: 'https://api.example.test', homeCarrierEndpointId: null,
      isCurrent: () => true,
      // The HTTP boundary supplies the real currentness fixture; observation,
      // invalidation routing and identity projection remain real.
      request: async () => Response.json(createPlainAccountEncryptionCurrentnessFixture({ updatedAt: ++physicalReads })),
    });
    try {
      observation.connected();
      await expect(observation.binding.read()).resolves.toMatchObject({ updatedAt: 1 });
      accountEncryptionMode.invalidateAccountEncryptionModeCache({ serverId: homeB });
      await expect(observation.binding.read()).resolves.toMatchObject({ updatedAt: 2 });
      expect(physicalReads).toBe(2);
    } finally { observation.dispose(); }
  });

  it('rejects a stale in-flight account mode GET after an update instead of disclosing or caching it', async () => {
    vi.doUnmock('@/sync/domains/server/serverRuntime');
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    await upsertAndActivateServer({ serverUrl: 'https://mode-update.test', scope: 'tab' });
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

    const staleFetches = Promise.allSettled([
      fetchAccountEncryptionMode(credentials),
      fetchAccountEncryptionMode(credentials),
    ]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await expect(updateAccountEncryptionMode(credentials, 'plain')).resolves.toMatchObject({ mode: 'plain' });

    resolveFirstGet(new Response(JSON.stringify({ mode: 'e2ee', updatedAt: 1 }), { status: 200 }));
    const retired = {
      status: 'rejected',
      reason: expect.objectContaining({
        code: 'account-encryption-mode-read-retired',
        canTryAgain: false,
      }),
    };
    expect(await staleFetches).toEqual([retired, retired]);
    await expect(fetchAccountEncryptionMode(credentials)).resolves.toMatchObject({ mode: 'plain', updatedAt: 3 });

    const getCalls = fetchMock.mock.calls.filter(([path, init]) =>
      new URL(String(path)).pathname === '/v1/account/encryption' && (init as RequestInit | undefined)?.method === 'GET',
    );
    expect(getCalls).toHaveLength(2);
  });
});
