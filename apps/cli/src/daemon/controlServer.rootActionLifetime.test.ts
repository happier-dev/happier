import nacl from 'tweetnacl';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, projectExternalActionManagedAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { ManagedIntentResultSchema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import type { SignedRootActionExecuteRequest } from './externalActions/signedRootActionControl';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createExternalMcpServer } from '@/mcp/createExternalMcpServer';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveManagedControlControllerTarget } from './externalActions/reconcileExternalActionTarget';
import { once } from 'node:events';
import { createServer } from 'node:http';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_SECURITY_PATH_V1, ApprovalRequestSchema, accountSettingsParse, decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { refreshTerminalPresentUserPolicy } from '@/settings/accountSettings/resolveEffectiveTerminalPresentUserPolicy';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createDaemonExternalActionTargetResolver } from './externalActions/daemonExternalActionTargetResolver';
import { createDaemonControlApp } from './controlServer';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

// Configuration is the environment boundary. Account policy, catalog and execution stay real.
vi.mock('@/configuration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return { ...actual, configuration: { ...actual.configuration, terminalPresentUserPolicy: 'allowed' as const } };
});

describe('signed root Action lifetime', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['cli', 'mcp'] as const)('admits managed Stop, Start and Delete at Home before local Ask on %s', async surface => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' } as const;
    const machine = { id: 'machine-local', kind: 'persistent', active: true, installationId: 'installation-local',
      installationPublicKey: Buffer.from(keys.publicKey).toString('base64'), revokedAt: null, replacedByMachineId: null,
      dataEncryptionKey: null, runnerContentKeyBinding: null,
      access: { custodian: { accountId: 'account', displayName: 'Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    const target = { kind: 'machine' as const, machineId: machine.id };
    const managed = ManagedMachineV1Schema.parse({ id: 'managed-local', homeId: 'srv_home', custodianAccountId: 'account',
      controller: { machineId: machine.id, installationId: machine.installationId },
      launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: {} },
      resource: { contributionRef: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, value: { instance: 'managed-leaf' } },
      allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 1,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const events: string[] = [];
    const deliveries: Array<ReturnType<typeof ExternalActionExecutionAuthorizationRequestV1Schema.parse>> = [];
    const receipts = new Map<string, ReturnType<typeof ManagedIntentResultSchema.parse>>();
    // Home is the system boundary. Local root admission, original Account
    // dispatch, envelope binding and installation-sealed caller custody stay real.
    const upstream = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/account/encryption') {
        response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
        return;
      }
      if (request.url === '/v1/account/encryption/currentness') {
        response.end(JSON.stringify({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
        return;
      }
      if (request.url === '/v1/machines') { response.end(JSON.stringify([machine])); return; }
      if (request.url === '/v1/machines/machine-local') { response.end(JSON.stringify({ machine })); return; }
      if (request.url === '/v1/machines/managed/actions/get') { response.end(JSON.stringify(managed)); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.method === 'POST' && request.url?.startsWith('/v1/actions/machines.managed.')) {
        const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const actionId = request.url.split('/')[3]!;
        const requestId = carrier.envelope.requestId!;
        if (request.url.endsWith('/execution-authorization')) {
          events.push(`admit:${requestId}`);
          response.end(JSON.stringify(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: `home-proof-${requestId}`,
            binding: { accountId: 'account', authentication: { kind: 'account', tokenEpoch: 1 },
              serverIdentityId: 'srv_home', machineId: machine.id, custodianAccountId: 'account',
              installationId: machine.installationId, actionId, requestId, target,
              requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(carrier.envelope), accountEncryptionMode: 'plain',
              managedAdmission: projectExternalActionManagedAdmissionV1(actionId, carrier.envelope.v === 1 ? carrier.envelope.input : undefined) } })));
          return;
        }
        deliveries.push(carrier);
        events.push(`deliver:${requestId}`);
        response.end(JSON.stringify({ v: 1, actionId, requestId, execution: { ok: true,
          result: receipts.get(requestId) ?? [...receipts.values()].at(-1) } }));
        return;
      }
      events.push(`unexpected:${request.method} ${request.url}`);
      response.writeHead(403).end(JSON.stringify({ code: 'permission_denied' }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing Home address');
    const serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;
    const { executor } = createCliActionExecutorHarness({ token, credentials, serverId: 'server-local',
      serverIdentityId: 'srv_home', serverHttpBaseUrl, sessionId: '', mode: 'plain', ctx: null,
      actionsSettingsProvider: createActionSettingsProvider({ scopeKey: `managed-root-${surface}`,
        accountSettings: accountSettingsParse({}) }) });
    const externalActionApi = { currentServerId: 'server-local', currentAccountId: 'account', executor,
      resolveManagedControlControllerTarget: async (actionId: string, input: unknown, signal: AbortSignal) => await resolveManagedControlControllerTarget({
        actionId, rawInput: input, credentials, serverHttpBaseUrl, signal,
      }),
      verifyPat: async () => { throw new Error('Stored Account control does not use PAT verification'); },
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverHttpBaseUrl }),
      executeOriginalAccountAction: async (request: SignedRootActionExecuteRequest & Readonly<{
        authority: 'present_user' | 'account_automation'; signal: AbortSignal;
      }>) => await dispatchOriginalAccountAction({ actionId: request.actionId, input: request.input,
        requestId: request.actionRequestId!, target: request.target ?? target, credentials,
        serverHttpBaseUrl, serverIdentityId: 'srv_home', authority: request.authority, signal: request.signal,
        invocation: { caller: { kind: 'host' }, surface: request.surface ?? 'cli', authority: request.authority } }),
    };
    const app = createDaemonControlApp({ getChildren: () => [], machineId: machine.id, controlToken: 'private-control-token',
      stopSession: async () => { throw new Error('Unexpected process stop'); },
      spawnSession: async () => { throw new Error('Unexpected process spawn'); }, requestShutdown: () => {},
      onHappySessionWebhook: () => {}, externalActionApi });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const daemonAddress = app.server.address();
    if (!daemonAddress || typeof daemonAddress === 'string') throw new Error('Missing daemon address');
    const { mcp } = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createExternalMcpServer({ credentials,
      machineId: 'ambient-machine', daemonControlTarget: { pid: process.pid, httpPort: daemonAddress.port, controlToken: 'private-control-token' },
      serverFeaturesSnapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: { machines: { enabled: true } }, capabilities: {
        serverIdentity: { serverIdentityId: 'srv_home' },
      } }) } }));
    const mcpClient = new Client({ name: 'managed-power-ingress', version: '1' });
    const [mcpServerTransport, mcpClientTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(mcpServerTransport); await mcpClient.connect(mcpClientTransport);
    try {
      for (const intent of ['stop', 'start', 'delete'] as const) {
        const actionId = intent === 'delete' ? 'machines.managed.delete' : 'machines.managed.power.set';
        const actionRequestId = `${surface}-${intent}`;
        const input = { homeId: 'srv_home', managedId: 'managed-local', expectedRevision: 1, when: 'now', intent,
          ...(intent === 'delete' ? { reviewedDependencies: true } : {}) };
        const receipt = ManagedIntentResultSchema.parse({ kind: 'accepted', managedId: 'managed-local', intentRevision: 2,
          operation: { operationId: `operation-${actionRequestId}` } });
        receipts.set(actionRequestId, receipt);
        if (surface === 'cli') {
          const response = await app.inject({ method: 'POST', url: '/actions/root/execute',
            headers: { 'x-happier-daemon-token': 'private-control-token' },
            payload: { actionId, input, ...(intent === 'delete' ? {} : { target }), surface, actionRequestId } });
          expect(response.statusCode).toBe(200);
          expect(response.json(), JSON.stringify(events)).toEqual({ ok: true, result: receipt });
        } else {
          const mcpResult = CallToolResultSchema.parse(await mcpClient.callTool({ name: 'action_execute', arguments: { actionId, input } }));
          const content = mcpResult.content.find(entry => entry.type === 'text');
          expect(mcpResult.isError, content?.type === 'text' ? content.text : JSON.stringify(mcpResult)).not.toBe(true);
          expect(content?.type === 'text' ? JSON.parse(content.text) : null).toEqual(receipt);
        }
        const delivered = deliveries.at(-1)!;
        expect(delivered.envelope).toEqual({ v: 1, input, requestId: surface === 'cli' ? actionRequestId : expect.any(String), target });
        expect(openExternalActionRequesterAccountContextV1({ authorization: delivered.executionAuthorization,
          purpose: { kind: 'external_action' }, machineId: machine.id, installationId: machine.installationId,
          serverIdentityId: 'srv_home', installationPrivateKey: keys.secretKey, includeInvocation: true })).toMatchObject({
          invocation: { caller: { kind: 'host' }, surface, authority: surface === 'mcp' ? 'account_automation' : 'present_user' },
        });
      }
      expect(deliveries).toHaveLength(3);
      expect(events).toEqual(deliveries.flatMap(delivery => [
        `admit:${delivery.envelope.requestId}`, `deliver:${delivery.envelope.requestId}`,
      ]));
    } finally {
      await mcpClient.close(); await mcp.close();
      await app.close(); upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });



  it('returns the durable pool approval before a human decision instead of retaining the root request', async () => {
    let storedApproval: unknown;
    let poolRequested = false;
    const upstream = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/account/encryption') {
        response.end(JSON.stringify({ mode: 'plain', updatedAt: 0 }));
        return;
      }
      if (request.url === '/v1/artifacts' && request.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const wire = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const content = decodePlainArtifactStoredContent(wire.body);
        if (!content || typeof content !== 'object' || !('body' in content) || typeof content.body !== 'string') {
          response.writeHead(400).end();
          return;
        }
        storedApproval = ApprovalRequestSchema.parse(JSON.parse(content.body));
        response.end(JSON.stringify({ ...wire, headerVersion: 1, bodyVersion: 1 }));
        return;
      }
      poolRequested ||= request.url === '/v4/connect/qualified/groups';
      response.writeHead(404).end(JSON.stringify({ error: 'unexpected_request' }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const credentials = { token: 'boundary-token', encryption: null } as const;
    const serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;
    const { executor } = createCliActionExecutorHarness({
      token: credentials.token, credentials, serverId: 'server-local', serverHttpBaseUrl,
      sessionId: '', mode: 'plain', ctx: null,
      actionsSettingsProvider: createActionSettingsProvider({
        scopeKey: 'root-pool-approval-boundary', accountSettings: accountSettingsParse({}),
      }),
    });
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine-local', controlToken: 'private-control-token',
      stopSession: async () => { throw new Error('Unexpected process stop'); },
      spawnSession: async () => { throw new Error('Unexpected process spawn'); },
      requestShutdown: () => { throw new Error('Unexpected process shutdown'); },
      onHappySessionWebhook: () => {},
      externalActionApi: {
        currentServerId: 'server-local', executor,
        verifyPat: async () => { throw new Error('Signed root does not use PAT verification'); },
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverHttpBaseUrl }),
      },
    });
    const coordinator = getSharedBlockingApprovalCoordinator();
    let approvalCreated!: (artifactId: string) => void;
    const created = new Promise<string>((resolve) => { approvalCreated = resolve; });
    const subscription = coordinator.subscribeApprovalChanges(({ artifactId, request }) => {
      if ('actionId' in request && request.actionId === 'connectedServices.pools.create') approvalCreated(artifactId);
    });
    const response = runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => await app.inject({ method: 'POST', url: '/actions/root/execute',
      headers: { 'x-happier-daemon-token': 'private-control-token' },
      payload: { actionId: 'connectedServices.pools.create', actionRequestId: 'pool-approval-request', input: {
        service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, group: { groupId: 'pool-approval' },
      } },
    }));
    let artifactId: string | undefined;
    try {
      artifactId = await Promise.race([created, response.then((reply) => {
        throw new Error(`Root request ended before approval persistence: ${JSON.stringify(reply.json())}`);
      })]);
      // Artifact acknowledgement has completed. Deferred response settlement is
      // microtask-only; a blocking decision waiter survives the next event-loop turn.
      const result = await Promise.race([response.then((reply) => reply.json()),
        new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending')))]);
      expect(result).toEqual({ ok: true, result: { kind: 'approval_request_created', artifactId,
        actionId: 'connectedServices.pools.create' } });
      expect(storedApproval).toMatchObject({ status: 'open', approval: { flow: 'deferred', result: 'required' },
        actionId: 'connectedServices.pools.create', requestedSurface: 'cli' });
      expect(poolRequested).toBe(false);
    } finally {
      if (artifactId) coordinator.cancelApproval(artifactId, 'test cleanup');
      subscription.dispose();
      await response;
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await app.close();
    }
  });

  it('cancels abandoned root pool requests and returns an uncertain result on the service deadline', async () => {
    let received!: () => void;
    let closed!: () => void;
    const accepted = new Promise<void>((resolve) => { received = resolve; });
    const cancelled = new Promise<void>((resolve) => { closed = resolve; });
    let releasePolicy!: () => void;
    let policyRequested!: () => void;
    const policyAccepted = new Promise<void>((resolve) => { policyRequested = resolve; });
    let upstreamPath: string | undefined;
    const upstream = createServer((request, response) => {
      if (request.url === ACCOUNT_SECURITY_PATH_V1) {
        releasePolicy = () => {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ v: 1, encryptionMode: 'plain', nativeEmail: null,
            password: { status: 'not_enrolled', revision: null }, terminalPresentUserPolicy: 'allowed' }));
        };
        policyRequested();
        return;
      }
      upstreamPath = request.url;
      request.resume();
      request.on('end', received);
      response.on('close', closed);
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const credentials = { token: 'boundary-token', encryption: null } as const;
    const serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;
    const { executor } = createCliActionExecutorHarness({
      token: credentials.token, credentials, serverId: 'server-local', serverHttpBaseUrl,
      sessionId: '', mode: 'plain', ctx: null,
      actionsSettingsProvider: createActionSettingsProvider({ scopeKey: 'root-action-hang-boundary', accountSettings: accountSettingsParse({
        actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'connectedServices.pools.create': ['cli'] } },
      }) }),
    });
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine-local', controlToken: 'private-control-token',
      stopSession: async () => { throw new Error('Unexpected process stop'); },
      spawnSession: async () => { throw new Error('Unexpected process spawn'); },
      requestShutdown: () => { throw new Error('Unexpected process shutdown'); },
      onHappySessionWebhook: () => {},
      externalActionApi: {
        currentServerId: 'server-local', executor,
        terminalPolicyScope: { token: credentials.token, serverHttpBaseUrl },
        verifyPat: async () => { throw new Error('Signed root does not use the PAT network verifier'); },
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverHttpBaseUrl }),
      },
    });
    const controller = new AbortController();
    let rootRequested!: () => void;
    const rootAccepted = new Promise<void>((resolve) => { rootRequested = resolve; });
    app.addHook('onRequest', async (request) => {
      if (request.url === '/actions/root/execute') rootRequested();
    });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const rootAddress = app.server.address();
      if (!rootAddress || typeof rootAddress === 'string') throw new Error('Missing daemon address');
      const url = `http://127.0.0.1:${rootAddress.port}/actions/root/execute`;
      const headers = { 'x-happier-daemon-token': 'private-control-token' };
      const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
      const policyRefresh = refreshTerminalPresentUserPolicy({ token: credentials.token, serverHttpBaseUrl });
      await policyAccepted;
      const request = axios.post(url, { actionId: 'connectedServices.pools.create', input: { service, group: { groupId: 'pool-cancel' } } }, {
        signal: controller.signal, headers,
      });
      const outcome = request.catch((error: unknown) => error);
      await rootAccepted;
      expect((await app.inject({ method: 'POST', url: '/ping', payload: {}, headers })).statusCode).toBe(200);
      expect(upstreamPath).toBeUndefined();
      releasePolicy();
      expect(await policyRefresh).toBe('allowed');
      await Promise.race([accepted, outcome.then((value) => {
        const data = value && typeof value === 'object' && 'data' in value ? value.data : value;
        throw new Error(`Root request ended before pool HTTP: ${axios.isAxiosError(value) ? value.message : JSON.stringify(data)}`);
      })]);
      expect(upstreamPath).toBe('/v4/connect/qualified/groups');
      expect((await app.inject({ method: 'POST', url: '/ping', payload: {}, headers })).statusCode).toBe(200);
      controller.abort();
      expect(axios.isCancel(await outcome)).toBe(true);
      await cancelled;
      vi.stubEnv('HAPPIER_CONNECTED_SERVICES_API_TIMEOUT_MS', '1000');
      const timedOut = await axios.post(url, {
        actionId: 'connectedServices.pools.create', input: { service, group: { groupId: 'pool-timeout' } },
      }, { headers });
      expect(timedOut.data).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    } finally {
      controller.abort();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await app.close();
    }
  }, 4000);
});
