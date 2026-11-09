import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol';
import { classifyIrohHomeCarrierFailure, createNodeIrohHomeTunnelSession, IrohError } from '@happier-dev/iroh-native/node';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';

import { acquireTerminalAuthEnrollmentRuntime } from './terminalAuthEnrollmentRuntime';

type NodeIrohNativeModule = NonNullable<Parameters<typeof createNodeIrohHomeTunnelSession>[0]['native']>;

const DESCRIPTOR = HomeConnectionDescriptorV1Schema.parse({
  v: 1,
  homeServerIdentityId: 'srv_home_runtime',
  canonicalServerUrl: 'https://home.example.test',
  revision: 1,
  endpoints: [
    { kind: 'https', url: 'https://home.example.test' },
    { kind: 'iroh', endpointId: 'a'.repeat(64) },
  ],
});

function nativeEnrollmentBoundary(failure?: IrohError): NodeIrohNativeModule {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected native operation'); };
  return {
    getAvailability: () => { throw new Error('Unexpected availability read'); },
    startHomeAcceptor: unexpected, stopHomeAcceptor: unexpected,
    getEndpointStatus: unexpected, getTunnelStatus: unexpected,
    startMachineAcceptor: unexpected, stopMachineAcceptor: unexpected,
    getMachineAcceptorStatus: unexpected, startMachineTunnel: unexpected,
    startMachineHttpTunnel: unexpected, stopMachineTunnel: unexpected, getMachineTunnelStatus: unexpected,
    createEndpoint: vi.fn(async input => ({ endpointHandle: 'account-client', endpointId: 'b'.repeat(64),
      relayPolicy: input.relayPolicy, relayMode: input.relayUrls?.length ? 'custom' as const : 'disabled' as const,
      capProfile: 'homeInteractive' as const, relayUrls: input.relayUrls ?? [] })),
    ensureHomeTunnel: vi.fn(async () => {
      if (failure) throw failure;
      return { tunnelId: 'home-tunnel', endpointHandle: 'account-client',
        homeServerIdentityId: DESCRIPTOR.homeServerIdentityId, homeEndpointId: 'a'.repeat(64),
        runtimeOrigin: 'http://127.0.0.1:48123', observedPath: 'direct' as const,
        carrier: 'iroh' as const, startedAtMs: 1 };
    }),
    releaseHomeTunnel: vi.fn(async () => undefined), shutdownEndpoint: vi.fn(async () => undefined),
  };
}

const GUEST_DESCRIPTOR = HomeConnectionDescriptorV1Schema.parse({
  ...DESCRIPTOR,
  canonicalServerUrl: 'http://happier-agent-qa-l12-c.localhost:3039',
  endpoints: [
    { kind: 'https', url: 'http://happier-agent-qa-l12-c.localhost:3039' },
    { kind: 'iroh', endpointId: 'a'.repeat(64) },
  ],
});

