import { readProviderBrokerResponseBody } from '@/providers/broker/providerBroker.testkit';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { createProviderBrokerRouteGrantSigningInputV2, type ProviderBrokerAccountOpenResponseV2 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { createProviderBrokerMachineCarrierTunnelOpen } from '@/daemon/peer/iroh/providerBrokerMachineCarrierTunnelOpen';
import { openAccountConnectionProviderBrokerAccess, readAccountConnectionProviderBrokerFailureDiagnostic } from './accountConnectionClient';
import { logger } from '@/ui/logger';
import { ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
const capturedFacts = { expectedConnectionSecurityFingerprint: 'connection-security:v1:test',
  expectedManagedRuntimeBindingFingerprint: 'managed-runtime-binding:v1:test' };

describe('personal connection broker consumer', () => {
  it.each([
    ['broker_open_refused', undefined, 'ordinary'],
    ['binding_invalid', undefined, 'ordinary'],
    ['binding_invalid', undefined, 'signature'],
    ['tunnel_open_failed', undefined, 'ordinary'],
    ['endpoint_discovery_failed', 403, 'ordinary'],
    ['endpoint_discovery_failed', 204, 'ordinary'],
    ['endpoint_discovery_failed', undefined, 'socket'],
    ['endpoint_discovery_failed', undefined, 'timeout'],
    ['endpoint_discovery_failed', undefined, 'abort'],
    ['endpoint_discovery_failed', undefined, 'unknown'],
    ['endpoint_discovery_failed', undefined, 'refresh'],
    ['endpoint_discovery_failed', 403, 'typed_http'],
    ['endpoint_discovery_failed', 403, 'source_refusal'],
  ] as const)('logs the private %s branch (HTTP %s, %s) without disclosing broker material', async (reason, httpStatus, variant) => {
    const connectionId = ProviderConnectionIdSchema.parse('gateway-1');
    const application = { agentTargetKey: 'backend:claude:built_in', protocol: 'anthropic',
      endpointTemplateId: 'http', implementationIdentity: { pluginId: 'happier.provider.gateway', localId: 'gateway' } } as const;
    const consumer = { kind: 'session', sessionId: 'session-1' } as const;
    const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const payload = { v: 2, grantId: 'grant-1', aud: 'happier-provider-broker-route-v2',
      issuedAt: 100, expiresAt: 200, homeId: 'home-1', accountId: 'account-1',
      source: { kind: 'account_connection', connectionId, ...capturedFacts }, initiatorTokenEpoch: 0,
      initiator: { accountId: 'account-1', machineId: 'worker-1', endpointId: 'a'.repeat(64) },
      target: { custodianAccountId: 'account-1', machineId: 'hub-1', endpointId: 'b'.repeat(64) }, consumer, application } as const;
    const opened: Extract<ProviderBrokerAccountOpenResponseV2, { ok: true }> = {
      ok: true, authority: { payload, signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: Buffer.from(tweetnacl.sign.detached(
        Buffer.from(createProviderBrokerRouteGrantSigningInputV2(payload)), key.secretKey,
      )).toString('base64url') } },
      target: { custodianAccountId: 'account-1', brokerMachineId: 'hub-1', endpointId: 'b'.repeat(64), endpointRevision: 1,
        endpoint: { endpointId: 'b'.repeat(64) } },
    };
    if (variant === 'signature') opened.authority.signature.valueBase64Url = Buffer.alloc(64).toString('base64url');
    let publishedClosed = false;
    let retirementAcknowledged = false;
    let nativeOpens = 0;
    let homeReads = 0;
    // A real closed HTTP connection reproduces c72's no-status discovery shape.
    const discoveryServer = variant === 'socket' ? createServer((request) => request.socket.destroy()) : null;
    let localPort = 43123;
    if (discoveryServer) {
      discoveryServer.listen(0, '127.0.0.1');
      await once(discoveryServer, 'listening');
      const address = discoveryServer.address();
      if (!address || typeof address === 'string') throw new Error('Missing discovery listener');
      localPort = address.port;
    }
    // Home issuance/admission, native transport, and HTTP are system boundaries.
    // The signed binding verifier and Account broker consumer remain real.
    const openTunnel = createProviderBrokerMachineCarrierTunnelOpen({ homeId: 'home-1', accountId: 'account-1', localMachineId: 'worker-1',
      runtime: { endpoint: { endpointId: 'a'.repeat(64) }, openHttpTunnel: async () => {
        if (reason === 'tunnel_open_failed') throw new Error('synthetic-private-native-error?token=do-not-log');
        const first = nativeOpens++ === 0;
        return { localPort, localCapability: 'c'.repeat(64), observedPath: 'unknown', remoteEndpointId: 'b'.repeat(64),
          close: async () => { if (first) publishedClosed = true; } };
      } }, resolveTrustRoots: () => [{ keyId: 'home', publicKey: Buffer.from(key.publicKey).toString('base64url') }], nowMs: () => 150,
      fetchImpl: async (_request, options) => {
        expect(options?.method).toBe('DELETE');
        retirementAcknowledged = true;
        return new Response(null, { status: 204 });
      } });
    const warning = vi.spyOn(logger, 'warnLocalFile');
    try {
      const error = await openAccountConnectionProviderBrokerAccess({ homeId: 'home-1', accountId: 'account-1',
        initiatorMachineId: 'worker-1', targetMachineId: reason === 'binding_invalid' && variant !== 'signature' ? 'different-hub' : 'hub-1',
        connectionId, consumer, application, ...capturedFacts, signal: new AbortController().signal,
        openBroker: async () => {
          homeReads++;
          if (reason === 'broker_open_refused') return { ok: false, reasonCode: 'broker_unavailable' };
          return variant === 'refresh' && homeReads > 1 ? { ok: false, reasonCode: 'resource_unavailable' } : opened;
        },
        openTunnel,
        fetchImpl: async (request, options) => {
          if (variant === 'socket') return await fetch(request, options);
          if (variant === 'timeout') throw new DOMException('private-url?token=do-not-log', 'TimeoutError');
          if (variant === 'abort') throw new DOMException('private-url?token=do-not-log', 'AbortError');
          if (variant === 'unknown') throw Object.assign(new Error('private-url?token=do-not-log'), {
            name: 'private-name-do-not-log', code: 'private-code-do-not-log',
          });
          return new Response(null, { status: httpStatus ?? 204,
            headers: { 'x-happier-provider-endpoint-path': httpStatus === 204 ? 'https://private.example/?token=do-not-log' : '/',
              ...(variant === 'typed_http' ? { 'x-happier-provider-broker-error-code': 'resource_unavailable' } : {}),
              ...(variant === 'source_refusal' ? { 'x-happier-provider-broker-error-code': 'provider_endpoint_rate_limited' } : {}) } });
        },
      }).then(() => { throw new Error('Expected broker refusal'); }, (error: unknown) => error);
      // Tunnel exceptions retain their existing shape; diagnostics must not alter settlement.
      if (reason !== 'tunnel_open_failed' && variant !== 'signature') expect(ProviderErrorV1Schema.parse(error).code)
        .toBe(variant === 'source_refusal' ? 'provider_endpoint_rate_limited' : 'provider_endpoint_unavailable');
      const records = warning.mock.calls.filter(([label]) => label === '[ProviderBroker] Account connection open refused');
      const diagnostic = {
        ...(reason === 'broker_open_refused' ? { admissionReasonCode: 'broker_unavailable' } : {}),
        ...(variant === 'refresh' || variant === 'typed_http' ? { admissionReasonCode: 'resource_unavailable' } : {}),
        ...(variant === 'source_refusal' ? { admissionReasonCode: 'provider_endpoint_rate_limited' } : {}),
        reason, ...(httpStatus === undefined ? {} : { httpStatus }),
        ...(reason === 'endpoint_discovery_failed' ? { discoveryCause: variant === 'socket' ? 'socket_closed'
          : variant === 'timeout' ? 'timeout' : variant === 'abort' ? 'aborted' : variant === 'unknown' ? 'transport_error'
            : variant === 'refresh' ? 'broker_refresh_refused' : httpStatus === 204 ? 'invalid_metadata' : 'http_response' } : {}),
      };
      expect(records).toEqual([['[ProviderBroker] Account connection open refused', diagnostic]]);
      expect(readAccountConnectionProviderBrokerFailureDiagnostic(error)).toEqual(diagnostic);
      const serialized = JSON.stringify(records);
      for (const privateValue of ['do-not-log', 'synthetic-private', 'home-1', 'account-1', 'gateway-1', 'worker-1', 'hub-1', 'a'.repeat(64), opened.authority.signature.valueBase64Url]) {
        expect(serialized).not.toContain(privateValue);
      }
      if (variant === 'refresh') {
        expect(homeReads).toBe(2); // Refusal settles without a new Home read or native dial.
        expect(nativeOpens).toBe(0);
      } else if (reason === 'endpoint_discovery_failed') {
        expect(publishedClosed).toBe(true);
        expect(retirementAcknowledged).toBe(true);
      }
    } finally {
      warning.mockRestore();
      await new Promise<void>(resolve => discoveryServer ? discoveryServer.close(() => resolve()) : resolve());
    }
  });
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
      signal: new AbortController().signal, openBroker: async () => opened,
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
  it('publishes only the exact admitted source and forwards decoded streamed bytes without replay', async () => {
    let effects = 0;
    let admitted = true;
    let openReads = 0;
    let declaredEndpointPath = '/';
    const server = createServer((request, response) => {
      if (request.url === '/v1/_happier/provider-broker/endpoint') {
        response.writeHead(204, { 'x-happier-provider-endpoint-path': declaredEndpointPath }).end();
        return;
      }
      if (!admitted) { response.writeHead(403).end(); return; }
      effects++;
      const encoded = gzipSync('data: admitted\n\n');
      response.writeHead(200, { 'content-type': 'text/event-stream',
        'content-encoding': 'gzip', 'content-length': String(encoded.length) });
      response.end(encoded);
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
    let carrierClosed = false;
    let retirementAttempt = 0;
    try {
      const access = await openAccountConnectionProviderBrokerAccess({ homeId: 'home-1', accountId: 'account-1',
        initiatorMachineId: 'worker-1', targetMachineId: 'hub-1', connectionId, consumer, application, ...capturedFacts,
        signal: new AbortController().signal, openBroker: async () => { openReads++; return opened; },
        openTunnel: async () => ({ localPort: address.port, localCapability: 'c'.repeat(64), observedPath: 'relay',
          retire: async () => { if (++retirementAttempt === 1) throw new Error('Home is unavailable during retirement'); },
          close: async () => { carrierClosed = true; } }) });
      const result = await access.access.request({ method: 'POST', pathAndQuery: '/v1/messages', body: new TextEncoder().encode('{}') });
      expect(await new Response(await readProviderBrokerResponseBody(result.body)).text()).toBe('data: admitted\n\n');
      expect(result.headers['content-encoding']).toBeUndefined();
      expect(result.headers['content-length']).toBeUndefined();
      expect(effects).toBe(1);
      // The Home-issued open and target per-request admission are the owners;
      // reading this local binding must not add another Home round trip.
      expect(openReads).toBe(1);
      admitted = false;
      await expect(access.readHttpBinding()).resolves.toHaveProperty('endpointUrl');
      expect(await access.access.request({ method: 'POST', pathAndQuery: '/v1/messages' })).toMatchObject({ status: 403 });
      expect(openReads).toBe(1);
      expect(effects).toBe(1);
      admitted = true;
      await expect(access.readHttpBinding()).resolves.toMatchObject({ endpointUrl: `http://127.0.0.1:${address.port}/` });
      await expect(access.cleanup()).rejects.toThrow('Home is unavailable during retirement');
      expect(carrierClosed).toBe(true);
      await expect(access.cleanup()).resolves.toBeUndefined();
      expect(effects).toBe(1);
      await expect(access.readHttpBinding()).rejects.toMatchObject({ code: 'provider_endpoint_unavailable' });
      await expect(openAccountConnectionProviderBrokerAccess({ homeId: 'home-1', accountId: 'account-1',
        initiatorMachineId: 'worker-1', targetMachineId: 'different-hub', connectionId, consumer, application, ...capturedFacts,
        signal: new AbortController().signal, openBroker: async () => opened,
        openTunnel: async () => { throw new Error('unadmitted transport reached'); } })).rejects.toMatchObject({ code: 'provider_endpoint_unavailable' });
      const runConsumer = { kind: 'execution_run', executionRunId: 'run-1' } as const;
      const runOpened: Extract<ProviderBrokerAccountOpenResponseV2, { ok: true }> = { ...opened,
        authority: { ...opened.authority, payload: { ...opened.authority.payload,
          consumer: runConsumer, executionRunOccurrenceId: 'current-occurrence' } } };
      await expect(openAccountConnectionProviderBrokerAccess({ homeId: 'home-1', accountId: 'account-1',
        initiatorMachineId: 'worker-1', targetMachineId: 'hub-1', connectionId, consumer: runConsumer, application, ...capturedFacts,
        executionRunOccurrenceId: 'captured-other-occurrence', signal: new AbortController().signal,
        openBroker: async () => runOpened,
        openTunnel: async () => { throw new Error('Different Run occurrence reached transport'); } })).rejects.toMatchObject({ code: 'provider_endpoint_unavailable' });
      const runAccess = await openAccountConnectionProviderBrokerAccess({ homeId: 'home-1', accountId: 'account-1',
        initiatorMachineId: 'worker-1', targetMachineId: 'hub-1', connectionId, consumer: runConsumer, application, ...capturedFacts,
        executionRunOccurrenceId: 'current-occurrence', signal: new AbortController().signal,
        openBroker: async () => runOpened,
        openTunnel: async () => ({ localPort: address.port, localCapability: 'd'.repeat(64), observedPath: 'direct',
          retire: async () => {}, close: async () => {} }) });
      await expect(runAccess.readHttpBinding()).resolves.toMatchObject({ endpointUrl: `http://127.0.0.1:${address.port}/` });
      await runAccess.cleanup();
      declaredEndpointPath = 'https://unrelated.example/v1';
      let unpublishedRetired = false;
      let unpublishedClosed = false;
      await expect(openAccountConnectionProviderBrokerAccess({ homeId: 'home-1', accountId: 'account-1',
        initiatorMachineId: 'worker-1', targetMachineId: 'hub-1', connectionId, consumer, application, ...capturedFacts,
        signal: new AbortController().signal, openBroker: async () => opened,
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
