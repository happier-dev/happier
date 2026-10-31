import { describe, expect, it, vi } from 'vitest';
import { request as requestHttp } from 'node:http';
import { connect } from 'node:net';
import tweetnacl from 'tweetnacl';
import {
  IROH_MACHINE_ADMISSION_PATH,
  IROH_MACHINE_REMOTE_ENDPOINT_HEADER,
  IROH_MACHINE_APPLICATION_PORT_HEADER,
  IROH_MACHINE_APPLICATION_CAPABILITY_HEADER,
} from '@happier-dev/iroh-native/node';
import {
  createProviderBrokerRouteGrantSigningInputV1,
  type ProviderBrokerRouteGrantPayloadV1,
  type SignedProviderBrokerRouteGrantV1,
} from '@happier-dev/protocol';
import { createPeerMediationLoopbackApp } from './server';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { logger } from '@/ui/logger';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { createProviderBrokerRouteGrantSigningInputV2, type SignedProviderBrokerRouteGrantV2 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { startDaemonProviderBrokerRuntime } from '@/providers/broker/daemonProviderBrokerRuntime';
import { createAccountConnectionBrokerSourceOpen } from '@/providers/broker/accountConnectionSource';
import { createTeamCredentialBrokerSourceOwner } from '@/providers/broker/teamCredentialBrokerSourceOwner';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { createBrokerProviderRegistry } from '@/providers/broker/providerBroker.testkit';
import { PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH, PROVIDER_BROKER_ENDPOINT_PATH_HEADER } from '@/providers/broker/providerBrokerPrivateProtocol';

const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
const sourceEndpoint = 'a'.repeat(64);
const targetEndpoint = 'b'.repeat(64);

function signedAuthority(): SignedProviderBrokerRouteGrantV1 {
  const payload: ProviderBrokerRouteGrantPayloadV1 = {
    v: 1, grantId: 'grant-1', aud: 'happier-provider-broker-route-v1', issuedAt: 100, expiresAt: 10_000,
    teamId: 'team-1', resourceId: 'resource-1',
    sourceRevision: 'source-revision-7',
    brokerPlacementFingerprint: 'c'.repeat(64),
    initiatorTokenEpoch: 0,
    initiator: { accountId: 'account-a', machineId: 'machine-a', endpointId: sourceEndpoint },
    target: { custodianAccountId: 'account-b', machineId: 'machine-b', endpointId: targetEndpoint },
    consumer: { kind: 'session', sessionId: 'session-1' },
    application: {
      agentTargetKey: 'codex',
      implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
      endpointTemplateId: 'openai-responses',
      protocol: 'openai-responses',
    },
  };
  return {
    payload,
    signature: {
      alg: 'Ed25519', keyId: 'home',
      valueBase64Url: Buffer.from(tweetnacl.sign.detached(
        Buffer.from(createProviderBrokerRouteGrantSigningInputV1(payload)), key.secretKey,
      )).toString('base64url'),
    },
  };
}

function createApp(
  resolveProviderBrokerApplicationTarget: NonNullable<Parameters<typeof createPeerMediationLoopbackApp>[0]['irohMachineAdmission']>['resolveProviderBrokerApplicationTarget'],
  nowMs = 200,
) {
  return createPeerMediationLoopbackApp({
    nowMs: () => nowMs,
    expected: { accountId: 'account-b', machineId: 'machine-b', flowKind: 'bounded_transfer', routeKind: 'loopback_direct', endpointFingerprint: 'unused' },
    trustRoots: [{ keyId: 'home', publicKey: Buffer.from(key.publicKey).toString('base64url') }],
    irohMachineAdmission: {
      localEndpointId: targetEndpoint,
      role: 'acceptor',
      allowedFlows: [],
      resolveApplicationTarget: () => null,
      resolveProviderBrokerApplicationTarget,
    },
  });
}

describe('provider-broker machine/1 admission', () => {
  it.each(['target_unavailable', 'target_failed', 'request_aborted', 'grant_invalid', 'binding_invalid'] as const)(
    'keeps %s at its carrier or private-source boundary without disclosing private errors', async reason => {
      const warning = vi.spyOn(logger, 'warnLocalFile');
      const custody = createManagedProviderExplicitStartCustody({ machineId: 'machine-b', happyHomeDir: '/unreached-broker-source' });
      const open = createAccountConnectionBrokerSourceOpen({ homeId: 'home', accountId: 'account-b', machineId: 'machine-b',
        expectedAccountSettingsScopeKey: 'scope', custody, withRegistry: async read => read(createBrokerProviderRegistry()),
        // Settings storage and Home admission are genuine boundaries. Keep the
        // real source opener, broker, signature verifier and admission route.
        getAccountSettingsSnapshot: () => {
          if (reason === 'target_failed') throw new Error('private-url?token=do-not-log');
          if (reason === 'request_aborted') throw new DOMException('private-url?token=do-not-log', 'AbortError');
          return null;
        },
        admitConsumer: async () => true,
        resolveBindingIntent: async () => { throw new Error('Unexpected credential lookup'); },
        projectModels: async () => { throw new Error('Unexpected model RPC'); },
      });
      const runtime = await startDaemonProviderBrokerRuntime({ machineId: 'machine-b',
        nowMs: () => 200, resolveTrustRoots: () => [{ keyId: 'home', publicKey: Buffer.from(key.publicKey).toString('base64url') }],
        createRequestId: () => 'request', accountConnection: { homeId: 'home', accountId: 'account-b', open,
          retire: async () => { throw new Error('Unexpected retirement'); } },
        sourceOwner: createTeamCredentialBrokerSourceOwner({ machineId: 'machine-b', custody,
          selectConnectedServicesSourceMember: async () => null, openConnectedServicesSource: async () => null,
          openProviderConnectionSource: async () => null }),
        resolveRequestPolicy: async () => { throw new Error('Unexpected Team policy'); },
        admitRequest: async () => { throw new Error('Unexpected Team admission'); },
        authorizeModelCatalog: async () => { throw new Error('Unexpected Team catalog'); },
      });
      const app = createApp(runtime.resolveProviderBrokerApplicationTarget);
      const payload: SignedProviderBrokerRouteGrantV2['payload'] = {
        v: 2, grantId: 'grant', aud: 'happier-provider-broker-route-v2', issuedAt: 100, expiresAt: 10_000,
        homeId: 'home', accountId: 'account-b', initiatorTokenEpoch: 0,
        source: { kind: 'account_connection', connectionId: ProviderConnectionIdSchema.parse('gateway'),
          expectedConnectionSecurityFingerprint: 'connection-security:v1:test',
          expectedManagedRuntimeBindingFingerprint: 'managed-runtime-binding:v1:test' },
        initiator: { accountId: 'account-b', machineId: 'machine-a', endpointId: sourceEndpoint },
        target: { custodianAccountId: 'account-b', machineId: 'machine-b', endpointId: targetEndpoint },
        consumer: { kind: 'session', sessionId: 'session' }, application: signedAuthority().payload.application,
      };
      const authority: SignedProviderBrokerRouteGrantV2 = { payload, signature: { alg: 'Ed25519', keyId: 'home',
        valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createProviderBrokerRouteGrantSigningInputV2(payload)), key.secretKey)).toString('base64url') } };
      if (reason === 'grant_invalid') authority.signature.valueBase64Url = Buffer.alloc(64).toString('base64url');
      try {
        const response = await app.inject({ method: 'POST', url: IROH_MACHINE_ADMISSION_PATH,
          headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: reason === 'binding_invalid' ? 'c'.repeat(64) : sourceEndpoint },
          payload: { v: 2, kind: 'provider_broker', authority } });
        const records = warning.mock.calls.filter(([label]) => label === '[ProviderBroker] Machine stream admission refused');
        if (reason === 'grant_invalid' || reason === 'binding_invalid') {
          expect(response.statusCode).toBe(403);
          expect(response.body).toBe('');
          expect(records).toEqual([['[ProviderBroker] Machine stream admission refused', { reason }]]);
        } else {
          expect(response.statusCode).toBe(204);
          expect(records).toEqual([]);
          const capability = String(response.headers[IROH_MACHINE_APPLICATION_CAPABILITY_HEADER.toLowerCase()]);
          const result = await new Promise<string>((resolve, reject) => {
            const socket = connect({ host: '127.0.0.1', port: Number(response.headers[IROH_MACHINE_APPLICATION_PORT_HEADER.toLowerCase()]) });
            const chunks: Buffer[] = [];
            socket.once('connect', () => socket.write(`${capability}GET ${PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`));
            socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
            socket.on('error', reject);
            socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
          });
          expect(result).toContain(reason === 'target_unavailable' ? 'HTTP/1.1 403' : 'HTTP/1.1 503');
          expect(result).not.toContain(PROVIDER_BROKER_ENDPOINT_PATH_HEADER);
          expect(JSON.parse(result.slice(result.indexOf('\r\n\r\n') + 4))).toMatchObject({ error: { code: reason === 'target_unavailable' ? 'resource_unavailable' : 'broker_unavailable' } });
          expect(result).not.toContain('do-not-log');
        }
      } finally { await app.close(); await runtime.close(); warning.mockRestore(); }
    },
  );
  it('admits a Home-signed personal connection epoch without inventing a Team resource', async () => {
    const payload = {
      v: 2, grantId: 'personal-grant', aud: 'happier-provider-broker-route-v2',
      issuedAt: 100, expiresAt: 10_000, homeId: 'home-1', accountId: 'account-b',
      source: { kind: 'account_connection', connectionId: 'gateway-1',
        expectedConnectionSecurityFingerprint: 'connection-security:v1:test',
        expectedManagedRuntimeBindingFingerprint: 'managed-runtime-binding:v1:test' },
      initiatorTokenEpoch: 0,
      initiator: { accountId: 'account-b', machineId: 'machine-a', endpointId: sourceEndpoint },
      target: { custodianAccountId: 'account-b', machineId: 'machine-b', endpointId: targetEndpoint },
      consumer: { kind: 'session', sessionId: 'session-1' },
      application: signedAuthority().payload.application,
    };
    const authority = { payload, signature: {
      alg: 'Ed25519', keyId: 'home', valueBase64Url: Buffer.from(tweetnacl.sign.detached(
        Buffer.from(createCanonicalJsonSigningInput(payload)), key.secretKey,
      )).toString('base64url'),
    } };
    const resolveTarget = vi.fn(async () => ({ port: 46_123 }));
    const app = createApp(resolveTarget);
    try {
      const response = await app.inject({
        method: 'POST', url: IROH_MACHINE_ADMISSION_PATH,
        headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: sourceEndpoint },
        payload: { v: 2, kind: 'provider_broker', authority },
      });
      expect(response.statusCode).toBe(204);
      expect(resolveTarget.mock.calls).toHaveLength(1);
      const substitution = await app.inject({
        method: 'POST', url: IROH_MACHINE_ADMISSION_PATH,
        headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: 'c'.repeat(64) },
        payload: { v: 2, kind: 'provider_broker', authority },
      });
      expect(substitution.statusCode).toBe(403);
      expect(resolveTarget.mock.calls).toHaveLength(1);
    } finally { await app.close(); }
  });
  it('cancels target resolution when the admission client disconnects and admits an immediate retry', async () => {
    let attempts = 0;
    let observedSignal: AbortSignal | undefined;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const app = createApp(async ({ signal }) => {
      attempts += 1;
      observedSignal = signal;
      resolveStarted();
      if (attempts === 1) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return { port: 46_123 };
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('admission listener did not bind');
    const authority = signedAuthority();
    const body = JSON.stringify({ v: 1, kind: 'provider_broker', authority });
    const client = requestHttp({
      host: '127.0.0.1',
      port: address.port,
      path: IROH_MACHINE_ADMISSION_PATH,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: sourceEndpoint,
      },
    });
    client.on('error', () => undefined);
    try {
      client.end(body);
      await started;
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      client.destroy();
      await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));

      const retry = await app.inject({
        method: 'POST', url: IROH_MACHINE_ADMISSION_PATH,
        headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: sourceEndpoint },
        payload: { v: 1, kind: 'provider_broker', authority },
      });
      expect(retry.statusCode).toBe(204);
      expect(attempts).toBe(2);
    } finally {
      client.destroy();
      await app.close();
    }
  });

  it('verifies the Home signature and binds both transport identities before selecting a target', async () => {
    const resolve = vi.fn(async () => ({ port: 46_123 }));
    const app = createApp(resolve);
    const authority = signedAuthority();
    const result = await app.inject({
      method: 'POST', url: IROH_MACHINE_ADMISSION_PATH,
      headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: sourceEndpoint },
      payload: { v: 1, kind: 'provider_broker', authority },
    });
    expect(result.statusCode).toBe(204);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      authenticatedRemoteEndpointId: sourceEndpoint,
      localEndpointId: targetEndpoint,
      authority,
    }));
    await app.close();
  });

  it('rejects forged authority and wrong observed initiator without invoking the target resolver', async () => {
    const resolve = vi.fn(async () => ({ port: 46_123 }));
    const app = createApp(resolve);
    const authority = signedAuthority();
    const forged = { ...authority, payload: { ...authority.payload, resourceId: 'other-resource' } };
    const forgedResponse = await app.inject({
      method: 'POST', url: IROH_MACHINE_ADMISSION_PATH,
      headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: sourceEndpoint },
      payload: { v: 1, kind: 'provider_broker', authority: forged },
    });
    expect(forgedResponse.statusCode).toBe(403);
    const wrongEndpoint = await app.inject({
      method: 'POST', url: IROH_MACHINE_ADMISSION_PATH,
      headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: 'c'.repeat(64) },
      payload: { v: 1, kind: 'provider_broker', authority },
    });
    expect(wrongEndpoint.statusCode).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
    await app.close();
  });

  it('leaves an authentic expired broker witness to the broker owner, which alone decides what that stream may do', async () => {
    // The broker owner admits an expired authority only to release the exact
    // claim it names (see daemonProviderBrokerRuntime tests); here it refuses.
    const resolve = vi.fn(async () => null);
    const app = createApp(resolve, 10_000);
    const authority = signedAuthority();
    const result = await app.inject({
      method: 'POST', url: IROH_MACHINE_ADMISSION_PATH,
      headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: sourceEndpoint },
      payload: { v: 1, kind: 'provider_broker', authority },
    });
    expect(result.statusCode).toBe(403);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      authenticatedRemoteEndpointId: sourceEndpoint,
      authority,
    }));
    await app.close();
  });

  it('does not expose a context-free Provider route on the mediation control application', async () => {
    const app = createApp(async () => ({ port: 46_123 }));
    const result = await app.inject({
      method: 'POST', url: '/v1/responses',
      payload: { model: 'test', input: 'hello' },
    });
    expect(result.statusCode).toBe(404);
    await app.close();
  });
});
