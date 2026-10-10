import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import tweetnacl from 'tweetnacl';

import {
  createProviderBrokerRouteGrantSigningInputV1,
  type ProviderBrokerOpenResponseV1,
  type ProviderBrokerRouteGrantPayloadV1,
  type SignedProviderBrokerRouteGrantV1,
} from '@happier-dev/protocol';
import { createProviderBrokerMachineCarrierTunnelOpen } from './providerBrokerMachineCarrierTunnelOpen';
import type { DaemonMachineIrohRuntime } from './daemonMachineIrohRuntime';
import { PROVIDER_BROKER_PRIVATE_CLOSE_PATH } from '@/providers/broker/providerBrokerPrivateProtocol';

const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const root = { keyId: 'home', publicKey: Buffer.from(key.publicKey).toString('base64url') };
const initiatorEndpoint = 'a'.repeat(64);
const targetEndpoint = 'b'.repeat(64);

function authority(overrides: Partial<ProviderBrokerRouteGrantPayloadV1> = {}): SignedProviderBrokerRouteGrantV1 {
  const payload: ProviderBrokerRouteGrantPayloadV1 = {
    v: 1,
    grantId: 'grant-1',
    aud: 'happier-provider-broker-route-v1',
    issuedAt: 100,
    expiresAt: 10_000,
    teamId: 'team-1',
    resourceId: 'resource-1',
    sourceRevision: 'source-revision-7',
    brokerPlacementFingerprint: 'c'.repeat(64),
    initiatorTokenEpoch: 0,
    initiator: { accountId: 'account-worker', machineId: 'machine-worker', endpointId: initiatorEndpoint },
    target: { custodianAccountId: 'account-custodian', machineId: 'machine-broker', endpointId: targetEndpoint },
    consumer: { kind: 'session', sessionId: 'session-1' },
    application: {
      agentTargetKey: 'codex',
      implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
      endpointTemplateId: 'cliproxyapi-openai-responses',
      protocol: 'openai-responses',
    },
    ...overrides,
  };
  return {
    payload,
    signature: {
      alg: 'Ed25519',
      keyId: 'home',
      valueBase64Url: Buffer.from(tweetnacl.sign.detached(
        Buffer.from(createProviderBrokerRouteGrantSigningInputV1(payload)),
        key.secretKey,
      )).toString('base64url'),
    },
  };
}

function brokerOpen(
  signed: SignedProviderBrokerRouteGrantV1 = authority(),
  targetOverrides: Partial<Extract<ProviderBrokerOpenResponseV1, { ok: true }>['target']> = {},
): Extract<ProviderBrokerOpenResponseV1, { ok: true }> {
  return {
    ok: true,
    authority: signed,
    target: {
      custodianAccountId: signed.payload.target.custodianAccountId,
      brokerMachineId: signed.payload.target.machineId,
      endpointId: signed.payload.target.endpointId,
      endpointRevision: 7,
      endpoint: {
        endpointId: targetOverrides.endpointId ?? signed.payload.target.endpointId,
        directAddresses: ['10.0.0.2:7777'],
        relayUrls: ['https://target-relay.example.test/'],
      },
      ...targetOverrides,
    },
  };
}

