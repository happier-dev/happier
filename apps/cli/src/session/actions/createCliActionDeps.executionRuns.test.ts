import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { accountSettingsParse, buildBackendTargetKeyV2, createActionExecutor, readBackendTargetRefV2, ScmComparisonCaptureInputSchema, ScmComparisonCaptureOutputSchema, ScmDiffSummaryGenerateInputSchema, type ActionExecutorDeps } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import type {
  ActionApprovalRequestCreatedResult,
  ActionsService,
  PluginActionInputById,
  PluginActionResultById,
  PluginInvocableActionId,
} from '@happier-dev/plugin-sdk/actions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { withTempDir } from '@/testkit/fs/tempDir';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createLocalTestMetadata, createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { createCapabilitiesService } from '@/capabilities/service';
import { executionRunsCapability } from '@/capabilities/registry/toolExecutionRuns';
import { CHECKLIST_IDS } from '@/capabilities/checklistIds';
import { enableLocalSessionRpcCalls, registerLocalSessionRpcTarget } from '@/session/transport/rpc/localSessionRpcChannel';

const {
  callMachineRpc,
  callSessionRpc,
  readMachineRpcRequestDisposition,
  fetchSessionById,
} = vi.hoisted(() => ({
  callMachineRpc: vi.fn(),
  callSessionRpc: vi.fn(),
  readMachineRpcRequestDisposition: vi.fn(),
  fetchSessionById: vi.fn(),
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc,
}));

vi.mock('@/session/transport/rpc/machineRpc', async (importOriginal) => ({
  executionRunAuthorityCeiling: (await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>()).executionRunAuthorityCeiling,
  callMachineRpc,
  callExactMachineRpc: callMachineRpc,
  readMachineRpcRequestDisposition,
}));

// Session HTTP is the boundary; preserve the real selector, encryption, and worktree owners.
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById,
  lookupSessionsByTags: async () => ({ state: 'available', sessions: [await fetchSessionById()] }),
}));

import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { createPluginActionCallerMaterializationFixture } from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import { createCliActionDeps, type MachineActionDirectTargetTransport } from './createCliActionDeps';
import { createCliActionInventoryDeps } from './cliActionDeps/createCliActionInventoryDeps';
import { createCliMachineInventoryActionDeps } from './cliActionDeps/machineInventory';

const executionMaterialization = createPluginActionCallerMaterializationFixture('acme.execution');

function runProtocolDescribeResponse(overrides?: Readonly<{ version?: number; features?: Readonly<Record<string, boolean>> }> | null) {
  const response = createCapabilitiesService({ capabilities: [executionRunsCapability],
    checklists: { [CHECKLIST_IDS.NEW_SESSION]: [], [CHECKLIST_IDS.MACHINE_DETAILS]: [] },
    buildContext: async () => { throw new Error('Protocol description must not discover native capabilities'); } }).describe();
  if (overrides === undefined) return response;
  return { ...response, capabilities: response.capabilities.map(descriptor => ({ ...descriptor,
    protocol: overrides === null ? undefined : descriptor.protocol && { ...descriptor.protocol, ...overrides } })) };
}

function serveSessionRecord(row: Readonly<{ id: string; active: boolean; machineId?: string; path?: string; local?: boolean }>) {
  fetchSessionById.mockImplementation(async () => createSessionRecordFixture({
    id: row.id, active: row.active, encryptionMode: 'plain',
    ...(row.machineId ? { machineId: row.machineId } : {}),
    metadata: JSON.stringify(await (row.local ? createLocalTestMetadata : createTestMetadata)({
      ...(row.path ? { path: row.path } : {}),
      ...(row.machineId ? { machineId: row.machineId } : {}),
    })),
  }));
}

const SCM_TEST_MACHINE_ID = 'machine-scm';
const SCM_TEST_HOME_ID = 'scm-capture-home';
/**
 * SCM Actions run on the Session's Machine. This host is that Machine: the installed plugin runtime
 * (real Git backend) and the Machine identity are the real owners, so capture runs unchanged beneath the Action.
 */
async function withLocalScmMachine<T>(run: () => Promise<T>): Promise<T> {
  return withTempDir('scm-local-machine-home-', async home => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
    let admitted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    try {
      env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: SCM_TEST_HOME_ID });
      reloadConfiguration();
      await updateSettings(settings => ({ ...settings, machineIdByServerId: { [SCM_TEST_HOME_ID]: SCM_TEST_MACHINE_ID } }));
      admitted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController,
        runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
      return await run();
    } finally {
      await admitted?.dispose();
      env.restore();
      reloadConfiguration();
    }
  });
}

beforeEach(() => {
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(String(url), []) };
    if (path === ACP_CATALOG_ROWS_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    if (!String(url).endsWith('/v1/account/encryption/currentness')) throw new Error(`Unexpected HTTP read: ${url}`);
    return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
  });
});
afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

