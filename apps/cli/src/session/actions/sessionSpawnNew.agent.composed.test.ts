import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { accountSettingsParse, createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol';
import { setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionCreationTargetPreparationResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { configuration } from '@/configuration';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionDeps } from './createCliActionDeps';
import { resolveCliAgentStartContextV1 } from './resolveCliAgentStartContextV1';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { inheritedCodexInput } from './sessionSpawnNew.agent.testkit';
import { createSessionRoleContext } from '../roles/sessionRoleContext';
import { createRoleSourceReader } from '../roles/roleSources';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { resetActiveAccountSettingsSnapshotForTests } from '../../settings/accountSettings/activeAccountSettingsSnapshot';
import type { ExecutionRunAppliedParentSelection } from '../../agent/runtime/bridges/executionRun/runtime/openInputs';
import { MachineRpcTargetNotCurrentError } from '@/session/transport/rpc/machineRpc';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

it.each([false, true])('admits cont6 inherited MCP spawn from real CLI caller facts (observed=%s)', async observed => {
  const sessionId = 'cmvd7yezo007vmcol3pu0sjus';
  const serverId = 'stack_agent-qa-orc__id_default';
  const machineId = '230d042f-545c-4245-b269-b3ac209add77';
  const backendTarget = resolveBackendTargetFromSessionMetadata({ flavor: 'codex' });
  if (!backendTarget) throw new Error('Missing native Agent target fixture');
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'qa-owner' })).toString('base64url')}.signature`;
  const metadata = { machineId, path: '/tmp', flavor: 'codex' };
  let selectionAvailable = true;
  let roleSourceAvailable = true;
  const readAppliedChildSelection = (): ExecutionRunAppliedParentSelection => selectionAvailable
    ? { status: 'applied', backendTarget, modelId: inheritedCodexInput.modelSelection.ref.modelId,
      modelSelection: inheritedCodexInput.modelSelection.ref, connectedServices: null }
    : { status: 'unavailable' };
  const roles = createSessionRoleContext({ readMetadata: () => metadata,
    readOrganization: async () => ({ manager: null, origin: null }),
    readRoleSources: createRoleSourceReader({ accountId: 'qa-owner', readRawAccountSettings: async () => {
      if (!roleSourceAvailable) throw new Error('Settings storage unavailable');
      return {};
    } }),
    readAccountRoleOverrides: () => ({ status: 'ready', overrides: {} }), readAppliedChildSelection,
  });
  // Home settings/catalog reads are external; native selection, role resolution
  // and CLI admission stay real through the production composition.
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    if (path === '/v1/account/encryption') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === ACP_CATALOG_ROWS_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
    throw new Error(`Unexpected Home read: ${path}`);
  });
  const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId,
    mode: 'plain', ctx: null, serverId, serverHttpBaseUrl: 'https://spawn-owner.test',
    getCurrentSessionMetadata: () => metadata, getCurrentSessionBackendTarget: () => backendTarget,
    getCurrentSessionWorkDepth: () => 0, getCurrentTurnWorkDepth: id => id === 'cont6-turn-2' ? 0 : undefined,
    getSessionRoleContext: () => roles,
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
  });
  // The native Session launch and optional plugin notification are system boundaries.
  const sessionSpawnNew = vi.fn<ActionExecutorDeps['sessionSpawnNew']>(async () => ({
    type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted',
  }));
  const executor = createActionExecutor({ sessionSpawnNew, resolveAgentStartContext: deps.resolveAgentStartContext,
    ...(observed ? { observeActionExecution: async () => {} } : {}),
  } as unknown as ActionExecutorDeps);
  const bridge = createActionToolExecutorBridge({ surface: 'agent', defaultSessionMachineId: machineId,
    resolveCallerPermissionMode: () => 'default',
    resolveActiveTurnPermissionWitness: () => ({ turnId: 'cont6-turn-2',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } }),
    executor: { execute: (id, value, context) => executor.execute(id, value, { ...context,
      serverId, runtimeAccountId: 'qa-owner',
      actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
    }) },
  });
  const invoke = (value: unknown) => bridge.executeActionByToolName('action_execute', {
    actionId: 'session.spawn_new', input: value,
  }, sessionId);
  const expected = { ok: true, result: { type: 'pending', outcome: 'accepted' } };
  const inherited = await invoke(inheritedCodexInput);
  expect(inherited, JSON.stringify(inherited)).toMatchObject(expected);
  const child = sessionSpawnNew.mock.calls[0]?.[0];
  expect(child).toMatchObject({
    executionTarget: { serverId, machineId },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    manager: { sessionId },
  });
  expect(SessionSpawnNewInputV2Schema.safeParse({ ...inheritedCodexInput,
    executionTarget: child?.executionTarget, agentTarget: child?.agentTarget, manager: child?.manager,
  }).success).toBe(true);
  const explicit = { ...inheritedCodexInput, executionTarget: { serverId, machineId },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
  expect(await invoke(explicit)).toMatchObject(expected);
  sessionSpawnNew.mockClear();
  for (const malformed of [{ ...inheritedCodexInput, agentTarget: null },
    { ...inheritedCodexInput, agentTarget: backendTarget },
    { ...inheritedCodexInput, executionTarget: {} }, { ...inheritedCodexInput, unknown: true }]) {
    expect(await invoke(malformed)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  }
  expect(sessionSpawnNew).not.toHaveBeenCalled();
  roleSourceAvailable = false;
  expect(await invoke(inheritedCodexInput)).toMatchObject({ ok: false, errorCode: 'target_unavailable',
    details: { code: 'target_unavailable', reason: 'role_source_incomplete' } });
  expect(sessionSpawnNew).not.toHaveBeenCalled();
  roleSourceAvailable = true;
  selectionAvailable = false;
  expect(await invoke(inheritedCodexInput)).toMatchObject({ ok: false, errorCode: 'target_unavailable',
    details: { code: 'target_unavailable', reason: 'caller_agent_unavailable' } });
  expect(sessionSpawnNew).not.toHaveBeenCalled();
});

// Exact author input from QA-R27's completed action_execute tool, with no
// credential material. Host authority is supplied separately below.
const input = SessionSpawnNewInputV2Schema.parse({
  creationKey: 'reading-note-child-46793491-3e20-4ef6-b1d4-7b8f58c6d878',
  executionTarget: { serverId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN', machineId: '8dab5e53-7434-44cb-8094-f01d45482713' },
  directory: { kind: 'path', path: '/home/happier' },
  agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
  modelSelection: { v: 1, ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-haiku-4-5' }, updatedAt: 1792181902614 },
  connectedServices: { v: 2, bindingsByServiceId: { 'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'beee2181-b6ad-463c-8c96-5922f24555cd' } } },
  memoryEnabled: false, permissionMode: 'read-only', manager: { sessionId: 'cmvbeu0ig0040m203zcysq5v8' },
  initialInput: { text: 'Reply exactly: The reading note is ready. No tools, files, shell or external services.' },
});

it.each(['missing-capability', 'malformed-preparation', 'target-refused'] as const)('distinguishes %s for the actual Agent child input through the real tool and Action owners', async scenario => {
  const { serverId, machineId } = input.executionTarget;
  const parentId = input.manager!.sessionId;
  const serverUrl = 'https://df99-home.test';
  const previousServerId = configuration.activeServerId;
  Object.assign(configuration, { activeServerId: serverId });
  onTestFinished(() => Object.assign(configuration, { activeServerId: previousServerId }));
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'df99-account' })).toString('base64url')}.signature`, encryption: null };
  const settings = accountSettingsParse({ memoryUpkeepInNewBots: false, actionsSettingsV1: setActionApprovalOverride({
    settings: { v: 1, actions: {} }, actionId: 'session.spawn_new', surface: 'agent', approvalRequired: false,
  }) });
  const startContext = resolveCliAgentStartContextV1({ sessionId: parentId, machineId, directory: '/home/happier',
    backendTarget: input.agentTarget, metadata: {}, starterDepth: 0, turnDepth: 0, callerPermissionMode: 'read-only', settings, roles: {} });
  if (!startContext || 'ok' in startContext || startContext.caller.kind !== 'session') throw new Error('Missing real Session Agent-start context');
  const requests: string[] = [];
  // Home HTTP and remote Machine IPC are system boundaries. The success vector
  // is DF96's real Linux target preparation, validated by its strict consumer;
  // it must not inspect the test controller's filesystem for a remote path.
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v1/machines/${machineId}`) return { status: 200, data: { machine: {
      id: machineId, revokedAt: null, replacedByMachineId: null,
      storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      operationProtocolCapabilities: {}, operationProtocolCapabilitiesRevision: 1,
    } } };
    throw new Error(`Unexpected HTTP boundary ${path}`);
  });
  const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: parentId,
    mode: 'plain', ctx: null, rawSession: {}, serverId, serverHttpBaseUrl: serverUrl,
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: settings }),
    machineActionDirectTargetTransport: { machineId, invoke: async method => {
      if (method !== RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) throw new Error(`Unexpected Machine IPC ${method}`);
      if (scenario === 'target-refused') throw new MachineRpcTargetNotCurrentError(machineId, 'root_target_mismatch');
      if (scenario === 'malformed-preparation') return undefined;
      return SessionCreationTargetPreparationResultV1Schema.parse({ ok: true, directory: '/home/happier',
        directoryKind: 'path', directoryCreationRequired: false, checkout: null });
    } },
  });
  const executor = createActionExecutor(deps);
  const hostContext = { serverId, runtimeAccountId: 'df99-account', agentStartContext: startContext,
    actionCaller: startContext.caller } satisfies ActionExecutorContext;
  const bridge = createActionToolExecutorBridge({ surface: 'agent', defaultSessionMachineId: machineId,
    actionsSettings: settings.actionsSettingsV1,
    resolveCallerPermissionMode: () => 'read-only',
    resolveActiveTurnPermissionWitness: () => ({ turnId: 'df99-turn',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' } }),
    executor: { execute: (id, value, context) => executor.execute(id, value, { ...context, ...hostContext }) },
  });
  const result = await runWithServerHttpBaseUrl(serverUrl, () => bridge.executeActionByToolName('action_execute', {
    actionId: 'session.spawn_new', input,
  }, parentId));
  const expected = scenario === 'missing-capability' ? {
    type: 'error', code: 'update_required', retryable: false,
    details: { kind: 'update_required', operation: 'session.spawn_new', component: 'daemon', reason: 'session_roles_snapshot_update_required' },
  } : scenario === 'target-refused' ? {
    type: 'error', code: 'spawn_failed', retryable: true,
    launchError: { kind: 'launch_error', code: 'machine_target_not_current', message: 'root_target_mismatch' },
  } : {
    type: 'error', code: 'incompatible_target', retryable: false,
    incompatibleTarget: { reason: 'target_preparation_invalid_result' },
  };
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: expected });
  if (!result.ok) throw new Error('Missing strict spawn result');
  expect(SessionSpawnNewResultV1Schema.parse(result.result)).toEqual(result.result);
  if (scenario === 'missing-capability') expect(requests).toContain(`/v1/machines/${machineId}`);
});
