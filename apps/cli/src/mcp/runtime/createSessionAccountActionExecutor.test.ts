import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createSessionAccountActionExecutor } from './createSessionAccountActionExecutor';
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getActionSpec, listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { MANAGED_MACHINE_ACTION_IDS_V1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { configuration } from '@/configuration';
import { NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { hashPrivateBearer } from '@/daemon/privateBearerFile';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { createSessionDaemonAuthorityFixture } from './sessionDaemonAuthority.testkit';
import * as processIdentity from '@/daemon/processIdentity';
import { Response as UndiciResponse } from 'undici';

const daemonHttpBoundary = vi.hoisted(() => vi.fn<typeof import('undici')['fetch']>());
// Daemon control deliberately pairs Undici fetch with its own dispatcher ABI.
// Substitute that external HTTP client, retaining capability and wire parsers.
vi.mock('undici', async importOriginal => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: (...args: Parameters<typeof actual.fetch>) =>
    daemonHttpBoundary.getMockImplementation()?.(...args) ?? actual.fetch(...args) };
});

// OS process inspection is the boundary; the real command-identity parser is retained.
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); daemonHttpBoundary.mockReset(); });

const createRestrictedExecutor = () => createCliActionExecutor({
  token: '', sessionId: 'caller-session', mode: 'plain', ctx: null,
});

