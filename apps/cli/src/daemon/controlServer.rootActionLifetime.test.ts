import { once } from 'node:events';
import { createServer } from 'node:http';
import { Server as SocketIoServer } from 'socket.io';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequestSchema, AutomationV3RunMutationResponseSchema, accountSettingsParse, decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createDaemonExternalActionTargetResolver } from './externalActions/daemonExternalActionTargetResolver';
import { createDaemonControlApp } from './controlServer';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
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

  it('keeps controllerless standalone MCP power with the Account provisioner owner', async () => {
    const managed = ManagedMachineV1Schema.parse({ id: 'account-managed', homeId: 'srv_home', custodianAccountId: 'account',
      launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      allocation: 'unsubmitted', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 1,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const paths: string[] = [];
    const upstream = createServer(async (request, response) => {
      paths.push(request.url ?? '');
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/account/encryption') return void response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
      if (request.url === '/v1/account/encryption/currentness') return void response.end(JSON.stringify({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
      if (request.url === '/v1/machines/managed/actions/get') return void response.end(JSON.stringify(managed));
      response.writeHead(404).end('{}');
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing Account Home address');
    const endpoint = `http://127.0.0.1:${address.port}`;
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({ v: 1, actions: {},
      approvalWaivedSurfaces: { 'machines.managed.power.set': ['mcp'] } }));
    const { mcp } = runWithServerHttpBaseUrl(endpoint, () => createExternalMcpServer({
      credentials: { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`,
        encryption: null, credentialProvenance: 'stored_session' }, daemonControlTarget: null,
      serverFeaturesSnapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: { machines: { enabled: true } },
        capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } } }) } }));
    const client = new Client({ name: 'controllerless-power', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport); await client.connect(clientTransport);
    try {
      const immediate = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
        actionId: 'machines.managed.power.set', input: { homeId: managed.homeId, managedId: managed.id,
          expectedRevision: 1, when: 'now', intent: 'start' } } }));
      const immediateText = immediate.content.find(entry => entry.type === 'text');
      // This row has no admitted provider descriptor: the Account owner refuses
      // that missing prerequisite without inventing or requiring a daemon.
      expect(immediateText?.type === 'text' ? JSON.parse(immediateText.text) : null).toMatchObject({ errorCode: 'admission_unavailable' });
      expect(paths).toContain('/v1/machines/managed/actions/get');
      expect(paths.some(path => path.startsWith('/v1/actions/'))).toBe(false);
    } finally {
      await client.close(); await mcp.close(); upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });

  it('preserves one Run-now retry key across distinct signed CLI and MCP requests to Home', async () => {
    const receipt = AutomationV3RunMutationResponseSchema.parse({ run: {
      id: 'run-one', automationId: 'habit-one', revision: 0, triggerId: null, triggerRetired: false,
      state: 'queued', cause: { kind: 'manual', invokedAt: 1 }, dueAt: 1,
      claimedAt: null, startedAt: null, finishedAt: null, claimedByMachineId: null, leaseExpiresAt: null,
      attempt: 0, errorCode: null, producedSessionId: null, executionDispatchState: null, executionAttempt: 0,
      replyHandoffState: 'none', replyHandoffAttempt: 0, replyHandoffDueAt: null, createdAt: 1, updatedAt: 1,
    }, workflowRun: { recipeKind: 'workflow-v2', workflowRunId: 'run-one' } });
    const submittedKeys: Array<string | string[] | undefined> = [];
    const requestedPaths: string[] = [];
    const features = FeaturesResponseSchema.parse({ features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {} });
    // Home HTTP is the genuine system boundary. Root admission, Action dispatch,
    // trigger semantics and the strict mutation-receipt decoder stay real.
    const upstream = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      requestedPaths.push(`${request.method} ${request.url}`);
      if (request.url === '/v1/features' || request.url === '/v1/features/authenticated') {
        response.end(JSON.stringify(features));
        return;
      }
      if (request.url === '/v1/account/encryption/currentness') {
        response.end(JSON.stringify({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
        return;
      }
      if (request.url === '/v3/automations/habit-one/run-now' && request.method === 'POST') {
        submittedKeys.push(request.headers['idempotency-key']);
        response.end(JSON.stringify(receipt));
      } else response.writeHead(404).end(JSON.stringify({ error: 'unexpected_request' }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;
    const credentials = { token: 'boundary-token', encryption: null } as const;
    const { executor } = createCliActionExecutorHarness({ token: credentials.token, credentials,
      serverId: 'server-local', serverHttpBaseUrl, sessionId: '', mode: 'plain', ctx: null,
      resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: serverHttpBaseUrl, token: credentials.token }),
      actionsSettingsProvider: createActionSettingsProvider({ scopeKey: 'habit-retry-root',
        accountSettings: accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {},
          approvalWaivedSurfaces: { 'workflow.trigger.run_now': ['cli', 'mcp'] } } }) }),
    });
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine-local',
      controlToken: 'private-control-token', stopSession: async () => { throw new Error('Unexpected stop'); },
      spawnSession: async () => { throw new Error('Unexpected spawn'); }, requestShutdown: () => {},
      onHappySessionWebhook: () => {}, externalActionApi: { currentServerId: 'server-local', executor,
        verifyPat: async () => { throw new Error('Signed root does not verify PATs'); },
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverHttpBaseUrl }),
      } });
    try {
      for (const { surface, actionRequestId } of [
        { surface: 'cli', actionRequestId: 'first-transport' },
        { surface: 'cli', actionRequestId: 'retry-transport' },
        { surface: 'mcp', actionRequestId: 'agent-transport' },
      ] as const) {
        const response = await app.inject({ method: 'POST', url: '/actions/root/execute',
          headers: { 'x-happier-daemon-token': 'private-control-token' },
          payload: { actionId: 'workflow.trigger.run_now', surface, actionRequestId,
            input: { automationId: 'habit-one', idempotencyKey: 'same-user-intent' } } });
        expect(response.statusCode).toBe(200);
        expect(response.json(), JSON.stringify(requestedPaths)).toEqual({ ok: true, result: receipt });
      }
      expect(submittedKeys).toEqual(['same-user-intent', 'same-user-intent', 'same-user-intent']);
      const malformed = await app.inject({ method: 'POST', url: '/actions/root/execute',
        headers: { 'x-happier-daemon-token': 'private-control-token' },
        payload: { actionId: 'workflow.trigger.run_now', input: { automationId: 'habit-one', idempotencyKey: '' } } });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({ ok: false, errorCode: 'invalid_envelope', error: 'invalid_envelope' });
      expect(submittedKeys).toHaveLength(3);
    } finally {
      await app.close(); upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });

  it.each(['connectedServices.pools.create', 'mcp.servers.import', 'mcp.servers.signIn.start',
    'connectedServices.authentication.submitManual', 'connectedServices.authentication.completeOAuth'] as const)(
    'preserves canonical %s approval response custody before a human decision', async actionId => {
    let storedApproval: unknown;
    let storedArtifact: Readonly<Record<string, unknown>> | undefined;
    let poolRequested = false;
    let holdArtifactAcknowledgement = false;
    let artifactWaiting!: () => void;
    const waiting = new Promise<void>(resolve => { artifactWaiting = resolve; });
    let releaseArtifact!: () => void;
    const released = new Promise<void>(resolve => { releaseArtifact = resolve; });
    let callerDisconnected!: () => void;
    const disconnected = new Promise<void>(resolve => { callerDisconnected = resolve; });
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
        storedArtifact = { ...wire, headerVersion: 1, bodyVersion: 1, seq: 1,
          createdAt: 1, updatedAt: 1, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain', publicAudience: null };
        if (holdArtifactAcknowledgement) {
          artifactWaiting();
          await released;
        }
        response.end(JSON.stringify(storedArtifact));
        return;
      }
      if (request.method === 'GET' && request.url === `/v1/artifacts/${storedArtifact?.id}`) {
        response.end(JSON.stringify(storedArtifact));
        return;
      }
      poolRequested ||= request.url === '/v4/connect/qualified/groups';
      response.writeHead(404).end(JSON.stringify({ error: 'unexpected_request' }));
    });
    // Home socket I/O is the boundary; registration and the live approval owner remain real.
    const sockets = new SocketIoServer(upstream, { path: '/v1/updates/' });
    sockets.on('connection', socket => {
      socket.on(SOCKET_RPC_EVENTS.REGISTER, ({ method }: { method: string }) => {
        socket.emit(SOCKET_RPC_EVENTS.REGISTERED, { method });
      });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', provenance: {
      v: 1, kind: 'account', authority: 'present_user',
    } })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null } as const;
    const serverHttpBaseUrl = `http://127.0.0.1:${address.port}`;
    const { executor } = createCliActionExecutorHarness({
      token: credentials.token, credentials, serverId: 'server-local', serverIdentityId: 'srv_home', serverHttpBaseUrl,
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
        currentServerId: 'server-local', currentAccountId: 'account', executor,
        verifyPat: async () => { throw new Error('Signed root does not use PAT verification'); },
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverHttpBaseUrl }),
      },
    });
    const coordinator = getSharedBlockingApprovalCoordinator();
    let approvalCreated!: (artifactId: string) => void;
    const created = new Promise<string>((resolve) => { approvalCreated = resolve; });
    let abandonedApprovalCreated!: (artifactId: string) => void;
    const abandonedCreated = new Promise<string>(resolve => { abandonedApprovalCreated = resolve; });
    const subscription = coordinator.subscribeApprovalChanges(({ artifactId, request }) => {
      if ('actionId' in request && request.actionId === actionId) {
        if (holdArtifactAcknowledgement) abandonedApprovalCreated(artifactId);
        else approvalCreated(artifactId);
      }
    });
    app.addHook('onRequest', async (request, reply) => {
      if (request.headers['x-test-abandoned'] === 'true') reply.raw.once('close', callerDisconnected);
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const rootAddress = app.server.address();
    if (!rootAddress || typeof rootAddress === 'string') throw new Error('Missing daemon address');
    const controller = new AbortController();
    const response = runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
      const reply = await axios.post(`http://127.0.0.1:${rootAddress.port}/actions/root/execute`, { actionId, actionRequestId: 'pool-approval-request', input: actionId === 'mcp.servers.import'
        ? { source: { kind: 'paste', text: JSON.stringify({ mcpServers: {
          'qa-cliparity-approval-only': { url: 'https://example.invalid/qa-cliparity' },
        } }) }, dryRun: true, where: { kind: 'replace', rules: [] } }
        : actionId === 'mcp.servers.signIn.start' ? { serverId: 'qa-sign-in', client: { clientId: 'private-client', clientSecret: 'private-secret' } }
        : actionId === 'connectedServices.authentication.submitManual' ? { attemptId: 'manual-attempt', fields: { token: 'private-manual-token' } }
        : actionId === 'connectedServices.authentication.completeOAuth' ? { attemptId: 'oauth-attempt', completion: { code: 'private-oauth-code', callbackUrl: 'https://callback.invalid/', state: 'private-oauth-state' } }
        : {
        service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, group: { groupId: 'pool-approval' },
      } }, { signal: controller.signal, headers: { 'x-happier-daemon-token': 'private-control-token' } });
      return { json: () => reply.data };
    });
    let artifactId: string | undefined;
    try {
      artifactId = await Promise.race([created, response.then((reply) => {
        throw new Error(`Root request ended before approval persistence: ${JSON.stringify(reply.json())}`);
      })]);
      let result: unknown;
      void response.then(reply => { result = reply.json(); });
      await expect.poll(() => result).toEqual({ ok: true,
        result: { kind: 'approval_request_created', artifactId, actionId } });
      expect(JSON.stringify(storedApproval)).not.toContain('private-manual-token');
      expect(JSON.stringify(storedApproval)).not.toContain('private-oauth-code');
      expect(storedApproval).toMatchObject({ status: 'open', approval: {
        flow: actionId === 'connectedServices.pools.create' ? 'deferred' : 'blocking', result: 'required' },
        actionId, requestedSurface: 'cli' });
      expect(poolRequested).toBe(false);
      if (actionId === 'mcp.servers.import') {
        // The caller has received its receipt and disconnects; private input stays with the daemon.
        controller.abort();
        expect(coordinator.getLiveWaiterCount(artifactId)).toBe(1);
        holdArtifactAcknowledgement = true;
        const abandoned = new AbortController();
        const abortedResponse = runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => await axios.post(
          `http://127.0.0.1:${rootAddress.port}/actions/root/execute`, {
            actionId, actionRequestId: 'paste-abandoned-before-receipt', input: { source: { kind: 'paste', text: JSON.stringify({
              mcpServers: { 'qa-cliparity-approval-only': { url: 'https://example.invalid/qa-cliparity' } },
            }) }, dryRun: true, where: { kind: 'replace', rules: [] } },
          }, { signal: abandoned.signal, headers: { 'x-happier-daemon-token': 'private-control-token', 'x-test-abandoned': 'true' } },
        )).catch((error: unknown) => error);
        await waiting;
        abandoned.abort();
        expect(axios.isCancel(await abortedResponse)).toBe(true);
        await disconnected;
        releaseArtifact();
        const abandonedArtifactId = await abandonedCreated;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(coordinator.getLiveWaiterCount(abandonedArtifactId)).toBe(0);
        await app.close();
        expect(coordinator.getLiveWaiterCount(artifactId)).toBe(0);
        expect(poolRequested).toBe(false);
      }
    } finally {
      releaseArtifact();
      if (artifactId) coordinator.cancelApproval(artifactId, 'test cleanup');
      subscription.dispose();
      await response;
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      upstream.closeAllConnections();
      if (upstream.listening) await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await app.close();
    }
  });

  it('cancels abandoned root pool requests and returns an uncertain result on the service deadline', async () => {
    let received!: () => void;
    let closed!: () => void;
    const accepted = new Promise<void>((resolve) => { received = resolve; });
    const cancelled = new Promise<void>((resolve) => { closed = resolve; });
    let upstreamPath: string | undefined;
    const upstream = createServer((request, response) => {
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
      const request = axios.post(url, { actionId: 'connectedServices.pools.create', input: { service, group: { groupId: 'pool-cancel' } } }, {
        signal: controller.signal, headers,
      });
      const outcome = request.catch((error: unknown) => error);
      await rootAccepted;
      expect((await app.inject({ method: 'POST', url: '/ping', payload: {}, headers })).statusCode).toBe(200);
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
