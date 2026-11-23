// Reuse the UI's native/CJS platform boundary for this cross-package composition.
import '../../../../ui/sources/dev/vitestSetup';
import * as React from 'react';
import axios from 'axios';
import Fastify from 'fastify';
import nacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { AccountSettingsSchema, createActionExecutor, type ActionExecutorDeps, UiActionDispatchRequestV1Schema,
  projectSessionAccessCapabilitiesV1, WorkflowDefinitionV1Schema, WorkflowRunAcceptedContextV1Schema,
  WorkflowProgressEnvelopeV1Schema } from '@happier-dev/protocol';
import { WorkflowDraftGetResultV1Schema } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import { bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createActionAutomationHttpPortV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness';
import { renderScreen } from '../../../../ui/sources/dev/testkit/render/renderScreen';
import { createHydratedPlainMachineFixture } from '../../../../ui/sources/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '../../../../ui/sources/dev/testkit/harness/machinePresence';
import { createWorkflowRunSummaryFixture, createWorkflowInvocationIndexFixture } from '../../../../ui/sources/dev/testkit/fixtures/workflowRunFixtures';
import { standardCleanup } from '../../../../ui/sources/dev/testkit/cleanup/standardCleanup';
import type { Socket } from 'socket.io-client';
import type { WorkflowInvocationReviewBuffers } from '../../../../ui/sources/components/workflows/run/WorkflowInvocationReview';
import { installedSessionExternalActionStorage as issuerStorage } from '../../../../server/sources/app/api/testkit/installedSessionExternalActionStorage';

const processIdentity = vi.hoisted(() => vi.fn());
// OS process identity and network transports are the only substituted boundaries.
vi.mock('@/daemon/processIdentity', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/processIdentity')>(),
  readProcessIdentityByPid: processIdentity,
}));
// The real issuer/authentication/currentness owners consume only this database
// I/O boundary; no SQLite harness or real database mutation is involved.
vi.mock('../../../../server/sources/storage/db', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../server/sources/storage/db')>(),
  db: (await import('../../../../server/sources/app/api/testkit/installedSessionExternalActionStorage')).installedSessionExternalActionStorage.db,
}));
vi.mock('socket.io-client', async importOriginal =>
  (await import('../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('../../../../ui/sources/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('../../../../ui/sources/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('../../../../ui/sources/dev/testkit/mocks/router')).createExpoRouterMock().module);
const sockets: Socket[] = [];
installDisconnectedServerSocketBoundary(socket => { sockets.push(socket); });
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { storage } = await import('../../../../ui/sources/sync/domains/state/storage');
await (await import('../../../../ui/sources/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
const { ClientActionReverseRuntime } = await import('../../../../ui/sources/components/appShell/runtime/ClientActionReverseRuntime');
const { useWorkflowLibraryView } = await import('../../../../ui/sources/components/workflows/library/useWorkflowLibraryView');
const { WorkflowEditorHostScreen } = await import('../../../../ui/sources/components/workflows/screens/WorkflowEditorHostScreen');
const { WorkflowInvocationReview } = await import('../../../../ui/sources/components/workflows/run/WorkflowInvocationReview');
const { AuthProvider } = await import('../../../../ui/sources/auth/context/AuthContext');
const { ModalProvider } = await import('../../../../ui/sources/modal');
const { AppPaneProvider } = await import('../../../../ui/sources/components/appShell/panes/AppPaneProvider');
const { createClientActionReverseDispatcher } = await import('@/session/actions/clientActionReverseDispatch');
const { createDaemonSessionAccountActionExecutor } = await import('@/daemon/agentRuntime/createDaemonSessionAccountActionExecutor');
const { prepareExternalActionRequesterAccountAuthorization } = await import('@/api/externalActionExecutionAuthorization');
const { createHappierMcpServer } = await import('@/mcp/createHappierMcpServer');
const { RpcHandlerManager } = await import('@/api/rpc/RpcHandlerManager');
const { configuration } = await import('@/configuration');
const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
const { createSessionRecordFixture } = await import('@/testkit/backends/sessionFixtures');
const { hashProcessCommand } = await import('@/daemon/sessionRegistry');
const { hashPrivateBearer } = await import('@/daemon/privateBearerFile');
const { createAgentSessionRunnerFactoryBinding } = await import('@/plugins/runtime/runner/agentSessionRunnerFactoryBinding');
const { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  readCurrentRunnerAgentRuntimeDaemonServiceAuthority, removeAgentRuntimeDaemonServiceAuthorityIfOwned } = await import('@/daemon/agentRuntime/sessionBridgeAuthorization');
const { AgentRuntimeDaemonServiceRequestV1Schema, AGENT_RUNTIME_DAEMON_SERVICES_PATH } = await import('@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol');
const { createDaemonControlRequestLifetime } = await import('@/daemon/controlRequestLifetime');
const { DAEMON_CONTROL_TOKEN_HEADER } = await import('@/daemon/controlHttp');
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each(['legacy', 'legacy-terminal', 'current', 'malformed'] as const)('routes real Session MCP Library Actions through the real Home issuer and mounted client (%s)', async kind => {
  // The installed Session storage fixture supplies PostgreSQL transaction I/O.
  vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
  await homes.reset();
  const serverUrl = 'https://workflow-client.test';
  const accountId = 'relay-account';
  const serverId = await homes.addHome({ name: 'Workflow', serverUrl, accountId });
  const connection = await restoreServerAccountForTest({ serverUrl, accountId, request: homes.request });
  homes.answer(serverId, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, { body: { v: 1, rows: [] } });
  installHomeGovernanceBoundaries(homes);
  const machine = createHydratedPlainMachineFixture({ id: 'driver-machine', accountId, machine: { activeAt: Date.now() } });
  storage.setState(state => ({ ...state, profile: { ...state.profile!, id: accountId } }));
  await publishMachineInventoryForTest({ serverId, accountId }, [machine]);
  const socket = sockets.slice().reverse().find(candidate => candidate.listeners(SOCKET_RPC_EVENTS.REQUEST).length > 0);
  if (!socket) throw new Error('Missing Account reverse receiver');
  const registered = new Set<string>();
  vi.spyOn(socket, 'emit').mockImplementation((event, ...args) => {
    const payload: unknown = args[0];
    if (payload && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string') {
      if (event === SOCKET_RPC_EVENTS.REGISTER) registered.add(payload.method);
      if (event === SOCKET_RPC_EVENTS.UNREGISTER) registered.delete(payload.method);
    }
    return socket;
  });
  const reverse = createClientActionReverseDispatcher(() => ({
    hasConnectedClientRpcHandler: method => registered.has(`${machine.id}:${method}`),
    callConnectedClientRpc: async (method, payload, options) => {
      const wire = UiActionDispatchRequestV1Schema.parse(JSON.parse(JSON.stringify(payload)));
      expect(wire.context.actionCaller).toMatchObject({ kind: 'session', sessionId: 'driver-session' });
      expect(wire.context.authority).toBe('account_automation');
      options.onIssued();
      const result = await new Promise<unknown>(resolve => socket.listeners(SOCKET_RPC_EVENTS.REQUEST).forEach(receive =>
        receive({ method: `${machine.id}:${method}`, params: wire }, resolve)));
      return { ok: true, result };
    },
  }));
  // A released paired credential has no structured provenance marker. It may
  // propose only through the authenticated Home and installed Session proof.
  const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
  const target = { kind: 'machine' as const, machineId: machine.id };
  Object.assign(issuerStorage.state, { accountId, machineId: machine.id, sessionId: 'driver-session',
    installationId: 'installation', homeId: 'srv_workflow', bound: true, publisherBound: true,
    publicKey: keys.publicKey, revokedAt: null });
  Object.assign(issuerStorage.account, { id: accountId, tokenEpoch: 0 });
  vi.stubEnv('HANDY_MASTER_SECRET', 'workflow-client-real-issuer-secret');
  vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
  vi.stubEnv('AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS', '0');
  const { auth } = await import('../../../../server/sources/app/auth/auth');
  await auth.init();
  const generator = await privacyKit.createPersistentTokenGenerator({ service: 'handy', seed: 'workflow-client-real-issuer-secret' });
  const token = kind === 'current' ? await auth.createToken(accountId, undefined, { kind: 'account', authority: 'present_user' })
    : await generator.new({ user: accountId, ...(kind === 'legacy-terminal' ? { extras: { session: 'paired-request' } }
      : kind === 'malformed' ? { extras: { provenance: { v: 1, kind: 'account', authority: 'account_automation' } } } : {}) });
  const { createAuthenticatedTestApp } = await import('../../../../server/sources/app/api/testkit/sqliteFastify');
  const { registerExternalActionRoutes } = await import('../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes');
  const issuer = createAuthenticatedTestApp({ authentication: 'real' });
  issuer.decorate('resolveCurrentSessionMachine', async (input: { accountId: string; sessionId: string }) =>
    issuerStorage.state.publisherBound && input.accountId === accountId && input.sessionId === 'driver-session' ? machine.id : null);
  registerExternalActionRoutes(issuer, { dispatch: async () => { throw new Error('Minting must not execute the client Action'); } });
  let delayNextLibrarySet = false;
  let delayedSetCount = 0;
  // A slow Home is a network boundary. Keep the real authentication, mint and
  // verifier behind TCP, including Axios's actual timeout/cancellation behavior.
  issuer.addHook('onRequest', async (request: { url: string }) => {
    if (delayNextLibrarySet && request.url === bindExternalActionExecutionAuthorizationHttpPathV1('workflow.library.view.set')) {
      delayNextLibrarySet = false;
      delayedSetCount += 1;
      await new Promise(resolve => setTimeout(resolve, 16_000));
    }
  });
  const issuerUrl = await issuer.listen({ port: 0, host: '127.0.0.1' });
  const network = axios.create({ proxy: false });
  const minted: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    expect(String(url)).toBe(`${serverUrl}/v2/sessions/driver-session`);
    return { status: 200, data: { session: createSessionRecordFixture({ id: 'driver-session', share: null, encryptionMode: 'plain',
      machineId: machine.id, workDepth: 1, metadata: JSON.stringify({ machineId: machine.id, path: '/tmp', permissionMode: 'default' }),
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } }) } };
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
    const pathname = new URL(String(url)).pathname;
    const response = await network.post(`${issuerUrl}${pathname}`, body, config);
    if (!pathname.endsWith('/verify') && response.status === 200) minted.push(decodeURIComponent(pathname.split('/').at(-2)!));
    return response;
  });
  let preparedRequest: Parameters<typeof prepareExternalActionRequesterAccountAuthorization>[0] | undefined;
  const actionAutomations = createActionAutomationHttpPortV1({ accountId, request: async (path, init) => {
    const response = await homes.request(`${serverUrl}${path}`, {
      method: init.method, signal: init.signal, headers: { Authorization: `Bearer ${connection.credentials.token}` },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!response.ok) throw new Error(`Automation request failed: ${response.status}`);
    return response.json();
  } });
  const execute = createDaemonSessionAccountActionExecutor({ serverId, serverHttpBaseUrl: serverUrl, token, machineId: machine.id,
    prepareExternalActionAuthorization: async admission => {
      preparedRequest = { actionId: admission.operation.actionId,
        input: admission.operation.input, requestId: admission.operation.requestId, target, machineId: machine.id,
        sourceMachineId: machine.id, accountId, accountEncryptionMode: 'plain', tokenEpochHint: 0, token, serverId,
        serverIdentityId: 'srv_workflow', serverHttpBaseUrl: serverUrl, installationId: 'installation', privateKey: keys.secretKey,
        sessionActionOrigin: admission.sessionActionOrigin, isCurrent: admission.isCallerCurrent,
        ...(admission.authority.signal ? { signal: admission.authority.signal } : {}) };
      const authorization = await prepareExternalActionRequesterAccountAuthorization(preparedRequest);
      return authorization ? { authorization, target } : null;
    },
    createExecutor: () => createActionExecutor({ clientActionExecute: reverse, actionAutomations } as unknown as ActionExecutorDeps),
  });
  const command = 'node /runtime/.runner-snapshots/workflow/dist/index.mjs';
  const runner = { pid: process.pid, processStartTimeMs: 23346, processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:workflow' };
  processIdentity.mockResolvedValue({ pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command });
  const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
  const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing, path,
    sessionId: 'driver-session', runner, retainedAgent: createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3',
      agentId: 'acme-agent', localAgentId: 'acme-agent', sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
      locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 }, normalizedModulePath: '/immutable/runtime.mjs', loadMode: 'immutable-js' }) };
  const serviceRequests: string[] = [];
  const outcomes: unknown[] = [];
  // Use real private HTTP so the control client's own Undici dispatcher and
  // request cancellation reach the same daemon executor as a loaded runner.
  const service = Fastify();
  service.post(AGENT_RUNTIME_DAEMON_SERVICES_PATH, async (incoming, reply) => {
    expect(incoming.headers[DAEMON_CONTROL_TOKEN_HEADER]).toBe('A'.repeat(43));
    const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(incoming.body);
    if (request.operation.kind !== 'action.execute') throw new Error('Unexpected host request');
    serviceRequests.push(request.operation.actionId);
    const lifetime = createDaemonControlRequestLifetime(incoming, reply);
    try {
      const outcome = await execute(request.operation, { sessionId: 'driver-session', isCurrent: async () => true,
        signal: lifetime.signal });
      outcomes.push(outcome);
      return { ok: true, result: { kind: 'action.execution', requestId: request.operation.requestId, outcome } };
    } finally {
      lifetime.dispose();
    }
  });
  await service.listen({ port: 0, host: '127.0.0.1' });
  const serviceAddress = service.server.address();
  if (!serviceAddress || typeof serviceAddress === 'string') throw new Error('Missing private service address');
  await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: serviceAddress.port, capability: 'A'.repeat(43) });
  vi.stubEnv('HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE', path);
  expect(await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({ ...configuration, path, expectedSessionId: 'driver-session' })).not.toBeNull();
  const settings = AccountSettingsSchema.parse({});
  let turnId = 'turn';
  const createMcp = () => createHappierMcpServer({ sessionId: 'driver-session', getServerBinding: () => ({ serverId, serverUrl }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: 'driver-session', encryptionMode: 'plain' }), updateMetadata() {},
    getMetadataSnapshot: () => createTestMetadata({ machineId: machine.id }), getWorkDepth: () => 1, getHostTurnWorkDepth: () => 2,
    getPermissionMode: () => 'default',
    getActiveTurnPermissionWitness: () => ({ turnId, causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } }),
    getActiveTurnAdmissionWitness: () => ({ turnId, inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1],
      callerPermissionMode: 'default', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
      agentStartCaller: { kind: 'session', sessionId: 'driver-session', starterDepth: 1, turnDepth: 2 } }),
    getStoredContentEncryptionContext: () => ({ mode: 'plain' }) }, { credentials: { token, encryption: null }, accountSettings: settings });
  let mcp = createMcp();
  let client = new Client({ name: 'workflow-driver', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.mcp.connect(serverTransport);
  await client.connect(clientTransport);
  function Library() { useWorkflowLibraryView([], null, true); return null; }
  const library = await renderScreen(React.createElement(Library));
  const call = async (actionId: string, input: unknown): Promise<unknown> => {
    const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId, input } }, CallToolResultSchema));
    const text = result.content.find(block => block.type === 'text');
    if (!text || text.type !== 'text') throw new Error('Missing MCP result');
    return JSON.parse(text.text);
  };
  let runtime: Awaited<ReturnType<typeof renderScreen>> | undefined;
  let editor: Awaited<ReturnType<typeof renderScreen>> | undefined;
  let review: Awaited<ReturnType<typeof renderScreen>> | undefined;
  try {
    runtime = await renderScreen(React.createElement(ClientActionReverseRuntime));
    const current = await call('workflow.library.view.get', {});
    expect(serviceRequests, JSON.stringify({ current, outcomes })).toEqual(['workflow.library.view.get']);
    if (kind === 'malformed') {
      expect(outcomes, JSON.stringify(outcomes)).toMatchObject([{ ok: false, errorCode: 'action_forbidden',
        details: { reason: 'external_authorization_refused' } }]);
      expect(minted).toEqual([]);
      return;
    }
    expect(current, JSON.stringify(outcomes)).toMatchObject({ view: 'all', searchQuery: '' });
    await act(async () => { expect(await call('workflow.library.view.set', { searchQuery: 'QA-FIN36b' })).toMatchObject({ ok: true }); });
    const firstSetRequestId = preparedRequest?.requestId;
    expect(await call('workflow.library.view.get', {})).toMatchObject({ searchQuery: 'QA-FIN36b' });
    // Native Agent turns create fresh MCP connections whose numeric JSON-RPC
    // ids restart. Repeat the identical set under the next real turn origin.
    await client.close();
    await mcp.mcp.close();
    turnId = 'next-turn';
    mcp = createMcp();
    client = new Client({ name: 'workflow-driver', version: '1' });
    const [nextClientTransport, nextServerTransport] = InMemoryTransport.createLinkedPair();
    await mcp.mcp.connect(nextServerTransport);
    await client.connect(nextClientTransport);
    expect(await call('workflow.library.view.get', {})).toMatchObject({ searchQuery: 'QA-FIN36b' });
    delayNextLibrarySet = kind === 'current';
    await act(async () => { expect(await call('workflow.library.view.set', { searchQuery: 'QA-FIN36b' })).toMatchObject({ ok: true }); });
    expect(firstSetRequestId).toBeTypeOf('string');
    expect(preparedRequest?.requestId).toBeTypeOf('string');
    expect(preparedRequest?.requestId).not.toBe(firstSetRequestId);
    expect(preparedRequest?.sessionActionOrigin?.sourceTurnId).toBe('next-turn');
    expect(delayedSetCount).toBe(kind === 'current' ? 1 : 0);
    expect(await call('workflow.library.view.get', {})).toMatchObject({ searchQuery: 'QA-FIN36b' });
    expect(minted).toContain('workflow.library.view.set');
    if (kind === 'current') {
      expect(await call('session.spawn_new', { machine: machine.id, directory: '/home/happier',
        model: 'claude-haiku-4-5', instructions: 'Reply with the reading check result.', manager: true }))
        .toMatchObject({ errorCode: 'invalid_parameters', error: 'invalid_parameters' });
      expect(minted).not.toContain('session.spawn_new');
    }
    const scope = { serverId, accountId };
    editor = await renderScreen(<AuthProvider initialCredentials={connection.credentials}><ModalProvider><AppPaneProvider>
      <WorkflowEditorHostScreen source={{ kind: 'new' }} />
    </AppPaneProvider></ModalProvider></AuthProvider>);
    const opened = WorkflowDraftGetResultV1Schema.parse(await call('workflow.authoring.draft.get', { scope }));
    if (opened.status !== 'available') throw new Error('Mounted editor did not answer');
    const draft = opened.drafts[0]!;
    await act(async () => {
      expect(await call('workflow.authoring.draft.edit', { scope, draftId: draft.draftId, expectedDraftRevision: draft.draftRevision,
        settings: { projectTarget: { machineId: machine.id, directory: '/qa-fin36b-agent-where' } } })).toMatchObject({ status: 'applied' });
    });
    const edited = WorkflowDraftGetResultV1Schema.parse(await call('workflow.authoring.draft.get', { scope, draftId: draft.draftId }));
    expect(edited).toMatchObject({ status: 'available', drafts: [{ settings: { projectTarget: { machineId: machine.id, directory: '/qa-fin36b-agent-where' } } }] });
    if (edited.status !== 'available') throw new Error('Edited draft did not answer');
    expect(edited.drafts[0]!.draftRevision).toBeGreaterThan(draft.draftRevision);
    await act(async () => { expect(await call('workflow.authoring.draft.undo', { scope, draftId: draft.draftId })).toMatchObject({ status: 'applied' }); });
    const undone = WorkflowDraftGetResultV1Schema.parse(await call('workflow.authoring.draft.get', { scope, draftId: draft.draftId }));
    expect(undone).toMatchObject({ status: 'available', drafts: [{ settings: { projectTarget: draft.settings.projectTarget } }] });

    const runId = '11111111-1111-4111-8111-111111111111';
    const heldId = '22222222-2222-4222-8222-222222222222';
    const definition = WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'wait', id: 'review', document: { text: 'Answer', references: [], attachments: [] }, result: { kind: 'text' } },
    ] });
    const run = createWorkflowRunSummaryFixture({ id: runId, ownerAccountId: accountId, origin: { kind: 'direct' }, machineId: machine.id, state: 'waiting_for_review' });
    const invocation = createWorkflowInvocationIndexFixture({ id: heldId, runId, lifecycle: 'waiting_for_review', contentRevision: '1' });
    const progress = WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1', blockKind: 'wait',
      invocationPath: { blockId: 'review', scope: [] }, attempt: '0', logicalInvocationRecordId: heldId, resultContract: { kind: 'text' } });
    const acceptedContext = WorkflowRunAcceptedContextV1Schema.parse({ startedBy: 'user', source: { kind: 'inline' }, inputs: {},
      machineId: machine.id, executionTarget: { kind: 'session' }, materializedLeaves: [{ sourceKey: '$root', blockId: 'review', kind: 'wait',
        selection: {}, authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: 'session' } }], frozenChildren: {},
      workspaceTarget: { project: { machineId: machine.id, directory: '/tmp', checkoutRootPath: '/tmp' } }, origin: { kind: 'direct' } });
    const buffers: WorkflowInvocationReviewBuffers = { drafts: new Map(), readings: new Map() };
    review = await renderScreen(<ModalProvider><WorkflowInvocationReview run={run} invocation={invocation} progress={progress}
      acceptedContext={acceptedContext} definition={definition} callerAccess={{ canEdit: true }} contentRevision="1" buffers={buffers}
      active confirmed={false} compact={false} viewerAccountId={accountId} current={() => true}
      onSettled={() => { throw new Error('Draft preparation must not accept the hold'); }} onOpenDraft={() => {}} onOpenRun={() => {}} /></ModalProvider>);
    await act(async () => { expect(await call('workflow.run.review.draft.set', { scope, draftId: heldId, runId,
      expectedContentRevision: '1', value: 'QA-FIN36b MCP DRAFT' })).toMatchObject({ status: 'applied' }); });
    expect(buffers.drafts.get(heldId)?.text).toBe('QA-FIN36b MCP DRAFT');
    expect(invocation.lifecycle).toBe('waiting_for_review');
    if (kind === 'legacy' || kind === 'legacy-terminal') {
      if (!preparedRequest) throw new Error('Session preparation was not reached');
      expect(await prepareExternalActionRequesterAccountAuthorization({ ...preparedRequest,
        sessionActionOrigin: undefined, sourceMachineId: undefined })).toBeNull();
    }
    await runtime.unmount(); runtime = undefined;
    expect(await call('workflow.library.view.get', {})).toMatchObject({ errorCode: 'unavailable' });
  } finally {
    await review?.unmount(); await editor?.unmount();
    await runtime?.unmount(); await library.unmount(); await client.close(); await mcp.mcp.close(); await connection.dispose();
    await service.close(); await issuer.close();
    await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority, capabilityDigest: hashPrivateBearer('A'.repeat(43)) });
  }
});
