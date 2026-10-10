import { connect } from 'node:net';

import {
  createProviderBrokerRouteGrantSigningInputV1,
  encodeProviderBrokerAuthorityV1,
  type ProviderBrokerRouteGrantPayloadV1,
  type SignedProviderBrokerRouteGrantV1,
} from '@happier-dev/protocol';
import { TeamCredentialSourceBindingV1Schema } from '@happier-dev/protocol/teams';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

import type { ManagedProviderEndpointHttpAccess } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import {
  PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER,
  PROVIDER_BROKER_APPLICATION_LIMIT_METRIC_HEADER,
  PROVIDER_BROKER_APPLICATION_LIMIT_REMAINING_HEADER,
  PROVIDER_BROKER_APPLICATION_LIMIT_RESETS_AT_HEADER,
  startProviderBrokerApplicationServer,
  writeProviderBrokerApplicationFailure,
} from './providerBrokerApplicationServer';
import { createProviderBrokerRequestHandler } from './providerBrokerRequestHandler';
import { PROVIDER_BROKER_PRIVATE_CLOSE_PATH } from './providerBrokerPrivateProtocol';

const signingKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
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
  initiator: {
    accountId: 'recipient-1',
    machineId: 'worker-1',
    endpointId: 'a'.repeat(64),
  },
  target: {
    custodianAccountId: 'custodian-1',
    machineId: 'broker-1',
    endpointId: 'b'.repeat(64),
  },
  consumer: { kind: 'session', sessionId: 'session-1' },
  application: {
    agentTargetKey: 'codex',
    implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
    endpointTemplateId: 'cliproxyapi-openai-chat',
    protocol: 'openai-chat',
  },
};

const expectedBinding = {
  teamId: payload.teamId,
  resourceId: payload.resourceId,
  sourceRevision: payload.sourceRevision,
  brokerPlacementFingerprint: payload.brokerPlacementFingerprint,
  initiator: payload.initiator,
  target: payload.target,
  consumer: payload.consumer,
  application: payload.application,
} as const;

function signedAuthority(): SignedProviderBrokerRouteGrantV1 {
  return {
    payload,
    signature: {
      alg: 'Ed25519',
      keyId: 'home-1',
      valueBase64Url: Buffer.from(tweetnacl.sign.detached(
        Buffer.from(createProviderBrokerRouteGrantSigningInputV1(payload)),
        signingKey.secretKey,
      )).toString('base64url'),
    },
  };
}

