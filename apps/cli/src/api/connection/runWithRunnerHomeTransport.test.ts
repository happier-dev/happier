import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol';
import { createNodeIrohHomeTunnelSession, IrohError } from '@happier-dev/iroh-native/node';

import { configuration, reloadConfiguration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { resolveServerHttpBaseUrl, resolveServerSocketIoTransports } from '@/api/client/serverHttpBaseUrl';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { seedTestServerProfile } from '@/testkit/serverProfiles';

import { runWithRunnerHomeTransport } from './runWithRunnerHomeTransport';

type NativeModule = NonNullable<Parameters<typeof createNodeIrohHomeTunnelSession>[0]['native']>;
const nativeBoundary = vi.hoisted(() => ({ current: null as NativeModule | null }));

// The addon is the OS/network boundary. Keep the default session factory,
// Home identity verification, carrier policy, and settings resolution real.
vi.mock('@happier-dev/iroh-native/node', async importOriginal => {
  const original = await importOriginal<typeof import('@happier-dev/iroh-native/node')>();
  return { ...original,
    createNodeIrohHomeTunnelSession: async (input: Parameters<typeof original.createNodeIrohHomeTunnelSession>[0]) => {
      if (!nativeBoundary.current) throw new Error('Native boundary fixture is not installed');
      return await original.createNodeIrohHomeTunnelSession({ ...input, native: nativeBoundary.current });
    },
  };
});

const SERVER_ID = 'runner-home';
const DESCRIPTOR = HomeConnectionDescriptorV1Schema.parse({
  v: 1,
  homeServerIdentityId: 'srv_runner_home',
  canonicalServerUrl: 'https://runner-home.example.test',
  revision: 1,
  endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }],
});

function createNativeBoundary() {
  let nextEndpoint = 0;
  let failure: IrohError | null = null;
  let reportedHomeId = DESCRIPTOR.homeServerIdentityId;
  let reportedEndpointId = 'a'.repeat(64);
  const endpoints = new Set<string>();
  const listeners = new Map<string, { server: Server; origin: string; endpointHandle: string }>();
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected native operation'); };
  const closeListener = async (tunnelId: string) => {
    const listener = listeners.get(tunnelId);
    if (!listener) return;
    await new Promise<void>((resolve, reject) => {
      listener.server.close(error => error ? reject(error) : resolve());
      listener.server.closeAllConnections();
    });
    listeners.delete(tunnelId);
  };
  const native = {
    getAvailability: (): never => { throw new Error('Unexpected availability read'); },
    startHomeAcceptor: unexpected, stopHomeAcceptor: unexpected,
    getEndpointStatus: unexpected, getTunnelStatus: unexpected,
    startMachineAcceptor: unexpected, stopMachineAcceptor: unexpected,
    getMachineAcceptorStatus: unexpected, startMachineTunnel: unexpected,
    startMachineHttpTunnel: unexpected, stopMachineTunnel: unexpected, getMachineTunnelStatus: unexpected,
    createEndpoint: async (input) => {
      const endpointHandle = `endpoint-${++nextEndpoint}`;
      endpoints.add(endpointHandle);
      return { endpointHandle, endpointId: nextEndpoint.toString(16).padStart(64, '0'),
        relayPolicy: input.relayPolicy ?? 'automatic', relayMode: 'disabled' as const,
        capProfile: 'homeInteractive' as const, relayUrls: [] };
    },
    ensureHomeTunnel: async (input) => {
      if (failure) throw failure;
      // This substitutes the native tunnel's loopback HTTP listener only. It
      // intentionally exposes public features, not synthetic Session/RPC routes.
      const server = createServer((request, response) => {
        if (request.url !== '/v1/features') { response.writeHead(404).end(); return; }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ features: {}, capabilities: {
          serverIdentity: { serverIdentityId: DESCRIPTOR.homeServerIdentityId },
        } }));
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected native fixture TCP address');
      const runtimeOrigin = `http://127.0.0.1:${address.port}`;
      const tunnelId = `tunnel-${input.endpointHandle}`;
      listeners.set(tunnelId, { server, origin: runtimeOrigin, endpointHandle: input.endpointHandle });
      return { tunnelId, endpointHandle: input.endpointHandle,
        homeServerIdentityId: reportedHomeId, homeEndpointId: reportedEndpointId,
        runtimeOrigin, observedPath: 'direct' as const, carrier: 'iroh' as const, startedAtMs: 1 };
    },
    releaseHomeTunnel: closeListener,
    shutdownEndpoint: async ({ endpointHandle }) => {
      for (const [id, listener] of listeners) {
        if (listener.endpointHandle === endpointHandle) await closeListener(id);
      }
      endpoints.delete(endpointHandle);
    },
  } satisfies NativeModule;
  return { native, endpoints, listeners,
    failWith: (error: IrohError) => { failure = error; },
    reportHomeId: (id: string) => { reportedHomeId = id; },
    reportEndpointId: (id: string) => { reportedEndpointId = id; },
    close: async () => {
      for (const id of listeners.keys()) await closeListener(id);
      endpoints.clear();
    },
  };
}