describe('detached exact Run output observation transport', () => {
  it('reads V2 support from safe describe without effectful detection and preserves caller authority', async () => {
    const service = createCapabilitiesService({ capabilities: [executionRunsCapability],
      checklists: { [CHECKLIST_IDS.NEW_SESSION]: [], [CHECKLIST_IDS.MACHINE_DETAILS]: [] },
      buildContext: async () => { throw new Error('Discovery is unavailable'); } });
    const invoke = vi.fn<MachineActionDirectTargetTransport['invoke']>(async method => {
      if (method !== RPC_METHODS.CAPABILITIES_DESCRIBE) throw new Error('Effectful capability detection is unavailable');
      return service.describe();
    });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine-1', invoke } });
    await expect(deps.executionRunCheckProtocolV2?.(null, {
      detachedScope: true, startAndWait: false, exactInputResults: false,
      runScopedAgentBindings: false, secretReferenceOverlay: false,
    }, { exactMachineId: 'machine-1', authority: 'account_automation' })).resolves.toEqual({
      ok: true, exactMachineId: 'machine-1',
    });
    expect(invoke).toHaveBeenCalledWith(RPC_METHODS.CAPABILITIES_DESCRIBE, {},
      expect.objectContaining({ localActionContext: expect.objectContaining({ authority: 'account_automation' }) }));
  });

  it.each([
    ['missing', undefined],
    ['disabled', { version: 2, available: false, features: { detachedScope: true } }],
    ['malformed', { version: 2, available: true, features: { detachedScope: 'true' } }],
  ] as const)('keeps %s Run describe facts unsupported without falling back to discovery', async (_name, protocol) => {
    const methods: string[] = [];
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine-1', invoke: async method => {
        methods.push(method);
        // Released .17 and current ../0.2 describe this capability without a V2 fact.
        return { protocolVersion: 1, capabilities: [{ id: 'tool.executionRuns', kind: 'tool', protocol }], checklists: {} };
      } } });
    await expect(deps.executionRunCheckProtocolV2?.(null, {
      detachedScope: true, startAndWait: false, exactInputResults: false,
      runScopedAgentBindings: false, secretReferenceOverlay: false,
    }, { exactMachineId: 'machine-1', authority: 'account_automation' })).resolves.toMatchObject({
      ok: false, errorCode: 'execution_run_protocol_unsupported',
    });
    expect(methods).toEqual([RPC_METHODS.CAPABILITIES_DESCRIBE]);
  });

  it.each(['installed', 'remote'] as const)('preserves a received %s Run refusal without treating it as a lost acknowledgement', async route => {
    const invoke = vi.fn<MachineActionDirectTargetTransport['invoke']>();
    const targetMachineId = route === 'installed' ? 'machine-1' : 'machine-2';
    const boundary = route === 'installed' ? invoke : callMachineRpc;
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine-1', invoke } });
    for (const [reply, rpcErrorCode] of [
      [{ error: 'Policy unavailable', errorCode: 'policy_unavailable' }, 'policy_unavailable'],
      [{ error: 'Unknown error' }, 'action_failed'],
    ] as const) {
      boundary.mockResolvedValueOnce(reply);
      await expect(deps.executionRunList(null, {}, { targetMachineId }))
        .rejects.toMatchObject({ rpcErrorCode, message: reply.error });
    }
    boundary.mockRejectedValueOnce(new Error('Connection lost'));
    expect(await deps.executionRunList(null, {}, { targetMachineId }))
      .toMatchObject({ ok: false, code: 'execution_run_target_unavailable' });
  });
  it('preserves the current causal ceiling on a direct retained Run send without start depth', async () => {
    const invoke = vi.fn<MachineActionDirectTargetTransport['invoke']>(async () => ({ ok: true }));
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine-1', invoke } });
    const causalPermissionAuthority = { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const };
    expect(await deps.detachedExecutionRunSend(null, { runId: 'retained-run', message: 'Next Workflow step', delivery: 'prompt' }, {
      targetMachineId: 'machine-1', surface: 'agent', authority: 'account_automation',
      causalPermissionAuthority, effectiveCallerPermissionMode: 'read-only',
    })).toEqual({ ok: true });
    // This host-private transport is the authority boundary consumed by the
    // registered Action receiver; a retained send has no new start depth.
    expect(invoke).toHaveBeenCalledWith(SESSION_RPC_METHODS.EXECUTION_RUN_SEND, expect.objectContaining({ runId: 'retained-run' }),
      expect.objectContaining({ localActionContext: expect.objectContaining({
        causalPermissionAuthority, callerPermissionMode: 'read-only', authority: 'account_automation',
      }) }));
    expect(invoke.mock.calls[0]?.[2]?.localActionContext).not.toHaveProperty('agentStartWorkDepth');
  });

  it.each(['list', 'start'] as const)('uses the installed exact Machine transport for ordinary detached Run %s', async (operation) => {
    const response = operation === 'list' ? { runs: [] } : { runId: 'detached-run', callId: 'call', sidechainId: 'sidechain' };
    const invoke = vi.fn(async () => response);
    callMachineRpc.mockClear();
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine-1', invoke } });
    const request = operation === 'list' ? {} : { kind: 'delegate', intent: 'delegate', instructions: 'Read the fixture',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
      retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' };
    const result = operation === 'list'
      ? await deps.executionRunList(null, request, { targetMachineId: 'machine-1' })
      : await deps.executionRunStart(null, request, { targetMachineId: 'machine-1' });
    expect(result).toEqual(response);
    expect(invoke).toHaveBeenCalledWith(operation === 'list' ? SESSION_RPC_METHODS.EXECUTION_RUN_LIST
      : SESSION_RPC_METHODS.EXECUTION_RUN_START, request, expect.any(Object));
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('routes an ordinary detached call to a different Machine and refuses private-context dispatch there', async () => {
    const response = { runs: [] };
    const invoke = vi.fn();
    callMachineRpc.mockReset().mockResolvedValue(response);
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine-1', invoke } });
    expect(await deps.executionRunList(null, {}, { targetMachineId: 'machine-2' })).toEqual(response);
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-2',
      method: SESSION_RPC_METHODS.EXECUTION_RUN_LIST }));
    callMachineRpc.mockClear();
    expect(await deps.executionRunList(null, {}, { targetMachineId: 'machine-2', workDepth: 1 }))
      .toMatchObject({ ok: false, code: 'execution_run_target_unavailable' });
    expect(await deps.detachedExecutionRunSend(null, { runId: 'retained-run', message: 'Keep the admitted ceiling', delivery: 'prompt' }, {
      targetMachineId: 'machine-2',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
      effectiveCallerPermissionMode: 'read-only',
    })).toMatchObject({ ok: false, code: 'execution_run_target_unavailable' });
    expect(callMachineRpc).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('ends a local passive observation at its authored deadline despite blocked output', async () => {
    const snapshot = { run: {
      runId: 'run-watch', callId: 'call', sidechainId: 'call', intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
      retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', startedAtMs: 1, status: 'running',
    } };
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine-1', invoke: async () =>
        ({ ok: true, status: 'running', disposition: 'snapshot', result: snapshot }) } });
    // The wait lazily imports its service. Load it first so the deadline timer is armed on the fake
    // clock before the clock advances, instead of racing a cold module transform.
    await Promise.all([import('@/session/services/executionRuns'), import('@/session/services/executionRunWaitTiming')]);
    const observation = new AbortController();
    vi.useFakeTimers();
    try {
      const waiting = deps.executionRunWait(null, { runId: 'run-watch', timeoutSeconds: 1 },
        { exactMachineId: 'machine-1', workDepth: 3, signal: observation.signal, onSnapshot: async () => blocked });
      let completed: unknown;
      void waiting.then(result => { completed = result; });
      await vi.advanceTimersByTimeAsync(1000);
      expect(completed).toMatchObject({ ok: false, code: 'observation_timeout' });
      release();
      await waiting;
    } finally {
      // The fake transport answers instantly, so an observation that outlives a failed assertion
      // would spin the worker's microtask queue and hang the whole file past every test timeout.
      observation.abort();
      release();
      vi.useRealTimers();
    }
  });

  it('keeps a causally admitted local wait on its native direct target', async () => {
    const result = { ok: true, status: 'running', disposition: 'needs_attention', result: { run: {
      runId: 'run-watch', callId: 'call', sidechainId: 'call', intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
      retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', startedAtMs: 1, status: 'running',
      attention: { kind: 'permission_required', requestIds: ['permission'] },
    } } };
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine-1', invoke: async () => result } });
    expect(await deps.executionRunWait(null, { runId: 'run-watch', condition: 'needs_attention' },
      { exactMachineId: 'machine-1', workDepth: 3 })).toMatchObject(result);
  });

  it.each([null, 'session-1'] as const)('publishes passive Run snapshots through the native service for %s scope', async (sessionId) => {
    const controller = new AbortController();
    const snapshot = { run: {
      runId: 'run-watch', callId: 'call', sidechainId: 'call', intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
      retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', startedAtMs: 1, status: 'running',
    } };
    const boundary = async (params: Parameters<typeof import('@/session/transport/rpc/sessionRpc')['callSessionRpc']>[0]) => {
      const result = { ok: true, status: 'running', disposition: 'snapshot', result: snapshot };
      if (!params.reattachOnReconnect?.onResult) return result;
      await params.reattachOnReconnect.onResult(result);
      params.signal?.throwIfAborted();
      throw new Error('passive observer must cancel after accepting baseline');
    };
    callSessionRpc.mockImplementationOnce(boundary);
    callMachineRpc.mockImplementationOnce(boundary);
    serveSessionRecord({ id: 'session-1', active: true, machineId: 'machine-1' });
    const credentials = { token: 'token', encryption: null };
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null });
    const snapshots: unknown[] = [];
    const waiting = deps.executionRunWait(sessionId, { runId: 'run-watch' }, { targetMachineId: 'machine-1',
      signal: controller.signal, onSnapshot: value => { snapshots.push(value); controller.abort(); } });
    await waiting.catch(() => undefined);
    expect(snapshots).toEqual([snapshot]);
    callSessionRpc.mockReset();
    callMachineRpc.mockReset();
  });

  it.each([{ waitForInputId: 'input-1' }, { waitForOutput: { kind: 'review_walkthrough' as const, comparisonId: 'comparison-1' } }])
  ('keeps exact get observation under caller lifecycle: %j', async (wait) => {
    callMachineRpc.mockResolvedValueOnce({ run: { runId: 'run-1' } });
    const credentials = { token: 'token', encryption: null };
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null });
    const controller = new AbortController();
    await deps.executionRunGet(null, { runId: 'run-1', ...wait }, { targetMachineId: 'machine-1', signal: controller.signal });
    expect(callMachineRpc.mock.lastCall?.[0]).toMatchObject({ method: SESSION_RPC_METHODS.EXECUTION_RUN_GET,
      timeoutMs: null, signal: controller.signal });
  });
});

type ExecutionRunActionId = Extract<PluginInvocableActionId,
  | 'execution.run.list'
  | 'execution.run.get'
  | 'execution.run.send'
  | 'execution.run.stop'
  | 'execution.run.action'>;

function createExecutionRunAction<K extends ExecutionRunActionId>(
  actionId: K,
  input: PluginActionInputById[K],
): Readonly<{
  actionId: K;
  invoke(service: ActionsService): Promise<PluginActionResultById[K] | ActionApprovalRequestCreatedResult>;
}> {
  return {
    actionId,
    invoke(service) {
      return service.execute(actionId, input);
    },
  };
}

function createExecutionRunSuccessCase<K extends ExecutionRunActionId>(
  actionId: K,
  input: PluginActionInputById[K],
  rpcResponse: unknown,
  expected: PluginActionResultById[K],
) {
  return {
    ...createExecutionRunAction(actionId, input),
    rpcResponse,
    expected,
  };
}

function createExecutionRunActionsService(detachedTransport?: 'installed' | 'public') {
  const directInvoke = vi.fn<MachineActionDirectTargetTransport['invoke']>();
  const credentials = {
    token: 'token',
    encryption: null,
  };
  resetActiveAccountSettingsSnapshotForTests();
  setActiveAccountSettingsSnapshot({ scopeKey: resolveAccountSettingsScopeKey(credentials), source: 'network',
    settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, settingsSecretsReadKeys: [], loadedAtMs: Date.now(),
    promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
  serveSessionRecord({ id: 'session-1', active: true });
  const deps = createCliActionDeps({
    token: credentials.token,
    credentials,
    sessionId: 'session-1',
    mode: 'plain',
    ctx: null,
    getCurrentSessionWorkDepth: () => 0,
    getCurrentTurnWorkDepth: () => 0,
    ...(detachedTransport === 'installed' ? {
      machineActionDirectTargetTransport: { machineId: 'machine-1', invoke: directInvoke },
    } : {}),
  });
  const actionExecutor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"execution.run.list": Object.keys(ActionSurfaceSchema.shape), "execution.run.get": Object.keys(ActionSurfaceSchema.shape), "execution.run.send": Object.keys(ActionSurfaceSchema.shape), "execution.run.stop": Object.keys(ActionSurfaceSchema.shape), "execution.run.action": Object.keys(ActionSurfaceSchema.shape), "execution.run.start": Object.keys(ActionSurfaceSchema.shape), "execution.run.ensure": Object.keys(ActionSurfaceSchema.shape), "execution.run.ensure_or_start": Object.keys(ActionSurfaceSchema.shape), "execution.run.stream.start": Object.keys(ActionSurfaceSchema.shape), "execution.run.stream.read": Object.keys(ActionSurfaceSchema.shape), "execution.run.stream.cancel": Object.keys(ActionSurfaceSchema.shape), "scm.diffSummary.generate": Object.keys(ActionSurfaceSchema.shape), "scm.diffSummary.draftPullRequest": Object.keys(ActionSurfaceSchema.shape), "scm.diffSummary.capture": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
    ...deps,
    isActionEnabled: () => true,

  });
  const retirement = new AbortController();
  const service = createPluginInvocationActionsService({
    seed: {
      plugin: { id: 'acme.execution', version: '1.0.0' },
      resolveCurrentPluginMaterializationRef:
        executionMaterialization.resolveCurrentPluginMaterializationRef,
      occurrenceId: 'generation-1',
      // Agent turns carry private admitted authority; ordinary plugin calls do not.
      surface: detachedTransport === 'public' ? 'plugin' : 'agent',
      session: { id: 'session-1' },
      readActiveTurnAdmissionWitness: () => ({
        inputId: 'execution-run-test-input',
        turnId: 'execution-run-test-turn',
        userMessageSeq: 1,
        userMessageSeqs: [1],
        agentStartCaller: { kind: 'session' as const, sessionId: 'session-1', starterDepth: 0, turnDepth: 0 },
        callerPermissionMode: 'default' as const,
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1' as const,
          admittedPermissionCeiling: 'default' as const,
        },
      }),
      signal: retirement.signal,
      isOccurrenceCurrent: () => !retirement.signal.aborted,
    },
    actionExecutor,
    invokeContributedAction: vi.fn(),
  });
  return { service, retirement, directInvoke };
}

