import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { createProviderBrokerRouteGrantSigningInputV2, type ProviderBrokerAccountOpenResponseV2 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { createProviderBrokerMachineCarrierTunnelOpen } from '@/daemon/peer/iroh/providerBrokerMachineCarrierTunnelOpen';
import { openAccountConnectionProviderBrokerAccess } from './accountConnectionClient';
const capturedFacts = { expectedConnectionSecurityFingerprint: 'connection-security:v1:test',
  expectedManagedRuntimeBindingFingerprint: 'managed-runtime-binding:v1:test' };

describe('personal connection broker consumer', () => {
  it('withdraws the old bearer listener while remote retirement remains pending', async () => {
    const connectionId = ProviderConnectionIdSchema.parse('gateway-1');
    const application = { agentTargetKey: 'backend:claude:built_in', protocol: 'anthropic',
      endpointTemplateId: 'http', implementationIdentity: { pluginId: 'happier.provider.gateway', localId: 'gateway' } } as const;
    const consumer = { kind: 'session', sessionId: 'session-1' } as const;
    const opened: Extract<ProviderBrokerAccountOpenResponseV2, { ok: true }> = {
      ok: true, authority: { payload: { v: 2, grantId: 'grant-1', aud: 'happier-provider-broker-route-v2',
        issuedAt: 100, expiresAt: 200, homeId: 'home-1', accountId: 'account-1',
        source: { kind: 'account_connection', connectionId, ...capturedFacts }, initiatorTokenEpoch: 0,
        initiator: { accountId: 'account-1', machineId: 'worker-1', endpointId: 'a'.repeat(64) },
        target: { custodianAccountId: 'account-1', machineId: 'hub-1', endpointId: 'b'.repeat(64) }, consumer, application },
        signature: { alg: 'Ed25519', keyId: 'key-1', valueBase64Url: Buffer.alloc(64).toString('base64url') } },
      target: { custodianAccountId: 'account-1', brokerMachineId: 'hub-1', endpointId: 'b'.repeat(64), endpointRevision: 1,
        endpoint: { endpointId: 'b'.repeat(64) } },
    };
    const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    opened.authority.signature = { alg: 'Ed25519', keyId: 'home', valueBase64Url: Buffer.from(tweetnacl.sign.detached(
      Buffer.from(createProviderBrokerRouteGrantSigningInputV2(opened.authority.payload)), key.secretKey,
    )).toString('base64url') };
    let finishRetirement!: () => void;
    const retirement = new Promise<void>(resolve => { finishRetirement = resolve; });
    let retirementStarted!: () => void;
    const started = new Promise<void>(resolve => { retirementStarted = resolve; });
    const listeners: Array<() => Promise<void>> = [];
    const openHttpTunnel = async () => {
      const capability = (listeners.length === 0 ? 'c' : 'd').repeat(64);
      const server = createServer(async (request, response) => {
        if (request.headers['x-happier-machine-local-capability'] !== capability) {
          response.writeHead(403).end();
          return;
        }
        if (request.url === '/v1/_happier/provider-broker/endpoint') {
          response.writeHead(204, { 'x-happier-provider-endpoint-path': '/' }).end();
        } else if (request.method === 'DELETE') {
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
      return { localPort: address.port, localCapability: capability, observedPath: 'relay' as const,
        remoteEndpointId: 'b'.repeat(64), close };
    };
    const openTunnel = createProviderBrokerMachineCarrierTunnelOpen({ homeId: 'home-1', accountId: 'account-1',
      localMachineId: 'worker-1',
      // The native transport is the external boundary; the signature, exact
      // peer binding and retirement lifecycle remain the real carrier owner.
      runtime: { endpoint: { endpointId: 'a'.repeat(64) }, openHttpTunnel } as never,
      resolveTrustRoots: () => [{ keyId: 'home', publicKey: Buffer.from(key.publicKey).toString('base64url') }], nowMs: () => 150 });
    const access = await openAccountConnectionProviderBrokerAccess({ homeId: 'home-1', accountId: 'account-1',
      initiatorMachineId: 'worker-1', targetMachineId: 'hub-1', connectionId, consumer, application, ...capturedFacts,
      signal: new AbortController().signal, openBroker: async () => opened, admitConsumer: async () => true,
      openTunnel });
    const binding = await access.readHttpBinding();
    let cleanup: Promise<void> | null = null;
    try {
      expect(await (await fetch(binding.endpointUrl, { headers: binding.headers })).text()).toBe('reachable');
      cleanup = Promise.resolve(access.cleanup());
      await started;
      await expect(fetch(binding.endpointUrl, { headers: binding.headers })).rejects.toBeDefined();
    } finally {
      finishRetirement();
      await cleanup;
      await Promise.all(listeners.map(close => close()));
    }
  });
  it('publishes only the exact admitted source and forwards streamed bytes without replay', async () => {
    let effects = 0;
    let declaredEndpointPath = '/';
    const server = createServer((request, response) => {
      if (request.url === '/v1/_happier/provider-broker/endpoint') {
        response.writeHead(204, { 'x-happier-provider-endpoint-path': declaredEndpointPath }).end();
        return;
      }
      effects++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: admitted\n\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listener unavailable');
    const application = { agentTargetKey: 'backend:claude:built_in', protocol: 'anthropic',
      endpointTemplateId: 'http', implementationIdentity: { pluginId: 'happier.provider.gateway', localId: 'gateway' } } as const;
    const connectionId = ProviderConnectionIdSchema.parse('gateway-1');
    const consumer = { kind: 'session', sessionId: 'session-1' } as const;
    const opened: Extract<ProviderBrokerAccountOpenResponseV2, { ok: true }> = {
      ok: true,
      authority: { payload: { v: 2, grantId: 'grant-1', aud: 'happier-provider-broker-route-v2',
        issuedAt: 100, expiresAt: 200, homeId: 'home-1', accountId: 'account-1',
        source: { kind: 'account_connection', connectionId, ...capturedFacts }, initiatorTokenEpoch: 0,
        initiator: { accountId: 'account-1', machineId: 'worker-1', endpointId: 'a'.repeat(64) },
        target: { custodianAccountId: 'account-1', machineId: 'hub-1', endpointId: 'b'.repeat(64) }, consumer, application },
        signature: { alg: 'Ed25519', keyId: 'key-1', valueBase64Url: Buffer.alloc(64).toString('base64url') } },
      target: { custodianAccountId: 'account-1', brokerMachineId: 'hub-1', endpointId: 'b'.repeat(64), endpointRevision: 1,
        endpoint: { endpointId: 'b'.repeat(64) } },
    };
    let admitted = true;
    let pendingAdmission: Promise<boolean> | null = null;
    let carrierClosed = false;
    let retirementAttempt = 0;
    try {
      const access = await openAccountConnectionProviderBrokerAccess({ homeId: 'home-1', accountId: 'account-1',
        initiatorMachineId: 'worker-1', targetMachineId: 'hub-1', connectionId, consumer, application, ...capturedFacts,
        signal: new AbortController().signal, openBroker: async () => opened,
        admitConsumer: async () => pendingAdmission ? await pendingAdmission : admitted,
        openTunnel: async () => ({ localPort: address.port, localCapability: 'c'.repeat(64), observedPath: 'relay',
          retire: async () => { if (++retirementAttempt === 1) throw new Error('Home is unavailable during retirement'); },
          close: async () => { carrierClosed = true; } }) });
      const result = await access.access.request({ method: 'POST', pathAndQuery: '/v1/messages', body: new TextEncoder().encode('{}') });
      expect(await new Response(result.body).text()).toBe('data: admitted\n\n');
      expect(effects).toBe(1);
      admitted = false;
      await expect(access.readHttpBinding()).rejects.toMatchObject({ code: 'provider_endpoint_unavailable' });
      expect(effects).toBe(1);
      admitted = true;
      let finishAdmission!: (value: boolean) => void;
      pendingAdmission = new Promise<boolean>(resolve => { finishAdmission = resolve; });
      const pendingBinding = access.readHttpBinding();
      await expect(access.cleanup()).rejects.toThrow('Home is unavailable during retirement');
      expect(carrierClosed).toBe(true);
      finishAdmission(true);
      await expect(pendingBinding).rejects.toMatchObject({ code: 'provider_endpoint_unavailable' });
      await expect(access.cleanup()).resolves.toBeUndefined();
      expect(effects).toBe(1);
      await expect(access.readHttpBinding()).rejects.toMatchObject({ code: 'provider_endpoint_unavailable' });
      await expect(openAccountConnectionProviderBrokerAccess({ homeId: 'home-1', accountId: 'account-1',
        initiatorMachineId: 'worker-1', targetMachineId: 'different-hub', connectionId, consumer, application, ...capturedFacts,
        signal: new AbortController().signal, openBroker: async () => opened, admitConsumer: async () => true,
        openTunnel: async () => { throw new Error('unadmitted transport reached'); } })).rejects.toMatchObject({ code: 'provider_endpoint_unavailable' });
      const runConsumer = { kind: 'execution_run', executionRunId: 'run-1' } as const;
      const runOpened: Extract<ProviderBrokerAccountOpenResponseV2, { ok: true }> = { ...opened,
        authority: { ...opened.authority, payload: { ...opened.authority.payload,
          consumer: runConsumer, executionRunOccurrenceId: 'current-occurrence' } } };
      await expect(openAccountConnectionProviderBrokerAccess({ homeId: 'home-1', accountId: 'account-1',
        initiatorMachineId: 'worker-1', targetMachineId: 'hub-1', connectionId, consumer: runConsumer, application, ...capturedFacts,
        executionRunOccurrenceId: 'captured-other-occurrence', signal: new AbortController().signal,
        openBroker: async () => runOpened, admitConsumer: async () => true,
        openTunnel: async () => { throw new Error('Different Run occurrence reached transport'); } })).rejects.toMatchObject({ code: 'provider_endpoint_unavailable' });
      const runAccess = await openAccountConnectionProviderBrokerAccess({ homeId: 'home-1', accountId: 'account-1',
        initiatorMachineId: 'worker-1', targetMachineId: 'hub-1', connectionId, consumer: runConsumer, application, ...capturedFacts,
        executionRunOccurrenceId: 'current-occurrence', signal: new AbortController().signal,
        openBroker: async () => runOpened, admitConsumer: async () => true,
        openTunnel: async () => ({ localPort: address.port, localCapability: 'd'.repeat(64), observedPath: 'direct',
          retire: async () => {}, close: async () => {} }) });
      await expect(runAccess.readHttpBinding()).resolves.toMatchObject({ endpointUrl: `http://127.0.0.1:${address.port}/` });
      await runAccess.cleanup();
      declaredEndpointPath = 'https://unrelated.example/v1';
      let unpublishedRetired = false;
      let unpublishedClosed = false;
      await expect(openAccountConnectionProviderBrokerAccess({ homeId: 'home-1', accountId: 'account-1',
        initiatorMachineId: 'worker-1', targetMachineId: 'hub-1', connectionId, consumer, application, ...capturedFacts,
        signal: new AbortController().signal, openBroker: async () => opened, admitConsumer: async () => true,
        openTunnel: async () => ({ localPort: address.port, localCapability: 'e'.repeat(64), observedPath: 'direct',
          retire: async () => { unpublishedRetired = true; }, close: async () => { unpublishedClosed = true; } }),
      })).rejects.toMatchObject({ code: 'provider_endpoint_unavailable' });
      expect(unpublishedRetired).toBe(true);
      expect(unpublishedClosed).toBe(true);
      expect(effects).toBe(1);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