/** The declared origin at the fetch boundary; real feature parsing and selection run above it. */
function serveHomeFeatures(identity: string | null = DESCRIPTOR.homeServerIdentityId) {
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => identity === null
    ? new Response('', { status: 503 })
    : new Response(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: identity } } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('acquireTerminalAuthEnrollmentRuntime', () => {
  const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_HOME_CARRIER_POLICY',
    'HAPPIER_IROH_RELAY_POLICY', 'HAPPIER_IROH_RELAY_URLS'] as const);

  beforeEach(() => {
    envScope.patch({ HAPPIER_HOME_CARRIER_POLICY: 'automatic',
      HAPPIER_IROH_RELAY_POLICY: undefined, HAPPIER_IROH_RELAY_URLS: undefined });
    serveHomeFeatures();
  });

  afterEach(() => {
    envScope.restore();
    vi.unstubAllGlobals();
  });

  it.each([
    ['reports another Home', 'srv_other_home', 'fail_closed', 'identity_mismatch'],
    ['cannot prove a Home', null, 'unavailable', 'unavailable'],
  ] as const)('refuses a declared HTTPS origin that %s before any credential can reach it', async (_name, identity, reason, code) => {
    const fetchMock = serveHomeFeatures(identity);
    const native = nativeEnrollmentBoundary(new IrohError('home_unreachable', 'private-native-detail'));

    const acquired = await acquireTerminalAuthEnrollmentRuntime(GUEST_DESCRIPTOR, {
      createSession: async input => await createNodeIrohHomeTunnelSession({ ...input, native }),
      classifyFailure: classifyIrohHomeCarrierFailure,
    });

    expect(acquired).toMatchObject({ ok: false, reason, carrierFailure: { attemptedCarrier: 'https', reason: code,
      irohAttempt: { outcome: 'unavailable', reason: 'home_unreachable' } } });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([`${GUEST_DESCRIPTOR.canonicalServerUrl}/v1/features`]);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has('Authorization')).toBe(false);
    expect(native.shutdownEndpoint).toHaveBeenCalledOnce();
  });

  it('proves a Standard-only declared HTTPS origin from the same public read', async () => {
    envScope.patch({ HAPPIER_HOME_CARRIER_POLICY: 'standard_only' });
    const fetchMock = serveHomeFeatures('srv_other_home');
    const createSession = vi.fn();

    await expect(acquireTerminalAuthEnrollmentRuntime(DESCRIPTOR, {
      createSession, classifyFailure: () => ({ fallbackAllowed: false }),
    })).resolves.toMatchObject({ ok: false, reason: 'fail_closed' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(createSession).not.toHaveBeenCalled();
  });

  it.each([undefined, 'home_unreachable', 'transport_timeout', 'transport_closed', 'transport', 'unknown', 'invalid_preamble', 'unsupported_alpn', 'endpoint_config_conflict'] as const)(
    'acquires a direct-only guest Home or falls back before acquisition (%s)', async code => {
      envScope.patch({ HAPPIER_HOME_CARRIER_POLICY: 'automatic' });
      // Only the native OS boundary is substituted; selection, session and classifier stay real.
      const native = nativeEnrollmentBoundary(code ? new IrohError(code, 'private-native-detail') : undefined);
      const acquired = await acquireTerminalAuthEnrollmentRuntime(GUEST_DESCRIPTOR, {
        createSession: async input => await createNodeIrohHomeTunnelSession({ ...input, native }),
        classifyFailure: classifyIrohHomeCarrierFailure,
      });
      expect(acquired).toMatchObject({ ok: true, runtime: code
        ? { carrier: 'https', runtimeOrigin: GUEST_DESCRIPTOR.canonicalServerUrl,
          irohAttempt: { outcome: 'unavailable', reason: code } }
        : { carrier: 'iroh', runtimeOrigin: 'http://127.0.0.1:48123' } });
      expect(native.ensureHomeTunnel).toHaveBeenCalledOnce();
      if (acquired.ok) await acquired.close();
      expect(native.shutdownEndpoint).toHaveBeenCalledOnce();
    },
  );

  it('configures the finite Account endpoint with the declared Home relay before dialing', async () => {
    envScope.patch({ HAPPIER_HOME_CARRIER_POLICY: 'automatic' });
    const native = nativeEnrollmentBoundary();
    const relayed = HomeConnectionDescriptorV1Schema.parse({ ...GUEST_DESCRIPTOR, endpoints: [
      GUEST_DESCRIPTOR.endpoints[0], { kind: 'iroh', endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test/'] },
    ] });
    const acquired = await acquireTerminalAuthEnrollmentRuntime(relayed, {
      createSession: async input => await createNodeIrohHomeTunnelSession({ ...input, native }),
      classifyFailure: classifyIrohHomeCarrierFailure,
    });
    try {
      expect(acquired.ok).toBe(true);
      expect(native.createEndpoint).toHaveBeenCalledWith(expect.objectContaining({ relayUrls: ['https://relay.example.test/'] }));
      expect(native.ensureHomeTunnel).toHaveBeenCalledWith(expect.objectContaining({ relayUrls: ['https://relay.example.test/'] }));
    } finally { if (acquired.ok) await acquired.close(); }
  });

  it('honors an explicit direct-only relay policy even when Home advertises a relay', async () => {
    envScope.patch({ HAPPIER_IROH_RELAY_POLICY: 'disabled' });
    const native = nativeEnrollmentBoundary();
    const relayed = HomeConnectionDescriptorV1Schema.parse({ ...GUEST_DESCRIPTOR, endpoints: [
      GUEST_DESCRIPTOR.endpoints[0], { kind: 'iroh', endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test/'] },
    ] });
    const acquired = await acquireTerminalAuthEnrollmentRuntime(relayed, {
      createSession: async input => await createNodeIrohHomeTunnelSession({ ...input, native }),
      classifyFailure: classifyIrohHomeCarrierFailure,
    });
    try {
      expect(acquired.ok).toBe(true);
      expect(native.createEndpoint).toHaveBeenCalledWith({ relayPolicy: 'disabled', capProfile: 'homeInteractive' });
    } finally { if (acquired.ok) await acquired.close(); }
  });

  it.each([
    { HAPPIER_IROH_RELAY_POLICY: 'invalid' },
    { HAPPIER_IROH_RELAY_URLS: 'not-a-url' },
    { HAPPIER_IROH_RELAY_URLS: 'https://relay.example.test,,https://other.example.test' },
    { HAPPIER_IROH_RELAY_POLICY: 'disabled', HAPPIER_IROH_RELAY_URLS: 'https://relay.example.test' },
  ])('keeps invalid relay configuration out of native acquisition and uses declared HTTPS (%j)', async env => {
    envScope.patch(env);
    const native = nativeEnrollmentBoundary();
    const acquired = await acquireTerminalAuthEnrollmentRuntime(GUEST_DESCRIPTOR, {
      createSession: async input => await createNodeIrohHomeTunnelSession({ ...input, native }),
      classifyFailure: classifyIrohHomeCarrierFailure,
    });
    try {
      expect(acquired).toMatchObject({ ok: true,
        runtime: { carrier: 'https', runtimeOrigin: GUEST_DESCRIPTOR.canonicalServerUrl } });
      expect(native.createEndpoint).not.toHaveBeenCalled();
      expect(native.ensureHomeTunnel).not.toHaveBeenCalled();
    } finally { if (acquired.ok) await acquired.close(); }
  });

  it.each(['identity_mismatch', 'relay_auth_failed', 'invalid_descriptor'] as const)(
    'retains the attempted carrier and closed %s reason without retargeting', async code => {
      const native = nativeEnrollmentBoundary(new IrohError(code, 'private-native-detail'));
      const acquired = await acquireTerminalAuthEnrollmentRuntime(GUEST_DESCRIPTOR, {
        createSession: async input => await createNodeIrohHomeTunnelSession({ ...input, native }),
        classifyFailure: classifyIrohHomeCarrierFailure,
      });
      expect(acquired).toMatchObject({ ok: false, reason: 'fail_closed',
        carrierFailure: { attemptedCarrier: 'iroh', reason: code } });
      expect(native.ensureHomeTunnel).toHaveBeenCalledOnce();
      expect(native.shutdownEndpoint).toHaveBeenCalledOnce();
    },
  );

  it('uses declared HTTPS when a previously proven daemon carrier is unavailable for enrollment', async () => {
    const native = nativeEnrollmentBoundary(new IrohError('home_unreachable', 'private-native-detail'));
    const session = await createNodeIrohHomeTunnelSession({ native, keylessEndpoint: 'account_client' });
    const unpublish = publishServerHttpRuntimeOrigin('http://127.0.0.1:48123', 'iroh', {
      descriptor: GUEST_DESCRIPTOR, acquire: async () => await session.ensureHomeTunnel({ descriptor: GUEST_DESCRIPTOR }),
    });
    try {
      const acquired = await acquireTerminalAuthEnrollmentRuntime(GUEST_DESCRIPTOR);
      expect(acquired).toMatchObject({ ok: true,
        runtime: { carrier: 'https', runtimeOrigin: GUEST_DESCRIPTOR.canonicalServerUrl } });
      if (acquired.ok) await acquired.close();
    } finally { unpublish(); await session.shutdown(); }
  });

  it('uses the standard Home application endpoint without creating an Iroh session when Standard only is configured', async () => {
    envScope.patch({ HAPPIER_HOME_CARRIER_POLICY: 'standard_only' });
    const createSession = vi.fn();
    const acquired = await acquireTerminalAuthEnrollmentRuntime(DESCRIPTOR, {
      createSession,
      classifyFailure: () => ({ fallbackAllowed: false }),
    });

    expect(acquired).toMatchObject({ ok: true, runtime: { carrier: 'https', runtimeOrigin: 'https://home.example.test' } });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('uses fresh Account-client identities for independent terminal auth acquisitions', async () => {
    const homeDir = join(process.cwd(), '.tmp-terminal-auth-identity');
    envScope.patch({ HAPPIER_HOME_DIR: homeDir });
    // The native addon is the OS boundary; keep the real session owner underneath.
    // Like the native manager, keyed endpoints share identity; keyless ones do not.
    const origins = new Map<string, string>();
    const activeOrigins = new Set<string>();
    let nextEndpoint = 0;
    const unusedNativeOperation = async (): Promise<never> => { throw new Error('Unexpected native operation'); };
    const native = {
      getAvailability: (): never => { throw new Error('Unexpected availability read'); },
      startHomeAcceptor: unusedNativeOperation, stopHomeAcceptor: unusedNativeOperation,
      getEndpointStatus: unusedNativeOperation, getTunnelStatus: unusedNativeOperation,
      startMachineAcceptor: unusedNativeOperation, stopMachineAcceptor: unusedNativeOperation,
      getMachineAcceptorStatus: unusedNativeOperation, startMachineTunnel: unusedNativeOperation,
      startMachineHttpTunnel: unusedNativeOperation, stopMachineTunnel: unusedNativeOperation,
      getMachineTunnelStatus: unusedNativeOperation,
      createEndpoint: async ({ keyPath }: Readonly<{ keyPath?: string }>) => {
        const endpointHandle = keyPath ?? `helper-${++nextEndpoint}`;
        const runtimeOrigin = origins.get(endpointHandle) ?? `http://127.0.0.1:${48123 + origins.size}`;
        origins.set(endpointHandle, runtimeOrigin);
        activeOrigins.add(runtimeOrigin);
        return { endpointHandle, endpointId: 'b'.repeat(64), relayPolicy: 'automatic' as const,
          relayMode: 'custom' as const, capProfile: 'account_client', relayUrls: [] };
      },
      ensureHomeTunnel: async ({ endpointHandle }: Readonly<{ endpointHandle: string }>) => ({
        tunnelId: `tunnel-${endpointHandle}`, endpointHandle,
        homeServerIdentityId: DESCRIPTOR.homeServerIdentityId,
        homeEndpointId: 'a'.repeat(64), runtimeOrigin: origins.get(endpointHandle)!, observedPath: 'relay' as const,
        carrier: 'iroh' as const, startedAtMs: 1,
      }),
      releaseHomeTunnel: async () => undefined,
      shutdownEndpoint: async ({ endpointHandle }: Readonly<{ endpointHandle: string }>) => {
        activeOrigins.delete(origins.get(endpointHandle)!);
      },
    } satisfies NodeIrohNativeModule;
    const createSession = vi.fn(async (input: Readonly<{ keylessEndpoint: 'account_client' }>) =>
      await createNodeIrohHomeTunnelSession({ ...input, native }),
    );
    const deps = {
      createSession,
      classifyFailure: () => ({ fallbackAllowed: false }),
    };

    const first = await acquireTerminalAuthEnrollmentRuntime(DESCRIPTOR, deps);
    if (!first.ok) throw new Error('expected first acquired runtime');
    const second = await acquireTerminalAuthEnrollmentRuntime(DESCRIPTOR, deps);
    if (!second.ok) throw new Error('expected second acquired runtime');
    try {
      expect(first.runtime.runtimeOrigin).not.toBe(second.runtime.runtimeOrigin);
      await first.close();
      expect(activeOrigins.has(second.runtime.runtimeOrigin)).toBe(true);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('projects an Iroh-first lease into an explicit authenticated enrollment runtime', async () => {
    const release = vi.fn(async () => {});
    const shutdown = vi.fn(async () => {});
    const acquired = await acquireTerminalAuthEnrollmentRuntime(DESCRIPTOR, {
      createSession: async () => ({
        ensureHomeTunnel: async () => ({
          homeServerIdentityId: DESCRIPTOR.homeServerIdentityId,
          endpointId: 'a'.repeat(64),
          runtimeOrigin: 'http://127.0.0.1:48123',
          observedPath: 'relay' as const,
          status: 'ready' as const,
          release,
        }),
        shutdown,
      }),
      classifyFailure: () => ({ fallbackAllowed: false }),
    });

    expect(acquired.ok && acquired.runtime).toEqual({
      runtimeOrigin: 'http://127.0.0.1:48123',
      carrier: 'iroh',
      authenticatedCredentialDestination: { kind: 'iroh', endpointId: 'a'.repeat(64) },
    });
    if (!acquired.ok) throw new Error('expected acquired runtime');
    await acquired.close();
    expect(release).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('threads caller cancellation into the native Home tunnel acquisition boundary', async () => {
    const controller = new AbortController();
    const observedSignals: Array<AbortSignal | undefined> = [];
    const acquired = await acquireTerminalAuthEnrollmentRuntime(DESCRIPTOR, {
      createSession: async () => ({
        ensureHomeTunnel: async (input) => {
          observedSignals.push(input.signal);
          return {
            homeServerIdentityId: DESCRIPTOR.homeServerIdentityId,
            endpointId: 'a'.repeat(64),
            runtimeOrigin: 'http://127.0.0.1:48123',
            observedPath: 'relay' as const,
            status: 'ready' as const,
            release: async () => undefined,
          };
        },
        shutdown: async () => undefined,
      }),
      classifyFailure: () => ({ fallbackAllowed: false }),
    }, controller.signal);

    expect(acquired.ok).toBe(true);
    expect(observedSignals).toEqual([controller.signal]);
    if (acquired.ok) await acquired.close();
  });

  it('always shuts down the native session when lease release fails', async () => {
    const releaseFailure = new Error('release failed');
    const release = vi.fn(async () => { throw releaseFailure; });
    const shutdown = vi.fn(async () => {});
    const acquired = await acquireTerminalAuthEnrollmentRuntime(DESCRIPTOR, {
      createSession: async () => ({
        ensureHomeTunnel: async () => ({
          homeServerIdentityId: DESCRIPTOR.homeServerIdentityId,
          endpointId: 'a'.repeat(64),
          runtimeOrigin: 'http://127.0.0.1:48123',
          observedPath: 'relay' as const,
          status: 'ready' as const,
          release,
        }),
        shutdown,
      }),
      classifyFailure: () => ({ fallbackAllowed: false }),
    });

    if (!acquired.ok) throw new Error('expected acquired runtime');
    await expect(acquired.close()).rejects.toBe(releaseFailure);
    expect(release).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('reports both lease release and session shutdown failures after settling both', async () => {
    const releaseFailure = new Error('release failed');
    const shutdownFailure = new Error('shutdown failed');
    const acquired = await acquireTerminalAuthEnrollmentRuntime(DESCRIPTOR, {
      createSession: async () => ({
        ensureHomeTunnel: async () => ({
          homeServerIdentityId: DESCRIPTOR.homeServerIdentityId,
          endpointId: 'a'.repeat(64),
          runtimeOrigin: 'http://127.0.0.1:48123',
          observedPath: 'relay' as const,
          status: 'ready' as const,
          release: async () => { throw releaseFailure; },
        }),
        shutdown: async () => { throw shutdownFailure; },
      }),
      classifyFailure: () => ({ fallbackAllowed: false }),
    });

    if (!acquired.ok) throw new Error('expected acquired runtime');
    const failure = await acquired.close().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([releaseFailure, shutdownFailure]);
  });

  it('uses exact descriptor HTTPS only when policy authorizes fallback', async () => {
    const shutdown = vi.fn(async () => {});
    const acquired = await acquireTerminalAuthEnrollmentRuntime(DESCRIPTOR, {
      createSession: async () => ({
        ensureHomeTunnel: async () => { throw new Error('unavailable'); },
        shutdown,
      }),
      classifyFailure: () => ({ fallbackAllowed: true }),
    });

    expect(acquired.ok && acquired.runtime).toEqual({
      runtimeOrigin: 'https://home.example.test',
      carrier: 'https',
      irohAttempt: { outcome: 'unavailable', reason: 'unknown' },
      authenticatedCredentialDestination: {
        kind: 'https',
        applicationUrl: 'https://home.example.test',
      },
    });
    if (!acquired.ok) throw new Error('expected fallback runtime');
    await acquired.close();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('returns fail-closed and shuts down the native session when policy refuses fallback', async () => {
    const shutdown = vi.fn(async () => {});
    const acquired = await acquireTerminalAuthEnrollmentRuntime(DESCRIPTOR, {
      createSession: async () => ({
        ensureHomeTunnel: async () => { throw new Error('identity mismatch'); },
        shutdown,
      }),
      classifyFailure: () => ({ fallbackAllowed: false }),
    });

    expect(acquired).toMatchObject({ ok: false, reason: 'fail_closed' });
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
