import axios from 'axios';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionRequestEnvelopeSchema, projectExternalActionApprovalDecisionAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createApiSessionSocketStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { AgentRuntimeDaemonServiceRequestV1Schema, AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
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
import { ProjectAccountRowMutationRequestV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { projectAccountRowReadResponse } from '@/testkit/http/projectAccountRows';
import { resolveExternalActionRootInvocationAuthority } from '@/api/externalActionExecutionAuthorization';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { logger } from '@/ui/logger';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// The listener and authenticated Home HTTP/socket transports are boundaries.
// Agent dispatch, requester recovery, executor and Project receiver stay real.
vi.mock('@/daemon/controlServer', async importOriginal => ({ ...await importOriginal<typeof import('@/daemon/controlServer')>(),
  startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));

it.each([
  { actor: 'owner', actionId: 'projects.open' },
  { actor: 'owner-url-only', actionId: 'projects.open' },
  { actor: 'member', actionId: 'projects.open' },
  { actor: 'foreign-manager', actionId: 'projects.open' },
  { actor: 'owner', actionId: 'projects.inspect' },
] as const)('dispatches $actionId through the installed Account Agent receiver ($actor)', async ({ actor, actionId: rootActionId }) => {
  expect(getActionSpec('projects.open').surfaces.agent).toBe(true);
  onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null;
    resetServerFeaturesClientForTests(); withdrawActiveProjectAccountRowsSnapshot(); });
  const homeId = `srv_project_agent_${actor.replace('-', '_')}`;
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null,
    credentialProvenance: 'stored_session' as const };
  const losesProfileIdentity = actor === 'owner-url-only';
  const custodianAccountId = actor === 'owner' || losesProfileIdentity ? 'requester' : 'company';
  const role = actor === 'member' ? 'use' as const : 'manage' as const;
  const custodianCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: custodianAccountId, tokenEpoch: 0,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null,
    credentialProvenance: 'stored_session' as const };
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
    credentials: custodianCredentials, externalActionAccountId: custodianAccountId,
    accountActionCredentials: credentials, requesterCredentials: credentials,
    ...(rootActionId === 'projects.inspect' ? { ordinaryAccountSession: true } : {}),
    homeServerIdentityId: homeId, machineAccess: { custodianAccountId, role },
    machineRpcMethods: [RPC_METHODS.PROJECTS_OPEN, RPC_METHODS.PROJECTS_INSPECT, RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED],
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }),
  });
  const serverId = h.f.bootstrap.attribution.serverId;
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
  if (losesProfileIdentity) {
    const transport = axios.request.bind(axios);
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      if (new URL(String(config.url)).pathname === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) {
        return { status: 200, data: { v: 1, rows: [] } };
      }
      return transport(config);
    });
    const open = h.machine.callProjectOpen.bind(h.machine);
    vi.spyOn(h.machine, 'callProjectOpen').mockImplementation(async request => {
      // The profile can lose its exact descriptor between approval and native dispatch.
      await updateSettings(settings => {
        const { homeConnectionDescriptor: _descriptor, homeConnectionDescriptorAuthority: _authority,
          ...urlOnly } = settings.servers[serverId]!;
        return { ...settings, servers: { ...settings.servers, [serverId]: urlOnly } };
      });
      return open(request);
    });
  }
  const owner = h.daemon.externalActionIngressOwner;
  if (!owner) throw new Error('Missing installed external Action owner');
  Reflect.set(h.machine, 'token', custodianCredentials.token);
  Reflect.set(h.machine, 'socket', createApiSessionSocketStub({ connected: true,
    emitWithAck: (event, payload) => event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1
      ? { v: 1, result: 'success', revision: 1 } : resolveApiSessionSocketDefaultAck(event, payload) }));
  h.machine.setRPCHandlers({ spawnSession: async () => ({ type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE',
      errorMessage: 'Native Agent startup is unavailable in this process-boundary fixture' }),
    stopSession: async () => true, requestShutdown() {} }, { externalActionIngressOwner: owner,
    actionsSettingsProvider: h.actionsSettingsProvider,
    requesterSessionRuntime: { serverId, resolve: h.resolveRequesterRuntime,
      release: runtime => releaseUnretainedRequesterSessionRuntimeContext(runtime,
        [...h.trackedSessionsByKey.values()].map(session => session.requesterSessionRuntimeContext)) },
    requesterBootstrapBoundary: { serverId, serverHttpBaseUrl: 'https://session-home.test', happyHomeDir: h.f.directory,
      getObservedServerIdentityId: async () => homeId,
      readInstallation: async () => ({ machineId: 'machine', identity: h.f.installation }),
      spawnLifecycleHandler: async () => { throw new Error('Project Open must not launch a Session'); } },
  });
  const manager: unknown = Reflect.get(h.machine, 'rpcHandlerManager');
  if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing installed Project receiver');
  const homeWrite = vi.mocked(axios.post).getMockImplementation();
  const homeRead = vi.mocked(axios.get).getMockImplementation();
  if (!homeWrite || !homeRead) throw new Error('Missing Home transport boundary');
  let roots = 0;
  const mintFailures: string[] = [];
  const transportFailures: string[] = [];
  const homeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    const input = args[0];
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/v1/account/profile') return Response.json({ id:
      new Headers(args[1]?.headers ?? (input instanceof Request ? input.headers : undefined)).get('Authorization') === `Bearer ${custodianCredentials.token}`
        ? custodianAccountId : 'requester' });
    if (url.pathname === '/v1/features/authenticated' || url.pathname === '/v1/features') return Response.json(
      FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: homeId } } }));
    try { return await homeFetch(...args); }
    catch (error) { transportFailures.push(String(error)); throw error; }
  });
  const receiverResults: unknown[] = [];
  const phases: unknown[] = [];
  vi.spyOn(logger, 'warnLocalFile').mockImplementation((...args) => { phases.push(args); });
  let artifact: Record<string, unknown> | undefined;
  const rows: ProjectAccountRowV1[] = [];
  const installationPublicKey = Buffer.from(h.f.installation.publicKey, 'base64url').toString('base64');
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path === '/v1/account/profile') return { status: 200, data: { id:
      args[1]?.headers?.Authorization === `Bearer ${custodianCredentials.token}` ? custodianAccountId : 'requester' } };
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
    if (path === `/v2/sessions/${h.sessionId}/pending`) return { status: 200, data: { didWrite: true,
      message: { localId: args[1] && typeof args[1] === 'object' ? Reflect.get(args[1], 'localId') : undefined } } };
    if (path.startsWith(`/v2/sessions/${h.sessionId}/pending/`) && path.endsWith('/delivery/block'))
      return { status: 200, data: { ok: true } };
    if (path === '/v1/account/project-rows/list') return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
    if (path === '/v1/account/project-rows/read') return projectAccountRowReadResponse(rows, args[1]);
    if (path === '/v1/account/project-rows/mutate') {
      const request = ProjectAccountRowMutationRequestV1Schema.parse(args[1]);
      const changed = request.mutations.map(item => ({ key: item.key, revision: 0, content: item.content }));
      rows.push(...changed);
      return { status: 200, data: { status: 'updated', cursor: 1, rows: changed } };
    }
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
    if (path !== `/v1/actions/${rootActionId}/execution-authorization`
      && path !== '/v1/actions/approval.request.decide/execution-authorization') {
      try { return await homeWrite(...args); }
      catch (error) { transportFailures.push(String(error)); throw error; }
    }
    try {
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(args[1]);
    const actionId = path.includes('/approval.request.decide/') ? 'approval.request.decide' : rootActionId;
    if (actionId === rootActionId) {
    if (!request.sessionActionOrigin || !request.sessionActionSource || !request.installationProof) throw new Error('Missing Agent Session root proof');
    expect(request.sessionActionOrigin.caller).toMatchObject({ kind: 'session', sessionId: h.sessionId });
    expect(verifyMachineInstallationProof({ publicKey: h.f.installation.publicKey, proof: request.installationProof,
      payload: { version: 1, accountId: 'requester', ...request.sessionActionSource,
        externalActionOrigin: { homeId, actionId, requestId: request.envelope.requestId!,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), origin: request.sessionActionOrigin } } })).toBe(true);
    roots++;
    }
    return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'project-agent-root', binding: {
      accountId: 'requester', custodianAccountId, serverIdentityId: homeId,
      authentication: { kind: actionId === rootActionId ? 'terminal' : 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
      machineId: 'machine', installationId: h.f.installation.installationId, admittedMachineRole: role,
      actionId, requestId: request.envelope.requestId, target: request.envelope.target,
      ...(actionId === 'approval.request.decide' ? { approvalDecisionAdmission: projectExternalActionApprovalDecisionAdmissionV1(request.envelope.v === 1 ? request.envelope.input : {}) } : {}),
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
      ...(request.sessionActionOrigin ? { sessionActionOrigin: request.sessionActionOrigin } : {}),
      ...(request.sessionActionSource ? { sessionActionSource: request.sessionActionSource } : {}),
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
          ...(packet.originalActionEnvelope ? { originalActionEnvelope: ExternalActionRequestEnvelopeSchema.parse(packet.originalActionEnvelope) } : {}),
          machineAdmission: { actorAccountId: 'requester', custodianAccountId, machineId: 'machine',
            installationId: h.f.installation.installationId, role, encryptionMode: 'plain' } });
        receiverResults.push(result);
        acknowledge({ ok: true, result });
      } catch (error) { acknowledge({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    });
  for (const socket of h.f.channel.server.sockets.sockets.values()) observeSocket(socket);
  h.f.channel.server.on('connection', observeSocket);
  const operation: Parameters<typeof h.dispatch>[0] = { kind: 'action.execute', surface: 'agent', actionId: rootActionId,
    requestId: h.operationBase().requestId,
    input: rootActionId === 'projects.inspect'
      ? { workspace: { serverId: homeId, workspaceId: 'project-inspection-workspace', machineId: 'machine', rootPath: h.cwd } }
      : { serverId: homeId, machineId: 'machine', source: { kind: 'folder', path: h.cwd }, materialization: { kind: 'attach' } },
    witness: { turnId: 'project-turn', inputId: 'project-input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
      agentStartCaller: { kind: 'session', sessionId: h.sessionId, starterDepth: 0, turnDepth: 0 }, callerPermissionMode: 'default' } };
  // Observe the real local RPC receiver, without replacing its implementation.
  // The caller cancels a self-forward so RED exercises the real path without
  // retaining a recursively dispatched request until its transport expires.
  const localRpc = vi.spyOn(h.machine, 'invokeLocalMachineAction');
  const cancellation = new AbortController();
  const services = boundary.control?.agentRuntimeDaemonServices;
  if (!services) throw new Error('Missing installed Agent service');
  let completed = false;
  const pending = (rootActionId === 'projects.inspect' ? services.dispatch(
    AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1, context: { token: 'a'.repeat(43), sessionId: h.sessionId }, operation }),
    { sessionId: h.sessionId, runner: h.runner, retainedAgent: h.retainedAgent, trackedSession: h.tracked,
      invocationContext: h.tracked.runnerAgentInvocationContext!, isCurrent: async () => true,
      signal: AbortSignal.any([h.signal, cancellation.signal]) },
  ).then(result => AgentRuntimeDaemonServiceResponseV1Schema.parse(result)) : h.dispatch(operation))
    .finally(() => { completed = true; });
  if (rootActionId === 'projects.inspect') {
    await Promise.race([pending, vi.waitFor(() => {
      if (completed) return;
      expect(localRpc).toHaveBeenCalled();
      cancellation.abort();
    }, { timeout: 30_000 })]);
  }
  const result = await pending;
  expect(result, JSON.stringify({ result, roots, mintFailures })).toMatchObject({ ok: true,
    result: { kind: 'action.execution', outcome: { ok: true } } });
  if (rootActionId === 'projects.inspect') {
    expect(result).toMatchObject({ result: { outcome: { result: { definition: { basis: { kind: 'absent' } } } } } });
    expect(localRpc).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
    expect(h.nativeEffects()).toBe(0);
    return;
  }
  if (!artifact || typeof artifact.id !== 'string') throw new Error('Agent request did not create a review card');
  const store = createCliApprovalsArtifactStore({ credentials, serverHttpBaseUrl: 'https://session-home.test' });
  const approval = ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId: artifact.id }));
  expect(approval).toMatchObject({ status: 'open' });
  expect(rows).toHaveLength(0);
  expect(h.nativeEffects()).toBe(0);
  const personCredentials = { ...credentials, token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature` };
  const decided = await createCliActionExecutorFromCredentials({ credentials: personCredentials, serverId,
    serverApiUrl: 'https://session-home.test', machineId: 'machine', externalActionClient: true,
    readCredentials: async () => personCredentials, onRequesterSessionCredentialDisclosure: async () => true,
  }).execute('approval.request.decide', { artifactId: artifact.id, decision: 'approve', serverIdentityId: homeId },
    { surface: 'cli', authority: 'present_user' });
  if (losesProfileIdentity) {
    expect(ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId: artifact.id }))).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'project_open_unavailable', effectAttempted: false },
    });
    expect(rows).toHaveLength(0);
    return;
  }
  expect(ApprovalRequestV2Schema.parse(await store.approvalsGet({ artifactId: artifact.id })),
    JSON.stringify({ decided, receiverResults, roots, mintFailures, transportFailures, phases })).toMatchObject(actor === 'owner'
      ? { execution: { ok: true, result: { kind: 'opened', directory: h.cwd } } }
      : { status: 'failed', execution: { ok: false, errorCode: 'workspace_private_checkout_required', effectAttempted: false,
          details: { remediation: { kind: 'confirmation_required', action: 'projects.open', label: expect.any(String) } },
          error: expect.stringContaining('private checkout') } });
  expect(decided, JSON.stringify({ decided, receiverResults, roots, mintFailures, transportFailures, phases })).toMatchObject({ ok: true });
  expect(roots).toBe(1);
  expect(rows.filter(row => row.key.kind === 'workspace-ref')).toHaveLength(actor === 'owner' ? 1 : 0);
  expect(h.nativeEffects()).toBe(0);
});
