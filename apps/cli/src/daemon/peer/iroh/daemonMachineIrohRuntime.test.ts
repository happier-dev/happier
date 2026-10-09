import { describe, expect, it, vi } from 'vitest';
import { HomeConnectionDescriptorV1Schema, RunnerBrokerReadinessRequestV1Schema } from '@happier-dev/protocol';
import { createNodeIrohHomeTunnelSession } from '@happier-dev/iroh-native/node';

import { createDaemonMachineIrohRuntime } from './daemonMachineIrohRuntime';
import { prepareDaemonHomeIrohTransport } from './daemonHomeIrohTransport';
import { acquireTerminalAuthEnrollmentRuntime } from '@/auth/terminalAuthEnrollmentRuntime';
import { resolveServerHttpBaseUrl, resolveServerSocketIoTransports } from '@/api/client/serverHttpBaseUrl';

const HOME_DESCRIPTOR = HomeConnectionDescriptorV1Schema.parse({
  v: 1,
  homeServerIdentityId: 'srv_home_iroh',
  canonicalServerUrl: 'https://home.example',
  revision: 7,
  endpoints: [{ kind: 'iroh', endpointId: 'c'.repeat(64), relayUrls: ['https://relay.test/'] }],
});

const WORKSPACE_SYNC_HANDSHAKE = { v: 1, flow: 'workspace_sync', operationId: 'operation-1', exact: 'verified' };