async function requestThroughApplicationTarget(input: Readonly<{
  port: number;
  localCapability: string;
  /** An Agent-supplied bearer. The target must never treat it as authority. */
  authority?: SignedProviderBrokerRouteGrantV1;
  /** Overrides the default small JSON body; used to probe the ingress limit. */
  body?: string;
}>): Promise<string> {
  const body = input.body ?? JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'hello' }] });
  const request = [
    'POST /v1/chat/completions HTTP/1.1',
    'Host: 127.0.0.1',
    ...(input.authority ? [`Authorization: Bearer ${encodeProviderBrokerAuthorityV1(input.authority)}`] : []),
    'X-Provider-Request: retained',
    'Connection: close',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n');

  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: input.port });
    const chunks: Buffer[] = [];
    socket.once('connect', () => {
      socket.write(input.localCapability, 'ascii');
      // Keep the response half open. The client requested `Connection: close`,
      // so the application owns closing only after the streamed result lands.
      socket.write(request, 'utf8');
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function closeApplicationTarget(input: Readonly<{
  port: number;
  localCapability: string;
  authority: SignedProviderBrokerRouteGrantV1;
}>): Promise<string> {
  const request = [
    `DELETE ${PROVIDER_BROKER_PRIVATE_CLOSE_PATH} HTTP/1.1`,
    'Host: 127.0.0.1',
    `Authorization: Bearer ${encodeProviderBrokerAuthorityV1(input.authority)}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: input.port });
    const chunks: Buffer[] = [];
    socket.once('connect', () => {
      socket.write(input.localCapability, 'ascii');
      socket.write(request, 'utf8');
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

describe('Provider broker target application integration', () => {
  it('keeps the consumer endpoint through upstream replacement and refuses withdrawn admission before effects', async () => {
    let admitted = true;
    let generation = 'daemon-one';
    let effects = 0;
    const server = await startProviderBrokerApplicationServer({
      handler: async () => ({ ok: false, reasonCode: 'transport_identity_mismatch' }),
      localConsumer: {
        authorize: (headers) => headers.authorization === 'Bearer consumer-local-token',
        request: async (request) => {
          if (!admitted) return { ok: false, reasonCode: 'resource_unavailable' };
          effects += 1;
          return { ok: true, response: {
            ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' },
            body: new ReadableStream<Uint8Array>({ start(controller) {
              controller.enqueue(new TextEncoder().encode(`${generation}:${request.pathAndQuery}`));
              controller.close();
            } }),
          } };
        },
      },
    });
    try {
      expect(server.localConsumerEndpointUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      const url = `${server.localConsumerEndpointUrl}/v1/messages`;
      const headers = { authorization: 'Bearer consumer-local-token' };
      expect(await (await fetch(url, { headers })).text()).toBe('daemon-one:/v1/messages');
      generation = 'daemon-two';
      expect(await (await fetch(url, { headers })).text()).toBe('daemon-two:/v1/messages');
      admitted = false;
      expect((await fetch(url, { headers })).status).toBe(403);
      expect((await fetch(url, { headers: { authorization: 'Bearer another-consumer' } })).status).toBe(403);
      expect(effects).toBe(2);
    } finally {
      await server.close();
    }
  });
  it('releases an unclaimed target and its stream lifetime when admission is cancelled, then permits an immediate retry', async () => {
    const closeFirstLifetime = vi.fn(async () => {});
    const closeRetryLifetime = vi.fn(async () => {});
    const server = await startProviderBrokerApplicationServer({
      handler: vi.fn(async () => ({ ok: false as const, reasonCode: 'resource_unavailable' as const })),
    });
    const context = (close: () => Promise<void>) => ({
      authenticatedRemoteEndpointId: payload.initiator.endpointId,
      authority: signedAuthority(),
      expected: expectedBinding,
      streamLifetime: { acquireSource: vi.fn(), close, retire: close },
    } as const);
    try {
      const admission = new AbortController();
      const abandoned = await server.createStreamTarget(context(closeFirstLifetime), admission.signal);
      admission.abort(new Error('admission client closed'));
      await vi.waitFor(() => expect(closeFirstLifetime).toHaveBeenCalledOnce());
      await expect(new Promise<void>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port: abandoned.port });
        socket.once('connect', () => {
          socket.destroy();
          reject(new Error('abandoned application target remained reachable'));
        });
        socket.once('error', () => resolve());
      })).resolves.toBeUndefined();

      const retry = await server.createStreamTarget(context(closeRetryLifetime));
      const response = await requestThroughApplicationTarget({ ...retry, authority: signedAuthority() });
      expect(response).toContain('HTTP/1.1 403 Forbidden');
      await vi.waitFor(() => expect(closeRetryLifetime).toHaveBeenCalledOnce());
    } finally {
      await server.close();
    }
  });

  it('transfers custody at capability claim so a later admission abort does not cancel the authenticated stream', async () => {
    let handlerStarted!: () => void;
    let finishHandler!: () => void;
    const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
    const finish = new Promise<void>((resolve) => { finishHandler = resolve; });
    const closeLifetime = vi.fn(async () => {});
    const server = await startProviderBrokerApplicationServer({
      handler: async () => {
        handlerStarted();
        await finish;
        return {
          ok: true as const,
          response: {
            ok: true as const,
            status: 200,
            statusText: 'OK',
            headers: Object.freeze({}),
            body: null,
          },
        };
      },
    });
    try {
      const admission = new AbortController();
      const target = await server.createStreamTarget({
        authenticatedRemoteEndpointId: payload.initiator.endpointId,
        authority: signedAuthority(),
        expected: expectedBinding,
        streamLifetime: { acquireSource: vi.fn(), close: closeLifetime, retire: closeLifetime },
      }, admission.signal);
      const response = requestThroughApplicationTarget({ ...target, authority: signedAuthority() });
      await started;
      admission.abort(new Error('admission request is already complete'));
      finishHandler();
      await expect(response).resolves.toContain('HTTP/1.1 200 OK');
      await vi.waitFor(() => expect(closeLifetime).toHaveBeenCalledOnce());
    } finally {
      finishHandler();
      await server.close();
    }
  });

  // The Agent's raw request reaches this parser before the Provider request
  // policy, so the ingress must not be narrower than the canonical Provider
  // decoded-body budget that policy enforces.
  it('accepts an Agent request body above the inherited default parser limit', async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      response: {
        ok: true as const, status: 200, statusText: 'OK', headers: Object.freeze({}), body: null,
      },
    }));
    const server = await startProviderBrokerApplicationServer({ handler });
    try {
      const target = await server.createStreamTarget({
        authenticatedRemoteEndpointId: payload.initiator.endpointId,
        authority: signedAuthority(),
        expected: expectedBinding,
        streamLifetime: { acquireSource: vi.fn(), close: vi.fn(async () => {}), retire: vi.fn(async () => {}) },
      });
      const response = await requestThroughApplicationTarget({
        ...target,
        authority: signedAuthority(),
        body: JSON.stringify({ model: 'gpt-5', context: 'x'.repeat(1_200_000) }),
      });
      expect(response).toContain('HTTP/1.1 200 OK');
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it('emits only recipient-safe exhaustion detail for the trusted server carrier', () => {
    const headers: Record<string, string> = {};
    const send = vi.fn();
    const reply = {
      header: vi.fn((name: string, value: string) => { headers[name] = value; }),
      code: vi.fn(() => ({ send })),
      send,
    };

    writeProviderBrokerApplicationFailure(reply, {
      ok: false,
      reasonCode: 'team_credential_usage_limit',
      usageLimit: {
        metric: 'total_tokens',
        remaining: '0',
        resetsAtUtc: '2026-09-15T00:00:00.000Z',
      },
    });

    expect(headers).toEqual({
      [PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER]: 'team_credential_usage_limit',
      [PROVIDER_BROKER_APPLICATION_LIMIT_METRIC_HEADER]: 'total_tokens',
      [PROVIDER_BROKER_APPLICATION_LIMIT_REMAINING_HEADER]: '0',
      [PROVIDER_BROKER_APPLICATION_LIMIT_RESETS_AT_HEADER]: '2026-09-15T00:00:00.000Z',
      'content-type': 'application/json',
    });
    expect(JSON.stringify(headers)).not.toMatch(/limitId|member|maximum/iu);
    // The Agent reads the body, not the headers: a refusal it can show in the
    // transcript names the reason and the exact recovery facts.
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(send).toHaveBeenCalledWith({
      type: 'error',
      error: {
        type: 'permission_error',
        code: 'team_credential_usage_limit',
        message: expect.stringMatching(/total_tokens.*0.*2026-09-15T00:00:00\.000Z/u),
        usageLimit: { metric: 'total_tokens', remaining: '0', resetsAtUtc: '2026-09-15T00:00:00.000Z' },
      },
    });
    expect(JSON.stringify(send.mock.calls)).not.toMatch(/limitId|member|maximum/iu);
  });

  it('describes a plain refusal in its body and omits usage facts it does not have', () => {
    const send = vi.fn();
    const reply = { header: vi.fn(), code: vi.fn(() => ({ send })), send };

    writeProviderBrokerApplicationFailure(reply, { ok: false, reasonCode: 'model_not_allowed' });

    expect(send).toHaveBeenCalledWith({
      type: 'error',
      error: { type: 'permission_error', code: 'model_not_allowed', message: expect.stringContaining('model_not_allowed') },
    });
  });

  it('names the selected resource so the recipient Session can attribute the refusal', () => {
    const send = vi.fn();
    const reply = { header: vi.fn(), code: vi.fn(() => ({ send })), send };

    writeProviderBrokerApplicationFailure(
      reply,
      { ok: false, reasonCode: 'resource_forbidden' },
      'resource-abc',
    );

    expect(send).toHaveBeenCalledWith({
      type: 'error',
      error: {
        type: 'permission_error',
        code: 'resource_forbidden',
        resourceId: 'resource-abc',
        message: expect.stringContaining('resource_forbidden'),
      },
    });
  });

  it('authenticates private close and awaits idempotent target lifetime retirement before acknowledging', async () => {
    const order: string[] = [];
    let retired = false;
    const retire = vi.fn(async () => {
      if (retired) return;
      retired = true;
      order.push('retired');
    });
    const streamLifetime = {
      acquireSource: vi.fn(),
      close: vi.fn(async () => {}),
      retire,
    };
    const handler = createProviderBrokerRequestHandler({
      resolveTrustRoots: () => [{
        keyId: 'home-1',
        publicKey: Buffer.from(signingKey.publicKey).toString('base64url'),
      }],
      nowMs: () => 200,
      resolveRequestPolicy: vi.fn(async () => null),
      createRequestId: () => 'request-1',
      admit: vi.fn(async () => ({ ok: false as const, reasonCode: 'resource_unavailable' as const })),
    });
    const server = await startProviderBrokerApplicationServer({ handler });
    try {
      const target = await server.createStreamTarget({
        authenticatedRemoteEndpointId: payload.initiator.endpointId,
        authority: signedAuthority(),
        expected: expectedBinding,
        streamLifetime,
      });
      const response = await closeApplicationTarget({ ...target, authority: signedAuthority() });
      order.push('ack-observed');
      expect(response).toContain('HTTP/1.1 204 No Content');
      expect(order).toEqual(['retired', 'ack-observed']);
    } finally {
      await server.close();
    }
    expect(order.filter((entry) => entry === 'retired')).toHaveLength(1);
  });
  it('retains failed stream cleanup for an idempotent server-close retry', async () => {
    let cleanupAttempts = 0;
    let released = false;
    let cleanupInFlight: Promise<void> | null = null;
    const streamLifetime = {
      acquireSource: vi.fn(),
      retire: vi.fn(async () => {}),
      close: vi.fn(() => {
        if (released) return Promise.resolve();
        cleanupInFlight ??= (++cleanupAttempts <= 2
          ? Promise.reject(new Error('stream cleanup failed'))
          : Promise.resolve()).then(
          () => { released = true; cleanupInFlight = null; },
          (error: unknown) => { cleanupInFlight = null; throw error; },
        );
        return cleanupInFlight;
      }),
    };
    const server = await startProviderBrokerApplicationServer({
      handler: vi.fn(async () => ({ ok: false as const, reasonCode: 'resource_unavailable' as const })),
    });
    await server.createStreamTarget({
      authenticatedRemoteEndpointId: payload.initiator.endpointId,
      authority: signedAuthority(),
      expected: expectedBinding,
      streamLifetime,
    });

    await expect(server.close()).rejects.toThrow('stream cleanup failed');
    await expect(server.close()).resolves.toBeUndefined();
    expect(cleanupAttempts).toBe(3);
  });

  it('binds the authenticated stream to the real broker handler and reaches Provider access', async () => {
    const upstreamRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'application/json',
        connection: 'keep-alive',
        'proxy-authenticate': 'must-not-cross',
        'transfer-encoding': 'identity',
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ id: 'completion-1' })));
          controller.close();
        },
      }),
    }));
    const access: ManagedProviderEndpointHttpAccess = {
      endpointUrl: () => 'http://127.0.0.1:1',
      request: upstreamRequest,
    };
    const admit = vi.fn(async () => ({ ok: true as const, access }));
    const handler = createProviderBrokerRequestHandler({
      resolveTrustRoots: () => [{
        keyId: 'home-1',
        publicKey: Buffer.from(signingKey.publicKey).toString('base64url'),
      }],
      nowMs: () => 200,
      resolveRequestPolicy: async () => ({
        resourceRevision: 7,
        sourceRevision: 'source-revision-7',
        application: payload.application,
        source: TeamCredentialSourceBindingV1Schema.parse({
          v: 1,
          kind: 'provider_connection',
          connectionId: 'pc_source',
          connectionSecurityFingerprint: 'connection-security:v1:source',
          credentialSlotId: 'apiKey',
        }),
        policy: null,
        modelCatalog: {
          models: [{ id: 'gpt-5' }],
          resolveCanonicalModelId: (modelId: string) => modelId,
        },
      }),
      createRequestId: () => 'request-1',
      admit,
    });
    const server = await startProviderBrokerApplicationServer({ handler });

    try {
      const target = await server.createStreamTarget({
        authenticatedRemoteEndpointId: payload.initiator.endpointId,
        authority: signedAuthority(),
        expected: expectedBinding,
      });
      const response = await requestThroughApplicationTarget({
        ...target,
        authority: signedAuthority(),
      });

      expect(response).toContain('HTTP/1.1 200 OK');
      expect(response).toContain('completion-1');
      expect(response.toLowerCase()).not.toContain('proxy-authenticate');
      expect(response.toLowerCase()).not.toContain('transfer-encoding: identity');
      expect(admit).toHaveBeenCalledWith(expect.objectContaining({
        authority: signedAuthority(),
        expectedResourceRevision: 7,
        requestId: 'request-1',
      }));
      expect(upstreamRequest).toHaveBeenCalledWith(expect.objectContaining({
        pathAndQuery: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'x-provider-request': 'retained' },
      }));
    } finally {
      await server.close();
    }
  });

  it('admits an Agent request by the stream-admitted authority and never by a bearer the Agent supplies', async () => {
    const access: ManagedProviderEndpointHttpAccess = {
      endpointUrl: () => 'http://127.0.0.1:1',
      request: vi.fn(async () => ({ ok: true, status: 204, statusText: 'No Content', headers: {}, body: null })),
    };
    const admit = vi.fn(async () => ({ ok: true as const, access }));
    const handler = createProviderBrokerRequestHandler({
      resolveTrustRoots: () => [{
        keyId: 'home-1',
        publicKey: Buffer.from(signingKey.publicKey).toString('base64url'),
      }],
      nowMs: () => 200,
      resolveRequestPolicy: async () => ({
        resourceRevision: 7,
        sourceRevision: 'source-revision-7',
        application: payload.application,
        source: TeamCredentialSourceBindingV1Schema.parse({
          v: 1,
          kind: 'provider_connection',
          connectionId: 'pc_source',
          connectionSecurityFingerprint: 'connection-security:v1:source',
          credentialSlotId: 'apiKey',
        }),
        policy: null,
        modelCatalog: { models: [{ id: 'gpt-5' }], resolveCanonicalModelId: (modelId: string) => modelId },
      }),
      createRequestId: () => 'request-1',
      admit,
    });
    const server = await startProviderBrokerApplicationServer({ handler });
    try {
      const target = await server.createStreamTarget({
        authenticatedRemoteEndpointId: payload.initiator.endpointId,
        authority: signedAuthority(),
        expected: expectedBinding,
      });
      // The Agent holds only the loopback endpoint and its local capability.
      const response = await requestThroughApplicationTarget(target);
      expect(response).toContain('HTTP/1.1 204');
      expect(admit).toHaveBeenCalledWith(expect.objectContaining({ authority: signedAuthority() }));

      // A bearer the Agent invents is neither trusted nor forwarded upstream.
      // The admission proxy is single-connection by contract
      // (`startFirstBytesLocalCapabilityProxy`), so the forged attempt needs its
      // own stream target; reusing the one the first request already consumed
      // would be refused by the transport before admission is even reached.
      const forgedTarget = await server.createStreamTarget({
        authenticatedRemoteEndpointId: payload.initiator.endpointId,
        authority: signedAuthority(),
        expected: expectedBinding,
      });
      const forged = { ...signedAuthority(), payload: { ...payload, resourceId: 'resource-forged' } };
      const forgedResponse = await requestThroughApplicationTarget({ ...forgedTarget, authority: forged });
      expect(forgedResponse).toContain('HTTP/1.1 204');
      expect(admit).toHaveBeenLastCalledWith(expect.objectContaining({ authority: signedAuthority() }));
      expect(access.request).toHaveBeenLastCalledWith(expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: expect.anything() }),
      }));
    } finally {
      await server.close();
    }
  });

  it('cancels the managed response body when the authenticated application stream disconnects', async () => {
    const cancelled = vi.fn();
    let requestSignal: AbortSignal | undefined;
    const server = await startProviderBrokerApplicationServer({
      handler: async ({ request }) => {
        requestSignal = request.signal;
        return {
          ok: true,
          response: {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/octet-stream' },
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(1024 * 1024).fill(7));
              },
              cancel: cancelled,
            }),
          },
        };
      },
    });
    try {
      const target = await server.createStreamTarget({
        authenticatedRemoteEndpointId: payload.initiator.endpointId,
        authority: signedAuthority(),
        expected: expectedBinding,
      });
      const body = JSON.stringify({ model: 'gpt-5', messages: [] });
      const socket = connect({ host: '127.0.0.1', port: target.port });
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => {
          socket.write(target.localCapability, 'ascii');
          socket.write([
            'POST /v1/chat/completions HTTP/1.1',
            'Host: 127.0.0.1',
            `Authorization: Bearer ${encodeProviderBrokerAuthorityV1(signedAuthority())}`,
            'Content-Type: application/json',
            `Content-Length: ${Buffer.byteLength(body)}`,
            '',
            body,
          ].join('\r\n'));
        });
        socket.once('data', () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', reject);
      });
      await vi.waitFor(() => {
        expect(requestSignal?.aborted).toBe(true);
        expect(cancelled).toHaveBeenCalledOnce();
      });
    } finally {
      await server.close();
    }
  });
});
