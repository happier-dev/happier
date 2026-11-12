import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MANAGED_CONNECTION_POLICY } from '@happier-dev/connection-supervisor';
import { createIrohNodeNativeModule, IrohError } from '@happier-dev/iroh-native/node';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import type { ServerProfile } from '@/server/serverProfiles';
import { adoptServerProfileHomeConnectionDescriptor, getServerProfile, setServerProfileEndpointsById } from '@/server/serverProfiles';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { resolveServerProfileApiUrl } from '@/configuration/serverSelection';
import { captureServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { logger } from '@/ui/logger';

const axiosGet = vi.hoisted(() => vi.fn());
// Axios is the HTTP boundary; its public defaults also back the credential wrapper.
vi.mock('axios', () => ({ default: { get: axiosGet, defaults: {} } }));

import { prepareDaemonHomeIrohTransport } from './daemonHomeIrohTransport';
import { createDaemonMachineIrohRuntime } from './daemonMachineIrohRuntime';

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

let homeDir: string;
let envScope: ReturnType<typeof createEnvKeyScope>;
beforeEach(async () => {
  homeDir = await createTempDir('happier-daemon-startup-profile-');
  envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined,
    HAPPIER_SERVER_URL: undefined, HAPPIER_LOCAL_SERVER_URL: undefined,
    HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
  reloadConfiguration();
  await saveHomeProfile(profile);
});

async function saveHomeProfile(saved: ServerProfile) {
  // Reconnect reads the real saved profile; HTTP and native adapters stay the only substituted boundaries.
  const previous = await getServerProfile(saved.id).catch(() => null);
  await setServerProfileEndpointsById({ id: saved.id, name: saved.name,
    serverUrl: saved.homeConnectionDescriptor?.canonicalServerUrl ?? saved.serverUrl, localServerUrl: saved.localServerUrl,
    webappUrl: saved.webappUrl, use: true });
  if (saved.homeConnectionDescriptor) {
    await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: saved.id,
      descriptor: { ...saved.homeConnectionDescriptor,
        revision: Math.max(saved.homeConnectionDescriptor.revision, (previous?.homeConnectionDescriptor?.revision ?? 0) + 1) },
      observation: 'exact' });
  }
  reloadConfiguration();
}

async function prepareSavedHomeTransport(input: Parameters<typeof prepareDaemonHomeIrohTransport>[0] & { profile: ServerProfile }) {
  await saveHomeProfile(input.profile);
  return await prepareDaemonHomeIrohTransport(input);
}

