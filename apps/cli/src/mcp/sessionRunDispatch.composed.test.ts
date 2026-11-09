import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/mini';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { PROFILE_ROWS_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1, ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createRunnerExecutionRunSnapshotResolver } from '@/agent/runtime/session/process/runnerExecutionRunSnapshot';
import * as controlServer from '@/daemon/controlServer';
import * as daemonControlHttp from '@/daemon/controlHttp';
import { deriveConnectedServiceRunMaterializeToken } from '@/daemon/connectedServices/runs/capabilityToken';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { executeSpawnSessionRequest } from '@/daemon/startup/executeSpawnSessionRequest';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createMutableApiSessionClientFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { registerExecutionRunHandlers } from '@/rpc/handlers/executionRuns';
import type { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { createSessionRoleContext } from '@/session/roles/sessionRoleContext';
import { createRoleSourceReader } from '@/session/roles/roleSources';
import { createScopedRuntimeActionSettingsProvider } from '@/settings/scopedRuntimeActionSettingsProvider';
import { createHappierMcpServer } from './createHappierMcpServer';
import { createSessionDaemonAuthorityFixture } from './runtime/sessionDaemonAuthority.testkit';
import type { HappyMcpSessionClient } from './startHappyServer';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each(['account_depth', 'account_agent', 'account_ceiling', 'policy_read_unavailable', 'workflow_preflight', 'ordinary_run_authority', 'home_authority'] as const)(
  'dispatches through the production daemon/native composition for an authored Agent (%s)', async scenario => {
  let installed: Parameters<typeof controlServer.startDaemonControlServer>[0] | null = null;
  // The listener and Home HTTP are system boundaries; startup, request admission,
  // dependency construction, source snapshots and native Agent activation stay real.
  vi.spyOn(controlServer, 'startDaemonControlServer').mockImplementation(async input => {
    installed = input;
    return { port: 43129, stop: async () => {} };
  });
  const realFetch = globalThis.fetch;
  const identity = { pluginId: 'acme.project-launch', localId: 'agent' };
  const h = await createInstalledProjectAgentDaemonFixture(() => installed, undefined, true, {
    manifest: createPluginManifestV2Fixture({ id: identity.pluginId, contributes: { agents: [{ id: identity.localId,
      title: 'Run dispatch Agent', runtime: { kind: 'custom' }, primary: 'sessions', capabilities: { sessions: {
        open: ['create'], delivery: ['newTurn'], cancel: true, workspaceWrites: 'deny',
      } },
    }] } }), files: {
      'runtime.mjs': `export function createRuntime() { return { sessions: { async open(opened) {
        if (opened.kind !== 'create') throw new Error('Unsupported fixture open');
        let listener; let sequence = 0;
        const emit = event => listener?.({ sessionId: opened.sessionId, sequence: ++sequence,
          emittedAtMs: Date.now(), ...event });
        return { watch(next) { listener = next;
          emit({ kind: 'provider-session-id', providerSessionId: 'authored-run-session' });
          return { dispose() { listener = undefined; } }; },
          async send(request) {
            const turnId = request.delivery.turnId;
            emit({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
            emit({ kind: 'turn-start', turnId, startedBy: 'host' });
            emit({ kind: 'message-delta', turnId, channel: 'assistant', text: 'ORC_TASK_RESULT' });
            emit({ kind: 'turn-complete', turnId });
            return { status: 'admitted' };
          }, async cancel(request) { emit({ kind: 'turn-cancelled', turnId: request.turnId, cause: request.reason });
            return { status: 'requested', turnId: request.turnId }; }, async dispose() {} };
      } } }; }`,
      'daemon.mjs': `import { createRuntime } from './runtime.mjs'; export function activate(api) {
        api.agents.register('agent', createRuntime, { sessionRunnerFactory: {
          module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 } }); }`,
    },
  }, undefined, {
    credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'custodian' })).toString('base64url')}.signature`, encryption: null },
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_run-home', machineId: 'machine' }),
  });
  if (!installed) throw new Error('Missing production daemon routes');
  const control = controlServer.createDaemonControlApp(installed);
  const controlToken = z.object({ controlToken: z.string() }).parse(installed).controlToken;
  vi.spyOn(daemonControlHttp, 'daemonPost').mockImplementation(async (path, body, options) => {
    const reply = await control.inject({ method: 'POST', url: path, payload: body ?? {},
      headers: { 'x-happier-daemon-token': options?.authScope === 'connected-service-run-materialize'
        ? deriveConnectedServiceRunMaterializeToken(controlToken) : controlToken } });
    expect(reply.statusCode, path).toBe(200);
    return reply.json();
  });
  const homeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', ((input, init) => new URL(String(input)).hostname === '127.0.0.1'
    ? realFetch(input, init) : homeFetch(input, init)) satisfies typeof fetch);
  const homeRead = vi.mocked(axios.get).getMockImplementation()!;
  const homeWrite = vi.mocked(axios.post).getMockImplementation()!;
  const daemonOutcomes: unknown[] = [];
  let authorizedMachineId = 'machine';
  vi.mocked(axios.post).mockImplementation(async (...args) => {
    if (new URL(String(args[0])).pathname === bindExternalActionExecutionAuthorizationVerifyHttpPathV1('agents.backends.list')) {
      return { status: h.f.isHomeCurrent() ? 200 : 403, data: h.f.isHomeCurrent() ? { ok: true } : { error: 'access_denied' } };
    }
    if (new URL(String(args[0])).pathname === bindExternalActionExecutionAuthorizationHttpPathV1('agents.backends.list')) {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(args[1]);
      expect(request.sessionActionOrigin?.caller.sessionId).toBe(h.sessionId);
      expect(request.sessionActionSource).toEqual({ machineId: 'machine', installationId: h.f.installation.installationId });
      expect(request.installationProof).toBeDefined();
      return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-home-authorization', binding: {
        accountId: 'requester', authentication: { kind: readAuthTokenProvenance(
          decodeJwtPayload(String(args[2]?.headers?.Authorization).slice('Bearer '.length)), { allowLegacyHome: true })?.provenance.kind,
          tokenEpoch: 0 }, serverIdentityId: 'srv_run-home',
        machineId: authorizedMachineId, custodianAccountId: 'custodian', installationId: h.f.installation.installationId,
        actionId: 'agents.backends.list', requestId: request.envelope.requestId, target: { kind: 'machine', machineId: authorizedMachineId },
        accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource,
      } }) };
    }
    return await homeWrite(...args);
  });
  let foreignAccount = false;
  let accountPolicy: Record<string, unknown> | null = null;
  let policyVersion = 0;
  let settingsChangeDuringProfileRead = false;
  let profileReads = 0;
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (path === '/v2/account/settings' && accountPolicy) return { status: 200, data: {
      content: { t: 'plain', v: accountPolicy }, version: policyVersion,
    } };
    if (path === PROFILE_ROWS_ROUTE_V1 && settingsChangeDuringProfileRead) {
      profileReads++;
      // A real Settings publication during an unrelated catalog read must not
      // turn a literal Workflow leaf's policy preparation into a stale commit.
      policyVersion++;
      await h.tracked.requesterSessionRuntimeContext?.bootstrap.refreshAccountSettings(policyVersion);
      throw Object.assign(new Error('Fixture Profile service unavailable'), { code: 'unreachable' });
    }
    if (foreignAccount && path === `/v2/sessions/${h.sessionId}`) return { status: 200, data: {
      session: createSessionRecordFixture({ id: h.sessionId, encryptionMode: 'plain',
        share: { accessLevel: 'admin', canApprovePermissions: true } }),
    } };
    if (path === ACP_CATALOG_ROWS_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
    if (path === '/v1/artifacts') return { status: 200, data: [] };
    return await homeRead(...args);
  });
  let turnDepth = 0;
  let permission: 'yolo' | 'read-only' = 'yolo';
  const metadata = createTestMetadata({ machineId: 'machine', path: h.cwd });
  const parent = createMutableApiSessionClientFixture({ sessionId: h.sessionId, metadata });
  const readRoleSources = createRoleSourceReader({});
  let selectionAvailable = true;
  const nativeTurnId = 'source-turn';
  const readAppliedChildSelection = () => selectionAvailable ? { status: 'applied' as const,
    backendTarget: { kind: 'backend' as const, backendId: h.retainedAgent.agentId },
    modelId: 'fixture-model', connectedServices: null } : { status: 'unavailable' as const };
  const roles = createSessionRoleContext({ readMetadata: () => metadata, readRoleSources,
    readOrganization: async () => ({ manager: null, origin: null }),
    readAccountRoleOverrides: () => ({ status: 'ready', overrides: {} }),
    readAppliedChildSelection,
  });
  const causalAuthority = () => ({ kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: permission });
  const host: HappyMcpSessionClient = {
    sessionId: h.sessionId, updateMetadata() {}, getMetadataSnapshot: () => metadata,
    getServerBinding: () => ({ serverId: 'session-home', serverUrl: 'https://session-home.test' }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: h.sessionId, encryptionMode: 'plain' }),
    getBackendTarget: () => ({ kind: 'backend', backendId: h.retainedAgent.agentId }),
    getCurrentSessionLocation: () => ({ machineId: 'machine', path: h.cwd }),
    getSessionRoleContext: () => roles, readRoleSources, getPermissionMode: () => permission,
    getWorkDepth: () => 0, getHostTurnWorkDepth: id => id === nativeTurnId ? turnDepth : undefined,
    getActiveTurnPermissionWitness: () => ({ turnId: nativeTurnId, causalPermissionAuthority: causalAuthority() }),
    getActiveTurnAdmissionWitness: () => ({ turnId: nativeTurnId, inputId: 'source-input', userMessageSeq: 1, userMessageSeqs: [1],
      agentStartCaller: { kind: 'session', sessionId: h.sessionId, starterDepth: 0, turnDepth },
      callerPermissionMode: permission, causalPermissionAuthority: causalAuthority() }),
  };
  const localRpc = vi.spyOn(host.rpcHandlerManager, 'invokeLocal');
  let manager: ExecutionRunHostBridge | undefined;
  const registration = registerExecutionRunHandlers(host.rpcHandlerManager, {
    sessionId: h.sessionId, cwd: h.cwd, parentProvider: 'codex', sendAcp: async () => {},
    resolveExecutionRunProfileCatalog: createRunnerExecutionRunSnapshotResolver({ sessionId: h.sessionId, machineId: 'machine' }),
    readPromptCredentials: async () => h.f.bootstrap.credentials,
    resolveAccountSettings: () => ({}), resolveRunReportPolicy: async () => ({ preset: 'important' }),
    sessionInteractionHost: { session: parent, machineId: 'machine',
      permissionHandler: new ProviderEnforcedPermissionHandler(parent, { logPrefix: '[Run dispatch fixture]' }),
      readAppliedChildSelection,
      readCurrentTurnId: () => nativeTurnId,
    }, onManagerCreated: created => { manager = created; },
  });
  let failNextPolicyRead = false;
  const authority = await createSessionDaemonAuthorityFixture({ sessionId: h.sessionId, retainedAgent: h.retainedAgent,
    execute: async operation => {
      const reply = await h.dispatch(operation);
      if (!reply.ok) throw new Error(`Daemon Action refused: ${reply.error.code}`);
      if (reply.result.kind !== 'action.execution') throw new Error('Missing daemon Action result');
      const outcome = reply.result.outcome;
      const details = !outcome.ok ? z.object({ reason: z.optional(z.string()) }).safeParse(outcome.details) : null;
      daemonOutcomes.push({ actionId: operation.actionId, ok: outcome.ok,
        ...(!outcome.ok ? { code: outcome.errorCode,
          ...(details?.success ? { details: details.data } : {}) } : {}) });
      return reply.result.outcome;
    },
    dispatchService: async request => {
      if (failNextPolicyRead && request.operation.kind === 'agent_start.policy.read') {
        failNextPolicyRead = false;
        return { ok: false, error: { code: 'requester_agent_start_policy_unavailable', message: 'Fixture policy read unavailable' } };
      }
      return await h.dispatch(request.operation, request.context.executionRunSnapshotId);
    },
  });
  const runtime = createHappierMcpServer(host, { authorityScope: 'session', sessionCredentials: h.f.bootstrap.credentials,
    actionsSettingsProvider: createScopedRuntimeActionSettingsProvider(normalizeActionsSettingsV1({})),
  });
  const client = new Client({ name: 'native-run-dispatch-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await runtime.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const request = { intent: 'task', backendTarget: { kind: 'agent', identity }, instructions: 'Reply only.', modelId: 'fixture-model',
      permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', waitForCompletion: true };
    const start = async (input: Record<string, unknown>) => {
      const reply = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
        arguments: { actionId: 'execution.run.start', input } }));
      const content = reply.content.find(row => row.type === 'text');
      if (content?.type !== 'text') throw new Error('Missing Run response');
      const payload: unknown = JSON.parse(content.text);
      return reply.isError ? { ok: false, ...z.object({ errorCode: z.string(), error: z.optional(z.string()), details: z.optional(z.unknown()) }).parse(payload) }
        : { ok: true, result: payload };
    };
    const workflowRequester = h.requester;
    const setAccountPolicy = async (policy: Record<string, unknown>) => {
      accountPolicy = policy;
      policyVersion++;
      expect(await workflowRequester.bootstrap.refreshAccountSettings(policyVersion)).toBe(true);
      expect(workflowRequester.readAccountSettingsSnapshot().settings).toMatchObject(policy);
    };
    await setAccountPolicy({});
    if (scenario === 'workflow_preflight') {
      settingsChangeDuringProfileRead = true;
      try {
        // Workflow's installed startup callback uses this same daemon entry point.
        // The canonical environment guard immediately after policy preparation
        // keeps this regression independent of later launch/default resolution.
        const spawnLeaf = (profileId?: string) => executeSpawnSessionRequest({ options: { directory: h.cwd,
          environmentVariables: { 'BAD=KEY': 'fixture' }, backendTarget: { kind: 'backend', backendId: 'codex' },
          ...(profileId ? { profileId } : {}),
          requesterSessionBootstrap: workflowRequester.bootstrap },
          requesterSessionRuntimeContext: workflowRequester,
          credentials: workflowRequester.bootstrap.credentials, api: workflowRequester.api,
          connectedServicesMaterializationBaseDir: h.cwd,
          connectedServiceRefreshCoordinator: null, connectedServiceQuotasCoordinator: null,
          connectedServiceRuntimeRegistry: workflowRequester.connectedServiceRuntimeRegistry,
          pidToTrackedSession: h.pidToTrackedSession, pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(),
          pidToSpawnWebhookTimeout: new Map(), spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
          resolveCanonicalTrackedSessionId: () => { throw new Error('Unexpected leaf launch'); },
          onChildExited: () => { throw new Error('Unexpected leaf launch'); },
        });
        const leaf = await spawnLeaf();
        expect.soft(leaf, JSON.stringify(leaf)).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_ENVIRONMENT_VARIABLES });
        expect.soft(profileReads).toBe(0);
        // An explicitly selected Launch Profile must still use its catalog and
        // refuse when that preparation cannot publish a current observation.
        expect.soft(await spawnLeaf('unavailable-profile')).toMatchObject({ type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE });
        expect.soft(profileReads).toBe(1);
      } finally { settingsChangeDuringProfileRead = false; }
      return;
    }
    const refusePolicy = async (policy: Record<string, unknown>, input: Record<string, unknown>, errorCode: string) => {
      await setAccountPolicy(policy);
      const refused = await start(input);
      expect.soft(refused, JSON.stringify({ refused, daemonOutcomes })).toMatchObject({ ok: false, errorCode,
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } });
      expect.soft(manager?.listPublicForRequest({}, h.sessionId) ?? []).toHaveLength(0);
    };
    if (scenario === 'account_depth') {
      await refusePolicy({ workDepthLimit: 0 }, request, 'work_depth_exceeded');
      return;
    }
    if (scenario === 'account_agent') {
      await refusePolicy({ sessionAgentStartAllowListsV1: { v: 1, allowedRoleIds: null,
        allowedAgentTargetKeys: [] } }, request, 'policy_denied_field');
      return;
    }
    if (scenario === 'account_ceiling') {
      await refusePolicy({ sessionAgentSpawnPolicyV1: { v: 1, permissionCeiling: 'read-only' } },
        { ...request, intent: 'delegate', permissionMode: 'workspace_write' }, 'policy_denied_field');
      return;
    }
    // A failed MCP policy read must not become default spawn policy merely
    // because the subsequent shared-context read succeeds.
    if (scenario === 'policy_read_unavailable') {
      await setAccountPolicy({ sessionAgentSpawnPolicyV1: { v: 1, permissionCeiling: 'read-only' } });
      failNextPolicyRead = true;
      expect.soft(await start({ ...request, intent: 'delegate', permissionMode: 'workspace_write' })).toMatchObject({ ok: false });
      expect.soft(manager?.listPublicForRequest({}, h.sessionId) ?? []).toHaveLength(0);
      return;
    }
    const result = await start(request);
    const localObservations = await Promise.all(localRpc.mock.results.map(async (row, index) => ({
      method: localRpc.mock.calls[index]?.[0],
      result: await Promise.resolve(row.value).catch((error: unknown) => ({
        exception: error instanceof Error ? error.message : 'unknown',
      })),
    })));
    expect(result, JSON.stringify({ result, daemonOutcomes, localObservations })).toMatchObject({ ok: true, result: { runId: expect.any(String),
      wait: { ok: true, status: 'succeeded', result: { latestToolResult: 'ORC_TASK_RESULT' } } } });
    const accepted = z.object({ result: z.object({ runId: z.string() }) }).parse(result);
    expect(manager?.get(accepted.result.runId)).toMatchObject({ sessionId: h.sessionId, depth: 1,
      backendId: h.retainedAgent.agentId, permissionMode: 'read_only' });
    expect(manager?.listPublicForRequest({}, h.sessionId)).toHaveLength(1);
    const refuse = async (input: Record<string, unknown>, errorCode: string) => {
      const refused = await start(input);
      expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, errorCode,
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } });
      expect(manager?.listPublicForRequest({}, h.sessionId)).toHaveLength(1);
    };
    if (scenario === 'ordinary_run_authority') {
      selectionAvailable = false;
      await refuse(request, 'target_unavailable');
      selectionAvailable = true;
      await refuse({ ...request, sessionId: 'foreign-session' }, 'unsupported_action');
      await refuse({ ...request, roleId: 'missing-role' }, 'role_target_unavailable');
      turnDepth = 4;
      await refuse(request, 'work_depth_exceeded');
      turnDepth = 0;
      permission = 'read-only';
      // Task intent is intrinsically read-only. Use the adjacent shared delegate
      // contract so this is a valid write request refused by the caller ceiling.
      await refuse({ ...request, intent: 'delegate', permissionMode: 'workspace_write' }, 'permission_exceeds_ceiling');
      permission = 'yolo';
      const unknownAgent = await start({ ...request, backendTarget: { kind: 'agent',
        identity: { pluginId: 'acme.unadmitted', localId: 'agent' } } });
      expect(unknownAgent, JSON.stringify(unknownAgent)).toMatchObject({ ok: false,
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } });
      expect(manager?.listPublicForRequest({}, h.sessionId)).toHaveLength(1);
      return;
    }
    authorizedMachineId = 'foreign-machine';
    const foreignMachine = await start(request);
    expect(foreignMachine, JSON.stringify(foreignMachine)).toMatchObject({ ok: false });
    expect(daemonOutcomes.at(-1)).toMatchObject({ actionId: 'agents.backends.list', ok: false });
    expect(manager?.listPublicForRequest({}, h.sessionId)).toHaveLength(1);
    authorizedMachineId = 'machine';
    foreignAccount = true;
    const recipient = await start(request);
    expect(recipient, JSON.stringify(recipient)).toMatchObject({ ok: false });
    expect(manager?.listPublicForRequest({}, h.sessionId)).toHaveLength(1);
    foreignAccount = false;
    h.f.retire();
    const retiredMachine = await start(request);
    expect(retiredMachine, JSON.stringify(retiredMachine)).toMatchObject({ ok: false });
    expect(manager?.listPublicForRequest({}, h.sessionId)).toHaveLength(1);
  } finally {
    try { await client.close(); await runtime.mcp.close(); }
    finally {
      try { registration.dispose(); await manager?.dispose(); await parent.close(); }
      finally { try { await authority.close(); } finally { await control.close(); } }
    }
  }
}, 30_000);