describe('runWithRunnerHomeTransport', () => {
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL',
    'HAPPIER_HOME_CARRIER_POLICY', 'HAPPIER_IROH_RELAY_POLICY', 'HAPPIER_IROH_RELAY_URLS']);
  let homeDir: string;
  let boundary: ReturnType<typeof createNativeBoundary>;

  beforeEach(async () => {
    homeDir = await createTempDir('happier-runner-home-');
    env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: SERVER_ID,
      HAPPIER_SERVER_URL: undefined, HAPPIER_LOCAL_SERVER_URL: undefined,
      HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined,
      HAPPIER_HOME_CARRIER_POLICY: 'automatic', HAPPIER_IROH_RELAY_POLICY: 'disabled',
      HAPPIER_IROH_RELAY_URLS: undefined });
    reloadConfiguration();
    await seedTestServerProfile({ id: SERVER_ID, homeId: DESCRIPTOR.homeServerIdentityId,
      serverUrl: DESCRIPTOR.canonicalServerUrl });
    await updateSettings(settings => ({ ...settings, activeServerId: SERVER_ID,
      servers: { ...settings.servers, [SERVER_ID]: {
        ...settings.servers![SERVER_ID], homeConnectionDescriptor: DESCRIPTOR,
      } } }));
    reloadConfiguration();
    boundary = createNativeBoundary();
    nativeBoundary.current = boundary.native;
  });

  afterEach(async () => {
    await boundary?.close();
    nativeBoundary.current = null;
    env.restore();
    reloadConfiguration();
    await removeTempDir(homeDir);
    vi.unstubAllGlobals();
  });

  it('keeps the runner Home reachable after the daemon tunnel closes and a replacement daemon acquires its own tunnel', async () => {
    // Separate sessions model the process-local native ownership. This proves
    // tunnel lifetime isolation; it does not claim a real daemon/session resume.
    const daemon = await createNodeIrohHomeTunnelSession({ keylessEndpoint: 'fixture' });
    let replacement: Awaited<ReturnType<typeof createNodeIrohHomeTunnelSession>> | undefined;
    const daemonLease = await daemon.ensureHomeTunnel({ descriptor: DESCRIPTOR });
    try {
      const result = await runWithRunnerHomeTransport(async () => {
        const runnerOrigin = resolveServerHttpBaseUrl();
        expect(runnerOrigin).not.toBe(daemonLease.runtimeOrigin);
        expect(resolveServerSocketIoTransports()).toEqual(['websocket']);
        expect(configuration.serverUrl).toBe(DESCRIPTOR.canonicalServerUrl);
        const readHome = async () => await (await fetch(`${resolveServerHttpBaseUrl()}/v1/features`)).json();
        expect(await readHome()).toHaveProperty('capabilities.serverIdentity.serverIdentityId', DESCRIPTOR.homeServerIdentityId);
        await daemon.shutdown();
        expect(await readHome()).toHaveProperty('capabilities.serverIdentity.serverIdentityId', DESCRIPTOR.homeServerIdentityId);
        replacement = await createNodeIrohHomeTunnelSession({ keylessEndpoint: 'fixture' });
        const replacementLease = await replacement.ensureHomeTunnel({ descriptor: DESCRIPTOR });
        expect(replacementLease.runtimeOrigin).not.toBe(runnerOrigin);
        expect(resolveServerHttpBaseUrl()).toBe(runnerOrigin);
        expect(await readHome()).toHaveProperty('capabilities.serverIdentity.serverIdentityId', DESCRIPTOR.homeServerIdentityId);
        return 'runner-finished';
      });
      expect(result).toBe('runner-finished');
      expect(resolveServerHttpBaseUrl()).toBe(DESCRIPTOR.canonicalServerUrl);
    } finally {
      await daemon.shutdown();
      await replacement?.shutdown();
    }
    expect(boundary.listeners.size).toBe(0);
    expect(boundary.endpoints.size).toBe(0);
  });

  it.each(['Home', 'EndpointId'] as const)('rejects a native tunnel for a different %s before running credential-bearing work', async identity => {
    if (identity === 'Home') boundary.reportHomeId('srv_other_home');
    else boundary.reportEndpointId('f'.repeat(64));
    const run = vi.fn(async () => 'must-not-run');
    await expect(runWithRunnerHomeTransport(run)).rejects.toMatchObject({ code: 'identity_mismatch' });
    expect(run).not.toHaveBeenCalled();
    expect(resolveServerHttpBaseUrl()).toBe(DESCRIPTOR.canonicalServerUrl);
    expect(boundary.listeners.size).toBe(0);
    expect(boundary.endpoints.size).toBe(0);
  });

  it('settles an unavailable Iroh-only Home with its typed error and releases the endpoint', async () => {
    const unavailable = new IrohError('home_unreachable', 'Home unavailable at native boundary');
    boundary.failWith(unavailable);
    const run = vi.fn(async () => 'must-not-run');
    await expect(runWithRunnerHomeTransport(run)).rejects.toBe(unavailable);
    expect(run).not.toHaveBeenCalled();
    expect(boundary.endpoints.size).toBe(0);
    expect(boundary.listeners.size).toBe(0);
  });

  it('unpublishes and closes the runner tunnel when the command throws', async () => {
    const commandError = new Error('Command failed');
    await expect(runWithRunnerHomeTransport(async () => {
      expect(resolveServerHttpBaseUrl()).not.toBe(DESCRIPTOR.canonicalServerUrl);
      throw commandError;
    })).rejects.toBe(commandError);
    expect(resolveServerHttpBaseUrl()).toBe(DESCRIPTOR.canonicalServerUrl);
    expect(boundary.listeners.size).toBe(0);
    expect(boundary.endpoints.size).toBe(0);
  });

  it('preserves a released URL-only profile without acquiring a native endpoint or probing features', async () => {
    await updateSettings(settings => {
      const { homeConnectionDescriptor: _descriptor, homeConnectionDescriptorAuthority: _authority,
        ...profile } = settings.servers![SERVER_ID];
      return { ...settings, servers: { ...settings.servers, [SERVER_ID]: profile } };
    });
    const fetchBoundary = vi.fn<typeof fetch>(async () => { throw new Error('Unexpected URL-only Home probe'); });
    vi.stubGlobal('fetch', fetchBoundary);
    expect(await runWithRunnerHomeTransport(async () => resolveServerHttpBaseUrl())).toBe(DESCRIPTOR.canonicalServerUrl);
    expect(fetchBoundary).not.toHaveBeenCalled();
    expect(boundary.endpoints.size).toBe(0);
    expect(boundary.listeners.size).toBe(0);
  });
});
