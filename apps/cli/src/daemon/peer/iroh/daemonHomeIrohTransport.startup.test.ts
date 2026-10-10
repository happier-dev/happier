import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MANAGED_CONNECTION_POLICY } from '@happier-dev/connection-supervisor';
import type { ServerProfile } from '@/server/serverProfiles';
import { resolveServerProfileApiUrl } from '@/configuration/serverSelection';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

const axiosGet = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { get: axiosGet } }));

import { prepareDaemonHomeIrohTransport } from './daemonHomeIrohTransport';

const profile: ServerProfile = {
  id: 'home', name: 'Home', serverUrl: 'https://home.example.test',
  webappUrl: 'https://home.example.test', createdAt: 0, updatedAt: 0, lastUsedAt: 0,
  homeConnectionDescriptor: {
    v: 1, homeServerIdentityId: 'srv_expected', canonicalServerUrl: 'https://home.example.test', revision: 1,
    endpoints: [{ kind: 'https', url: 'https://ingress.example.test' }],
  },
};

function features(identity = 'srv_expected') {
  return new Response(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: identity } } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  axiosGet.mockReset();
});

describe('daemon Home startup verification', () => {
  it.each(['automatic', 'standard_only'] as const)('verifies and publishes the same-Home profile API origin under %s', async (applicationCarrierEligibility) => {
    const forwardedProfile: ServerProfile = {
      ...profile,
      serverUrl: 'https://HOME.example.test:443/',
      localServerUrl: ' http://127.0.0.1:50259/ ',
    };
    const apiUrl = resolveServerProfileApiUrl(forwardedProfile);
    const fetchMock = vi.fn<typeof fetch>(async (url) => features(
      url === `${apiUrl}/v1/features` ? 'srv_expected' : 'srv_wrong',
    ));
    vi.stubGlobal('fetch', fetchMock);
    axiosGet.mockResolvedValue({ status: 200 });

    const transport = await prepareDaemonHomeIrohTransport({
      runtime: null, profile: forwardedProfile, applicationCarrierEligibility,
    });
    try {
      expect(transport.carrier).toBe('standard');
      expect(resolveServerHttpBaseUrl()).toBe(apiUrl);
      expect(axiosGet).not.toHaveBeenCalled();
      await expect(transport.verifyAuthenticated('fixture-home-token')).resolves.toEqual({ status: 'ready' });
      expect(axiosGet).toHaveBeenCalledWith(`${apiUrl}/v1/auth/ping`, expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer fixture-home-token' }),
      }));
      expect(fetchMock.mock.calls.every(([url]) => url === `${apiUrl}/v1/features`)).toBe(true);
    } finally {
      await transport.release();
    }
  });

  it('reacquires the refreshed same-Home local API origin without changing credential authority', async () => {
    const forwardedProfile: ServerProfile = { ...profile, localServerUrl: 'http://127.0.0.1:50259' };
    let currentProfile = forwardedProfile;
    vi.stubGlobal('fetch', vi.fn(async () => features()));
    axiosGet.mockResolvedValue({ status: 200 });
    const transport = await prepareDaemonHomeIrohTransport({
      runtime: null, profile: forwardedProfile, token: 'fixture-home-token',
      readProfile: async () => currentProfile,
    });
    try {
      expect(resolveServerHttpBaseUrl()).toBe(forwardedProfile.localServerUrl);
      currentProfile = { ...forwardedProfile, localServerUrl: 'http://127.0.0.1:50260' };
      await expect(transport.reacquire()).resolves.toEqual({ status: 'ready' });
      expect(resolveServerHttpBaseUrl()).toBe(currentProfile.localServerUrl);
      expect(axiosGet).toHaveBeenLastCalledWith(`${currentProfile.localServerUrl}/v1/auth/ping`, expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer fixture-home-token' }),
      }));
    } finally {
      await transport.release();
    }
  });

  it('keeps the descriptor endpoint when the local URL belongs to a different Home profile', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => features(
      url === 'https://ingress.example.test/v1/features' ? 'srv_expected' : 'srv_wrong',
    ));
    vi.stubGlobal('fetch', fetchMock);
    axiosGet.mockResolvedValue({ status: 200 });
    const transport = await prepareDaemonHomeIrohTransport({
      runtime: null, token: 'fixture-home-token',
      profile: { ...profile, serverUrl: 'https://other-home.example.test', localServerUrl: 'http://127.0.0.1:50259' },
    });
    try {
      expect(resolveServerHttpBaseUrl()).toBe('https://ingress.example.test');
      expect(axiosGet).toHaveBeenCalledWith('https://ingress.example.test/v1/auth/ping', expect.anything());
    } finally {
      await transport.release();
    }
  });

  it.each(['timeout', 'connection_refused', '503'] as const)('waits through %s before publishing a verified Home', async (failure) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        if (failure === '503') return new Response('', { status: 503 });
        throw failure === 'timeout'
          ? new DOMException('timed out', 'AbortError')
          : new TypeError('connection refused');
      })
      .mockImplementation(async () => features());
    vi.stubGlobal('fetch', fetchMock);
    axiosGet.mockResolvedValue({ status: 200 });
    const publish = vi.fn(() => vi.fn());
    const startup = prepareDaemonHomeIrohTransport({ runtime: null, profile, token: 'home-token', publishRuntimeOrigin: publish });
    const settled = vi.fn();
    void startup.then(settled, settled);

    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEFAULT_MANAGED_CONNECTION_POLICY.initialFastRetryDelayMs);
    const transport = await startup;
    expect(transport.carrier).toBe('standard');
    expect(publish).toHaveBeenCalledWith('https://ingress.example.test', 'https');
    expect(fetchMock.mock.calls.every(([url]) => url === 'https://ingress.example.test/v1/features')).toBe(true);
    await transport.release();
    const verifiedAttempts = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(DEFAULT_MANAGED_CONNECTION_POLICY.backoffMaxMs);
    expect(fetchMock).toHaveBeenCalledTimes(verifiedAttempts);
  });

  it.each([undefined, 'http://127.0.0.1:50259'])('refuses a mismatched Home before sending the credential or publishing an origin (local URL: %s)', async (localServerUrl) => {
    const fetchMock = vi.fn(async () => features('srv_wrong'));
    vi.stubGlobal('fetch', fetchMock);
    const publish = vi.fn(() => vi.fn());
    await expect(prepareDaemonHomeIrohTransport({ runtime: null, profile: { ...profile, localServerUrl }, token: 'home-token', publishRuntimeOrigin: publish }))
      .rejects.toThrow(/identity/i);
    expect(fetchMock).toHaveBeenCalledWith(`${localServerUrl ?? 'https://ingress.example.test'}/v1/features`, expect.anything());
    expect(axiosGet).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('retries transient authenticated verification after preparing a pre-auth transport', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => features()));
    const transport = await prepareDaemonHomeIrohTransport({ runtime: null, profile, publishRuntimeOrigin: () => () => undefined });
    axiosGet.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ status: 200 });
    const verification = transport.verifyAuthenticated('fresh-token');
    const settled = vi.fn();
    void verification.then(settled, settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEFAULT_MANAGED_CONNECTION_POLICY.initialFastRetryDelayMs);
    await expect(verification).resolves.toEqual({ status: 'ready' });
    await transport.release();
    const authenticatedAttempts = axiosGet.mock.calls.length;
    await vi.advanceTimersByTimeAsync(DEFAULT_MANAGED_CONNECTION_POLICY.backoffMaxMs);
    expect(axiosGet).toHaveBeenCalledTimes(authenticatedAttempts);
  });

  it('refuses rejected Account authentication without publishing the Home origin', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => features()));
    axiosGet.mockResolvedValue({ status: 403 });
    const publish = vi.fn(() => vi.fn());
    await expect(prepareDaemonHomeIrohTransport({ runtime: null, profile, token: 'home-token', publishRuntimeOrigin: publish }))
      .rejects.toThrow(/403/);
    expect(publish).not.toHaveBeenCalled();
  });

  it('never sends a credential or publishes an origin when TLS verification fails, and cancels its retry on shutdown', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed', {
      cause: Object.assign(new Error('untrusted certificate'), { code: 'CERT_HAS_EXPIRED' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const shutdown = new AbortController();
    const publish = vi.fn(() => vi.fn());
    const startup = prepareDaemonHomeIrohTransport({ runtime: null, profile, token: 'home-token', signal: shutdown.signal, publishRuntimeOrigin: publish });
    const rejected = expect(startup).rejects.toThrow(/released/);
    await vi.advanceTimersByTimeAsync(DEFAULT_MANAGED_CONNECTION_POLICY.initialFastRetryDelayMs);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(publish).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();
    shutdown.abort();
    await rejected;
    const attemptsBeforeShutdown = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(DEFAULT_MANAGED_CONNECTION_POLICY.backoffMaxMs);
    expect(fetchMock).toHaveBeenCalledTimes(attemptsBeforeShutdown);
    expect(publish).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('cancels an in-flight identity request on shutdown without publishing its late success', async () => {
    vi.useFakeTimers();
    let respond: (response: Response) => void = () => undefined;
    const requestSignals: NonNullable<NonNullable<Parameters<typeof fetch>[1]>['signal']>[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => await new Promise<Response>((resolve) => {
      if (init?.signal) requestSignals.push(init.signal);
      respond = resolve;
    })));
    const shutdown = new AbortController();
    const publish = vi.fn(() => vi.fn());
    const startup = prepareDaemonHomeIrohTransport({ runtime: null, profile, token: 'home-token', signal: shutdown.signal, publishRuntimeOrigin: publish });
    const rejected = expect(startup).rejects.toThrow(/released/);
    await vi.advanceTimersByTimeAsync(0);
    shutdown.abort();
    await rejected;
    // This network boundary deliberately ignores abort and supplies a late reply.
    // Neither that reply nor a stopped supervisor may publish the runtime origin.
    expect(requestSignals[0]?.aborted).toBe(true);
    respond(features());
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEFAULT_MANAGED_CONNECTION_POLICY.backoffMaxMs);
    expect(publish).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('settles pending authenticated verification and stops backoff when the transport is released', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => features()));
    const unpublish = vi.fn();
    const transport = await prepareDaemonHomeIrohTransport({ runtime: null, profile, publishRuntimeOrigin: () => unpublish });
    axiosGet.mockRejectedValue(new Error('connection refused'));
    const verification = transport.verifyAuthenticated('fresh-token');
    await vi.advanceTimersByTimeAsync(0);
    await transport.release();
    await expect(verification).resolves.toMatchObject({ status: 'server_unreachable' });
    expect(unpublish).toHaveBeenCalledOnce();
    const authenticatedAttempts = axiosGet.mock.calls.length;
    await vi.advanceTimersByTimeAsync(DEFAULT_MANAGED_CONNECTION_POLICY.backoffMaxMs);
    expect(axiosGet).toHaveBeenCalledTimes(authenticatedAttempts);
  });
});