describe('Session MCP Account routing', () => {
  it.each([
    'authority_path_absent', 'turn_witness_absent', 'execution_run_turn_mismatch',
    'execution_run_not_current', 'scm_workspace_invalid', 'turn_witness_projection_invalid',
    'runner_authority_refused',
  ] as const)('retains the owner refusal reason %s before daemon execution', async reason => {
    const daemon = await createSessionDaemonAuthorityFixture({ sessionId: 'caller-session',
      execute: async () => { throw new Error('Refused admission must not execute'); } });
    type Witness = NonNullable<ReturnType<NonNullable<HappyMcpSessionClient['getActiveTurnAdmissionWitness']>>>;
    // Ordinary native Muse Queue turns carry this host-produced input shape,
    // rather than the separate realtime-input admission used by Voice.
    const witness: Witness = { turnId: 'host-turn', inputId: 'host-input', userMessageSeq: 1, userMessageSeqs: [1],
      agentStartCaller: { kind: 'session', sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 } };
    if (reason === 'authority_path_absent') vi.stubEnv('HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE', '');
    if (reason === 'runner_authority_refused') vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockResolvedValue(null);
    const executor = createSessionAccountActionExecutor({ base: createRestrictedExecutor(), client: {
      sessionId: 'caller-session', getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://home.test' }),
      rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} }, updateMetadata() {},
      getActiveTurnAdmissionWitness: () => reason === 'turn_witness_absent' ? null
        : reason === 'turn_witness_projection_invalid' ? { ...witness, userMessageSeq: -1 } : witness,
      ...(reason === 'execution_run_turn_mismatch' || reason === 'execution_run_not_current' ? {
        getSessionActionConfirmationBinding: () => ({
          turnId: reason === 'execution_run_turn_mismatch' ? 'other-turn' : witness.turnId,
          lifetimeSignal: new AbortController().signal, isCurrent: () => reason !== 'execution_run_not_current',
          run: { runId: 'child-run', occurrenceId: 'child-occurrence', sidechainId: 'child-sidechain' },
        }),
      } : {}),
    } });
    try {
      const result = await executor.execute(reason === 'scm_workspace_invalid' ? 'scm.diff.file' : 'workflow.definition.edit',
        reason === 'scm_workspace_invalid' ? { path: 'file.ts' }
          : getActionSpec('workflow.definition.edit').inputSchema.parse({
            definitionId: '1113a111-1113-4113-8113-111311131113', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
            ops: [{ kind: 'rename', name: 'Updated recipe' }],
          }), { surface: 'agent' });
      expect(ActionExecuteFailureSchema.parse(result)).toEqual({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
        details: { code: 'target_unavailable', diagnostic: { reason } } });
      expect(daemon.actionRequestCount).toBe(0);
    } finally {
      // Restore the stub before the fixture restores its original environment.
      vi.unstubAllEnvs();
      await daemon.close();
    }
  });

  it('executes a Workflow edit from an admitted ordinary native Queue turn', async () => {
    const outcome = { ok: true as const, result: { status: 'updated' } };
    const daemon = await createSessionDaemonAuthorityFixture({ sessionId: 'caller-session', execute: async operation => {
      expect(operation).toMatchObject({ actionId: 'workflow.definition.edit', witness: {
        turnId: 'host-turn', inputId: 'host-input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
      } });
      return outcome;
    } });
    const executor = createSessionAccountActionExecutor({ base: createRestrictedExecutor(), client: {
      sessionId: 'caller-session', getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://home.test' }),
      rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} }, updateMetadata() {},
      getActiveTurnAdmissionWitness: () => ({ turnId: 'host-turn', inputId: 'host-input', userMessageSeq: 1, userMessageSeqs: [1],
        agentStartCaller: { kind: 'session', sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 } }),
    } });
    try {
      expect(await executor.execute('workflow.definition.edit', getActionSpec('workflow.definition.edit').inputSchema.parse({
        definitionId: '1113a111-1113-4113-8113-111311131113', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
        ops: [{ kind: 'rename', name: 'Updated recipe' }],
      }), { surface: 'agent' })).toEqual(outcome);
      expect(daemon.actionRequestCount).toBe(1);
    } finally { await daemon.close(); }
  });

  it('preserves the daemon requester refusal at the Session MCP Action sink without retrying', async () => {
    const failure = { ok: false as const, error: {
      code: 'native_agent_privileged_effect_authority_unavailable', message: 'Runner authority unavailable',
      cause: { code: 'requester_scope_unavailable', stage: 'runner_authority' as const },
    } };
    const daemon = await createSessionDaemonAuthorityFixture({ sessionId: 'caller-session',
      actionServiceFailure: failure,
      execute: async () => { throw new Error('The refused service cannot execute an Action'); },
    });
    const executor = createSessionAccountActionExecutor({ base: createRestrictedExecutor(), client: {
      sessionId: 'caller-session', getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://home.test' }),
      rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} }, updateMetadata() {},
      getActiveTurnAdmissionWitness: () => ({ turnId: 'host-turn', inputId: 'host-input', userMessageSeq: 1, userMessageSeqs: [1],
        agentStartCaller: { kind: 'session', sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 } }),
    } });
    try {
      expect(await executor.execute('session.spawn_new', {
        creationKey: 'requester-refusal', executionTarget: { serverId: 'home', machineId: 'shared-machine' },
        directory: { kind: 'path', path: '/workspace' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      }, { surface: 'mcp' })).toEqual({ ok: false, errorCode: failure.error.code,
        error: failure.error.message, details: failure.error.cause });
      expect(daemon.actionRequestCount).toBe(1);
    } finally { await daemon.close(); }
  });

  it.each([
    { actionId: 'machines.setup.adminAccess.set', input: { serverId: 'home', machineId: 'target-machine',
      expectedMetadataVersion: 1, expectedAdminAccess: { version: 1, mode: 'none' }, adminAccess: { version: 1, mode: 'preauthorized' }, comparison: 'field' },
      outcome: { status: 'applied', policy: { version: 1, mode: 'preauthorized' }, metadataVersion: 2 } },
    { actionId: 'machines.setup.adminAccess.inspect', input: { serverId: 'home', machineId: 'target-machine' },
      outcome: { status: 'unavailable' } },
  ] as const)('forwards $actionId through credentialed daemon authority from a restricted runner', async action => {
    const daemon = await createSessionDaemonAuthorityFixture({ sessionId: 'caller-session', execute: async operation => {
      expect(operation).toMatchObject({ actionId: action.actionId, input: action.input, surface: 'mcp', requestId: 'admin-operation' });
      return { ok: true, result: action.outcome };
    } });
    const executor = createSessionAccountActionExecutor({ base: createRestrictedExecutor(), client: {
      sessionId: 'caller-session', getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://home.test' }),
      rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} }, updateMetadata() {},
      getActiveTurnAdmissionWitness: () => ({ turnId: 'host-turn', inputId: 'host-input', userMessageSeq: 1, userMessageSeqs: [1],
        agentStartCaller: { kind: 'session', sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 } }),
    } });
    try {
      expect(await executor.execute(action.actionId, action.input, { surface: 'mcp', actionRequestId: 'admin-operation' }))
        .toEqual({ ok: true, result: action.outcome });
    } finally { await daemon.close(); }
  });

  it('settles a daemon-bound Action as cancelled when its exact host native admission ends', async () => {
    const executor = createSessionAccountActionExecutor({ base: createRestrictedExecutor(), client: {
      sessionId: 'caller-session', getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://home.test' }),
      rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} }, updateMetadata() {},
      getActiveTurnAdmissionWitness: () => ({ turnId: 'speech-turn', inputId: 'person-start', userMessageSeq: null, userMessageSeqs: [],
        nativeRealtimeAdmission: { admissionId: 'person-start', occurrenceId: 'provider-occurrence', attemptId: 'live-attempt' },
        signal: AbortSignal.abort(), agentStartCaller: { kind: 'session', sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 } }),
    } });
    expect(await executor.execute('notifications.notify_me', { message: 'After End' }, { surface: 'agent' }))
      .toMatchObject({ ok: false, errorCode: 'cancelled' });
  });

  it('cancels an in-flight daemon HTTP Action when its exact host native admission ends', async () => {
    const lifetime = new AbortController();
    let release!: () => void;
    let didDispatch!: () => void;
    const pendingEffect = new Promise<void>(resolve => { release = resolve; });
    const dispatched = new Promise<void>(resolve => { didDispatch = resolve; });
    const daemon = await createSessionDaemonAuthorityFixture({ sessionId: 'caller-session', execute: async () => {
      didDispatch();
      await pendingEffect;
      return { ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } };
    } });
    const executor = createSessionAccountActionExecutor({ base: createRestrictedExecutor(), client: {
      sessionId: 'caller-session', getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://home.test' }),
      rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} }, updateMetadata() {},
      getActiveTurnAdmissionWitness: () => ({ turnId: 'speech-turn', inputId: 'person-start', userMessageSeq: null, userMessageSeqs: [],
        nativeRealtimeAdmission: { admissionId: 'person-start', occurrenceId: 'provider-occurrence', attemptId: 'live-attempt' },
        signal: lifetime.signal, agentStartCaller: { kind: 'session', sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 } }),
    } });
    try {
      const pending = executor.execute('notifications.notify_me', { message: 'During native input' }, { surface: 'agent' });
      await dispatched;
      lifetime.abort();
      expect(await pending).toMatchObject({ ok: false, errorCode: 'cancelled' });
    } finally { release(); await daemon.close(); }
  });

  it('does not turn an implicit Session workspace into Machine-wide saved inventory authority', async () => {
    const executor = createSessionAccountActionExecutor({ base: createRestrictedExecutor(), client: {
      sessionId: 'caller-session', getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://home.test' }),
      rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} }, updateMetadata() {},
    } });
    expect(await executor.execute('scm.diffSummary.result.list', {}, { surface: 'agent', defaultSessionId: 'caller-session' }))
      .toMatchObject({ ok: false, errorCode: 'machine_not_selected' });
  });
  it('refuses unavailable daemon authority instead of executing with the session bearer', async () => {
    vi.stubEnv('HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE', '');
    const executor = createSessionAccountActionExecutor({
      base: createRestrictedExecutor(),
      client: {
        sessionId: 'caller-session',
        getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://home.test' }),
        rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} },
        updateMetadata() {},
      },
    });
    const result = await executor.execute('notifications.notify_me', { message: 'Notify' }, { surface: 'agent' });
    expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
  });

  it.each([
    ...listActionSpecs().filter(spec => spec.executionPlacement === 'machine'
      && (spec.id.startsWith('projects.') || spec.id.startsWith('action.operations.')
        || spec.id.startsWith('localServices.')
        || MANAGED_MACHINE_ACTION_IDS_V1.some(id => id === spec.id))).map(spec => ({
        actionId: spec.id, input: JSON.parse(spec.examples?.mcp?.argsExample ?? spec.examples?.voice?.argsExample ?? '{}'), uncertain: false,
      })),
    { actionId: 'notifications.notify_me' as const, input: { message: 'Notify' }, uncertain: false },
    { actionId: 'notifications.notify_me' as const, input: { message: 'Notify' }, uncertain: true },
    { actionId: 'connectedServices.authentication.beginConnect' as const,
      input: { service: { pluginId: 'acme.portable-auth', localId: 'example' }, modeId: 'manual' }, uncertain: false },
    { actionId: 'connectedServices.authentication.submitManual' as const,
      input: { attemptId: 'attempt-1', fields: { token: 'fixture-token' } }, uncertain: false },
    { actionId: 'session.list' as const, input: {}, uncertain: false },
    { actionId: 'machines.resources.policy.set' as const, input: { machineId: 'shared-machine', expectedRevision: 1,
      patch: { processes: { allProcessesVisible: true } } }, uncertain: false },
    { actionId: 'agents.backends.list' as const, input: { includeDisabled: false }, uncertain: false },
    { actionId: 'agents.models.list' as const, input: { backendTargetKey: 'agent:acme.discovery/assistant', machineId: 'shared-machine' }, uncertain: false },
    { actionId: 'agents.config_options.list' as const, input: { backendTargetKey: 'agent:acme.discovery/assistant', machineId: 'shared-machine', modelId: 'small' }, uncertain: false },
    { actionId: 'agents.session_modes.list' as const, input: { backendTargetKey: 'agent:acme.discovery/assistant', machineId: 'shared-machine' }, uncertain: false },
    { actionId: 'action.options.resolve' as const, input: { actionId: 'execution.run.start', fieldPath: 'configOptions',
      draftInput: { backendTargetKey: 'agent:acme.discovery/assistant', machineId: 'shared-machine', modelId: 'small' } }, uncertain: false },
    { actionId: 'session.activity.get' as const, input: { sessionId: 'caller-session' }, uncertain: false },
    { actionId: 'session.goal.get' as const, input: { sessionId: { selector: 'workers' } }, uncertain: false },
    { actionId: 'session.goal.clear' as const, input: { sessionId: { selector: 'self', of: 'led-child' } }, uncertain: false },
    { actionId: 'scm.diff.file' as const, input: { cwd: '/run/workspace', path: 'file.ts' }, uncertain: false },
    { actionId: 'scm.file.read' as const, input: { cwd: '/run/workspace', path: 'file.ts', selector: { side: 'before', area: 'pending' } }, uncertain: false },
    { actionId: 'scm.blame.get' as const, input: { cwd: '/run/workspace', path: 'file.ts' }, uncertain: false },
    { actionId: 'session.transcript.get' as const, input: { sessionId: 'caller-session', limit: 10 }, uncertain: false },
    { actionId: 'session.notes.set' as const, input: { sessionId: 'led-child', notes: 'Delegated notes' }, uncertain: false },
    ...(['none', 'wait', 'return'] as const).map(reply => ({
      actionId: 'session.message.send' as const,
      input: { sessionId: 'led-child', message: 'Report your findings', reply }, uncertain: false,
    })),
    { actionId: 'session.roles.apply_to_reports' as const, input: { sessionId: 'caller-session' }, uncertain: false },
    { actionId: 'session.spawn_new' as const, input: {
      executionTarget: { serverId: 'home', machineId: 'shared-machine' },
      directory: { kind: 'path', path: '/workspace' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    }, uncertain: false },
    { actionId: 'workflow.run.start' as const, input: {
      runId: '11111111-1111-4111-8111-111111111111',
      source: { kind: 'inline', definition: { version: 1, blocks: ['Work'] } },
    }, uncertain: false },
    { actionId: 'plugins.install' as const, input: {
      path: '/workspace/plugin', machineId: 'shared-machine', dev: true,
    }, uncertain: false },
    { actionId: 'plugins.enable' as const, input: { pluginId: 'acme.lifecycle', machineId: 'shared-machine' }, uncertain: false },
    { actionId: 'plugins.disable' as const, input: { pluginId: 'acme.lifecycle', machineId: 'shared-machine' }, uncertain: false },
    { actionId: 'plugins.uninstall' as const, input: { pluginId: 'acme.lifecycle', machineId: 'shared-machine' }, uncertain: false },
    { actionId: 'plugins.rollback' as const, input: { pluginId: 'acme.lifecycle', machineId: 'shared-machine' }, uncertain: false },
    { actionId: 'plugins.trust.forget' as const, input: { pluginId: 'acme.lifecycle', machineId: 'shared-machine' }, uncertain: false },
    { actionId: 'plugins.update_policy.set' as const, input: { pluginId: 'acme.lifecycle', machineId: 'shared-machine', policy: 'pinned' }, uncertain: false },
    { actionId: 'ui.find' as const, input: { op: 'read' }, uncertain: false },
    { actionId: 'session.pending.next' as const, input: {}, uncertain: false },
    { actionId: 'workspace.tabs.list' as const, input: {}, uncertain: false },
  ])('routes $actionId with only the host admission witness and its Session capability (uncertain: $uncertain)', async ({ actionId, input, uncertain }) => {
    const command = 'node /runtime/.runner-snapshots/session-account/dist/index.mjs';
    const runner = { pid: process.pid, processStartTimeMs: 23_346,
      processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:session-account' };
    vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockResolvedValue({ pid: process.pid, processStartTimeMs: runner.processStartTimeMs, command });
    const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
    const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
      path, sessionId: 'caller-session', runner,
      retainedAgent: createAgentSessionRunnerFactoryBinding({
        v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
        sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
        locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
        normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js',
      }),
    };
    await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31_001, capability: 'A'.repeat(43) });
    vi.stubEnv('HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE', path);
    const witness = { turnId: 'host-turn', inputId: 'host-input', userMessageSeq: 1, userMessageSeqs: [1],
      agentStartCaller: { kind: 'session' as const, sessionId: 'caller-session', starterDepth: 2, turnDepth: 6 },
      callerPermissionMode: 'yolo' as const,
      causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const } };
    const requests: unknown[] = [];
    daemonHttpBoundary.mockImplementation(async (_url, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      requests.push(body);
      if (uncertain) return new UndiciResponse(JSON.stringify({ ok: false, error: {
        code: NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE, message: 'Connection lost after dispatch',
      } }), { status: 200 });
      return new UndiciResponse(JSON.stringify({ ok: true, result: { kind: 'action.execution', requestId: 'request-1',
        outcome: { ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } } } }), { status: 200 });
    });
    try {
      const executor = createSessionAccountActionExecutor({ base: createRestrictedExecutor(),
        // Account credentials alone select neither a local Account effect owner
        // nor another Session's input transport. Both retain daemon admission.
        hasAccountAuthority: actionId === 'session.message.send' || actionId === 'notifications.notify_me', client: {
        sessionId: 'caller-session', getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://home.test' }),
        ...(actionId === 'session.message.send' ? { getMachineAdmissionTransport: () => async () => {
          throw new Error('Cross-Session input cannot use the bound runner transport');
        } } : {}),
        rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} }, updateMetadata() {},
        getCurrentSessionLocation: () => ({ machineId: 'shared-machine', path: '/run/workspace' }),
        getActiveTurnAdmissionWitness: () => witness,
        ...(actionId === 'session.list' ? { getSessionActionConfirmationBinding: () => ({ turnId: witness.turnId,
          lifetimeSignal: new AbortController().signal, isCurrent: () => true,
          run: { runId: 'child-run', occurrenceId: 'child-occurrence', sidechainId: 'child-sidechain' } }) } : {}),
      } });
      const result = await executor.execute(actionId, input, {
        surface: 'cli', defaultSessionId: 'forged-session', actionRequestId: 'request-1',
        approvalOrigin: { kind: 'transcript_tool_call', sessionId: 'forged-session', toolCallId: 'tool-1', toolName: 'action_execute' },
      });
      // Admission must reach the authenticated source-daemon boundary rather
      // than trying the runner's own-Session input transport.
      expect(requests).toHaveLength(1);
      expect(result).toEqual(uncertain
        ? { ok: false, errorCode: 'outcome_uncertain', error: 'outcome_uncertain' }
        : { ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
      expect(requests[0]).toEqual({ v: 1, context: { token: 'A'.repeat(43), sessionId: 'caller-session' },
        operation: { kind: 'action.execute', surface: 'agent', requestId: 'request-1', actionId,
          ...(actionId.startsWith('scm.') ? { scmWorkspace: { machineId: 'shared-machine', directory: '/run/workspace' } } : {}),
          ...(actionId === 'session.list' ? { executionRun: { runId: 'child-run', occurrenceId: 'child-occurrence' } } : {}),
          input, witness: { ...witness, workDepth: 6 }, toolCallId: 'tool-1' } });
      expect(requests).toHaveLength(1);
    } finally { await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority, capabilityDigest: hashPrivateBearer('A'.repeat(43)) }); }
  });
});