describe('createProviderBrokerMachineCarrierTunnelOpen', () => {
  it.each([
    { consumer: { kind: 'session' as const, sessionId: 'session-1' } },
    { consumer: { kind: 'execution_run' as const, executionRunId: 'run-1' }, executionRunOccurrenceId: 'run-occurrence-1' },
  ])('uses the complete Home-signed cross-Account target without broad Machine-read authority ($consumer.kind)', async (consumerBinding) => {
    const close = vi.fn(async () => undefined);
    const openHttpTunnel = vi.fn<DaemonMachineIrohRuntime['openHttpTunnel']>(async () => ({
      localPort: 41_001,
      localCapability: 'c'.repeat(64),
      remoteEndpointId: targetEndpoint,
      observedPath: 'relay' as const,
      close,
    }));
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker',
      localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root],
      nowMs: () => 200,
    });

    const opened = brokerOpen(authority(consumerBinding));
    const refreshBrokerOpen = vi.fn(async () => brokerOpen(authority({ ...consumerBinding, grantId: 'grant-2' })));

    await expect(open({ brokerOpen: opened, refreshBrokerOpen })).resolves.toMatchObject({
      localPort: 41_001,
      localCapability: 'c'.repeat(64),
      observedPath: 'relay',
    });
    expect(openHttpTunnel).toHaveBeenCalledWith(expect.objectContaining({
      flow: 'provider_broker',
      remoteEndpointId: targetEndpoint,
      handshake: { v: 1, kind: 'provider_broker', authority: expect.any(Object) },
    }), opened.target.endpoint);
    const transport = openHttpTunnel.mock.calls[0]?.[0];
    await expect(transport?.handshakeProvider?.()).resolves.toEqual({
      v: 1,
      kind: 'provider_broker',
      authority: expect.objectContaining({ payload: expect.objectContaining({ grantId: 'grant-2' }) }),
    });
    expect(refreshBrokerOpen).toHaveBeenCalledOnce();
  });

  it('withdraws the Team bearer listener while exact signed retirement is pending', async () => {
    let finishRetirement!: () => void;
    const retirement = new Promise<void>(resolve => { finishRetirement = resolve; });
    let retirementStarted!: () => void;
    const started = new Promise<void>(resolve => { retirementStarted = resolve; });
    const listeners: Array<() => Promise<void>> = [];
    const openHttpTunnel: DaemonMachineIrohRuntime['openHttpTunnel'] = async () => {
      const localCapability = (listeners.length === 0 ? 'c' : 'd').repeat(64);
      const server = createServer(async (request, response) => {
        if (request.headers['x-happier-machine-local-capability'] !== localCapability) {
          response.writeHead(403).end();
          return;
        }
        if (request.method === 'DELETE') {
          retirementStarted();
          await retirement;
          response.writeHead(204).end();
        } else response.end('reachable');
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('listener unavailable');
      let closing: Promise<void> | null = null;
      const close = () => closing ??= new Promise<void>(resolve => { server.close(() => resolve()); });
      listeners.push(close);
      return { localPort: address.port, localCapability, remoteEndpointId: targetEndpoint, observedPath: 'relay', close };
    };
    const open = createProviderBrokerMachineCarrierTunnelOpen({ accountId: 'account-worker', localMachineId: 'machine-worker',
      // Native HTTP is the genuine OS boundary; route signing, peer checks and
      // retirement remain the canonical carrier implementation.
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root], nowMs: () => 200 });
    const tunnel = await open({ brokerOpen: brokerOpen() });
    const endpointUrl = `http://127.0.0.1:${tunnel.localPort}/v1`;
    const headers = { authorization: `Bearer ${tunnel.localCapability}`, 'x-happier-machine-local-capability': tunnel.localCapability };
    let retiring: Promise<void> | null = null;
    try {
      expect(await (await fetch(endpointUrl, { headers })).text()).toBe('reachable');
      retiring = tunnel.retire();
      await started;
      await expect(fetch(endpointUrl, { headers })).rejects.toBeDefined();
    } finally {
      finishRetirement();
      await retiring;
      await Promise.all(listeners.map(close => close()));
    }
  });

  it('retires the signed broker stream on an unpublished capability after withdrawing the consumer', async () => {
    const order: string[] = [];
    const close = vi.fn(async () => { order.push('transport-close'); });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      order.push('retire-ack');
      expect(init).toMatchObject({
        method: 'DELETE',
        redirect: 'error',
        headers: expect.objectContaining({
          authorization: expect.stringMatching(/^Bearer /),
          'x-happier-machine-local-capability': 'd'.repeat(64),
        }),
      });
      return new Response(null, { status: 204 });
    });
    let opened = 0;
    const openHttpTunnel = vi.fn<DaemonMachineIrohRuntime['openHttpTunnel']>(async () => ({
      localPort: 41_001 + opened,
      localCapability: (opened++ === 0 ? 'c' : 'd').repeat(64),
      remoteEndpointId: targetEndpoint,
      observedPath: 'relay' as const,
      close,
    }));
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker',
      localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root],
      nowMs: () => 200,
      fetchImpl,
    });

    const tunnel = await open({ brokerOpen: brokerOpen() });
    await tunnel.retire();
    await tunnel.retire();
    await tunnel.close();

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`http://127.0.0.1:41002${PROVIDER_BROKER_PRIVATE_CLOSE_PATH}`);
    expect(order).toEqual(['transport-close', 'retire-ack', 'transport-close']);
  });

  it('releases its own claim on the retained authority, without a fresh Home admission and after cancellation', async () => {
    const binding = new AbortController();
    const close = vi.fn(async () => undefined);
    const openHttpTunnel = vi.fn<DaemonMachineIrohRuntime['openHttpTunnel']>(async () => ({
      localPort: 41_001,
      localCapability: 'c'.repeat(64),
      remoteEndpointId: targetEndpoint,
      observedPath: 'relay' as const,
      close,
    }));
    const signed = authority();
    let retireAttempt = 0;
    const fetchImpl = vi.fn(async () => {
      retireAttempt += 1;
      // The stream the DELETE travels over is dialled by the transport, which
      // runs the handshake provider for every accepted local connection.
      const transport = openHttpTunnel.mock.calls.at(-1)?.[0];
      await expect(transport?.handshakeProvider?.()).resolves.toEqual({
        v: 1,
        kind: 'provider_broker',
        authority: signed,
      });
      return new Response(null, { status: retireAttempt === 1 ? 502 : 204 });
    });
    // Home refuses a fresh inference admission precisely because the Session
    // that ended is the reason we are releasing.
    const refreshBrokerOpen = vi.fn(async () => ({ ok: false as const, reasonCode: 'session_not_active' as const }));
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker',
      localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root],
      nowMs: () => 200,
      fetchImpl,
    });

    const tunnel = await open({ brokerOpen: brokerOpen(signed), refreshBrokerOpen, signal: binding.signal });
    binding.abort();

    await expect(tunnel.retire()).rejects.toThrow();
    // The public transport stays withdrawn; a new private control channel
    // retries only the same signed claim at the exact target.
    await expect(tunnel.retire()).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(refreshBrokerOpen).not.toHaveBeenCalled();
    await expect(openHttpTunnel.mock.calls[0]?.[0].handshakeProvider?.()).rejects.toMatchObject({ code: 'broker_consumer_closed' });
  });

  it('fails a new stream closed when Home returns a changed sealed binding', async () => {
    const openHttpTunnel = vi.fn<DaemonMachineIrohRuntime['openHttpTunnel']>(async () => ({
      localPort: 41_001,
      localCapability: 'c'.repeat(64),
      remoteEndpointId: targetEndpoint,
      observedPath: 'direct' as const,
      close: vi.fn(async () => undefined),
    }));
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker', localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root], nowMs: () => 200,
    });
    await open({
      brokerOpen: brokerOpen(),
      refreshBrokerOpen: async () => brokerOpen(authority({ resourceId: 'other-resource' })),
    });
    const transport = openHttpTunnel.mock.calls[0]?.[0];
    await expect(transport?.handshakeProvider?.()).rejects.toMatchObject({ code: 'broker_binding_changed' });
  });

  it('retries a failed private control close without repeating acknowledged retirement', async () => {
    let opened = 0;
    let controlClosed = false;
    let closeFailed = false;
    let releases = 0;
    const openHttpTunnel: DaemonMachineIrohRuntime['openHttpTunnel'] = async () => {
      const control = opened++ !== 0;
      return { localPort: control ? 41002 : 41001, localCapability: (control ? 'd' : 'c').repeat(64),
        remoteEndpointId: targetEndpoint, observedPath: 'relay', close: async () => {
          if (!control) return;
          if (!closeFailed) { closeFailed = true; throw new Error('native release failed'); }
          controlClosed = true;
        } };
    };
    const open = createProviderBrokerMachineCarrierTunnelOpen({ accountId: 'account-worker', localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root], nowMs: () => 200,
      fetchImpl: async () => { releases++; return new Response(null, { status: 204 }); } });
    const tunnel = await open({ brokerOpen: brokerOpen() });
    await expect(tunnel.retire()).rejects.toThrow('native release failed');
    await expect(tunnel.retire()).resolves.toBeUndefined();
    expect(controlClosed).toBe(true);
    expect(releases).toBe(1);
    expect(opened).toBe(2);
  });

  it('requests Home again and rejects an expired witness before a later stream opens', async () => {
    const openHttpTunnel = vi.fn<DaemonMachineIrohRuntime['openHttpTunnel']>(async () => ({
      localPort: 41_004, localCapability: 'f'.repeat(64), remoteEndpointId: targetEndpoint,
      observedPath: 'direct' as const, close: vi.fn(async () => undefined),
    }));
    const times = [200, 200, 200, 20_000];
    const refreshBrokerOpen = vi.fn(async () => brokerOpen(authority({ grantId: `fresh-${refreshBrokerOpen.mock.calls.length}` })));
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker', localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root], nowMs: () => times.shift() ?? 20_000,
    });
    await open({ brokerOpen: brokerOpen(), refreshBrokerOpen });
    const provider = openHttpTunnel.mock.calls[0]?.[0].handshakeProvider;
    await expect(provider?.()).resolves.toMatchObject({ kind: 'provider_broker' });
    await expect(provider?.()).rejects.toMatchObject({ code: 'grant_expired' });
    expect(refreshBrokerOpen).toHaveBeenCalledTimes(2);
  });

  it('rejects either a substituted open witness or a tampered signed endpoint before dialing', async () => {
    const openHttpTunnel = vi.fn();
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker', localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root], nowMs: () => 200,
    });
    const signed = authority();
    const substituted = {
      ...signed,
      payload: {
        ...signed.payload,
        target: { ...signed.payload.target, endpointId: 'c'.repeat(64) },
      },
    };
    await expect(open({ brokerOpen: brokerOpen(authority(), { endpointId: 'c'.repeat(64) }) }))
      .rejects.toMatchObject({ code: 'broker_target_endpoint_changed' });
    await expect(open({ brokerOpen: brokerOpen(substituted) }))
      .rejects.toMatchObject({ code: 'grant_bad_signature' });
    await expect(open({ brokerOpen: brokerOpen(authority({
      initiator: {
        accountId: 'account-worker',
        machineId: 'machine-worker',
        endpointId: 'd'.repeat(64),
      },
    })) }))
      .rejects.toMatchObject({ code: 'broker_initiator_mismatch' });
    expect(openHttpTunnel).not.toHaveBeenCalled();
  });

  it.each(['consumer', 'control'] as const)('closes a %s tunnel whose authenticated remote identity does not match the signed target', async (phase) => {
    const close = vi.fn(async () => undefined);
    let opened = 0;
    const openHttpTunnel = vi.fn(async () => ({
      localPort: 41_002,
      localCapability: 'd'.repeat(64),
      remoteEndpointId: phase === 'control' && opened++ === 0 ? targetEndpoint : 'c'.repeat(64),
      observedPath: 'direct' as const,
      close,
    }));
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker', localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root], nowMs: () => 200,
      fetchImpl,
    });
    if (phase === 'control') {
      const tunnel = await open({ brokerOpen: brokerOpen() });
      await expect(tunnel.retire()).rejects.toMatchObject({ code: 'transport_identity_mismatch' });
    } else await expect(open({ brokerOpen: brokerOpen() })).rejects.toMatchObject({ code: 'transport_identity_mismatch' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(phase === 'control' ? 2 : 1);
  });

  it('rechecks signed authority currentness immediately before dialing', async () => {
    const openHttpTunnel = vi.fn();
    const times = [200, 20_000];
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker', localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root],
      nowMs: () => times.shift() ?? 20_000,
    });
    await expect(open({ brokerOpen: brokerOpen() })).rejects.toMatchObject({ code: 'grant_expired' });
    expect(openHttpTunnel).not.toHaveBeenCalled();
  });

  it('settles promptly on cancellation while native open is pending and closes its late tunnel', async () => {
    const close = vi.fn(async () => undefined);
    let resolveTunnel!: (value: {
      localPort: number;
      localCapability: string;
      remoteEndpointId: string;
      observedPath: 'relay';
      close(): Promise<void>;
    }) => void;
    const pendingTunnel = new Promise<Parameters<typeof resolveTunnel>[0]>((resolve) => { resolveTunnel = resolve; });
    const openHttpTunnel = vi.fn(async () => await pendingTunnel);
    const open = createProviderBrokerMachineCarrierTunnelOpen({
      accountId: 'account-worker', localMachineId: 'machine-worker',
      runtime: { endpoint: { endpointId: initiatorEndpoint }, openHttpTunnel } as never,
      resolveTrustRoots: () => [root], nowMs: () => 200,
    });
    const controller = new AbortController();
    const reason = new Error('cancelled native dial');
    const result = open({ brokerOpen: brokerOpen(), signal: controller.signal });
    await vi.waitFor(() => expect(openHttpTunnel).toHaveBeenCalledOnce());
    controller.abort(reason);

    await expect(Promise.race([
      result,
      new Promise((_, reject) => setTimeout(() => reject(new Error('cancellation did not settle')), 100)),
    ])).rejects.toBe(reason);
    resolveTunnel({
      localPort: 41_003,
      localCapability: 'e'.repeat(64),
      remoteEndpointId: targetEndpoint,
      observedPath: 'relay',
      close,
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
});
