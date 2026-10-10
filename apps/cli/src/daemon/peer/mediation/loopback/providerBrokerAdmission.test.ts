import { describe, expect, it, vi } from 'vitest';
import { request as requestHttp } from 'node:http';
import tweetnacl from 'tweetnacl';
import {
  IROH_MACHINE_ADMISSION_PATH,
  IROH_MACHINE_REMOTE_ENDPOINT_HEADER,
} from '@happier-dev/iroh-native/node';
import {
  createProviderBrokerRouteGrantSigningInputV1,
  type ProviderBrokerRouteGrantPayloadV1,
  type SignedProviderBrokerRouteGrantV1,
} from '@happier-dev/protocol';
import { createPeerMediationLoopbackApp } from './server';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';

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