describe('createCliActionDeps execution-run plugin bindings', () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  });
  it('dispatches the selected connected Claude profile despite signed-out native inventory', async () => {
    const credentials = { token: 'requesting-account', encryption: null };
    const serviceId = 'happier.agent.claude/claude-subscription';
    const agentId = 'happier.agent.claude/claude';
    serveSessionRecord({ id: 'session-1', active: true, machineId: 'machine-1' });
    const originalGet = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (url, ...args) => {
      if (new URL(String(url)).pathname === '/v1/machines/machine-1') {
        return { status: 200, data: { machine: { id: 'machine-1', machineKind: 'permanent',
          managedMachineRef: null, installationId: null, active: true, activeAt: Date.now(),
          revokedAt: null, replacedByMachineId: null } } };
      }
      if (new URL(String(url)).pathname === '/v1/account/entity-rows/connected-accounts/purposes') {
        return { status: 200, data: { status: 'present', revision: 1,
          content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } } };
      }
      return originalGet(url, ...args);
    });
    // These are the Machine and Session RPC boundaries. Keep Action admission,
    // inventory projection, Account defaults, selection and Run dispatch real.
    const machineRpc = async ({ method }: Readonly<{ method: string }>) => {
      if (method === RPC_METHODS.CAPABILITIES_DESCRIBE) return runProtocolDescribeResponse();
      if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
        return { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
          [agentId]: { id: 'claude', title: 'Claude', capabilities: {
            sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
          } },
        } } };
      }
      if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
        [`cli.${agentId}`]: { ok: true, checkedAt: 1, data: {
          installed: true, version: '1', latestVersion: null, update: { supported: false, command: null },
          signIn: { status: 'signedOut', loginSupport: 'login_terminal' }, platform: { supported: true },
          install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [],
        } },
      } };
      throw new Error(`Unexpected Machine RPC: ${method}`);
    };
    callMachineRpc.mockImplementation(machineRpc);
    callSessionRpc.mockResolvedValue({ runId: 'run-connected', callId: 'call-connected', sidechainId: 'call-connected' });
    const params = { token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain' as const, ctx: null };
    const inventoryDeps = createCliActionInventoryDeps(params);
    const machineDeps = createCliMachineInventoryActionDeps(params, { inventoryDeps, callMachineAction: machineRpc });
    expect(await machineDeps.machinesAgentsList!({ machineId: 'machine-1' }, {})).toMatchObject({
      items: [{ agentId, signIn: { status: 'signedOut' } }],
    });
    expect(await inventoryDeps.agentsConnectedDefaultRoutesRead!({ agentIds: [agentId] }, {})).toEqual({ [agentId]: 'native' });
    const executor = createActionExecutor({ ...createCliActionDeps(params), ...inventoryDeps, ...machineDeps });
    const result = await executor.execute('execution.run.start', {
      sessionId: 'session-1', intent: 'delegate', backendTarget: { kind: 'agent',
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      instructions: 'Report ready.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
      runClass: 'bounded', ioMode: 'request_response',
      connectedServices: `${serviceId}:profile:owned-profile`,
    }, { surface: 'cli', defaultSessionId: 'session-1', defaultSessionMachineId: 'machine-1' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { runId: 'run-connected' } });
    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: credentials.token, sessionId: 'session-1', method: `session-1:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`,
      request: expect.objectContaining({ connectedServices: { v: 2, bindingsByServiceId: {
        [serviceId]: { source: 'connected', selection: 'profile', profileId: 'owned-profile' },
      } } }),
    }));
  });
  it.each([null, 'source-session'])('does not send an admitted private stamp through public RPC (Session: %s)', async sessionId => {
    const credentials = { token: 'token', encryption: null };
    const deps = createCliActionDeps({ token: 'token', credentials, sessionId: 'cli-global', mode: 'plain', ctx: null });
    const result = await deps.executionRunStart(sessionId, { instructions: 'Inspect' }, {
      exactMachineId: 'machine-1', workDepth: 1, workspaceWrites: 'deny',
    });
    expect(result).toMatchObject({ ok: false, code: 'execution_run_target_unavailable', details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } });
    expect(callMachineRpc).not.toHaveBeenCalled();
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it.each([
    { authority: 'account_automation' as const, spawns: 0 },
    { authority: 'present_user' as const, spawns: 1 },
  ])('Run start into a stopped Session forwards $authority to the Resume owner ($spawns spawns)', async ({ authority, spawns }) => {
    const stop = { v: 1, cause: 'explicit_stop', requestId: 'person-stop', requestedAtMs: 100 } as const;
    fetchSessionById.mockImplementation(async () => createSessionRecordFixture({
      id: 'session-1', active: false, machineId: 'machine-1', encryptionMode: 'plain',
      metadata: JSON.stringify({ ...await createTestMetadata({ machineId: 'machine-1', path: '/repo' }),
        runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} }, claudeSessionId: 'native-1', sessionExplicitStopV1: stop }),
    }));
    // The launch itself is outside this contract: admission and its authority are what must hold.
    callMachineRpc.mockResolvedValue({ type: 'error', errorCode: 'spawn_failed', errorMessage: 'launch refused' });
    const credentials = { token: 'token', encryption: null };
    const deps = createCliActionDeps({ token: 'token', credentials, sessionId: 'cli-global', mode: 'plain', ctx: null });
    const result = await deps.executionRunStart('session-1', { instructions: 'Summarize' }, { authority });
    expect(result).toMatchObject({ ok: false, code: 'execution_run_target_unavailable',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } });
    const launches = callMachineRpc.mock.calls.map(call => call[0]).filter(call => call.method.includes('spawn-happy-session'));
    expect(launches).toHaveLength(spawns);
    if (spawns) expect(launches[0].request.executionAuthorization).toMatchObject({ provenance: 'user_request' });
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('carries admitted depth and write ceiling in the exact-daemon private context, not Run input', async () => {
    const invoke = vi.fn(async () => ({ runId: 'run-1' }));
    const credentials = { token: 'token', encryption: null };
    const deps = createCliActionDeps({ token: 'token', credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine-1', invoke },
    });
    await deps.executionRunStart(null, { instructions: 'Inspect' }, { exactMachineId: 'machine-1', workDepth: 3, workspaceWrites: 'deny' });
    expect(invoke).toHaveBeenCalledWith(SESSION_RPC_METHODS.EXECUTION_RUN_START,
      { instructions: 'Inspect' },
      expect.objectContaining({ localActionContext: expect.objectContaining({ surface: 'agent', agentStartWorkDepth: 3, agentStartWorkspaceWrites: 'deny' }) }));
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('starts an attached Run through the exact local Session owner without discarding its admitted ceilings', async () => {
    await withTempDir('attached-run-admission-', async home => {
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
      env.patch({ HAPPIER_HOME_DIR: home });
      reloadConfiguration();
      enableLocalSessionRpcCalls();
      const token = `h.${Buffer.from(JSON.stringify({ sub: 'owner', extras: { provenance: {
        v: 1, kind: 'terminal', authority: 'account_automation',
      } } })).toString('base64url')}.s`;
      const retire = await registerLocalSessionRpcTarget({ sessionId: 'session-1', credentialToken: token,
        handleRequest: async () => ({}), cancelRequest: () => {}, readTrustedCaller: async () => null });
      try {
        serveSessionRecord({ id: 'session-1', active: true, machineId: 'machine-1' });
        callSessionRpc.mockResolvedValue({ runId: 'attached-run', callId: 'attached-call', sidechainId: 'attached-call' });
        const invoke = vi.fn();
        const deps = createCliActionDeps({ token, credentials: { token, encryption: null },
          sessionId: 'cli-global', mode: 'plain', ctx: null,
          machineActionDirectTargetTransport: { machineId: 'machine-1', invoke } });
        const result = await deps.executionRunStart('session-1', { instructions: 'Review' }, {
          exactMachineId: 'machine-1', workDepth: 3, workspaceWrites: 'deny',
          effectiveCallerPermissionMode: 'read_only',
          causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
        });
        expect(result).toMatchObject({ ok: true, data: { runId: 'attached-run' } });
        expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1',
          request: { instructions: 'Review' }, localActionContext: expect.objectContaining({
            agentStartWorkDepth: 3, agentStartWorkspaceWrites: 'deny', callerPermissionMode: 'read_only',
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
          }) }));
        expect(invoke).not.toHaveBeenCalled();
      } finally { await retire(); env.restore(); reloadConfiguration(); }
    });
  });

  it('carries exact Workflow invocation services only through the local detached start', async () => {
    const actionCaller = { kind: 'workflowRun' as const, runId: 'workflow-1', authorization: {
      admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const },
    } };
    const permissionStore = {
      publishRequest: vi.fn(),
      publishRequestAndWait: vi.fn(async () => undefined),
      registerResponseTargetHandler: vi.fn(() => () => undefined),
    };
    const workflowObservationSink = { commit: vi.fn(async () => undefined) };
    const invoke = vi.fn(async (method: string) => {
      if (method === RPC_METHODS.CAPABILITIES_DESCRIBE) return runProtocolDescribeResponse({ version: 2, features: { detachedScope: true, startAndWait: true, exactInputResults: true, runScopedAgentBindings: true } });
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_START) return {
        runId: 'run-1', callId: 'call-1', sidechainId: 'call-1',
      };
      throw new Error(`unexpected:${method}`);
    });
    const credentials = { token: 'token', encryption: null };
    const deps = createCliActionDeps({
      token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine-1', invoke },
    });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"execution.run.start": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...deps, isActionEnabled: () => true });

    await expect(executor.execute('execution.run.start', {
      sessionId: null,
      intent: 'agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Write the file.',
      permissionMode: 'default',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'request_response',
    }, {
      surface: 'agent',
      authority: 'account_automation',
      executionRunTargetMachineId: 'machine-1',
      executionRunPermissionRequestStore: permissionStore,
      executionRunWorkflowObservationSink: workflowObservationSink,
      callerPermissionMode: 'default',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
      actionCaller,
      actionRequestId: 'workflow-input-v2:exact:execution-run-start',
      agentStartContext: {
        caller: { kind: 'originless', runId: 'workflow-1', runDepth: 2 },
        baseline: { machineId: 'machine-1', directory: '/workspace' },
        ledSubtreeSessionIds: [], workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'default',
      },
    })).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(invoke).toHaveBeenCalledWith(
      SESSION_RPC_METHODS.EXECUTION_RUN_START,
      expect.any(Object),
      expect.objectContaining({
        executionRunPermissionRequestStore: permissionStore,
        executionRunWorkflowObservationSink: workflowObservationSink,
        localActionContext: expect.objectContaining({ agentStartWorkDepth: 3, actionCaller,
          actionRequestId: 'workflow-input-v2:exact:execution-run-start' }),
      }),
    );
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    callMachineRpc.mockReset();
    callSessionRpc.mockReset();
    readMachineRpcRequestDisposition.mockReset();
    readMachineRpcRequestDisposition.mockReturnValue(null);
    fetchSessionById.mockReset();
  });

  it('routes the five plugin-visible run lifecycle actions to the canonical session owner with typed results', async () => {
    const { service } = createExecutionRunActionsService();
    const session = { id: 'session-1', active: true, machineId: 'machine-1' };
    serveSessionRecord(session);
    callSessionRpc
      .mockImplementationOnce(async () => {
        session.machineId = 'machine-2';
        return { ok: true };
      })
      .mockResolvedValueOnce({ ok: true, runId: 'run-1', created: false })
      .mockResolvedValueOnce({ streamId: 'stream-1' })
      .mockResolvedValueOnce({
        streamId: 'stream-1',
        events: [{ t: 'delta', textDelta: 'hello' }],
        nextCursor: 1,
        done: false,
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(service.execute('execution.run.ensure', {
      runId: 'run-1',
      resume: true,
    })).resolves.toEqual({ ok: true });
    await expect(service.execute('execution.run.ensure_or_start', {
      runId: 'run-1',
      resume: true,
    })).resolves.toEqual({ ok: true, runId: 'run-1', created: false });
    await expect(service.execute('execution.run.stream.start', {
      runId: 'run-1',
      message: 'Continue',
      resume: true,
    })).resolves.toEqual({ streamId: 'stream-1' });
    await expect(service.execute('execution.run.stream.read', {
      runId: 'run-1',
      streamId: 'stream-1',
      cursor: 0,
      maxEvents: 16,
    })).resolves.toEqual({
      streamId: 'stream-1',
      events: [{ t: 'delta', textDelta: 'hello' }],
      nextCursor: 1,
      done: false,
    });
    await expect(service.execute('execution.run.stream.cancel', {
      runId: 'run-1',
      streamId: 'stream-1',
    })).resolves.toEqual({ ok: true });

    expect(fetchSessionById).toHaveBeenCalledTimes(5);
    expect(callSessionRpc.mock.calls.map(([request]) => request.rawSession.machineId)).toEqual([
      'machine-1', 'machine-2', 'machine-2', 'machine-2', 'machine-2',
    ]);
    expect(callSessionRpc.mock.calls.map(([request]) => ({
      method: request.method,
      request: request.request,
    }))).toEqual([
      {
        method: `session-1:${SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE}`,
        request: { runId: 'run-1', resume: true },
      },
      {
        method: `session-1:${SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START}`,
        request: { runId: 'run-1', resume: true },
      },
      {
        method: `session-1:${SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START}`,
        request: { runId: 'run-1', message: 'Continue', resume: true },
      },
      {
        method: `session-1:${SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ}`,
        request: { runId: 'run-1', streamId: 'stream-1', cursor: 0, maxEvents: 16 },
      },
      {
        method: `session-1:${SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL}`,
        request: { runId: 'run-1', streamId: 'stream-1' },
      },
    ]);
    expect(callSessionRpc.mock.calls.map(([request]) => request.timeoutMs)).toEqual([
      null,
      null,
      null,
      undefined,
      null,
    ]);
  });

  it('routes SCM diff-summary through the supplied canonical Action boundary without a direct run transport', () => withLocalScmMachine(async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-summary-deps-' });
    directories.push(fixture.rootPath);
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'captured through session Action\n');
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    serveSessionRecord({ id: 'session-1', active: true, machineId: SCM_TEST_MACHINE_ID, path: fixture.rootPath, local: true });
    const executeCanonicalAction = vi.fn(async (actionId: string, _input: unknown) => {
      if (actionId === 'execution.run.start') {
        return {
          ok: true as const,
          result: {
            runId: 'run-1',
            callId: 'call-1',
            sidechainId: 'sidechain-1',
          },
        };
      }
      throw new Error(`unexpected action: ${actionId}`);
    });
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
    });

    const observed = await deps.scmActionExecute?.({
      actionId: 'scm.diffSummary.generate',
      input: {
        cwd: fixture.rootPath,
        sessionId: 'session-1',
        source: { kind: 'workingTree' },
        modelSelector: {
          backendTargetKey: buildBackendTargetKeyV2({
            kind: 'backend',
            backendId: 'codex',
            sourceKind: 'configured',
            configuredBackendId: 'fixture-model',
          }),
        },
      },
      context: { defaultSessionId: 'session-1' },
      executeCanonicalAction,
    });
    expect(observed).toMatchObject({ success: true, runId: 'run-1',
      comparison: { inventory: { state: 'complete', files: [expect.objectContaining({ path: fixture.trackedPath })] } },
      outputs: { summary: { state: 'pending' } },
    });
    expect(executeCanonicalAction).toHaveBeenNthCalledWith(1, 'execution.run.start', expect.objectContaining({
      waitForCompletion: false,
      backendTarget: { kind: 'backend', backendId: 'fixture-model', configuredBackendId: 'fixture-model', sourceKind: 'configured' },
      intentInput: expect.objectContaining({ sessionId: 'session-1', comparisonId: expect.any(String) }),
    }));
    expect(executeCanonicalAction.mock.calls[0]?.[1]).toHaveProperty('sessionId', 'session-1');
    expect(executeCanonicalAction).toHaveBeenCalledTimes(1);
    expect(callSessionRpc).not.toHaveBeenCalled();
  }));

  it.each(['scm.diffSummary.generate', 'scm.diffSummary.draftPullRequest'] as const)('keeps delayed %s admission and its typed refusal under the caller lifetime', async actionId => {
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) } };
    const controller = new AbortController();
    let release!: () => void;
    let dispatched!: () => void;
    const admitted = new Promise<void>(resolve => { dispatched = resolve; });
    const response = new Promise<void>(resolve => { release = resolve; });
    // Authenticated Machine RPC is the boundary. Its ordinary read deadline
    // cannot decide whether the external generation effect was admitted.
    callMachineRpc.mockImplementation(async ({ request, authorization, timeoutMs, signal }) => {
      const input = ScmDiffSummaryGenerateInputSchema.parse(request);
      expect(input.sessionId).toBe('session-1');
      expect(authorization).toEqual({ kind: 'session.write', sessionId: 'session-1' });
      expect(signal).toBe(controller.signal);
      dispatched();
      await response;
      if (timeoutMs !== null) throw Object.assign(new Error('Machine RPC call timeout'), { code: 'MACHINE_RPC_TIMEOUT' });
      return { success: false, errorCode: 'DIFF_UNAVAILABLE', error: 'Saved comparison is unavailable', sourceKey: 'workingTree:/workspace' };
    });
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null });
    const pending = deps.scmActionExecute!({
      actionId,
      input: { cwd: '/workspace', sessionId: 'session-1', source: { kind: 'workingTree' } },
      context: { defaultSessionId: 'session-1', externalActionTarget: { kind: 'machine', machineId: 'machine-1' },
        signal: controller.signal,
        rpcSessionAuthorization: { kind: 'session.write', sessionId: 'session-1' } },
      executeCanonicalAction: async () => { throw new Error('Remote invocation must be admitted on the owning machine'); },
    });
    await admitted;
    release();
    await expect(pending).resolves.toMatchObject({ success: false, errorCode: 'DIFF_UNAVAILABLE', error: 'Saved comparison is unavailable' });
  });

  it('captures selected-session inventory without model admission', () => withLocalScmMachine(async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-capture-deps-' });
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) } };
    serveSessionRecord({ id: 'session-1', active: true, machineId: SCM_TEST_MACHINE_ID, path: fixture.rootPath, local: true });
    const executeCanonicalAction = vi.fn(async () => { throw new Error('Capture must not admit an analysis run'); });
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null });
    try {
      await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Inventory before prose\n');
      await expect(deps.scmActionExecute?.({ actionId: 'scm.diffSummary.capture',
        input: { cwd: fixture.rootPath, source: { kind: 'workingTree' } },
        context: { defaultSessionId: 'session-1' }, executeCanonicalAction,
      })).resolves.toMatchObject({ success: true, comparison: { inventory: { state: 'complete',
        files: [expect.objectContaining({ path: fixture.trackedPath })],
      } } });
      expect(executeCanonicalAction).not.toHaveBeenCalled();
    } finally { await rm(fixture.rootPath, { recursive: true, force: true }); }
  }));

  it('reads pinned comparison evidence without recapturing later pending files', () => withLocalScmMachine(async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-pinned-capture-deps-' });
    directories.push(fixture.rootPath);
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) } };
    serveSessionRecord({ id: 'session-1', active: true, machineId: SCM_TEST_MACHINE_ID, path: fixture.rootPath, local: true });
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null });
    const executeCanonicalAction = vi.fn(async () => { throw new Error('Pinned reads must not admit another action'); });
    const execute = (input: unknown) => deps.scmActionExecute?.({ actionId: 'scm.diffSummary.capture', input,
      context: { defaultSessionId: 'session-1' }, executeCanonicalAction });
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Captured first version\n');
    const captured = ScmComparisonCaptureOutputSchema.parse(await execute({ cwd: fixture.rootPath, source: { kind: 'workingTree' } }));
    if (!captured.success) throw new Error('Fixture comparison capture failed');
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'Different later version\n');
    const request = ScmComparisonCaptureInputSchema.parse({ cwd: fixture.rootPath,
      source: { kind: 'workingTree' }, comparisonId: captured.comparison.id });
    await expect(execute(request)).resolves.toMatchObject({ success: true, comparison: captured.comparison });
    await expect(execute({ ...request, source: { kind: 'commit', commit: 'HEAD' } })).resolves.toMatchObject({
      success: false, errorCode: 'DIFF_UNAVAILABLE',
    });
    expect(executeCanonicalAction).not.toHaveBeenCalled();
  }));

  it('reads PR evidence through the canonical constrained source Action from page one', () => withLocalScmMachine(async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-pr-source-deps-' });
    directories.push(fixture.rootPath);
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) } };
    serveSessionRecord({ id: 'session-1', active: true, machineId: SCM_TEST_MACHINE_ID, path: fixture.rootPath, local: true });
    // The contributed plugin process is the system boundary; canonical Action
    // admission, source-input shaping, and evidence capture stay real.
    const invokeContributedAction = vi.fn(async (request: Readonly<{ input?: unknown }>) => {
      const continuation = request.input && typeof request.input === 'object' && 'continuation' in request.input
        ? request.input.continuation : undefined;
      return { ok: true as const, result: { kind: 'changedFiles', omittedRowCount: 0, projectionTruncated: false,
        ...(!continuation ? { continuation: 'source-page-two', incomplete: 'pagination' } : {}),
        rows: [{ path: continuation ? 'second.ts' : 'first.ts', status: 'modified', diffAvailable: true,
          evidence: { state: 'available', patch: '@@ -1 +1 @@\n-before\n+after\n' } }],
        comparison: { beforeOid: 'a'.repeat(40), baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40),
          locator: { providerId: 'fixture', repository: 'owner/repo', number: 1 },
          totalFileCount: 2, enumeratedFileCount: continuation ? 2 : 1, freshness: 'current',
          inventory: continuation ? 'complete' : 'incomplete', content: continuation ? 'complete' : 'incomplete',
          reasons: continuation ? [] : ['pages_pending'] },
      } };
    });
    const canonical = createActionExecutor({ invokeContributedAction } as unknown as ActionExecutorDeps);
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null });
    await expect(deps.scmActionExecute?.({ actionId: 'scm.diffSummary.capture',
      input: { cwd: fixture.rootPath, source: { kind: 'pullRequest', locator: {
        providerId: 'fixture', repository: 'owner/repo', number: 1,
        sourceAction: { action: { pluginId: 'acme.source', localId: 'changed-files' },
          input: { instance: { selected: 'account-one' }, routingToken: 'source-token', limit: 7,
            comparison: false, continuation: 'client-midpage' } },
      } } }, context: { defaultSessionId: 'session-1' },
      executeCanonicalAction: (actionId, input, options) => canonical.execute(actionId, input, { surface: 'api', ...options }),
    })).resolves.toMatchObject({ success: true, comparison: { endpoints: { before: 'a'.repeat(40), after: 'b'.repeat(40) },
      inventory: { state: 'complete', files: [expect.objectContaining({ path: 'first.ts' }), expect.objectContaining({ path: 'second.ts' })] },
    } });
    expect(invokeContributedAction).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: { pluginId: 'acme.source', localId: 'changed-files' },
      input: { instance: { selected: 'account-one' }, routingToken: 'source-token', limit: 7, comparison: true },
      requiredDangerLevel: 'safe',
    }));
    expect(invokeContributedAction).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: { pluginId: 'acme.source', localId: 'changed-files' },
      input: { instance: { selected: 'account-one' }, routingToken: 'source-token', limit: 7, comparison: true,
        continuation: 'source-page-two' }, requiredDangerLevel: 'safe',
    }));
  }));

  it('refuses selected-session evidence outside the machine filesystem policy before capture or admission', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-summary-permission-' });
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) } };
    serveSessionRecord({ id: 'session-1', active: true, path: fixture.rootPath, local: true });
    const executeCanonicalAction = vi.fn(async () => ({ ok: true as const, result: { runId: 'denied-run', callId: 'call', sidechainId: 'sidechain' } }));
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
      scmFilesystemAccessPolicy: { kind: 'restrictedRoots', roots: [join(fixture.rootPath, 'other-workspace')] },
    });
    try {
      await expect(deps.scmActionExecute?.({ actionId: 'scm.diffSummary.generate',
        input: { cwd: fixture.rootPath, source: { kind: 'workingTree' }, modelSelector: { backendTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }) } },
        context: { defaultSessionId: 'session-1' }, executeCanonicalAction,
      })).resolves.toMatchObject({ ok: false, errorCode: 'scm_action_path_denied' });
      expect(executeCanonicalAction).not.toHaveBeenCalled();
    } finally { await rm(fixture.rootPath, { recursive: true, force: true }); }
  });

  const sessionRun = {
    runId: 'run-1',
    callId: 'call-1',
    sidechainId: 'call-1',
    intent: 'task',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    permissionMode: 'read_only',
    retentionPolicy: 'ephemeral',
    runClass: 'bounded',
    ioMode: 'request_response',
    status: 'running',
    startedAtMs: 1,
  } satisfies PluginActionResultById['execution.run.get']['run'];
  const executionRunBackendTarget = readBackendTargetRefV2(sessionRun.backendTarget);

  const executionRunSuccessCases = [
    createExecutionRunSuccessCase('execution.run.list', { backendTarget: executionRunBackendTarget }, { runs: [] }, { runs: [] }),
    createExecutionRunSuccessCase('execution.run.get', { runId: 'run-1' }, { run: sessionRun }, { run: sessionRun }),
    createExecutionRunSuccessCase('execution.run.stop', { runId: 'run-1' }, { ok: true }, { ok: true }),
    createExecutionRunSuccessCase(
      'execution.run.action',
      { runId: 'run-1', actionId: 'task.commit', input: { summary: true } },
      { ok: true, updatedToolResult: 'done' },
      { ok: true, updatedToolResult: 'done' },
    ),
  ];

  it.each(executionRunSuccessCases)('unwraps the Session service result for $actionId', async ({
    rpcResponse,
    expected,
    invoke,
  }) => {
    callSessionRpc.mockResolvedValueOnce(rpcResponse);
    const { service } = createExecutionRunActionsService();

    await expect(invoke(service)).resolves.toEqual(expected);
  });

  const executionRunFailureCases = [
    createExecutionRunAction('execution.run.list', { backendTarget: executionRunBackendTarget }),
    createExecutionRunAction('execution.run.get', { runId: 'run-1' }),
    createExecutionRunAction('execution.run.stop', { runId: 'run-1' }),
    createExecutionRunAction('execution.run.action', { runId: 'run-1', actionId: 'task.commit', input: {} }),
  ];

  it.each(executionRunFailureCases)('projects a Session service failure for $actionId as an outer Action failure', async ({ invoke }) => {
    callSessionRpc.mockResolvedValueOnce({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Execution runs disabled',
    });
    const { service } = createExecutionRunActionsService();

    await expect(invoke(service)).rejects.toMatchObject({
      code: 'execution_run_not_allowed',
      message: 'Execution runs disabled',
    });
  });

  describe.each(['installed', 'public'] as const)('detached %s transport', (transport) => {
    it('routes detached execution.run.send through V2 preflight to the exact Session-origin machine', async () => {
      const { service, directInvoke } = createExecutionRunActionsService(transport);
      serveSessionRecord({ id: 'session-1', active: true, machineId: 'machine-1' });
      const rpc = transport === 'installed' ? directInvoke : callMachineRpc;
      rpc
        .mockResolvedValueOnce(runProtocolDescribeResponse({ version: 2, features: { detachedScope: true } }))
        .mockResolvedValueOnce({ ok: true });

      await expect(service.execute('execution.run.send', {
        sessionId: null,
        runId: 'run-1',
        message: 'Continue',
      })).resolves.toEqual({ ok: true });

      const requests = transport === 'installed'
        ? directInvoke.mock.calls.map(([method, request]) => ({ machineId: 'machine-1', method, request }))
        : callMachineRpc.mock.calls.map(([request]) => ({
            machineId: request.machineId,
            method: request.method,
            request: request.request,
          }));
      expect(requests).toEqual([
        {
          machineId: 'machine-1',
          method: RPC_METHODS.CAPABILITIES_DESCRIBE,
          request: {},
        },
        {
          machineId: 'machine-1',
          method: SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
          request: {
            sessionId: null,
            runId: 'run-1',
            message: 'Continue',
            delivery: 'steer_if_supported',
          },
        },
      ]);
      if (transport === 'installed') {
        expect(directInvoke.mock.calls[1]?.[2]).toMatchObject({
          signal: expect.any(AbortSignal),
          localActionContext: { authority: 'account_automation', callerPermissionMode: 'default',
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } },
        });
        expect(callMachineRpc).not.toHaveBeenCalled();
      } else {
        expect(callMachineRpc.mock.calls[1]?.[0]).toMatchObject({ timeoutMs: null });
        expect(directInvoke).not.toHaveBeenCalled();
      }
      expect(callSessionRpc).not.toHaveBeenCalled();
    });

    it('keeps detached stream cancellation under execution-run lifecycle ownership', async () => {
      const { service, directInvoke } = createExecutionRunActionsService(transport);
      serveSessionRecord({ id: 'session-1', active: true, machineId: 'machine-1' });
      const rpc = transport === 'installed' ? directInvoke : callMachineRpc;
      rpc
        .mockResolvedValueOnce(runProtocolDescribeResponse({ version: 2, features: { detachedScope: true } }))
        .mockResolvedValueOnce({ ok: true });

      await expect(service.execute('execution.run.stream.cancel', {
        sessionId: null,
        runId: 'run-1',
        streamId: 'stream-1',
      })).resolves.toEqual({ ok: true });

      if (transport === 'installed') {
        expect(directInvoke.mock.calls[1]).toEqual([
          SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
          { runId: 'run-1', streamId: 'stream-1' },
          expect.objectContaining({ signal: expect.any(AbortSignal), localActionContext: expect.objectContaining({
            surface: 'agent', authority: 'account_automation', callerPermissionMode: 'default',
          }) }),
        ]);
        expect(callMachineRpc).not.toHaveBeenCalled();
      } else {
        expect(callMachineRpc.mock.calls[1]?.[0]).toMatchObject({
          machineId: 'machine-1',
          method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
          request: { runId: 'run-1', streamId: 'stream-1' },
          timeoutMs: null,
        });
        expect(directInvoke).not.toHaveBeenCalled();
      }
      expect(callSessionRpc).not.toHaveBeenCalled();
    });

    it('keeps detached stop under execution-run lifecycle ownership', async () => {
      const { service, directInvoke } = createExecutionRunActionsService(transport);
      serveSessionRecord({ id: 'session-1', active: true, machineId: 'machine-1' });
      const rpc = transport === 'installed' ? directInvoke : callMachineRpc;
      rpc
        .mockResolvedValueOnce(runProtocolDescribeResponse({ version: 2, features: { detachedScope: true } }))
        .mockResolvedValueOnce({ ok: true });

      await expect(service.execute('execution.run.stop', {
        sessionId: null,
        runId: 'run-1',
      })).resolves.toEqual({ ok: true });

      if (transport === 'installed') {
        expect(directInvoke.mock.calls[1]).toEqual([
          SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
          { runId: 'run-1' },
          expect.objectContaining({ signal: expect.any(AbortSignal), localActionContext: expect.objectContaining({
            surface: 'agent', authority: 'account_automation', callerPermissionMode: 'default',
          }) }),
        ]);
        expect(callMachineRpc).not.toHaveBeenCalled();
      } else {
        expect(callMachineRpc.mock.calls[1]?.[0]).toMatchObject({
          machineId: 'machine-1',
          method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
          request: { runId: 'run-1' },
          timeoutMs: null,
        });
        expect(directInvoke).not.toHaveBeenCalled();
      }
      expect(callSessionRpc).not.toHaveBeenCalled();
    });

    it('projects a detached execution.run.send failure returned by the exact machine', async () => {
      const { service, directInvoke } = createExecutionRunActionsService(transport);
      serveSessionRecord({ id: 'session-1', active: true, machineId: 'machine-1' });
      const rpc = transport === 'installed' ? directInvoke : callMachineRpc;
      rpc
        .mockResolvedValueOnce(runProtocolDescribeResponse({ version: 2, features: { detachedScope: true } }))
        .mockResolvedValueOnce({
          ok: false,
          errorCode: 'execution_run_not_allowed',
          error: 'Execution runs disabled',
        });

      await expect(service.execute('execution.run.send', {
        sessionId: null,
        runId: 'run-1',
        message: 'Continue',
      })).rejects.toMatchObject({
        code: 'execution_run_not_allowed',
        message: 'Execution runs disabled',
      });

      const methods = transport === 'installed'
        ? directInvoke.mock.calls.map(([method]) => method)
        : callMachineRpc.mock.calls.map(([request]) => request.method);
      expect(methods).toEqual([
        RPC_METHODS.CAPABILITIES_DESCRIBE,
        SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
      ]);
      expect(callSessionRpc).not.toHaveBeenCalled();
    });

    it.each([
      ['notSent', 'execution_run_target_unavailable'],
      ['outcomeUnknown', 'execution_run_send_outcome_unknown'],
    ] as const)('classifies a detached send transport failure with %s disposition', async (disposition, errorCode) => {
      const sendError = new Error(`send ${disposition}`);
      const { service, directInvoke } = createExecutionRunActionsService(transport);
      serveSessionRecord({ id: 'session-1', active: true, machineId: 'machine-1' });
      const rpc = transport === 'installed' ? directInvoke : callMachineRpc;
      rpc
        .mockResolvedValueOnce(runProtocolDescribeResponse({ version: 2, features: { detachedScope: true } }))
        .mockRejectedValueOnce(sendError);
      readMachineRpcRequestDisposition.mockImplementation((error) => (
        error === sendError ? disposition : null
      ));

      await expect(service.execute('execution.run.send', {
        sessionId: null,
        runId: 'run-1',
        message: 'Continue',
      })).rejects.toMatchObject({ code: errorCode });
      // The notSent code also describes a pre-dispatch refusal, so prove this
      // fixture actually reached the transport whose disposition it classifies.
      expect(rpc).toHaveBeenCalledTimes(2);
    });
  });

  it('forwards plugin cancellation to the pending execution-run dependency and rejects late settlement', async () => {
    const caller = new AbortController();
    let gotSignal = false;
    let settleDependency!: (value: unknown) => void;
    callSessionRpc.mockImplementationOnce(({ signal }: Readonly<{ signal?: AbortSignal }>) =>
      new Promise((resolve, reject) => {
        settleDependency = resolve;
        signal?.addEventListener('abort', () => {
          gotSignal = true;
          reject(signal.reason ?? new Error('aborted'));
        }, { once: true });
      }));

    const { service } = createExecutionRunActionsService();
    let settled = false;
    let published = false;
    const invocation = service.execute('execution.run.ensure', {
      runId: 'run-1',
    }, { signal: caller.signal }).then(
      () => {
        settled = true;
        published = true;
        return { code: null };
      },
      (error: unknown) => {
        settled = true;
        return {
          code: error && typeof error === 'object' && 'code' in error
            ? (error as { code?: unknown }).code
            : null,
        };
      },
    );

    await vi.waitFor(() => expect(callSessionRpc).toHaveBeenCalledTimes(1));
    caller.abort();
    const abortObservation = await Promise.race([
      invocation.then(() => ({ settled, gotSignal })),
      new Promise<Readonly<{ settled: boolean; gotSignal: boolean }>>((resolve) => {
        setTimeout(() => resolve({ settled, gotSignal }), 0);
      }),
    ]);

    settleDependency({ ok: true });
    const result = await invocation;

    expect(abortObservation).toEqual({ settled: true, gotSignal: true });
    expect(result).toEqual({ code: 'plugin_action_aborted' });
    expect(published).toBe(false);
  });

  it('fails closed before transport when the CLI action owner has no authenticated credentials', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
    });
    const service = createPluginInvocationActionsService({
      seed: {
        plugin: { id: 'acme.execution', version: '1.0.0' },
        resolveCurrentPluginMaterializationRef:
          executionMaterialization.resolveCurrentPluginMaterializationRef,
        occurrenceId: 'generation-1',
        surface: 'agent',
        session: { id: 'session-1' },
        readActiveTurnAdmissionWitness: () => ({
          inputId: 'execution-run-test-input',
          turnId: 'execution-run-test-turn',
          userMessageSeq: 1,
          userMessageSeqs: [1],
          causalPermissionAuthority: {
            kind: 'admittedSessionInputV1' as const,
            admittedPermissionCeiling: 'default' as const,
          },
        }),
        signal: new AbortController().signal,
        isOccurrenceCurrent: () => true,
      },
      actionExecutor: createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"execution.run.ensure": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
        ...deps,
        isActionEnabled: () => true,

      }),
      invokeContributedAction: vi.fn(),
    });

    await expect(service.execute('execution.run.ensure', {
      runId: 'run-1',
    })).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('preflights an attached immediate secret overlay against the exact Session machine before start dispatch', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    serveSessionRecord({ id: 'session-1', active: true, machineId: 'machine-1' });
    callMachineRpc.mockResolvedValueOnce(runProtocolDescribeResponse({ version: 2, features: {
              detachedScope: true,
              startAndWait: true,
              secretReferenceOverlay: false,
            } }));
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
    });
    const executionRunStart = vi.fn(async () => ({
      runId: 'run-1',
      callId: 'call-1',
      sidechainId: 'call-1',
    }));
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"execution.run.start": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
      ...deps,
      executionRunStart,
      isActionEnabled: () => true,

    });

    await expect(executor.execute('execution.run.start', {
      sessionId: 'session-1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Summarize the change.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      secretReferenceOverlay: {
        v: 1,
        bindings: {
          API_KEY: { ref: 'happier:shared-secret:v1:resource-1', revision: 2 },
        },
      },
    }, { surface: 'rpc', defaultSessionId: 'session-1' })).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_protocol_unsupported',
      error: 'execution_run_protocol_unsupported',
      details: {
        executionRunStart: { v: 1, runCreation: 'noRunCreated' },
        updateRequired: {
          kind: 'update_required',
          operation: 'execution.run.start',
          component: 'daemon',
          reason: 'execution_run_secret_reference_overlay_update_required',
        },
      },
    });

    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ token: 'token' }),
      machineId: 'machine-1',
      method: RPC_METHODS.CAPABILITIES_DESCRIBE,
      request: {},
    }));
    expect(executionRunStart).not.toHaveBeenCalled();
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('starts no attached Team-bound run when the Session moves after exact-machine capability admission', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const rawSession = { id: 'session-1', active: true, machineId: 'machine-capable' };
    serveSessionRecord(rawSession);
    callMachineRpc.mockImplementationOnce(async () => {
      rawSession.machineId = 'machine-replaced';
      return runProtocolDescribeResponse({ version: 2, features: {
                detachedScope: true,
                startAndWait: true,
                exactInputResults: true,
                runScopedAgentBindings: true,
                secretReferenceOverlay: true,
              } });
    });
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
    });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"execution.run.start": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
      ...deps,
      isActionEnabled: () => true,

    });
    const agentTargetKey = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' });
    const teamCredentialModel = {
      kind: 'team_credential_provider_model' as const,
      resourceId: 'resource-1',
      teamId: 'team-1',
      expectedResourceRevision: 4,
      deliveryMode: 'brokered' as const,
      agentTargetKey,
      modelId: 'team-model',
    };

    await expect(executor.execute('execution.run.start', {
      sessionId: 'session-1',
      intent: 'delegate',
      backendTarget: readBackendTargetRefV2(agentTargetKey),
      instructions: 'Summarize the change.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      modelId: teamCredentialModel.modelId,
      teamCredentialModel,
      teamCredentialSessionBindingConsent: {
        v: 1,
        sessionId: 'session-1',
        teamId: teamCredentialModel.teamId,
        resourceId: teamCredentialModel.resourceId,
        expectedResourceRevision: teamCredentialModel.expectedResourceRevision,
      },
    }, { surface: 'rpc', defaultSessionId: 'session-1' })).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_target_unavailable',
      error: 'execution_run_target_unavailable',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });

    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-capable',
      method: RPC_METHODS.CAPABILITIES_DESCRIBE,
    }));
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it.each(['account', 'session'] as const)('reports certain no-Run when the fresh %s lookup fails after capability admission', async (boundary) => {
    const credentials = { token: 'token', encryption: null };
    serveSessionRecord({ id: 'session-1', active: true, machineId: 'machine-1' });
    callMachineRpc.mockImplementationOnce(async () => {
      if (boundary === 'session') fetchSessionById.mockRejectedValueOnce(new Error('HTTP 500'));
      else vi.mocked(axios.get).mockRejectedValueOnce(new Error('HTTP 500'));
      return runProtocolDescribeResponse({ version: 2, features: { detachedScope: true, startAndWait: true, secretReferenceOverlay: true } });
    });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"execution.run.start": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
      ...createCliActionDeps({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null }),
      isActionEnabled: () => true,
    });
    const result = await executor.execute('execution.run.start', {
      sessionId: 'session-1', intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Summarize the change.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
      runClass: 'bounded', ioMode: 'request_response',
      secretReferenceOverlay: { v: 1, bindings: { API_KEY: { ref: 'happier:shared-secret:v1:resource-1', revision: 2 } } },
    }, { surface: 'rpc', defaultSessionId: 'session-1' });
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.CAPABILITIES_DESCRIBE }));
    expect(result).toMatchObject({ ok: false, errorCode: 'execution_run_target_unavailable',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } });
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it.each([
    'executionRunStart', 'executionRunCheckProtocolV2', 'executionRunPermissionRespond', 'detachedExecutionRunSend',
    'executionRunList', 'executionRunGet', 'executionRunEnsure', 'executionRunEnsureOrStart',
    'executionRunStreamStart', 'executionRunStreamRead', 'executionRunStreamCancel',
    'executionRunCancelTurn', 'executionRunStop', 'executionRunAction', 'executionRunWait',
  ] as const)('cancels %s while its fresh Session transport is pending, before any RPC', async (operation) => {
    const credentials = { token: 'token', encryption: null };
    const sessionId = 'c111111111111111111111111';
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null });
    const caller = new AbortController();
    let cancelledRead = false;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    fetchSessionById.mockImplementationOnce(({ signal }: Readonly<{ signal?: AbortSignal }>) => new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => { cancelledRead = true; reject(signal.reason); }, { once: true });
      release = () => resolve(createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain' }));
      entered();
    }));
    const invocation = operation === 'executionRunCheckProtocolV2'
      ? deps.executionRunCheckProtocolV2?.(sessionId, { detachedScope: true, startAndWait: false, exactInputResults: false,
        runScopedAgentBindings: false, secretReferenceOverlay: false }, { signal: caller.signal })
      : operation === 'executionRunPermissionRespond'
        ? deps.executionRunPermissionRespond?.({ runId: 'run-1', requestId: 'permission-1', approved: true },
          { surface: 'rpc', defaultSessionId: sessionId, signal: caller.signal })
        : operation === 'detachedExecutionRunSend'
          ? deps.detachedExecutionRunSend(null, { runId: 'run-1', message: 'Next' }, { originSessionId: sessionId, signal: caller.signal })
          : deps[operation]?.(sessionId, { runId: 'run-1', occurrenceId: 'occurrence-1', turnId: 'turn-1' }, { signal: caller.signal });
    if (!invocation) throw new Error('Expected Run adapter');
    const pending = invocation.then(
      value => ({ kind: 'returned' as const, value }), error => ({ kind: 'rejected' as const, error }),
    );
    expect(await Promise.race([ready.then(() => 'reading'), pending])).toBe('reading');
    const reason = new Error('caller cancelled');
    caller.abort(reason);
    try { expect(cancelledRead).toBe(true); } finally { release(); }
    expect(await pending).toEqual(operation === 'executionRunStart'
      ? { kind: 'returned', value: { ok: false, code: 'cancelled',
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } } }
      : { kind: 'rejected', error: reason });
    expect(callSessionRpc).not.toHaveBeenCalled();
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('uses the exact Session machine capability fact and refuses detached dispatch to a V1 daemon', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    serveSessionRecord({ id: 'session-1', active: true, machineId: 'machine-1' });
    callMachineRpc.mockResolvedValue(runProtocolDescribeResponse(null));
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
    });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"execution.run.start": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
      ...deps,
      isActionEnabled: () => true,

    });

    await expect(executor.execute('execution.run.start', {
      sessionId: null,
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Summarize the change.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }, { surface: 'rpc', defaultSessionId: 'session-1' })).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_protocol_unsupported',
      error: 'execution_run_protocol_unsupported',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });

    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ token: 'token' }),
      machineId: 'machine-1',
      method: RPC_METHODS.CAPABILITIES_DESCRIBE,
      request: {},
    }));
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('classifies an unavailable V2 capability method as protocol-unsupported before start dispatch', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    serveSessionRecord({ id: 'session-1', active: true, machineId: 'machine-1' });
    callMachineRpc.mockRejectedValueOnce(createRpcCallError({
      error: 'Capability detection is unavailable',
      errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    }));
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
    });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"execution.run.start": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
      ...deps,
      isActionEnabled: () => true,

    });

    await expect(executor.execute('execution.run.start', {
      sessionId: null,
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Summarize the change.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }, { surface: 'rpc', defaultSessionId: 'session-1' })).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_protocol_unsupported',
      error: 'execution_run_protocol_unsupported',
      details: {
        executionRunStart: { v: 1, runCreation: 'noRunCreated' },
        executionRunPreflight: { phase: 'capabilities.describe', cause: { code: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE } },
      },
    });

    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('classifies a malformed V2 capability fact as protocol-unsupported before start dispatch', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    serveSessionRecord({ id: 'session-1', active: true, machineId: 'machine-1' });
    callMachineRpc.mockResolvedValueOnce(runProtocolDescribeResponse({ version: 1, features: { detachedScope: true } }));
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
    });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"execution.run.start": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
      ...deps,
      isActionEnabled: () => true,

    });

    await expect(executor.execute('execution.run.start', {
      sessionId: null,
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Summarize the change.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }, { surface: 'rpc', defaultSessionId: 'session-1' })).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_protocol_unsupported',
      error: 'execution_run_protocol_unsupported',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });

    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('classifies a failed V2 capability probe as target-unavailable before start dispatch', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    serveSessionRecord({ id: 'session-1', active: true, machineId: 'machine-1' });
    callMachineRpc.mockRejectedValueOnce(new Error('machine offline'));
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
    });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"execution.run.start": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
      ...deps,
      isActionEnabled: () => true,

    });

    await expect(executor.execute('execution.run.start', {
      sessionId: null,
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Summarize the change.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }, { surface: 'rpc', defaultSessionId: 'session-1' })).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_target_unavailable',
      error: 'execution_run_target_unavailable',
      details: {
        executionRunStart: { v: 1, runCreation: 'noRunCreated' },
        executionRunPreflight: { phase: 'capabilities.describe', cause: { code: null } },
      },
    });

    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc.mock.calls[0]?.[0]).toMatchObject({
      machineId: 'machine-1',
      method: RPC_METHODS.CAPABILITIES_DESCRIBE,
    });
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('preserves canonical plugin cancellation when capability detection aborts before start dispatch', async () => {
    const caller = new AbortController();
    let capabilitySignal: AbortSignal | undefined;
    let observeCapabilityAdmission!: () => void;
    const capabilityAdmission = new Promise<void>(resolve => { observeCapabilityAdmission = resolve; });
    const { service } = createExecutionRunActionsService();
    serveSessionRecord({ id: 'session-1', active: true, machineId: 'machine-1' });
    callMachineRpc.mockImplementationOnce(({ signal }: Readonly<{ signal?: AbortSignal }>) =>
      new Promise((_resolve, reject) => {
        capabilitySignal = signal;
        observeCapabilityAdmission();
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      }));

    const invocation = service.execute('execution.run.start', {
      sessionId: null,
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Summarize the change.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }, { signal: caller.signal });

    await Promise.race([capabilityAdmission, invocation]);
    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    caller.abort();

    await expect(invocation).rejects.toMatchObject({ code: 'plugin_action_aborted' });
    expect(capabilitySignal?.aborted).toBe(true);
    expect(callMachineRpc.mock.calls.map(([request]) => request.method)).toEqual([
      RPC_METHODS.CAPABILITIES_DESCRIBE,
    ]);
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('keeps a detached start identity when its CLI waiter catches an AbortError', async () => {
    const caller = new AbortController();
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    callMachineRpc.mockImplementation(async ({ method }: Readonly<{ method: string }>) => {
      if (method === RPC_METHODS.CAPABILITIES_DESCRIBE) {
        return runProtocolDescribeResponse({ version: 2, features: { detachedScope: true, startAndWait: true } });
      }
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_START) {
        return { runId: 'run-detached', callId: 'call-detached', sidechainId: 'call-detached' };
      }
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_WAIT) {
        caller.abort();
        const error = new Error('wait aborted');
        error.name = 'AbortError';
        throw error;
      }
      throw new Error(`Unexpected machine RPC ${method}`);
    });
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
    });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"execution.run.start": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
      ...deps,
      isActionEnabled: () => true,

    });

    await expect(executor.execute('execution.run.start', {
      sessionId: null,
      intent: 'task',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Return a bounded result.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      waitForCompletion: true,
    }, {
      surface: 'rpc',
      defaultSessionId: 'origin-session',
      executionRunTargetMachineId: 'machine-admitted',
      signal: caller.signal,
    })).resolves.toEqual({
      ok: true,
      result: {
        runId: 'run-detached',
        callId: 'call-detached',
        sidechainId: 'call-detached',
        wait: { ok: false, code: 'cancelled' },
      },
    });

    expect(callMachineRpc.mock.calls.map(([request]) => request.method)).toEqual([
      RPC_METHODS.CAPABILITIES_DESCRIBE,
      SESSION_RPC_METHODS.EXECUTION_RUN_START,
      SESSION_RPC_METHODS.EXECUTION_RUN_WAIT,
    ]);
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('uses the host-stamped detached machine for V2 preflight and start instead of the origin Session machine', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    serveSessionRecord({ id: 'origin-session', active: true, machineId: 'machine-origin' });
    callMachineRpc.mockImplementation(async ({ method }: Readonly<{ method: string }>) => {
      if (method === RPC_METHODS.CAPABILITIES_DESCRIBE) {
        return runProtocolDescribeResponse({ version: 2, features: { detachedScope: true, startAndWait: true } });
      }
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_START) {
        return { runId: 'run-detached', callId: 'call-detached', sidechainId: 'call-detached' };
      }
      throw new Error(`Unexpected machine RPC ${method}`);
    });
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
    });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"execution.run.start": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
      ...deps,
      isActionEnabled: () => true,

    });

    await expect(executor.execute('execution.run.start', {
      sessionId: null,
      intent: 'task',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Return a bounded result.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }, {
      surface: 'rpc',
      defaultSessionId: 'origin-session',
      executionRunTargetMachineId: 'machine-admitted',
    })).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(callMachineRpc.mock.calls.map(([request]) => ({
      machineId: request.machineId,
      method: request.method,
    }))).toEqual([
      { machineId: 'machine-admitted', method: RPC_METHODS.CAPABILITIES_DESCRIBE },
      { machineId: 'machine-admitted', method: SESSION_RPC_METHODS.EXECUTION_RUN_START },
    ]);
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['notSent', 'noRunCreated'],
    ['outcomeUnknown', 'outcomeUnknown'],
  ] as const)('projects a %s detached start transport failure as %s', async (disposition, runCreation) => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const startError = new Error(`start ${disposition}`);
    callMachineRpc
      .mockResolvedValueOnce(runProtocolDescribeResponse({ version: 2, features: { detachedScope: true, startAndWait: true } }))
      .mockRejectedValueOnce(startError);
    readMachineRpcRequestDisposition.mockImplementation((error) => (
      error === startError ? disposition : null
    ));
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
    });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"execution.run.start": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
      ...deps,
      isActionEnabled: () => true,

    });

    await expect(executor.execute('execution.run.start', {
      sessionId: null,
      intent: 'task',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Return a bounded result.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    }, {
      surface: 'rpc',
      defaultSessionId: 'origin-session',
      executionRunTargetMachineId: 'machine-admitted',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_target_unavailable',
      error: 'execution_run_target_unavailable',
      details: { executionRunStart: { v: 1, runCreation } },
    });
  });
});

