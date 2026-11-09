import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProjectServiceDeclarationTargetIdV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { deriveWorkspaceSyncRelationshipId, projectWorkspaceSyncAdmissionInputV1 } from '@happier-dev/protocol/workspaces/workspaceSyncAdmissionV1';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import axios from 'axios';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionRequestEnvelopeSchema, projectExternalActionApprovalDecisionAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { ApiClient } from '@/api/api';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { updateSettings } from '@/persistence';
import { configuration, reloadConfiguration } from '@/configuration';
import { releaseUnretainedRequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { executeExternalAction } from './executeExternalAction';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { resolveExternalActionRootInvocationAuthority, verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { logger } from '@/ui/logger';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// The listener and authenticated Home HTTP/socket transports are boundaries.
// Agent dispatch, requester recovery, executor and Service receiver stay real.
vi.mock('@/daemon/controlServer', async importOriginal => ({ ...await importOriginal<typeof import('@/daemon/controlServer')>(),
  startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));

it.each(['declared Service', 'incomplete native declaration'] as const)('handles Session Agent Start for %s', async scenario => {
  expect(getActionSpec('localServices.launcher.start').surfaces.agent).toBe(true);
  onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null;
    resetServerFeaturesClientForTests(); withdrawActiveProjectAccountRowsSnapshot(); });
  const homeId = 'srv_service_agent';
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null,
    credentialProvenance: 'stored_session' as const };
  const custodianAccountId = 'requester';
  const role = 'manage' as const;
  const personCredentials = { ...credentials, token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature` };
  const custodianCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: custodianAccountId, tokenEpoch: 0,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null,
    credentialProvenance: 'stored_session' as const };
  let runtimeActionExecute: ReturnType<ApiClient['createBrowserRuntimeActionExecutor']>;
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    ordinaryAccountSession: true, credentials: custodianCredentials, externalActionAccountId: custodianAccountId,
    accountActionCredentials: credentials, requesterCredentials: credentials,
    homeServerIdentityId: homeId, machineAccess: { custodianAccountId, role },
    runtimeActionExecute: request => runtimeActionExecute(request),
    machineRpcMethods: [RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED, RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START],
    resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
      browser: { enabled: true, viewTargets: { enabled: true } },
      localServices: { enabled: true, inventory: { enabled: true }, managed: { enabled: true },
        actions: { enabled: true }, launcher: { enabled: true } },
    }, capabilities: {} }) }),
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }),
  });
  runtimeActionExecute = (await ApiClient.create(custodianCredentials)).createBrowserRuntimeActionExecutor();
  const serverId = h.f.bootstrap.attribution.serverId;
  const rootPath = join(h.f.directory, 'accepted-project');
  await writeFile(join(rootPath, '.happier', 'project.json'), JSON.stringify({ version: 1, services: { checked: {
    source: { kind: 'command', command: `${JSON.stringify(process.execPath)} -e \"setInterval(() => {}, 1000)\"` },
  } } }));
  const instances = () => h.plugin.registry.projectManagedServices.listProjectServices().filter(service => service.kind === 'workspace');
  onTestFinished(async () => { await Promise.all(instances().map(service => service.stop())); });
  const authority = { happyHomeDir: h.f.directory, publicReleaseRing: configuration.publicReleaseRing };
  const bridge = await publishAgentRuntimeDaemonServiceAuthority({ ...authority,
    path: await createAgentRuntimeDaemonServiceAuthorityPath(authority), sessionId: h.sessionId,
    runner: h.runner, retainedAgent: h.retainedAgent, httpPort: 43129, capability: 'a'.repeat(43) });
  h.tracked.agentRuntimeDaemonServiceAuthorityFilePath = bridge.path;
  h.tracked.agentRuntimeDaemonServiceCapabilityHash = bridge.capabilityDigest;
  await seedTestServerProfile({ id: serverId, homeId, serverUrl: 'https://session-home.test' });
  await updateSettings(settings => ({ ...settings, activeServerId: serverId,
    machineIdByServerId: { ...settings.machineIdByServerId, [serverId]: 'machine' },
    lastTokenSubByServerId: { ...settings.lastTokenSubByServerId, [serverId]: 'requester' } }));
  reloadConfiguration();
  const owner = h.daemon.externalActionIngressOwner;
  if (!owner) throw new Error('Missing installed external Action owner');
  Reflect.set(h.machine, 'socket', createApiSessionSocketStub({ connected: true }));
  h.machine.setRPCHandlers({ spawnSession: async () => { throw new Error('Service Start must not launch a Session'); },
    stopSession: async () => true, requestShutdown() {} }, { externalActionIngressOwner: owner,
    actionsSettingsProvider: h.actionsSettingsProvider,
    requesterSessionRuntime: { serverId, resolve: h.resolveRequesterRuntime, release: releaseUnretainedRequesterSessionRuntimeContext },
    requesterBootstrapBoundary: { serverId, serverHttpBaseUrl: 'https://session-home.test', happyHomeDir: h.f.directory,
      getObservedServerIdentityId: async () => homeId,
      readInstallation: async () => ({ machineId: 'machine', identity: h.f.installation }),
      spawnLifecycleHandler: async () => { throw new Error('Service Start must not launch a Session'); } },
  });
  const manager: unknown = Reflect.get(h.machine, 'rpcHandlerManager');
  if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing installed Service receiver');
  const homeWrite = vi.mocked(axios.post).getMockImplementation();
  const homeRead = vi.mocked(axios.get).getMockImplementation();
  if (!homeWrite || !homeRead) throw new Error('Missing Home transport boundary');
  let roots = 0;
  const mintFailures: string[] = [];
  const transportFailures: string[] = [];
  const rowResponses: unknown[] = [];
  const homeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    const input = args[0];
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/v1/features/authenticated' || url.pathname === '/v1/features') return Response.json(
      FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: homeId } } }));
    try { return await homeFetch(...args); }
    catch (error) { transportFailures.push(String(error)); throw error; }
  });
  const receiverResults: unknown[] = [];
  const phases: unknown[] = [];
  vi.spyOn(logger, 'debug').mockImplementation((...args) => {
    if ((args[0] === '[ActionApproval] origin phase' || args[0] === '[ProjectService] launch phase')
      && args[1] && typeof args[1] === 'object') phases.push(args[1]);
  });
  let artifact: Record<string, unknown> | undefined;
  const installationPublicKey = Buffer.from(h.f.installation.publicKey, 'base64url').toString('base64');
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path.startsWith('/v1/artifacts/')) return artifact && path === '/v1/artifacts/' + artifact.id
      ? { status: 200, data: artifact } : { status: 404, data: { error: 'not_found' } };
    if (path === '/v1/machines') {
      const response = await homeRead('https://session-home.test/v1/machines/machine', args[1]);
      return { status: 200, data: [{ ...response.data.machine, active: true,
        installationPublicKey }] };
    }
    let response;
    try { response = await homeRead(...args); }
    catch (error) { transportFailures.push(String(error)); throw error; }
    if (path === `/v2/sessions/${h.sessionId}`) return { ...response, data: { ...response.data,
      session: { ...response.data.session, metadata: JSON.stringify({ ...JSON.parse(response.data.session.metadata), permissionMode: 'default' }) } } };
    if (new URL(String(args[0])).pathname === '/v1/machines/machine') return { ...response, data: {
      ...response.data, machine: { ...response.data.machine, kind: 'persistent', active: true, revokedAt: null,
        replacedByMachineId: null, installationPublicKey } } };
    return response;
  });
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path === `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`) return { status: 200, data: { status: 'absent' } };
    if (path === `/v2/sessions/${h.sessionId}/pending`) return { status: 200, data: { didWrite: true,
      message: { localId: args[1] && typeof args[1] === 'object' ? Reflect.get(args[1], 'localId') : undefined } } };
    if (path.startsWith(`/v2/sessions/${h.sessionId}/pending/`) && path.endsWith('/delivery/block'))
      return { status: 200, data: { ok: true } };
    if (path === '/v1/artifacts' || artifact && path === '/v1/artifacts/' + artifact.id) {
      const mutation = readCarrierMutation(args[1]);
      const version = Number(artifact?.bodyVersion ?? 0) + 1;
      artifact = { ...artifact, ...mutation, ownerAccountId: 'requester', access: 'owner', publicAudience: 'none',
        encryptionMode: 'plain', headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version };
      return { status: 200, data: { id: artifact.id, success: true, headerVersion: version, bodyVersion: version } };
    }
    if (path.endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
    if (path === '/v1/actions/approval.request.decide') {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(args[1]);
      const authorization = request.executionAuthorization;
      const result = await executeExternalAction({ ...owner, actionId: 'approval.request.decide',
        envelope: request.envelope, executionAuthorization: authorization,
        principal: { accountId: 'requester', authority: 'present_user', authentication: { kind: 'account', tokenEpoch: 0 } },
        currentMachineId: 'machine', currentAccountId: custodianAccountId, currentInstallationId: h.f.installation.installationId,
        verifyExecutionAuthorization: async () => true, signal: h.signal });
      receiverResults.push(result);
      if (result.kind !== 'response') throw new Error('Installed approval ingress refused');
      return { status: 200, data: result.response };
    }
    if (path !== '/v1/actions/localServices.launcher.start/execution-authorization'
      && path !== '/v1/actions/approval.request.decide/execution-authorization') {
      try { const response = await homeWrite(...args);
        if (path.includes('/project-rows/')) rowResponses.push({ path, body: args[1], status: response.status, data: response.data,
          originalAccount: args[2]?.headers?.Authorization === `Bearer ${credentials.token}` });
        return response; }
      catch (error) { transportFailures.push(String(error)); throw error; }
    }
    try {
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(args[1]);
    const actionId = path.includes('/approval.request.decide/') ? 'approval.request.decide' : 'localServices.launcher.start';
    if (actionId === 'localServices.launcher.start') {
    if (!request.sessionActionOrigin || !request.sessionActionSource || !request.installationProof) throw new Error('Missing Agent Session root proof');
    expect(request.sessionActionOrigin.caller).toMatchObject({ kind: 'session', sessionId: h.sessionId });
    expect(verifyMachineInstallationProof({ publicKey: h.f.installation.publicKey, proof: request.installationProof,
      payload: { version: 1, accountId: 'requester', ...request.sessionActionSource,
        externalActionOrigin: { homeId, actionId: 'localServices.launcher.start', requestId: request.envelope.requestId!,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), origin: request.sessionActionOrigin } } })).toBe(true);
    roots++;
    }
    const sync = request.envelope.v === 1 ? projectWorkspaceSyncAdmissionInputV1(actionId, request.envelope.input)
      : request.envelope.workspaceSyncAdmission;
    return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'project-agent-root', binding: {
      accountId: 'requester', custodianAccountId, serverIdentityId: homeId,
      authentication: { kind: actionId === 'localServices.launcher.start' ? 'terminal' : 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
      machineId: 'machine', installationId: h.f.installation.installationId, admittedMachineRole: role,
      actionId, requestId: request.envelope.requestId, target: request.envelope.target,
      ...(request.envelope.idempotencyKey ? { idempotencyKey: request.envelope.idempotencyKey } : {}),
      ...(sync ? { workspaceSyncAdmission: { relationshipId: sync.relationshipId ?? deriveWorkspaceSyncRelationshipId(request.envelope.requestId!),
        sourceWorkspaceRefId: sync.sourceWorkspaceRefId, source: { actorAccountId: 'requester', custodianAccountId,
          machineId: sync.sourceMachineId, installationId: h.f.installation.installationId, role, encryptionMode: 'plain' } } } : {}),
      ...(actionId === 'approval.request.decide' ? { approvalDecisionAdmission: projectExternalActionApprovalDecisionAdmissionV1(request.envelope.v === 1 ? request.envelope.input : {}) } : {}),
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
      sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource,
    } }) };
    } catch (error) { mintFailures.push(error instanceof Error ? error.message : String(error)); throw error; }
  });
  const observeSocket = (socket: Socket) => socket.on(SOCKET_RPC_EVENTS.CALL,
    async (packet: SocketRpcRequestPayload, acknowledge: (result: unknown) => void) => {
      try {
        const execution = packet.externalActionExecution;
        const result = await manager.handleRequest({ method: packet.method, params: packet.params,
          requestId: packet.requestId, callerAuthority: execution
            ? resolveExternalActionRootInvocationAuthority(execution.authorization) : 'present_user',
          ...(execution ? { callerInputAuthorization: execution.authorization } : {}),
          ...(execution?.authorization.binding.sessionActionOrigin
            ? { sessionActionOrigin: execution.authorization.binding.sessionActionOrigin } : {}),
          ...(packet.originalActionEnvelope ? { originalActionEnvelope: ExternalActionRequestEnvelopeSchema.parse(packet.originalActionEnvelope) } : {}),
          machineAdmission: { actorAccountId: 'requester', custodianAccountId, machineId: 'machine',
            installationId: h.f.installation.installationId, role, encryptionMode: 'plain' } });
        receiverResults.push({ method: packet.method, result });
        acknowledge({ ok: true, result });
      } catch (error) { acknowledge({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });
  for (const socket of h.f.channel.server.sockets.sockets.values()) observeSocket(socket);
  h.f.channel.server.on('connection', observeSocket);
  expect(await resolveSessionTransportContext({ credentials, idOrPrefix: h.sessionId, reason: 'session-action' })).toMatchObject({ ok: true });
  const result = await h.dispatch({ kind: 'action.execute', surface: 'agent', actionId: 'localServices.launcher.start',
    requestId: h.operationBase().requestId,
    input: scenario === 'incomplete native declaration' ? {
      machineId: 'machine', targetId: 'QA-AGENT-TURNS-1107-svc', sessionId: h.sessionId,
      declaration: { workspaceRefId: '/tmp/QA-AGENT-TURNS-1107-svc', selection: { kind: 'native',
        source: { kind: 'native', tool: 'package_script', file: 'index.html', target: 'python3 -m http.server 42512 --bind 127.0.0.1' } } },
    } : { machineId: 'machine', sessionId: h.sessionId,
      targetId: createProjectServiceDeclarationTargetIdV1({ serverId, machineId: 'machine', id: 'workspace' }, { kind: 'manifest', name: 'checked' }),
      workspace: { serverId, workspaceId: 'workspace', machineId: 'machine', rootPath },
      declaration: { workspaceRefId: 'workspace', selection: { kind: 'manifest', name: 'checked' } } },
    witness: { turnId: 'project-turn', inputId: 'project-input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
      agentStartCaller: { kind: 'session', sessionId: h.sessionId, starterDepth: 0, turnDepth: 0 }, callerPermissionMode: 'default' } });
  if (scenario === 'incomplete native declaration') {
    expect(result, JSON.stringify({ result, roots, mintFailures })).toMatchObject({ ok: true,
      result: { kind: 'action.execution', outcome: { ok: false, errorCode: 'launcher_start_declaration_unavailable' } } });
    expect(artifact).toBeUndefined();
    expect(instances()).toHaveLength(0);
    expect(roots).toBe(1);
    return;
  }
  expect(result, JSON.stringify({ result, roots, mintFailures })).toMatchObject({ ok: true,
    result: { kind: 'action.execution', outcome: { ok: true, result: { kind: 'approval_request_created' } } } });
  expect(instances()).toHaveLength(0);
  if (!artifact || typeof artifact.id !== 'string') throw new Error('Agent request did not create a review card');
  const store = createCliApprovalsArtifactStore({ credentials, serverHttpBaseUrl: 'https://session-home.test' });
  const approval = ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId: artifact.id }));
  expect(approval).toMatchObject({ status: 'open' });
  if (!approval.executionOriginV1?.externalActionExecutionAuthorization || !approval.executionOriginV1.target) throw new Error('Missing retained root');
  expect(await verifyExternalActionExecutionAuthorizationCurrent({ authorization: approval.executionOriginV1.externalActionExecutionAuthorization,
    effectActionId: 'localServices.launcher.start', target: approval.executionOriginV1.target, privateKey: h.f.installation.privateKey,
    installationId: h.f.installation.installationId, serverHttpBaseUrl: 'https://session-home.test' })).toBe(true);
  const decided = await createCliActionExecutorFromCredentials({ credentials: personCredentials, serverId,
    serverApiUrl: 'https://session-home.test', machineId: 'machine', externalActionClient: true,
    readCredentials: async () => personCredentials, onRequesterSessionCredentialDisclosure: async () => true,
  }).execute('approval.request.decide', { artifactId: artifact.id, decision: 'approve', serverIdentityId: homeId },
    { surface: 'cli', authority: 'present_user' });
  expect(decided, JSON.stringify({ decided, receiverResults, roots, mintFailures, transportFailures, phases })).toMatchObject({ ok: true });
  expect(ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId: artifact.id })),
    JSON.stringify({ decided, receiverResults, roots, mintFailures, transportFailures, phases, rowResponses })).toMatchObject({ execution: { ok: true } });
  expect(instances()).toHaveLength(1);
  const service = instances()[0];
  expect(service.isServing()).toBe(true);
  const ownedRoot = h.plugin.registry.projectManagedServices.readProcessRoots().find(root =>
    root.owner.kind === 'service' && root.owner.serviceId === service.instanceId);
  if (!ownedRoot) throw new Error('Native Service did not publish its owned process');
  expect(process.kill(ownedRoot.pid, 0)).toBe(true);
  expect(roots).toBe(1);
  const stopped = await service.stop();
  expect(stopped).toMatchObject({ status: 'stopped' });
  expect(() => process.kill(ownedRoot.pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
  console.info('Session Agent Service native lifecycle', { pid: ownedRoot.pid, cleanup: stopped.status });
});