function nativeHarness(overrides: Record<string, unknown> = {}) {
  return {
    createEndpoint: vi.fn(async (_request: unknown) => ({ endpointHandle: 'endpoint-1', endpointId: 'a'.repeat(64) })),
    getEndpointStatus: vi.fn(async () => ({
      endpointHandle: 'endpoint-1', endpointId: 'a'.repeat(64), relayMode: 'custom', relayUrls: ['https://relay.test/'],
      capProfile: 'machineBulk', directAddresses: ['127.0.0.1:7777'], active: true,
    })),
    startMachineAcceptor: vi.fn(async () => ({})),
    stopMachineAcceptor: vi.fn(async () => undefined),
    startMachineTunnel: vi.fn(async () => ({
      machineTunnelId: 'tunnel-1', endpointHandle: 'endpoint-1', localPort: 48123,
      localCapability: 'c'.repeat(64),
      connectionActive: true, remoteEndpointId: 'b'.repeat(64), observedPath: 'relay',
      startedAtMs: 1, lastErrorCode: null,
    })),
    startMachineHttpTunnel: vi.fn(async () => ({
      machineTunnelId: 'tunnel-1', endpointHandle: 'endpoint-1', localPort: 48123,
      localCapability: 'c'.repeat(64),
      connectionActive: true, remoteEndpointId: 'b'.repeat(64), observedPath: 'relay',
      startedAtMs: 1, lastErrorCode: null,
    })),
    stopMachineTunnel: vi.fn(async () => undefined),
    ensureHomeTunnel: vi.fn(async () => ({
      tunnelId: 'home-tunnel-1', endpointHandle: 'endpoint-1',
      homeServerIdentityId: 'srv_home_iroh', homeEndpointId: 'c'.repeat(64),
      runtimeOrigin: 'http://127.0.0.1:49123', carrier: 'iroh', observedPath: 'direct',
      startedAtMs: 1,
    })),
    releaseHomeTunnel: vi.fn(async () => undefined),
    shutdownEndpoint: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function createHarness(nativeOverrides: Record<string, unknown> = {}, connectTcp?: unknown) {
  const native = nativeHarness(nativeOverrides);
  const runtime = await createDaemonMachineIrohRuntime({
    happyHomeDir: '/daemon-home',
    relayConfig: { relayPolicy: 'automatic', relayUrls: ['https://relay.test/'] },
    native: native as never,
    ...(connectTcp ? { connectTcp: connectTcp as never } : {}),
  });
  return { native, runtime };
}

describe('createDaemonMachineIrohRuntime', () => {
  it('uses an ephemeral native identity for an Account client without touching the daemon endpoint key', async () => {
    const native = nativeHarness();
    const runtime = await createDaemonMachineIrohRuntime({ happyHomeDir: '/daemon-home', identity: 'ephemeral',
      relayConfig: { relayPolicy: 'disabled', relayUrls: [] }, native: native as never });
    if (!runtime.available) throw new Error('Expected native Account client endpoint');
    expect(native.createEndpoint.mock.calls[0]?.[0]).not.toHaveProperty('keyPath');
    await runtime.shutdown();
  });
  it('keeps the daemon endpoint and acceptor active when an in-process auth helper closes', async () => {
    const { native, runtime } = await createHarness();
    if (!runtime.available) throw new Error('expected daemon endpoint');
    await runtime.startAttemptAcceptor({ admissionPort: 49124 });
    const home = await prepareDaemonHomeIrohTransport({
      runtime,
      profile: { serverUrl: 'https://home.example', homeConnectionDescriptor: HOME_DESCRIPTOR } as never,
      probe: async () => ({ status: 'ready' }),
    });
    try {
      const helper = await acquireTerminalAuthEnrollmentRuntime(HOME_DESCRIPTOR, {
        // Exercise the real session lifecycle beneath the native/OS boundary.
        createSession: async (input) => await createNodeIrohHomeTunnelSession({ ...input, native: native as never }),
        classifyFailure: () => ({ fallbackAllowed: false }),
      });
      expect(helper.ok).toBe(true);
      if (!helper.ok) throw helper.error;
      expect(helper.runtime.runtimeOrigin).toBe('http://127.0.0.1:49123');
      await helper.close();
      expect(native.shutdownEndpoint).not.toHaveBeenCalled();
      expect(native.stopMachineAcceptor).not.toHaveBeenCalled();
      expect(resolveServerHttpBaseUrl()).toBe('http://127.0.0.1:49123');
      expect(resolveServerSocketIoTransports()).toEqual(['websocket']);
      const cancellation = new AbortController();
      cancellation.abort();
      const cancelledHelper = await acquireTerminalAuthEnrollmentRuntime(HOME_DESCRIPTOR, {
        createSession: async (input) => await createNodeIrohHomeTunnelSession({ ...input, native: native as never }),
        classifyFailure: () => ({ fallbackAllowed: false }),
      }, cancellation.signal);
      expect(cancelledHelper).toMatchObject({ ok: false, error: { name: 'AbortError' } });
      expect(native.shutdownEndpoint).not.toHaveBeenCalled();
      const releaseFailure = new Error('native lease release failed');
      const retryableHelper = await acquireTerminalAuthEnrollmentRuntime(HOME_DESCRIPTOR, {
        createSession: async (input) => await createNodeIrohHomeTunnelSession({ ...input, native: native as never }),
        classifyFailure: () => ({ fallbackAllowed: false }),
      });
      if (!retryableHelper.ok) throw retryableHelper.error;
      native.releaseHomeTunnel.mockRejectedValueOnce(releaseFailure);
      await expect(retryableHelper.close()).rejects.toBe(releaseFailure);
      expect(native.shutdownEndpoint).not.toHaveBeenCalled();
      await retryableHelper.close();

      const privateNative = nativeHarness();
      const ensurePrivateTunnel = privateNative.ensureHomeTunnel;
      privateNative.ensureHomeTunnel = vi.fn(async () => ({
        ...await ensurePrivateTunnel(), runtimeOrigin: 'http://127.0.0.1:49125',
      }));
      const otherRevision = await acquireTerminalAuthEnrollmentRuntime({ ...HOME_DESCRIPTOR, revision: 8 }, {
        createSession: async (input) => await createNodeIrohHomeTunnelSession({ ...input, native: privateNative as never }),
        classifyFailure: () => ({ fallbackAllowed: false }),
      });
      if (!otherRevision.ok) throw otherRevision.error;
      expect(otherRevision.runtime.runtimeOrigin).toBe('http://127.0.0.1:49125');
      await otherRevision.close();
      expect(privateNative.shutdownEndpoint).toHaveBeenCalledOnce();
      expect(native.shutdownEndpoint).not.toHaveBeenCalled();
      expect(resolveServerHttpBaseUrl()).toBe('http://127.0.0.1:49123');
      await expect(runtime.ensureHomeTunnel!({ descriptor: HOME_DESCRIPTOR })).resolves.toMatchObject({
        runtimeOrigin: 'http://127.0.0.1:49123',
      });
    } finally {
      await home.release();
      await runtime.shutdown();
    }
  });

  it('dials relay-only recovery without changing the published Home descriptor', async () => {
    const { native, runtime } = await createHarness();
    expect(runtime.available).toBe(true);
    if (!runtime.available) return;
    const descriptorWithDirectAndRelay = {
      v: 1 as const,
      homeServerIdentityId: 'srv_home_iroh',
      canonicalServerUrl: 'https://home.example',
      revision: 7,
      endpoints: [{
        kind: 'iroh' as const,
        endpointId: 'c'.repeat(64),
        directAddresses: ['127.0.0.1:40123'],
        relayUrls: ['https://relay.test/'],
      }],
    };

    const first = await runtime.ensureHomeTunnel!({ descriptor: descriptorWithDirectAndRelay });
    const second = await runtime.ensureHomeTunnel!({ descriptor: descriptorWithDirectAndRelay, relayOnly: true });
    expect(native.ensureHomeTunnel).toHaveBeenNthCalledWith(1, expect.objectContaining({
      directAddresses: ['127.0.0.1:40123'],
      relayUrls: ['https://relay.test/'],
    }));
    expect(native.ensureHomeTunnel).toHaveBeenNthCalledWith(2, {
      endpointHandle: 'endpoint-1',
      homeServerIdentityId: descriptorWithDirectAndRelay.homeServerIdentityId,
      endpointId: descriptorWithDirectAndRelay.endpoints[0]!.endpointId,
      relayUrls: ['https://relay.test/'],
    });
    expect(descriptorWithDirectAndRelay.endpoints[0]!.directAddresses).toEqual(['127.0.0.1:40123']);
    await first.release();
    await second.release();
    await runtime.shutdown();
  });

  it('reuses the installation key path and EndpointId across daemon restarts', async () => {
    const endpointId = 'e'.repeat(64);
    let nextHandle = 0;
    const keyPaths: string[] = [];
    const native = nativeHarness({
      createEndpoint: vi.fn(async (input: { keyPath?: string }) => {
        keyPaths.push(input.keyPath ?? '');
        nextHandle += 1;
        return { endpointHandle: `endpoint-${nextHandle}`, endpointId };
      }),
      getEndpointStatus: vi.fn(async (handle: string) => ({
        endpointHandle: handle,
        endpointId,
        relayMode: 'custom',
        relayUrls: ['https://relay.test/'],
        capProfile: 'machineBulk',
        directAddresses: [],
        active: true,
      })),
    });
    const input = {
      happyHomeDir: '/daemon-home',
      relayConfig: { relayPolicy: 'automatic' as const, relayUrls: ['https://relay.test/'] },
      native: native as never,
    };

    const first = await createDaemonMachineIrohRuntime(input);
    expect(first.available).toBe(true);
    if (!first.available) return;
    expect(first.endpoint.endpointId).toBe(endpointId);
    await first.shutdown();

    const restarted = await createDaemonMachineIrohRuntime(input);
    expect(restarted.available).toBe(true);
    if (!restarted.available) return;
    expect(restarted.endpoint.endpointId).toBe(endpointId);
    expect(keyPaths).toEqual([
      '/daemon-home/runtime/iroh/endpoint.key',
      '/daemon-home/runtime/iroh/endpoint.key',
    ]);
    await restarted.shutdown();
  });

  it('owns one daemon-lifetime endpoint, attempt acceptors, and exact verified tunnel handshakes', async () => {
    const order: string[] = [];
    let failNextAcceptorStop = false;
    const native = {
      createEndpoint: vi.fn(async () => ({ endpointHandle: 'endpoint-1', endpointId: 'a'.repeat(64) })),
      getEndpointStatus: vi.fn(async () => ({
        endpointHandle: 'endpoint-1', endpointId: 'a'.repeat(64), relayMode: 'custom', relayUrls: ['https://relay.test/'],
        capProfile: 'machineBulk', directAddresses: ['127.0.0.1:7777'], active: true,
      })),
      startMachineAcceptor: vi.fn(async () => { order.push('acceptor:start'); return {}; }),
      stopMachineAcceptor: vi.fn(async () => {
        if (failNextAcceptorStop) {
          failNextAcceptorStop = false;
          throw new Error('native acceptor stop failed');
        }
        order.push('acceptor:stop');
      }),
      startMachineTunnel: vi.fn(async () => ({
        machineTunnelId: 'tunnel-1', endpointHandle: 'endpoint-1', localPort: 48123,
        localCapability: 'c'.repeat(64),
        connectionActive: true, remoteEndpointId: 'b'.repeat(64), observedPath: 'relay',
        startedAtMs: 1, lastErrorCode: null,
      })),
      stopMachineTunnel: vi.fn(async () => { order.push('tunnel:stop'); }),
      ensureHomeTunnel: vi.fn(async () => ({
        tunnelId: 'home-tunnel-1', endpointHandle: 'endpoint-1',
        homeServerIdentityId: 'srv_home_iroh', homeEndpointId: 'c'.repeat(64),
        runtimeOrigin: 'http://127.0.0.1:49123', carrier: 'iroh', observedPath: 'direct',
        startedAtMs: 1,
      })),
      releaseHomeTunnel: vi.fn()
        .mockRejectedValueOnce(new Error('native Home release failed'))
        .mockImplementation(async () => { order.push('home-tunnel:stop'); }),
      shutdownEndpoint: vi.fn()
        .mockRejectedValueOnce(new Error('native endpoint shutdown failed'))
        .mockImplementation(async () => { order.push('endpoint:stop'); }),
    };
    const write = vi.fn(async () => undefined);
    const connectTcp = vi.fn(async () => ({
      write, endWrite: async () => undefined,
      onData: () => () => undefined, close: async () => { order.push('tcp:stop'); },
    }));
    const runtime = await createDaemonMachineIrohRuntime({
      happyHomeDir: '/daemon-home',
      relayConfig: { relayPolicy: 'automatic', relayUrls: ['https://relay.test/'] },
      native: native as never,
      connectTcp: connectTcp as never,
    });
    expect(runtime.available).toBe(true);
    if (!runtime.available) return;
    expect(native.createEndpoint).toHaveBeenCalledTimes(1);
    expect(native.createEndpoint).toHaveBeenCalledWith(expect.objectContaining({
      keyPath: expect.stringMatching(/runtime[\\/]iroh[\\/]endpoint\.key$/), capProfile: 'machineBulk',
    }));
    expect(runtime.endpoint).toEqual({
      endpointId: 'a'.repeat(64), relayUrls: ['https://relay.test/'], directAddresses: ['127.0.0.1:7777'],
    });

    const homeLease = await runtime.ensureHomeTunnel!({
      descriptor: {
        v: 1,
        homeServerIdentityId: 'srv_home_iroh',
        canonicalServerUrl: 'https://home.example',
        revision: 7,
        endpoints: [{ kind: 'iroh', endpointId: 'c'.repeat(64), relayUrls: ['https://relay.test/'] }],
      } as never,
    });
    expect(native.ensureHomeTunnel).toHaveBeenCalledWith({
      endpointHandle: 'endpoint-1', homeServerIdentityId: 'srv_home_iroh',
      endpointId: 'c'.repeat(64), relayUrls: ['https://relay.test/'],
    });
    expect(homeLease.runtimeOrigin).toBe('http://127.0.0.1:49123');
    await expect(homeLease.release()).rejects.toThrow('native Home release failed');
    await runtime.stopActiveTunnels();
    expect(native.releaseHomeTunnel).toHaveBeenCalledTimes(2);

    await runtime.startAttemptAcceptor({ admissionPort: 47001 });
    failNextAcceptorStop = true;
    await expect(runtime.stopAttemptAcceptor()).rejects.toThrow('native acceptor stop failed');
    await runtime.stopAttemptAcceptor();
    await runtime.startAttemptAcceptor({ admissionPort: 47002 });
    expect(native.createEndpoint).toHaveBeenCalledTimes(1);

    const handshake = { v: 1, flow: 'workspace_sync', operationId: 'operation-1', exact: 'verified' };
    const tunnel = await runtime.openTunnel({
      alpn: 'happier/machine/1', remoteEndpointId: 'b'.repeat(64), flow: 'workspace_sync',
      operationId: 'operation-1', handshake: handshake as never,
    }, { endpointId: 'b'.repeat(64), directAddresses: ['10.0.0.2:7777'] });
    expect(tunnel).toMatchObject({
      localPort: 48123,
      localCapability: 'c'.repeat(64),
      remoteEndpointId: 'b'.repeat(64),
      observedPath: 'relay',
    });
    expect(connectTcp).not.toHaveBeenCalled();
    await tunnel.close();

    const connection = await runtime.openTransport({
      alpn: 'happier/machine/1', remoteEndpointId: 'b'.repeat(64), flow: 'workspace_sync',
      operationId: 'operation-1', handshake: handshake as never,
    }, { endpointId: 'b'.repeat(64), directAddresses: ['10.0.0.2:7777'] });
    expect(native.startMachineTunnel).toHaveBeenCalledWith(expect.objectContaining({
      endpointHandle: 'endpoint-1', endpointId: 'b'.repeat(64), directAddresses: ['10.0.0.2:7777'],
      handshakeJson: JSON.stringify(handshake), capProfile: 'machineBulk',
    }));
    expect(connectTcp).toHaveBeenCalledWith({ host: '127.0.0.1', port: 48123 });
    expect(write).toHaveBeenCalledWith(Buffer.from('c'.repeat(64), 'ascii'));
    expect(connection.remoteEndpointId).toBe('b'.repeat(64));

    await expect(runtime.openTunnel({
      alpn: 'happier/machine/1', remoteEndpointId: 'b'.repeat(64), flow: 'finite_transfer',
      handshake: handshake as never,
    }, { endpointId: 'b'.repeat(64) })).rejects.toThrow('does not match the verified handshake');

    await runtime.stopActiveTunnels();
    await expect(runtime.shutdown()).rejects.toThrow('native endpoint shutdown failed');
    await runtime.shutdown();
    expect(native.shutdownEndpoint).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['home-tunnel:stop', 'acceptor:start', 'acceptor:stop', 'acceptor:start', 'tunnel:stop', 'tcp:stop', 'tunnel:stop', 'acceptor:stop', 'endpoint:stop']);
  });

  it('coalesces concurrent Home lease release callers onto one native release', async () => {
    const { native, runtime } = await createHarness();
    expect(runtime.available).toBe(true);
    if (!runtime.available) return;
    const lease = await runtime.ensureHomeTunnel!({ descriptor: HOME_DESCRIPTOR });
    const direct = lease.release();
    const throughOwner = runtime.stopActiveTunnels();
    await Promise.all([direct, throughOwner]);
    expect(native.releaseHomeTunnel).toHaveBeenCalledTimes(1);
  });

  it('fails closed and releases a finite-transfer raw tunnel if native publishes a local capability', async () => {
    const { native, runtime } = await createHarness();
    expect(runtime.available).toBe(true);
    if (!runtime.available) return;

    await expect(runtime.openTunnel({
      alpn: 'happier/machine/1',
      remoteEndpointId: 'b'.repeat(64),
      flow: 'finite_transfer',
      handshake: { v: 1, flow: 'finite_transfer' } as never,
    }, { endpointId: 'b'.repeat(64) })).rejects.toThrow(
      'Iroh finite-transfer tunnel unexpectedly published a local capability',
    );
    expect(native.stopMachineTunnel).toHaveBeenCalledWith('tunnel-1');
    await runtime.shutdown();
  });

  it('coalesces concurrent machine tunnel close callers onto one native stop', async () => {
    const { native, runtime } = await createHarness();
    expect(runtime.available).toBe(true);
    if (!runtime.available) return;
    const tunnel = await runtime.openTunnel({
      alpn: 'happier/machine/1', remoteEndpointId: 'b'.repeat(64), flow: 'workspace_sync',
      operationId: 'operation-1', handshake: WORKSPACE_SYNC_HANDSHAKE as never,
    }, { endpointId: 'b'.repeat(64), directAddresses: ['10.0.0.2:7777'] });
    const direct = tunnel.close();
    const throughOwner = runtime.stopActiveTunnels();
    await Promise.all([direct, throughOwner]);
    expect(native.stopMachineTunnel).toHaveBeenCalledTimes(1);
  });

  it('owns the native Machine HTTP lease through the same retryable runtime cleanup owner', async () => {
    const { native, runtime } = await createHarness();
    expect(runtime.available).toBe(true);
    if (!runtime.available) return;

    const handshake = RunnerBrokerReadinessRequestV1Schema.parse({
      v: 1,
      kind: 'provider_broker_readiness',
      homeServerIdentityId: 'srv_runner_home',
      activationId: '00000000-0000-4000-8000-000000000010',
      launchManifestCommitment: 'A'.repeat(43),
      resourceId: 'resource-1',
      agentTargetKey: 'agent:happier.agent.codex/codex',
      protocol: 'openai-responses',
      modelId: 'gpt-5',
      initiator: { installationId: 'installation-1', endpointId: 'a'.repeat(64) },
      target: { machineId: 'broker-machine', endpointId: 'b'.repeat(64) },
      activationSignature: 'A'.repeat(86),
      installationSignature: 'A'.repeat(86),
    });
    const tunnel = await runtime.openHttpTunnel({
      alpn: 'happier/machine/1', remoteEndpointId: 'b'.repeat(64),
      flow: 'provider_broker_readiness', handshake,
    }, { endpointId: 'b'.repeat(64), directAddresses: ['10.0.0.2:7777'] });

    expect(native.startMachineHttpTunnel).toHaveBeenCalledWith(expect.objectContaining({
      endpointHandle: 'endpoint-1', endpointId: 'b'.repeat(64),
      handshakeJson: JSON.stringify(handshake), capProfile: 'machineBulk',
    }));
    expect(tunnel).toMatchObject({
      localPort: 48123,
      localCapability: 'c'.repeat(64),
      remoteEndpointId: 'b'.repeat(64),
      observedPath: 'relay',
    });

    await Promise.all([tunnel.close(), runtime.stopActiveTunnels()]);
    expect(native.stopMachineTunnel).toHaveBeenCalledTimes(1);
  });

  it('releases the owned native tunnel even when the subsidiary local stream close fails', async () => {
    const { native, runtime } = await createHarness({}, async () => ({
      write: async () => undefined,
      endWrite: async () => undefined,
      onData: () => () => undefined,
      close: async () => { throw new Error('local stream close failed'); },
    }));
    expect(runtime.available).toBe(true);
    if (!runtime.available) return;
    const connection = await runtime.openTransport({
      alpn: 'happier/machine/1', remoteEndpointId: 'b'.repeat(64), flow: 'workspace_sync',
      operationId: 'operation-1', handshake: WORKSPACE_SYNC_HANDSHAKE as never,
    }, { endpointId: 'b'.repeat(64), directAddresses: ['10.0.0.2:7777'] });
    await expect(connection.close()).resolves.toBeUndefined();
    expect(native.stopMachineTunnel).toHaveBeenCalledWith('tunnel-1');
    await runtime.stopActiveTunnels();
    expect(native.stopMachineTunnel).toHaveBeenCalledTimes(1);
  });

  it('disposes the endpoint created before the status and descriptor projection when that projection fails', async () => {
    const native = nativeHarness({
      getEndpointStatus: vi.fn(async () => ({
        endpointHandle: 'endpoint-1', endpointId: 'a'.repeat(64), relayMode: 'custom', relayUrls: ['https://relay.test/'],
        capProfile: 'machineBulk', directAddresses: ['not-a-socket-address'], active: true,
      })),
    });

    const result = await createDaemonMachineIrohRuntime({
      happyHomeDir: '/daemon-home',
      relayConfig: { relayPolicy: 'automatic', relayUrls: ['https://relay.test/'] },
      native: native as never,
    });

    expect(result).toMatchObject({ available: false, reason: 'startup_failed' });
    expect(native.shutdownEndpoint).toHaveBeenCalledWith({ endpointHandle: 'endpoint-1' });
  });

  it('reports a fail-closed-classified local endpoint creation failure as native-runtime unavailability', async () => {
    // `endpoint_key_unavailable` is classified fail-closed for a *selected*
    // Iroh Home. Local carrier preparation must not make that decision: it
    // reports unavailability so the HTTPS-aware Home transport owner remains
    // the single owner of the trusted-HTTPS-or-fail-closed choice.
    const creationFailure = Object.assign(new Error('local endpoint key is unreadable'), {
      name: 'IrohError',
      code: 'endpoint_key_unavailable',
    });
    const native = nativeHarness({ createEndpoint: vi.fn(async () => { throw creationFailure; }) });

    const result = await createDaemonMachineIrohRuntime({
      happyHomeDir: '/daemon-home',
      relayConfig: { relayPolicy: 'automatic', relayUrls: ['https://relay.test/'] },
      native: native as never,
    });

    expect(result).toMatchObject({ available: false, reason: 'startup_failed', error: creationFailure });
    // No native endpoint was created, so there is no custody to retain.
    await expect(result.shutdown()).resolves.toBeUndefined();
    expect(native.shutdownEndpoint).not.toHaveBeenCalled();
  });

  it('returns failed-but-cleanable custody when startup projection and its first endpoint shutdown both fail', async () => {
    const projectionFailure = new Error('endpoint status projection failed');
    const native = nativeHarness({
      getEndpointStatus: vi.fn(async () => { throw projectionFailure; }),
      shutdownEndpoint: vi.fn()
        .mockRejectedValueOnce(new Error('native endpoint shutdown failed'))
        .mockResolvedValueOnce(undefined),
    });

    const result = await createDaemonMachineIrohRuntime({
      happyHomeDir: '/daemon-home',
      relayConfig: { relayPolicy: 'automatic', relayUrls: ['https://relay.test/'] },
      native: native as never,
    });

    expect(result).toMatchObject({
      available: false,
      reason: 'startup_failed',
      error: projectionFailure,
    });
    await expect(result.shutdown()).resolves.toBeUndefined();
    expect(native.shutdownEndpoint).toHaveBeenCalledTimes(2);
  });

  it('owns an acceptor attempt before native response validation and retains failed cleanup for retry', async () => {
    let failStop = true;
    const { native, runtime } = await createHarness({
      startMachineAcceptor: vi.fn(async () => {
        throw new Error('malformed native acceptor response');
      }),
      stopMachineAcceptor: vi.fn(async () => {
        if (failStop) throw new Error('native acceptor stop failed');
      }),
    });
    expect(runtime.available).toBe(true);
    if (!runtime.available) return;

    await expect(runtime.startAttemptAcceptor({ admissionPort: 47001 }))
      .rejects.toThrow('malformed native acceptor response');
    expect(native.stopMachineAcceptor).toHaveBeenCalledTimes(1);

    failStop = false;
    await expect(runtime.stopAttemptAcceptor()).resolves.toBeUndefined();
    expect(native.stopMachineAcceptor).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent acceptor stop callers onto one retryable native stop', async () => {
    let releaseStop!: () => void;
    const stopReleased = new Promise<void>((resolve) => { releaseStop = resolve; });
    const { native, runtime } = await createHarness({
      stopMachineAcceptor: vi.fn(async () => await stopReleased),
    });
    expect(runtime.available).toBe(true);
    if (!runtime.available) return;
    await runtime.startAttemptAcceptor({ admissionPort: 47001 });

    const first = runtime.stopAttemptAcceptor();
    const second = runtime.stopAttemptAcceptor();
    await vi.waitFor(() => expect(native.stopMachineAcceptor).toHaveBeenCalledTimes(1));
    releaseStop();
    await Promise.all([first, second]);
    expect(native.stopMachineAcceptor).toHaveBeenCalledTimes(1);
  });

  it('owns the machine tunnel from native creation, so a failed local-hop cleanup stays retryable through the owner', async () => {
    let failTunnelStop = true;
    const { native, runtime } = await createHarness({
      stopMachineTunnel: vi.fn(async () => {
        if (failTunnelStop) {
          failTunnelStop = false;
          throw new Error('native tunnel stop failed');
        }
      }),
    }, async () => { throw new Error('local hop connect failed'); });
    expect(runtime.available).toBe(true);
    if (!runtime.available) return;

    await expect(runtime.openTransport({
      alpn: 'happier/machine/1', remoteEndpointId: 'b'.repeat(64), flow: 'workspace_sync',
      operationId: 'operation-1', handshake: WORKSPACE_SYNC_HANDSHAKE as never,
    }, { endpointId: 'b'.repeat(64), directAddresses: ['10.0.0.2:7777'] }))
      .rejects.toThrow('local hop connect failed');
    expect(native.stopMachineTunnel).toHaveBeenCalledTimes(1);

    // The rejected cleanup left the native tunnel owned by the same runtime.
    await runtime.stopActiveTunnels();
    expect(native.stopMachineTunnel).toHaveBeenCalledTimes(2);
    await runtime.stopActiveTunnels();
    expect(native.stopMachineTunnel).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent shutdown callers onto one cleanup sequence and refuses new work afterwards', async () => {
    const { native, runtime } = await createHarness();
    expect(runtime.available).toBe(true);
    if (!runtime.available) return;
    await runtime.startAttemptAcceptor({ admissionPort: 47001 });
    await Promise.all([runtime.shutdown(), runtime.shutdown()]);
    expect(native.stopMachineAcceptor).toHaveBeenCalledTimes(1);
    expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1);
    await expect(runtime.ensureHomeTunnel!({ descriptor: HOME_DESCRIPTOR }))
      .rejects.toThrow('Iroh daemon runtime is shut down');
    await expect(runtime.startAttemptAcceptor({ admissionPort: 47002 }))
      .rejects.toThrow('Iroh machine runtime is shut down');
    await expect(runtime.openTunnel({
      alpn: 'happier/machine/1', remoteEndpointId: 'b'.repeat(64), flow: 'workspace_sync',
      operationId: 'operation-1', handshake: WORKSPACE_SYNC_HANDSHAKE as never,
    }, { endpointId: 'b'.repeat(64) })).rejects.toThrow('Iroh machine runtime is shut down');
  });

  it('reaches native endpoint shutdown without waiting for an in-flight machine tunnel creation, then releases the late result', async () => {
    let resolveCreate!: (value: {
      machineTunnelId: string;
      endpointHandle: string;
      localPort: number;
      localCapability: string;
      connectionActive: boolean;
      remoteEndpointId: string;
      observedPath: 'direct' | 'relay' | 'unknown';
      startedAtMs: number;
      lastErrorCode: string | null;
    }) => void;
    const { native, runtime } = await createHarness({
      startMachineTunnel: vi.fn(async () => await new Promise((resolve) => { resolveCreate = resolve; })),
    });
    expect(runtime.available).toBe(true);
    if (!runtime.available) return;

    // Admit the creation first, wait for the native creator to be called, then
    // begin shutdown, so the race is real.
    const creation = runtime.openTunnel({
      alpn: 'happier/machine/1', remoteEndpointId: 'b'.repeat(64), flow: 'workspace_sync',
      operationId: 'operation-1', handshake: WORKSPACE_SYNC_HANDSHAKE as never,
    }, { endpointId: 'b'.repeat(64), directAddresses: ['10.0.0.2:7777'] });
    await vi.waitFor(() => expect(native.startMachineTunnel).toHaveBeenCalledTimes(1));
    const shutdown = runtime.shutdown();

    // Native endpoint shutdown owns admission closure, cancellation and the
    // join, so JavaScript must reach it promptly instead of waiting behind the
    // in-flight creation it is supposed to cancel.
    await vi.waitFor(() => expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1));
    await shutdown;

    // A creation that resolved just before native shutdown raced publication:
    // it is released by its own owner and never handed to its caller.
    resolveCreate({
      machineTunnelId: 'tunnel-race', endpointHandle: 'endpoint-1', localPort: 48123,
      localCapability: 'c'.repeat(64), connectionActive: true, remoteEndpointId: 'b'.repeat(64),
      observedPath: 'relay', startedAtMs: 1, lastErrorCode: null,
    });
    await expect(creation).rejects.toThrow('Iroh machine runtime is shut down');
    expect(native.stopMachineTunnel).toHaveBeenCalledWith('tunnel-race');
    expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1);
  });

  it('reaches native endpoint shutdown without waiting for an in-flight Home tunnel creation, then releases the late lease', async () => {
    let resolveCreate!: (value: {
      tunnelId: string;
      endpointHandle: string;
      homeServerIdentityId: string;
      homeEndpointId: string;
      runtimeOrigin: string;
      carrier: 'iroh';
      observedPath: 'direct' | 'relay' | 'unknown';
      startedAtMs: number;
    }) => void;
    const { native, runtime } = await createHarness({
      ensureHomeTunnel: vi.fn(async () => await new Promise((resolve) => { resolveCreate = resolve; })),
    });
    expect(runtime.available).toBe(true);
    if (!runtime.available) return;

    // Admit the creation first, wait for the native creator to be called, then
    // begin shutdown, so the race is real.
    const creation = runtime.ensureHomeTunnel!({ descriptor: HOME_DESCRIPTOR });
    await vi.waitFor(() => expect(native.ensureHomeTunnel).toHaveBeenCalledTimes(1));
    const shutdown = runtime.shutdown();

    // A blocked Home dial must never gate the native shutdown that cancels it.
    await vi.waitFor(() => expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1));
    await shutdown;

    resolveCreate({
      tunnelId: 'home-tunnel-race', endpointHandle: 'endpoint-1', homeServerIdentityId: 'srv_home_iroh',
      homeEndpointId: 'c'.repeat(64), runtimeOrigin: 'http://127.0.0.1:49123', carrier: 'iroh',
      observedPath: 'direct', startedAtMs: 1,
    });

    // The racing lease is released by its own owner and never published.
    await expect(creation).rejects.toThrow('Iroh daemon runtime is shut down');
    expect(native.releaseHomeTunnel).toHaveBeenCalledWith('home-tunnel-race');
    expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1);
  });

  it('releases the subsidiary local-hop creation that raced shutdown and never publishes the machine transport', async () => {
    let resolveConnect!: (value: {
      write: (data: Uint8Array) => Promise<void>;
      endWrite: () => Promise<void>;
      onData: (listener: (data: Uint8Array) => void) => () => void;
      close: () => Promise<void>;
    }) => void;
    const connectTcp = vi.fn(async () => await new Promise<{
      write: (data: Uint8Array) => Promise<void>;
      endWrite: () => Promise<void>;
      onData: (listener: (data: Uint8Array) => void) => () => void;
      close: () => Promise<void>;
    }>((resolve) => { resolveConnect = resolve; }));
    const { native, runtime } = await createHarness({}, connectTcp);
    expect(runtime.available).toBe(true);
    if (!runtime.available) return;

    const creation = runtime.openTransport({
      alpn: 'happier/machine/1', remoteEndpointId: 'b'.repeat(64), flow: 'workspace_sync',
      operationId: 'operation-1', handshake: WORKSPACE_SYNC_HANDSHAKE as never,
    }, { endpointId: 'b'.repeat(64), directAddresses: ['10.0.0.2:7777'] });
    await vi.waitFor(() => expect(connectTcp).toHaveBeenCalledTimes(1));

    const shutdown = runtime.shutdown();
    await vi.waitFor(() => expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1));
    await shutdown;

    resolveConnect({
      write: async () => undefined,
      endWrite: async () => undefined,
      onData: () => () => undefined,
      close: async () => undefined,
    });
    await expect(creation).rejects.toThrow('Iroh machine runtime is shut down');
    expect(native.stopMachineTunnel).toHaveBeenCalledWith('tunnel-1');
    expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1);
  });

  it('settles shutdown truthfully while a creation the native owner cancels is still rejecting', async () => {
    let rejectCreate!: (error: unknown) => void;
    const { native, runtime } = await createHarness({
      startMachineTunnel: vi.fn(async () => await new Promise((_, reject) => { rejectCreate = reject; })),
    });
    expect(runtime.available).toBe(true);
    if (!runtime.available) return;

    // Admit the creation first, wait for the native creator to be called, then
    // begin shutdown, so the race is real.
    const creation = runtime.openTunnel({
      alpn: 'happier/machine/1', remoteEndpointId: 'b'.repeat(64), flow: 'workspace_sync',
      operationId: 'operation-1', handshake: WORKSPACE_SYNC_HANDSHAKE as never,
    }, { endpointId: 'b'.repeat(64), directAddresses: ['10.0.0.2:7777'] });
    await vi.waitFor(() => expect(native.startMachineTunnel).toHaveBeenCalledTimes(1));

    // Native endpoint shutdown is what cancels the in-flight creation, so it
    // must run before the creation settles.
    await runtime.shutdown();
    expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1);

    rejectCreate(new Error('native tunnel creation failed'));
    await expect(creation).rejects.toThrow('native tunnel creation failed');
    // A cancelled creation produced no custody to release.
    expect(native.stopMachineTunnel).not.toHaveBeenCalled();
  });

  it('refuses new tunnel creation after shutdown begins without calling the native creators', async () => {
    let releaseOwnedTunnel!: () => void;
    const ownedTunnelReleased = new Promise<void>((resolve) => { releaseOwnedTunnel = resolve; });
    const { native, runtime } = await createHarness({
      stopMachineTunnel: vi.fn(async () => { await ownedTunnelReleased; }),
    });
    expect(runtime.available).toBe(true);
    if (!runtime.available) return;
    const openInput = {
      alpn: 'happier/machine/1', remoteEndpointId: 'b'.repeat(64), flow: 'workspace_sync',
      operationId: 'operation-1', handshake: WORKSPACE_SYNC_HANDSHAKE as never,
    } as const;
    await runtime.openTunnel(openInput, { endpointId: 'b'.repeat(64), directAddresses: ['10.0.0.2:7777'] });

    // Native aggregate shutdown starts promptly; JavaScript cleanup remains
    // pending on the owned tunnel while later creations are refused.
    const shutdown = runtime.shutdown();
    await vi.waitFor(() => expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(native.stopMachineTunnel).toHaveBeenCalledTimes(1));

    await expect(runtime.ensureHomeTunnel!({ descriptor: HOME_DESCRIPTOR }))
      .rejects.toThrow('Iroh daemon runtime is shut down');
    await expect(runtime.openTunnel(openInput, { endpointId: 'b'.repeat(64) }))
      .rejects.toThrow('Iroh machine runtime is shut down');
    await expect(runtime.openTransport(openInput, { endpointId: 'b'.repeat(64) }))
      .rejects.toThrow('Iroh machine runtime is shut down');
    expect(native.ensureHomeTunnel).not.toHaveBeenCalled();
    expect(native.startMachineTunnel).toHaveBeenCalledTimes(1);

    releaseOwnedTunnel();
    await shutdown;
    expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1);
  });

  it('attempts and settles every owned tunnel cleanup before shutdown proceeds or fails, keeping failed custody retryable', async () => {
    const stopCalls: string[] = [];
    let failTunnelStop = true;
    let releaseBlockingStop!: () => void;
    const blockingStopReleased = new Promise<void>((resolve) => { releaseBlockingStop = resolve; });
    let tunnelSeq = 0;
    const { native, runtime } = await createHarness({
      startMachineTunnel: vi.fn(async () => {
        tunnelSeq += 1;
        return {
          machineTunnelId: `tunnel-${tunnelSeq}`, endpointHandle: 'endpoint-1', localPort: 48120 + tunnelSeq,
          localCapability: 'c'.repeat(64),
          connectionActive: true, remoteEndpointId: 'b'.repeat(64), observedPath: 'relay',
          startedAtMs: 1, lastErrorCode: null,
        };
      }),
      stopMachineTunnel: vi.fn(async (machineTunnelId: string) => {
        stopCalls.push(machineTunnelId);
        if (machineTunnelId === 'tunnel-1' && failTunnelStop) throw new Error('native tunnel stop failed');
        await blockingStopReleased;
      }),
    });
    expect(runtime.available).toBe(true);
    if (!runtime.available) return;
    const openInput = {
      alpn: 'happier/machine/1', remoteEndpointId: 'b'.repeat(64), flow: 'workspace_sync',
      operationId: 'operation-1', handshake: WORKSPACE_SYNC_HANDSHAKE as never,
    } as const;
    await runtime.openTunnel(openInput, { endpointId: 'b'.repeat(64), directAddresses: ['10.0.0.2:7777'] });
    await runtime.openTunnel(openInput, { endpointId: 'b'.repeat(64), directAddresses: ['10.0.0.2:7777'] });

    let shutdownSettled = false;
    const shutdownOutcome = runtime.shutdown();
    shutdownOutcome.then(() => { shutdownSettled = true; }, () => { shutdownSettled = true; });

    // Native endpoint cancellation starts before JavaScript waits for the
    // subsidiary closers; every closer is still attempted and settled before
    // the public wrapper resolves.
    await vi.waitFor(() => expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(stopCalls).toEqual(['tunnel-1', 'tunnel-2']));
    expect(shutdownSettled).toBe(false);

    releaseBlockingStop();
    await expect(shutdownOutcome).rejects.toThrow('native tunnel stop failed');
    expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1);

    // Failed custody stays owned and retryable; the settled release is not repeated.
    failTunnelStop = false;
    stopCalls.length = 0;
    await runtime.shutdown();
    expect(stopCalls).toEqual(['tunnel-1']);
    expect(native.shutdownEndpoint).toHaveBeenCalledTimes(1);
  });
});