describe('background memory hint Runs', () => {
  // User decision 2026-11-10: a hint never wakes an inactive Session. The real
  // memory hint runner, text-prompt adapter, Action executor and CLI Run deps run
  // here; only Session HTTP, Session RPC and Machine RPC are boundaries.
  it('starts the hint Run in detached scope and reads, resumes or spawns no Session', () => withTempDir('memory-hint-detached-home-', async home => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
    try {
      env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: 'memory-hint-home' });
      reloadConfiguration();
      await updateSettings(settings => ({ ...settings, machineIdByServerId: { 'memory-hint-home': 'machine-local' } }));
      serveSessionRecord({ id: 'inactive-session', active: false, machineId: 'machine-local' });
      fetchSessionById.mockClear();
      callSessionRpc.mockReset();
      callMachineRpc.mockReset().mockImplementation(async ({ method }: Readonly<{ method: string }>) => {
        if (method === RPC_METHODS.CAPABILITIES_DESCRIBE) {
          return runProtocolDescribeResponse({ version: 2, features: { detachedScope: true, startAndWait: true } });
        }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_START) {
          return { runId: 'run-hint', callId: 'call-hint', sidechainId: 'call-hint' };
        }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_WAIT) return { ok: false, code: 'execution_run_wait_unavailable' };
        throw new Error(`Unexpected machine RPC ${method}`);
      });
      const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) } };
      const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null });
      const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"execution.run.start": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...deps, isActionEnabled: () => true });
      const { runMemoryHintsExecutionRun } = await import('@/daemon/memory/hints/runMemoryHintsExecutionRun');
      const { runLlmTaskTextPrompt } = await import('@/agent/executionRuns/tasks/textPromptWithRunnerConfig');

      await runMemoryHintsExecutionRun({
        sessionId: 'inactive-session', prompt: 'Summarize', credentials, sessionAgentTargetKey: null,
        choice: { v: 1, modelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'default' }, permissionMode: 'no_tools' },
        runTextPrompt: request => runLlmTaskTextPrompt({
          ...request, executeStart: (input, context) => executor.execute('execution.run.start', input, context),
        }),
      }).catch(() => undefined);

      const methods = callMachineRpc.mock.calls.map(([request]) => `${request.machineId}:${request.method}`);
      // 0 Session reads ⇒ 0 resume decisions ⇒ 0 runner spawns.
      expect({ sessionReads: fetchSessionById.mock.calls.length, sessionRpcs: callSessionRpc.mock.calls.length })
        .toEqual({ sessionReads: 0, sessionRpcs: 0 });
      expect(methods.filter(method => method.endsWith(`:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`)))
        .toEqual([`machine-local:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`]);
      expect(methods.filter(method => !method.endsWith(`:${RPC_METHODS.CAPABILITIES_DESCRIBE}`)
        && !method.endsWith(`:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`)
        && !method.endsWith(`:${SESSION_RPC_METHODS.EXECUTION_RUN_WAIT}`))).toEqual([]);
    } finally {
      env.restore();
      reloadConfiguration();
    }
  }));
});