async function startHomeListener(upstreamAttempt: number) {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_expected' } }, upstreamAttempt }));
  });
  const websocket = new WebSocketServer({ server });
  websocket.on('connection', socket => {
    socket.send(String(upstreamAttempt));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback listener');
  return { server, runtimeOrigin: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  axiosGet.mockReset();
  envScope.restore();
  reloadConfiguration();
  await removeTempDir(homeDir);
});

describe('daemon Home startup verification', () => {
  it('reconsiders Iroh on the existing startup wake when the declared application origin stays unreachable', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => String(url).startsWith('http://qa.localhost:3039/')
      ? new Response('', { status: 503 }) : features()));
    axiosGet.mockResolvedValue({ status: 200 });
    let dials = 0;
    // Substitute only the native OS boundary; startup selection, verification,
    // backoff, and publication use the production composition.
    const runtime = await createDaemonMachineIrohRuntime({ happyHomeDir: '/unused-native-fixture',
      identity: 'ephemeral', relayConfig: { relayPolicy: 'disabled', relayUrls: [] }, native: {
        createEndpoint: async () => ({ endpointHandle: 'startup-recovery', endpointId: 'b'.repeat(64) }),
        getEndpointStatus: async () => ({ active: true, endpointId: 'b'.repeat(64), relayUrls: [], directAddresses: [] }),
        ensureHomeTunnel: async () => {
          dials += 1;
          if (dials === 1) throw new IrohError('transport_timeout', 'Fixture boot-time transport unavailable');
          return { tunnelId: 'recovered', runtimeOrigin: 'http://127.0.0.1:48123', observedPath: 'relay' as const };
        },
        releaseHomeTunnel: async () => undefined,
        shutdownEndpoint: async () => undefined,
      } as never });
    if (!runtime.available) throw new Error('Expected fixture endpoint');
    const shutdown = new AbortController();
    const publish = vi.fn(() => () => undefined);
    const startup = prepareDaemonHomeIrohTransport({ runtime, token: 'fixture-home-token', signal: shutdown.signal,
      applicationCarrierEligibility: 'automatic', publishRuntimeOrigin: publish, profile: { ...profile,
        homeConnectionDescriptor: { ...profile.homeConnectionDescriptor!, endpoints: [
          { kind: 'iroh', endpointId: 'a'.repeat(64) }, { kind: 'https', url: 'http://qa.localhost:3039' },
        ] } } });
    // Observe completion without waiting forever if carrier selection gets stuck on HTTPS.
    let transport: Awaited<typeof startup> | undefined;
    void startup.then(value => { transport = value; }, () => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(publish).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(DEFAULT_MANAGED_CONNECTION_POLICY.initialFastRetryDelayMs);
      expect(dials).toBe(2);
      await vi.waitFor(() => expect(transport?.carrier).toBe('iroh'));
      expect(publish).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(DEFAULT_MANAGED_CONNECTION_POLICY.backoffMaxMs);
      expect(dials).toBe(2);
    } finally {
      shutdown.abort();
      await startup.then(value => value.release(), () => undefined);
      await runtime.shutdown();
    }
  });

  it.each(['iroh', 'https'] as const)('keeps the process-captured Home origin serving after its upstream listener closes (%s replacement)', async replacement => {
    const servers: ReturnType<typeof createServer>[] = [];
    const fallback = replacement === 'https' ? await startHomeListener(2) : null;
    let dials = 0;
    const native = {
      createEndpoint: async () => ({ endpointHandle: 'bridge-owner', endpointId: 'b'.repeat(64) }),
      getEndpointStatus: async () => ({ active: true, endpointId: 'b'.repeat(64), relayUrls: ['https://relay.test/'], directAddresses: [] }),
      ensureHomeTunnel: async () => {
        dials += 1;
        if (dials > 1 && fallback) throw new IrohError('unavailable', 'Fixture Iroh connection closed');
        const { server, runtimeOrigin } = await startHomeListener(dials);
        servers.push(server);
        return { tunnelId: String(servers.length - 1), runtimeOrigin, observedPath: 'relay' as const };
      },
      releaseHomeTunnel: async (id: string) => {
        const server = servers[Number(id)];
        if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      },
      shutdownEndpoint: async () => undefined,
    };
    // Native is the OS boundary. Runtime custody, carrier selection, fresh
    // identity probes, publication, and the captured reader remain real.
    const runtime = await createDaemonMachineIrohRuntime({ happyHomeDir: '/unused-native-fixture',
      identity: 'ephemeral', relayConfig: { relayPolicy: 'automatic', relayUrls: ['https://relay.test/'] }, native: native as never });
    if (!runtime.available) throw new Error('Expected fixture endpoint');
    axiosGet.mockResolvedValue({ status: 200 });
    const tunnelProfile = { ...profile,
      homeConnectionDescriptor: { ...profile.homeConnectionDescriptor!, endpoints: [
        { kind: 'iroh' as const, endpointId: 'a'.repeat(64), relayUrls: ['https://relay.test/'] },
        ...(fallback ? [{ kind: 'https' as const, url: fallback.runtimeOrigin }] : []),
      ] } };
    const home = await prepareDaemonHomeIrohTransport({ runtime, token: 'fixture-token', profile: tunnelProfile,
      readProfile: async () => tunnelProfile });
    const retainedOrigin = resolveServerHttpBaseUrl();
    try {
      const readHome = captureServerHttpBaseUrl();
      const initialOrigin = readHome();
      // In-process requester Account consumers retain this origin for later
      // settings requests across verified carrier replacement.
      if (!retainedOrigin) throw new Error('Expected published process route');
      expect(await (await fetch(`${retainedOrigin}/v1/features`)).json()).toMatchObject({ upstreamAttempt: 1 });
      await expect(home.reacquire()).resolves.toEqual({ status: 'ready' });
      expect(dials).toBe(1);
      expect(readHome()).toBe(initialOrigin);
      await native.releaseHomeTunnel('0');
      const verification = home.verifyAuthenticated('fixture-token');
      await vi.waitFor(() => expect(dials).toBe(2));
      await expect(verification).resolves.toEqual({ status: 'ready' });
      expect(dials).toBe(2);
      expect(home.carrier).toBe(replacement === 'iroh' ? 'iroh' : 'standard');
      expect(readHome()).toBe(initialOrigin);
      expect(resolveServerHttpBaseUrl()).toBe(retainedOrigin);
      expect(await (await fetch(`${retainedOrigin}/v1/features`)).json()).toMatchObject({ upstreamAttempt: 2 });
      expect((await fetch(`${initialOrigin}/v2/account/settings`)).status).toBe(200);
      await expect(home.verifyAuthenticated('fixture-token')).resolves.toEqual({ status: 'ready' });
      expect(dials).toBe(replacement === 'https' ? 3 : 2);
      const socket = new WebSocket(retainedOrigin);
      try {
        const [message] = await once(socket, 'message');
        expect(String(message)).toBe('2');
        const closed = once(socket, 'close');
        await home.release();
        await closed;
      } finally {
        socket.terminate();
      }
    } finally {
      await home.release();
      await runtime.shutdown();
      if (fallback) await new Promise<void>((resolve, reject) => fallback.server.close(error => error ? reject(error) : resolve()));
    }
    await expect(fetch(`${retainedOrigin}/v1/features`)).rejects.toThrow();
  });

  it.each(['transport_closed', 'future_native_closure', 'probe-timeout', 'health-unavailable', 'features-unavailable'] as const)('keeps startup alive on declared HTTPS with one Iroh attempt per acquisition after %s', async code => {
    const fetchMock = vi.fn<typeof fetch>(async url => {
      if (String(url).startsWith('http://127.0.0.1:48123/')) {
        if (code === 'probe-timeout') throw new DOMException('timed out', 'AbortError');
        if (code === 'health-unavailable') return new Response('', { status: 503 });
        return Response.json({ invalid: 'features' });
      }
      return features();
    });
    vi.stubGlobal('fetch', fetchMock);
    axiosGet.mockResolvedValue({ status: 200 });
    const warnings = vi.spyOn(logger, 'warn');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('Unexpected daemon exit'); });
    let dials = 0;
    const ok = (result: unknown) => JSON.stringify({ ok: true, result });
    const endpoint = { endpointHandle: 'startup-endpoint', endpointId: 'b'.repeat(64),
      relayPolicy: 'disabled', relayMode: 'disabled', capProfile: 'machineBulk', relayUrls: [] };
    // The raw native addon is an OS boundary. Its real ABI parser, runtime
    // factory, selection policy, readiness probes and origin publisher run.
    const addon = new Proxy({} as Parameters<typeof createIrohNodeNativeModule>[0], {
      get: (_target, operation) => async () => {
        if (operation === 'createEndpoint') return ok(endpoint);
        if (operation === 'getEndpointStatus') return ok({ ...endpoint, active: true, directAddresses: [] });
        if (operation === 'ensureHomeTunnel') {
          dials += 1;
          if (code !== 'transport_closed' && code !== 'future_native_closure') {
            return ok({ tunnelId: 'startup-tunnel', endpointHandle: endpoint.endpointHandle,
              homeServerIdentityId: 'srv_expected', homeEndpointId: 'a'.repeat(64), carrier: 'iroh',
              runtimeOrigin: 'http://127.0.0.1:48123', observedPath: 'relay', startedAtMs: 1 });
          }
          return JSON.stringify({ ok: false, error: { code, message: 'private-native-closure-detail' } });
        }
        if (operation === 'releaseHomeTunnel') return ok(null);
        if (operation === 'shutdownEndpoint') return ok(null);
        throw new Error(`Unexpected native operation: ${String(operation)}`);
      },
    });
    const runtime = await createDaemonMachineIrohRuntime({ happyHomeDir: '/unused-native-fixture',
      identity: 'ephemeral', relayConfig: { relayPolicy: 'disabled', relayUrls: [] }, native: createIrohNodeNativeModule(addon) });
    if (!runtime.available) throw new Error('Fixture endpoint must initialize');
    try {
      const transport = await prepareSavedHomeTransport({ runtime, token: 'fixture-home-token',
        applicationCarrierEligibility: 'automatic', profile: { ...profile,
          homeConnectionDescriptor: { ...profile.homeConnectionDescriptor!, endpoints: [
            { kind: 'iroh', endpointId: 'a'.repeat(64) }, { kind: 'https', url: 'https://ingress.example.test' },
          ] } } });
      try {
        expect(transport.carrier).toBe('standard');
        expect(resolveServerHttpBaseUrl()).toBe('https://ingress.example.test');
        await expect(transport.verifyAuthenticated('fixture-home-token')).resolves.toEqual({ status: 'ready' });
        expect(axiosGet).toHaveBeenCalledWith('https://ingress.example.test/v1/auth/ping', expect.anything());
        if (code === 'transport_closed' || code === 'future_native_closure') {
          expect(warnings).toHaveBeenCalledWith(expect.any(String), { reason: 'transport_closed_unknown' });
        } else {
          expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('http://127.0.0.1:48123/'))).toHaveLength(2);
        }
        expect(dials).toBe(2);
        expect(exit).not.toHaveBeenCalled();
      } finally { await transport.release(); }
    } finally {
      await runtime.shutdown();
      warnings.mockRestore();
      exit.mockRestore();
    }
  });

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

    const transport = await prepareSavedHomeTransport({
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
    expect(publish).toHaveBeenCalledWith('https://ingress.example.test', 'https', undefined, profile.id);
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
    let observeAuthenticatedAttempt: () => void = () => undefined;
    const authenticatedAttempt = new Promise<void>(resolve => { observeAuthenticatedAttempt = resolve; });
    axiosGet.mockImplementationOnce(async () => {
      observeAuthenticatedAttempt();
      throw new Error('timeout');
    }).mockResolvedValue({ status: 200 });
    const verification = transport.verifyAuthenticated('fresh-token');
    const settled = vi.fn();
    void verification.then(settled, settled);
    await authenticatedAttempt;
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
