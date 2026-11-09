import { describe, expect, it, vi } from 'vitest';
import { IrohError } from '@happier-dev/iroh-native/node';

import { createDeferred } from '../../testkit/async/deferred';
import { prepareDaemonHomeIrohTransport } from '../peer/iroh/daemonHomeIrohTransport';
import { createDaemonMachineIrohRuntime } from '../peer/iroh/daemonMachineIrohRuntime';

import { cleanupDaemonHomeMachineWorkspace } from './daemonHomeMachineWorkspaceCleanup';

const HOME_DESCRIPTOR = {
  v: 1 as const,
  homeServerIdentityId: 'srv_home_daemon',
  canonicalServerUrl: 'https://home.example.test',
  revision: 4,
  endpoints: [{ kind: 'iroh' as const, endpointId: 'c'.repeat(64) }],
};

describe('cleanupDaemonHomeMachineWorkspace', () => {
  it('attempts every cleanup and aggregates all failures', async () => {
    const workspaceFailure = new Error('workspace failed');
    const homeFailure = new Error('home failed');
    const calls: string[] = [];
    const cleanup = (name: string, failure?: Error) => vi.fn(async () => {
      calls.push(name);
      if (failure) throw failure;
    });

    await expect(cleanupDaemonHomeMachineWorkspace({
      stopWorkspaceSync: cleanup('workspace', workspaceFailure),
      stopMachineAcceptor: cleanup('acceptor'),
      stopPeerMediation: cleanup('peer'),
      stopDirectPeer: cleanup('direct'),
      releaseHomeTransport: cleanup('home', homeFailure),
      shutdownMachineIroh: cleanup('machine'),
      cleanupFailedIrohStartup: cleanup('failed-startup'),
    })).rejects.toMatchObject({ errors: [workspaceFailure, homeFailure] });

    expect(calls).toEqual([
      'workspace', 'acceptor', 'peer', 'direct', 'machine', 'home', 'failed-startup',
    ]);
  });

  it('reaches native Iroh shutdown before awaiting a blocked Home transport release', async () => {
    const homeReleaseStarted = createDeferred();
    const homeRelease = createDeferred();
    const calls: string[] = [];
    const completedCleanup = cleanupDaemonHomeMachineWorkspace({
      stopWorkspaceSync: async () => { calls.push('workspace'); },
      stopMachineAcceptor: async () => { calls.push('acceptor'); },
      stopPeerMediation: async () => { calls.push('peer'); },
      stopDirectPeer: async () => { calls.push('direct'); },
      releaseHomeTransport: async () => {
        calls.push('home');
        homeReleaseStarted.resolve();
        await homeRelease.promise;
      },
      shutdownMachineIroh: async () => { calls.push('machine'); },
      cleanupFailedIrohStartup: async () => { calls.push('failed-startup'); },
    });

    try {
      await homeReleaseStarted.promise;
      expect(calls).toContain('machine');
    } finally {
      homeRelease.resolve();
      await completedCleanup;
    }

    expect(calls).toEqual([
      'workspace', 'acceptor', 'peer', 'direct', 'machine', 'home', 'failed-startup',
    ]);
  });

  it('lets native endpoint shutdown cancel a cold Home reacquisition instead of deadlocking teardown', async () => {
    // Only the native endpoint owner can cancel a dial that never answers, so a
    // cold reacquisition is the exact state the daemon teardown corridor has to
    // survive. Native is the one mocked boundary; the Home transport, the
    // Machine runtime and the cleanup owner all run their real logic.
    const coldHomeDial = createDeferred<never>();
    const native = {
      createEndpoint: vi.fn(async () => ({ endpointHandle: 'endpoint-1', endpointId: 'a'.repeat(64) })),
      getEndpointStatus: vi.fn(async () => ({
        endpointHandle: 'endpoint-1', endpointId: 'a'.repeat(64), relayMode: 'custom',
        relayUrls: ['https://relay.test/'], capProfile: 'machineBulk',
        directAddresses: ['127.0.0.1:7777'], active: true,
      })),
      startMachineAcceptor: vi.fn(async () => ({})),
      stopMachineAcceptor: vi.fn(async () => undefined),
      startMachineTunnel: vi.fn(async () => { throw new Error('unused'); }),
      startMachineHttpTunnel: vi.fn(async () => { throw new Error('unused'); }),
      stopMachineTunnel: vi.fn(async () => undefined),
      ensureHomeTunnel: vi.fn(async () => {
        if (native.ensureHomeTunnel.mock.calls.length > 1) return await coldHomeDial.promise;
        return {
          tunnelId: 'home-tunnel-1', endpointHandle: 'endpoint-1',
          homeServerIdentityId: HOME_DESCRIPTOR.homeServerIdentityId,
          homeEndpointId: HOME_DESCRIPTOR.endpoints[0]!.endpointId,
          runtimeOrigin: 'http://127.0.0.1:49123', carrier: 'iroh' as const,
          observedPath: 'direct' as const, startedAtMs: 1,
        };
      }),
      releaseHomeTunnel: vi.fn(async () => undefined),
      shutdownEndpoint: vi.fn(async () => {
        // Native endpoint shutdown closes admission and cancels admitted work.
        coldHomeDial.reject(new IrohError('cancelled', 'Iroh endpoint shut down'));
      }),
    };

    const runtime = await createDaemonMachineIrohRuntime({
      happyHomeDir: '/daemon-home',
      relayConfig: { relayPolicy: 'automatic', relayUrls: ['https://relay.test/'] },
      native: native as never,
    });
    expect(runtime.available).toBe(true);
    if (!runtime.available) return;

    const profile = {
      serverUrl: HOME_DESCRIPTOR.canonicalServerUrl,
      homeConnectionDescriptor: HOME_DESCRIPTOR,
    } as never;
    const homeTransport = await prepareDaemonHomeIrohTransport({
      runtime,
      profile,
      token: 'daemon-token',
      readProfile: async () => ({ serverUrl: HOME_DESCRIPTOR.canonicalServerUrl,
        homeConnectionDescriptor: { ...HOME_DESCRIPTOR, revision: HOME_DESCRIPTOR.revision + 1 } }),
      probe: async () => ({ status: 'ready' as const }),
      publishRuntimeOrigin: () => () => undefined,
    });
    expect(homeTransport.carrier).toBe('iroh');

    // Admit the reacquisition and wait for the native dial before tearing down,
    // so the release really is parked behind uncancelled native work.
    const reacquisition = homeTransport.reacquire();
    await vi.waitFor(() => expect(native.ensureHomeTunnel).toHaveBeenCalledTimes(2));

    await cleanupDaemonHomeMachineWorkspace({
      stopWorkspaceSync: async () => undefined,
      stopMachineAcceptor: runtime.stopAttemptAcceptor,
      stopPeerMediation: async () => undefined,
      stopDirectPeer: async () => undefined,
      releaseHomeTransport: async () => await homeTransport.release(),
      shutdownMachineIroh: async () => await runtime.shutdown(),
      cleanupFailedIrohStartup: async () => undefined,
    });

    // The parked reacquisition settles instead of staying pending, and a
    // cancelled dial never reports the Home transport ready.
    expect((await reacquisition).status).not.toBe('ready');
    expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1);
    expect(native.releaseHomeTunnel).toHaveBeenCalledWith('home-tunnel-1');
  });
});
