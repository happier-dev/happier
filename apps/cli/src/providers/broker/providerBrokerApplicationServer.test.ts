import { connect } from 'node:net';
import { createServer } from 'node:http';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { createTeamCredentialBrokerSourceOwner } from './teamCredentialBrokerSourceOwner';
import { createPrivateProviderBrokerStreamLifetime } from './daemonProviderBrokerRuntime';

import {
  createProviderBrokerRouteGrantSigningInputV1,
  encodeProviderBrokerAuthorityV1,
  type ProviderBrokerRouteGrantPayloadV1,
  type SignedProviderBrokerRouteGrantV1,
} from '@happier-dev/protocol';
import { TeamCredentialSourceBindingV1Schema } from '@happier-dev/protocol/teams';
import { TEAM_CREDENTIAL_EXTERNAL_PROVIDER_APPLICATION_HTTP_PATH_V1 } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
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
import { logger } from '@/ui/logger';
import { ProviderBrokerApplicationFailureError } from './providerBrokerApplicationFailure';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { PROVIDER_BROKER_ACTION_EXECUTE_PATH_V3 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { requestThroughApplicationTarget } from './providerBroker.testkit';

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

function signedAuthority(grantId = payload.grantId): SignedProviderBrokerRouteGrantV1 {
  const signedPayload = { ...payload, grantId };
  return {
    payload: signedPayload,
    signature: {
      alg: 'Ed25519',
      keyId: 'home-1',
      valueBase64Url: Buffer.from(tweetnacl.sign.detached(
        Buffer.from(createProviderBrokerRouteGrantSigningInputV1(signedPayload)),
        signingKey.secretKey,
      )).toString('base64url'),
    },
  };
}

async function closeApplicationTarget(input: Readonly<{
  port: number;
  localCapability: string;
  authority: SignedProviderBrokerRouteGrantV1;
  requestId?: string;
}>): Promise<string> {
  const request = [
    `DELETE ${PROVIDER_BROKER_PRIVATE_CLOSE_PATH} HTTP/1.1`,
    'Host: 127.0.0.1',
    `Authorization: Bearer ${encodeProviderBrokerAuthorityV1(input.authority)}`,
    ...(input.requestId ? [`X-Happier-Provider-Broker-Close-Request-Id: ${input.requestId}`] : []),
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
  it('retains a typed execution cause over the finite Action carrier', async () => {
    const actionInput = { region: 'eu' };
    const failureCause = { phase: 'provider.credential_resolution', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null } as const;
    const server = await startProviderBrokerApplicationServer({
      handler: async () => ({ ok: false, reasonCode: 'resource_unavailable' }),
    });
    try {
      const target = await server.createActionStreamTarget({ kind: 'action_operation', authority: {
        payload: { v: 3, grantId: 'action-grant', aud: 'happier-provider-broker-action-v3',
          issuedAt: 100, expiresAt: 200, teamId: payload.teamId, resourceId: payload.resourceId,
          source: { v: 1, kind: 'provider_connection', connectionId: 'pc_source',
            connectionSecurityFingerprint: 'connection-security:v1:source', credentialSlotId: 'apiKey' },
          consumer: { kind: 'action_operation', operationId: 'operation', actionId: 'example.cloud/actions/options',
            pluginVersion: '1.0.0', purpose: { consumer: { pluginId: 'example.cloud', localId: 'options' }, purpose: 'cloud-api' } },
          inputDigest: computeActionInputApprovalDigestV1('example.cloud/actions/options', actionInput),
          declaration: { version: '1.0.0', manifestDigestSha256: `sha256:${'a'.repeat(64)}` },
          initiator: payload.initiator, target: payload.target,
        }, signature: signedAuthority().signature,
      }, execute: async () => { throw Object.assign(new Error('private source detail'), { failureCause }); } });
      const response = await requestThroughApplicationTarget({ ...target,
        path: PROVIDER_BROKER_ACTION_EXECUTE_PATH_V3, body: JSON.stringify({ input: actionInput }),
      });
      expect(response).toContain('HTTP/1.1 503');
      expect(JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4))).toMatchObject({
        ok: false, reasonCode: 'broker_unavailable', failureCause,
      });
      expect(response).not.toContain('private source detail');
    } finally { await server.close(); }
  });

  it('writes a typed local access refusal through the canonical broker body writer', async () => {
    const server = await startProviderBrokerApplicationServer({
      handler: async () => ({ ok: false, reasonCode: 'resource_unavailable' }),
      localConsumer: { authorize: () => true, request: async () => {
        throw new ProviderBrokerApplicationFailureError({ ok: false, reasonCode: 'broker_unavailable' });
      } },
    });
    try {
      const response = await server.app.inject({ method: 'GET', url: '/v1/models' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ type: 'error', error: { type: 'permission_error', code: 'broker_unavailable' } });
    } finally { await server.close(); }
  });
  it('preserves a typed refusal thrown by local managed access at the HTTP writer', async () => {
    const failureCause = { phase: 'provider.source_read', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null } as const;
    const server = await startProviderBrokerApplicationServer({
      handler: async () => ({ ok: false, reasonCode: 'resource_unavailable' }),
      localConsumer: { authorize: () => true, request: async () => {
        throw new ProviderBrokerApplicationFailureError({ ok: false, reasonCode: 'source_unavailable', failureCause });
      } },
    });
    try {
      const response = await server.app.inject({ method: 'GET', url: '/v1/models' });
      expect(response.statusCode).toBe(403);
      expect(response.headers[PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER]).toBe('source_unavailable');
      expect(response.json().error).toMatchObject({ type: 'permission_error', code: 'source_unavailable', failureCause });
    } finally { await server.close(); }
  });
  it('writes a typed source refusal from managed access through the handler and HTTP failure owner', async () => {
    const diagnostics = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const warnings = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const source = TeamCredentialSourceBindingV1Schema.parse({ v: 1, kind: 'provider_connection',
      connectionId: 'pc_source', connectionSecurityFingerprint: 'connection-security:v1:source', credentialSlotId: 'apiKey' });
    const server = await startProviderBrokerApplicationServer({ handler: createProviderBrokerRequestHandler({
      resolveRequestPolicy: async () => ({ resourceRevision: 7, sourceRevision: payload.sourceRevision,
        application: payload.application, source, policy: null,
        modelCatalog: { models: [{ id: 'gpt-5' }], resolveCanonicalModelId: id => id } }),
      createRequestId: () => 'broker-source-refusal',
      admit: async () => ({ ok: true, access: { endpointUrl: () => 'http://127.0.0.1:43120/v1',
        // Managed access is the Provider effect boundary. Preserve the real
        // broker handler, phase, signature and HTTP response path around it.
        request: async () => { throw new ProviderBrokerApplicationFailureError({ ok: false, reasonCode: 'source_unavailable' }); },
      } }),
    }) });
    try {
      const target = await server.createStreamTarget({ authenticatedRemoteEndpointId: payload.initiator.endpointId,
        authority: signedAuthority(), expected: expectedBinding });
      const response = await requestThroughApplicationTarget(target);
      expect(response).toContain('HTTP/1.1 403');
      expect(response).toContain(`${PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER}: source_unavailable`);
      expect(response).toContain('"code":"source_unavailable"');
      expect(response).toContain('"resourceId":"resource-1"');
      expect([...diagnostics.mock.calls, ...warnings.mock.calls]
        .filter(([marker]) => marker === '[provider-broker-application]')).toEqual([
        ['[provider-broker-application]', { stage: 'application_response', applicationRequestId: 'req-1', code: 'source_unavailable' }],
      ]);
    } finally {
      await server.close();
      diagnostics.mockRestore();
      warnings.mockRestore();
    }
  });

  it.each(['completed', 'failed'] as const)('records only response-body failure after upstream %s without replaying the request', async outcome => {
    const diagnostics = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const warnings = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const content = 'private upstream response sentinel';
    let upstreamRequests = 0;
    let failUpstream = () => {};
    const upstream = createServer((_request, reply) => {
      upstreamRequests++;
      reply.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.write(content);
      if (outcome === 'completed') reply.end();
      else failUpstream = () => reply.destroy(new Error('private upstream exception sentinel'));
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('upstream did not listen');
    const upstreamUrl = `http://127.0.0.1:${address.port}`;
    const server = await startProviderBrokerApplicationServer({ handler: createProviderBrokerRequestHandler({
      resolveRequestPolicy: async () => ({ resourceRevision: 7, sourceRevision: payload.sourceRevision,
        application: payload.application,
        source: TeamCredentialSourceBindingV1Schema.parse({ v: 1, kind: 'provider_connection',
          connectionId: 'pc_source', connectionSecurityFingerprint: 'connection-security:v1:source', credentialSlotId: 'apiKey' }),
        policy: null,
        modelCatalog: { models: [{ id: 'gpt-5' }], resolveCanonicalModelId: id => id } }),
      createRequestId: () => 'broker-request-stream',
      admit: async () => ({ ok: true, access: { endpointUrl: () => upstreamUrl,
        request: async request => {
          const response = await fetch(`${upstreamUrl}${request.pathAndQuery}`, {
            method: request.method, body: request.body ? new TextDecoder().decode(request.body) : undefined, signal: request.signal,
          });
          return { ok: response.ok, status: response.status, statusText: response.statusText,
            headers: Object.fromEntries(response.headers), body: response.body };
        } } }),
    }) });
    try {
      const target = await server.createStreamTarget({ authenticatedRemoteEndpointId: payload.initiator.endpointId,
        authority: signedAuthority(), expected: expectedBinding });
      const response = await requestThroughApplicationTarget({ ...target,
        onData: chunk => { if (chunk.includes(content)) failUpstream(); } });
      expect(response).toContain(content);
      if (outcome === 'failed') await vi.waitFor(() => expect(warnings).toHaveBeenCalledWith('[provider-broker-application]', {
        stage: 'response_body', applicationRequestId: 'req-1', outcome, httpStatus: 200,
        responseBytes: Buffer.byteLength(content),
      }));
      // A diagnostic must add zero upstream requests or per-chunk log records.
      expect(upstreamRequests).toBe(1);
      const records = [...diagnostics.mock.calls, ...warnings.mock.calls]
        .filter(([marker]) => marker === '[provider-broker-application]');
      expect(records).toHaveLength(outcome === 'failed' ? 1 : 0);
      expect(JSON.stringify(records)).not.toContain('private upstream');
    } finally {
      await server.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      diagnostics.mockRestore();
      warnings.mockRestore();
    }
  });

  it('keeps successful Team requests quiet and records one failed upstream response without payloads', async () => {
    const diagnostics = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const warnings = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    let effects = 0;
    let requestIdsCreated = 0;
    const admissionIds: string[] = [];
    const grantId = '09df506c-86a6-4569-a4dd-5c3256e0d152';
    const source = TeamCredentialSourceBindingV1Schema.parse({ v: 1, kind: 'provider_connection',
      connectionId: 'pc_source', connectionSecurityFingerprint: 'connection-security:v1:source', credentialSlotId: 'apiKey' });
    // The Home policy/admission and Provider HTTP boundary are external systems;
    // keep the broker's real policy, signature verification and HTTP wiring.
    const server = await startProviderBrokerApplicationServer({ handler: createProviderBrokerRequestHandler({
      resolveRequestPolicy: async () => ({ resourceRevision: 7, sourceRevision: payload.sourceRevision,
        application: payload.application, source, policy: null,
        modelCatalog: { models: [{ id: 'gpt-5' }], resolveCanonicalModelId: id => id } }),
      createRequestId: () => `broker-request-${++requestIdsCreated}`,
      admit: async input => {
        admissionIds.push(input.requestId);
        return { ok: true, access: { endpointUrl: () => 'http://127.0.0.1:43120/v1',
        request: async () => ({ ok: ++effects === 1, status: effects === 1 ? 200 : 429,
          statusText: '', headers: {}, body: null }) } };
      },
    }) });
    try {
      for (let turn = 0; turn < 2; turn++) {
        const target = await server.createStreamTarget({ authenticatedRemoteEndpointId: payload.initiator.endpointId,
          authority: signedAuthority(grantId), expected: expectedBinding });
        const response = await requestThroughApplicationTarget({ ...target,
          body: JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'private prompt sentinel' }] }) });
        expect(response).toContain(turn === 0 ? 'HTTP/1.1 200' : 'HTTP/1.1 429');
      }
      const records = [...diagnostics.mock.calls, ...warnings.mock.calls]
        .filter(([marker]) => marker === '[provider-broker-application]').map(([, data]) => data);
      expect(records).toEqual([{ stage: 'response_body', applicationRequestId: 'req-2',
        httpStatus: 429, outcome: 'failed', responseBytes: 0 }]);
      expect(effects).toBe(2); // Diagnostics perform no extra Provider requests.
      expect(admissionIds).toEqual(['broker-request-1', 'broker-request-2']);
      expect(JSON.stringify(records)).not.toMatch(/private prompt sentinel|connection-security|Bearer|valueBase64Url/u);
    } finally {
      await server.close();
      diagnostics.mockRestore();
      warnings.mockRestore();
    }
  });

  it('correlates private close receipt and completed real retirement without logging untrusted header values', async () => {
    const diagnostics = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const controller = createPluginReloadController();
    const fixture = await createManagedRunLaunchFixture({ controller, activateAgent: false });
    const sourceOwner = createTeamCredentialBrokerSourceOwner({
      machineId: payload.target.machineId,
      custody: createManagedProviderExplicitStartCustody({ machineId: payload.target.machineId,
        happyHomeDir: fixture.happyHomeDir, controller }),
      // This is the release-only stream: no source-selection/acquisition path
      // is entered. Retirement uses the real registry and managed custody.
      selectConnectedServicesSourceMember: async () => null,
      openConnectedServicesSource: async () => null,
      openProviderConnectionSource: async () => null,
    });
    const server = await startProviderBrokerApplicationServer({ handler: createProviderBrokerRequestHandler({
      resolveRequestPolicy: async () => null, createRequestId: () => 'broker-request',
      admit: async () => ({ ok: false, reasonCode: 'resource_unavailable' }),
    }) });
    try {
      for (const requestId of ['d0d1cc6c-1c83-4ca9-a263-5ed116c00845', undefined, 'private credential header']) {
        diagnostics.mockClear();
        const target = await server.createStreamTarget({
          authenticatedRemoteEndpointId: payload.initiator.endpointId, authority: signedAuthority(), expected: expectedBinding,
          streamLifetime: createPrivateProviderBrokerStreamLifetime({ sourceOwner,
            application: payload.application, operation: payload.consumer }),
        });
        expect(await closeApplicationTarget({ ...target, authority: signedAuthority(), requestId }))
          .toContain('HTTP/1.1 204 No Content');
        const records = diagnostics.mock.calls.filter(([marker]) => marker === '[provider-broker-close]');
        const received = records[0]?.[1];
        expect(received).toEqual({ event: 'received', targetMachineId: payload.target.machineId,
          requestId: requestId?.startsWith('d0d1') ? requestId : expect.stringMatching(/^req-/u),
          applicationRequestId: expect.any(String) });
        if (!received || typeof received !== 'object') throw new Error('Missing close receipt diagnostic');
        expect(records).toEqual([
          ['[provider-broker-close]', received],
          ['[provider-broker-close]', { ...received, event: 'retirement_completed' }],
        ]);
        expect(JSON.stringify(records)).not.toContain('private credential header');
        expect(JSON.stringify(records)).not.toContain(encodeProviderBrokerAuthorityV1(signedAuthority()));
      }
    } finally {
      await server.close();
      await fixture.cleanup();
      diagnostics.mockRestore();
    }
  });

  it.each([
    { name: 'Error', code: 'ECONNRESET', expected: { errorName: 'Error', errorCode: 'ECONNRESET' } },
    { name: 'Error', code: 'ECONNRESET', statusCode: 400, expected: { errorName: 'Error', errorCode: 'ECONNRESET' } },
    { name: 'private credential name', code: 'private credential code', expected: { errorName: 'UnknownError' } },
  ])('returns a retryable typed application failure and logs only safe exception metadata: $name/$statusCode', async ({ name, code, statusCode, expected }) => {
    const diagnostics = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const server = await startProviderBrokerApplicationServer({
      handler: async () => ({ ok: false, reasonCode: 'resource_unavailable' }),
      localConsumer: {
        authorize: () => true,
        request: async () => { throw Object.assign(new Error('private credential diagnostic'), {
          name, code, statusCode, phase: 'private phase', brokerRequestId: 'private credential id',
        }); },
      },
    });
    try {
      const response = await server.app.inject({ method: 'GET', url: '/v1/models', headers: {
        'request-id': 'private credential id', 'x-request-id': 'private credential id',
      } });
      expect(response.statusCode).toBe(503);
      expect(response.headers[PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER]).toBe('broker_unavailable');
      expect(response.json().error.code).toBe('broker_unavailable');
      if (code === 'ECONNRESET') expect(response.json().error.message).toContain('ECONNRESET');
      expect(diagnostics).toHaveBeenCalledWith('[provider-broker-application]', {
        stage: 'handler', code: 'exception', phase: 'handler', applicationRequestId: expect.any(String), ...expected,
      });
      expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('private');
      expect(response.body).not.toContain('private');
    } finally {
      await server.close();
      diagnostics.mockRestore();
    }
  });
  it('parses complete external carrier envelopes above retired local caps before enforcing carrier admission', async () => {
    const server = await startProviderBrokerApplicationServer({ handler: createProviderBrokerRequestHandler({
      resolveRequestPolicy: async () => null,
      createRequestId: () => 'unused', admit: async () => ({ ok: false, reasonCode: 'resource_unavailable' }),
    }) });
    try {
      for (const bytes of [1024 * 1024 + 1, 8 * 1024 * 1024]) {
        const response = await server.app.inject({ method: 'POST',
          url: TEAM_CREDENTIAL_EXTERNAL_PROVIDER_APPLICATION_HTTP_PATH_V1,
          headers: { 'content-type': 'application/json' }, payload: `{}` + ' '.repeat(bytes - 2),
        });
        expect(response.statusCode).toBe(403);
      }
    } finally {
      await server.close();
    }
  });

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

  it('preserves Agent request bytes above the inherited default parser limit for policy parsing', async () => {
    const handler = vi.fn(async (_request: Parameters<ReturnType<typeof createProviderBrokerRequestHandler>>[0]) => ({
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
      const body = ` { "model": "gpt-5", "context": "${'x'.repeat(1_200_000)}" } `;
      const response = await requestThroughApplicationTarget({
        ...target,
        authority: signedAuthority(),
        body,
      });
      expect(response).toContain('HTTP/1.1 200 OK');
      expect(handler).toHaveBeenCalledOnce();
      const forwarded = handler.mock.calls[0][0].request.body;
      expect(new TextDecoder().decode(forwarded) === body).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('admits a large inference body through the real transport and request policy and cancels upstream', async () => {
    const diagnostics = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const warnings = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const input = 'x'.repeat(8 * 1024 * 1024);
    let admittedInput: unknown;
    let upstreamCancelled = false;
    const upstream = createServer(async (request, reply) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      admittedInput = body.context;
      if (body.stream) {
        reply.on('close', () => { upstreamCancelled = true; });
        reply.writeHead(200, { 'content-type': 'text/event-stream' });
        reply.write('data: {"id":"large-stream"}\n\n');
      } else {
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end(JSON.stringify({ id: 'large-completion', inputBytes: Buffer.byteLength(body.context) }));
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('upstream did not listen');
    const upstreamUrl = `http://127.0.0.1:${address.port}`;
    const access: ManagedProviderEndpointHttpAccess = {
      endpointUrl: () => upstreamUrl,
      async request(request) {
        const response = await fetch(`${upstreamUrl}${request.pathAndQuery}`, {
          method: request.method,
          headers: request.headers,
          body: request.body ? new TextDecoder().decode(request.body) : undefined,
          signal: request.signal,
        });
        return { ok: response.ok, status: response.status, statusText: response.statusText,
          headers: Object.fromEntries(response.headers), body: response.body };
      },
    };
    const handler = createProviderBrokerRequestHandler({
      resolveRequestPolicy: async () => ({
        resourceRevision: 7, sourceRevision: payload.sourceRevision, application: payload.application,
        source: TeamCredentialSourceBindingV1Schema.parse({ v: 1, kind: 'provider_connection',
          connectionId: 'pc_source', connectionSecurityFingerprint: 'connection-security:v1:source', credentialSlotId: 'apiKey' }),
        policy: null,
        modelCatalog: { models: [{ id: 'gpt-5' }], resolveCanonicalModelId: (id: string) => id },
      }),
      createRequestId: () => 'request-large',
      admit: async () => ({ ok: true, access }),
    });
    const server = await startProviderBrokerApplicationServer({ handler });
    const context = {
      authenticatedRemoteEndpointId: payload.initiator.endpointId,
      authority: signedAuthority(), expected: expectedBinding,
    };
    try {
      const target = await server.createStreamTarget(context);
      const response = await requestThroughApplicationTarget({
        ...target,
        authority: signedAuthority(),
        body: JSON.stringify({ model: 'gpt-5', context: input }),
      });
      expect(response).toContain('HTTP/1.1 200 OK');
      expect(response).toContain('large-completion');
      expect(response).toContain('8388608');
      expect(admittedInput).toBe(input);

      const streamTarget = await server.createStreamTarget(context);
      const streamBody = JSON.stringify({ model: 'gpt-5', context: input, stream: true });
      const socket = connect({ host: '127.0.0.1', port: streamTarget.port });
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => {
          socket.write(streamTarget.localCapability, 'ascii');
          socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(streamBody)}\r\n\r\n${streamBody}`);
        });
        socket.once('data', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
      });
      await vi.waitFor(() => expect(upstreamCancelled).toBe(true));
      await vi.waitFor(() => expect([...diagnostics.mock.calls, ...warnings.mock.calls]
        .filter(([marker]) => marker === '[provider-broker-application]').map(([, record]) => record))
        .toEqual([{ stage: 'response_body', applicationRequestId: 'req-2', httpStatus: 200,
          outcome: 'cancelled', responseBytes: expect.any(Number) }]));
    } finally {
      await server.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
      diagnostics.mockRestore();
      warnings.mockRestore();
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

  it.each([
    ['model_not_allowed', 403, 'permission_error'],
    ['request_too_large', 413, 'invalid_request_error'],
  ] as const)('writes %s with its provider-compatible HTTP error shape', (reasonCode, status, errorType) => {
    const send = vi.fn();
    const reply = { header: vi.fn(), code: vi.fn(() => ({ send })), send };

    writeProviderBrokerApplicationFailure(reply, { ok: false, reasonCode });

    expect(send).toHaveBeenCalledWith({
      type: 'error',
      error: { type: errorType, code: reasonCode, message: expect.stringContaining(reasonCode) },
    });
    expect(reply.code).toHaveBeenCalledWith(status);
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
