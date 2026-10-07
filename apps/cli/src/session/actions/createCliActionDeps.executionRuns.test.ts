import { buildBackendTargetKeyV2, createActionExecutor, readBackendTargetRefV2, ScmComparisonCaptureInputSchema, ScmComparisonCaptureOutputSchema, ScmDiffSummaryGenerateInputSchema, type ActionExecutorDeps } from '@happier-dev/protocol';
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
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLocalScmRepositoryFixture } from '@/scm/contracts/scmBackendContractFixtures';

const {
  callMachineRpc,
  callSessionRpc,
  readMachineRpcRequestDisposition,
  resolveSessionTransportContext,
} = vi.hoisted(() => ({
  callMachineRpc: vi.fn(),
  callSessionRpc: vi.fn(),
  readMachineRpcRequestDisposition: vi.fn(),
  resolveSessionTransportContext: vi.fn(),
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc,
}));

vi.mock('@/session/transport/rpc/machineRpc', () => ({
  callMachineRpc,
  callExactMachineRpc: callMachineRpc,
  readMachineRpcRequestDisposition,
}));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));

import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { createPluginActionCallerMaterializationFixture } from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import { createCliActionDeps } from './createCliActionDeps';

const executionMaterialization = createPluginActionCallerMaterializationFixture('acme.execution');

describe('detached exact Run output observation transport', () => {
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
    vi.useFakeTimers();
    try {
      const waiting = deps.executionRunWait(null, { runId: 'run-watch', timeoutSeconds: 1 },
        { exactMachineId: 'machine-1', workDepth: 3, onSnapshot: async () => blocked });
      let completed: unknown;
      void waiting.then(result => { completed = result; });
      await vi.advanceTimersByTimeAsync(1000);
      expect(completed).toMatchObject({ ok: false, code: 'observation_timeout' });
      release();
      await waiting;
    } finally { release(); vi.useRealTimers(); }
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
    resolveSessionTransportContext.mockResolvedValue({ ok: true, sessionId: 'session-1',
      rawSession: { id: 'session-1', active: true }, mode: 'plain', ctx: null });
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

function createExecutionRunActionsService() {
  const credentials = {
    token: 'token',
    encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
  };
  resolveSessionTransportContext.mockResolvedValue({
    ok: true,
    sessionId: 'session-1',
    rawSession: { id: 'session-1', active: true },
    accountEncryptionCurrentness: { mode: 'plain' },
    mode: 'plain',
    ctx: null,
  });
  const deps = createCliActionDeps({
    token: credentials.token,
    credentials,
    sessionId: 'plugin-global',
    mode: 'plain',
    ctx: null,
  });
  const actionExecutor = createActionExecutor({
    ...deps,
    isActionEnabled: () => true,
    isActionApprovalRequired: () => false,
  });
  const retirement = new AbortController();
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
      signal: retirement.signal,
      isOccurrenceCurrent: () => !retirement.signal.aborted,
    },
    actionExecutor,
    invokeContributedAction: vi.fn(),
  });
  return { service, retirement };
}

describe('createCliActionDeps execution-run plugin bindings', () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  });
  it('does not send an admitted write ceiling through a public machine request', async () => {
    const credentials = { token: 'token', encryption: null };
    const deps = createCliActionDeps({ token: 'token', credentials, sessionId: 'cli-global', mode: 'plain', ctx: null });
    const result = await deps.executionRunStart(null, { instructions: 'Inspect' }, {
      exactMachineId: 'machine-1', workspaceWrites: 'deny',
    });
    expect(result).toMatchObject({ ok: false, code: 'execution_run_target_unavailable', details: { runCreation: 'noRunCreated' } });
    expect(callMachineRpc).not.toHaveBeenCalled();
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

  it('carries exact Workflow invocation services only through the local detached start', async () => {
    const permissionStore = {
      publishRequest: vi.fn(),
      publishRequestAndWait: vi.fn(async () => undefined),
      registerResponseTargetHandler: vi.fn(() => () => undefined),
    };
    const workflowObservationSink = { commit: vi.fn(async () => undefined) };
    const invoke = vi.fn(async (method: string) => {
      if (method === RPC_METHODS.CAPABILITIES_DETECT) return {
        protocolVersion: 2,
        results: {
          'tool.executionRuns': {
            ok: true,
            data: {
              protocolVersion: 2,
              features: { detachedScope: true, startAndWait: true, exactInputResults: true, runScopedAgentBindings: true },
            },
          },
        },
      };
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
    const executor = createActionExecutor({ ...deps, isActionEnabled: () => true, isActionApprovalRequired: () => false });

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
        localActionContext: expect.objectContaining({ agentStartWorkDepth: 3 }),
      }),
    );
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    callMachineRpc.mockReset();
    callSessionRpc.mockReset();
    readMachineRpcRequestDisposition.mockReset();
    readMachineRpcRequestDisposition.mockReturnValue(null);
    resolveSessionTransportContext.mockReset();
  });

  it('routes the five plugin-visible run lifecycle actions to the canonical session owner with typed results', async () => {
    const { service } = createExecutionRunActionsService();
    callSessionRpc
      .mockResolvedValueOnce({ ok: true })
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

    expect(resolveSessionTransportContext).toHaveBeenCalledTimes(1);
    expect(resolveSessionTransportContext).toHaveBeenCalledWith({
      credentials: expect.objectContaining({ token: 'token' }),
      idOrPrefix: 'session-1',
    });
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

  it('routes SCM diff-summary through the supplied canonical Action boundary without a direct run transport', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-summary-deps-' });
    directories.push(fixture.rootPath);
    await writeFile(join(fixture.rootPath, fixture.trackedPath), 'captured through session Action\n');
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      rawSession: { id: 'session-1', active: true, path: fixture.rootPath },
      accountEncryptionCurrentness: { mode: 'plain' },
      mode: 'plain',
      ctx: null,
    });
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

    await expect(deps.scmActionExecute?.({
      actionId: 'scm.diffSummary.generate',
      input: {
        cwd: fixture.rootPath,
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
    })).resolves.toMatchObject({ success: true, runId: 'run-1',
      comparison: { inventory: { state: 'complete', files: [expect.objectContaining({ path: fixture.trackedPath })] } },
      outputs: { summary: { state: 'pending' } },
    });
    expect(executeCanonicalAction).toHaveBeenNthCalledWith(1, 'execution.run.start', expect.objectContaining({
      waitForCompletion: false,
      intentInput: expect.objectContaining({ sessionId: 'session-1', comparisonId: expect.any(String) }),
    }));
    expect(executeCanonicalAction.mock.calls[0]?.[1]).not.toHaveProperty('sessionId');
    expect(executeCanonicalAction).toHaveBeenCalledTimes(1);
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('forwards exact-machine generation with the selected session and strict public comparison input', async () => {
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) } };
    callMachineRpc.mockImplementation(async ({ request }) => {
      const input = ScmDiffSummaryGenerateInputSchema.parse(request);
      expect(input.sessionId).toBe('session-1');
      return { success: false, errorCode: 'MODEL_UNAVAILABLE', error: 'Unavailable test model', sourceKey: 'workingTree:/workspace' };
    });
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null });
    await expect(deps.scmActionExecute?.({
      actionId: 'scm.diffSummary.generate',
      input: { cwd: '/workspace', source: { kind: 'workingTree' } },
      context: { defaultSessionId: 'session-1', externalActionTarget: { kind: 'machine', machineId: 'machine-1' } },
      executeCanonicalAction: async () => { throw new Error('Remote invocation must be admitted on the owning machine'); },
    })).resolves.toMatchObject({ success: false, errorCode: 'MODEL_UNAVAILABLE' });
  });

  it('captures selected-session inventory without model admission', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-capture-deps-' });
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) } };
    resolveSessionTransportContext.mockResolvedValue({ ok: true, sessionId: 'session-1',
      rawSession: { id: 'session-1', active: true, path: fixture.rootPath },
      accountEncryptionCurrentness: { mode: 'plain' }, mode: 'plain', ctx: null });
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
  });

  it('reads pinned comparison evidence without recapturing later pending files', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-pinned-capture-deps-' });
    directories.push(fixture.rootPath);
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) } };
    resolveSessionTransportContext.mockResolvedValue({ ok: true, sessionId: 'session-1',
      rawSession: { id: 'session-1', active: true, path: fixture.rootPath },
      accountEncryptionCurrentness: { mode: 'plain' }, mode: 'plain', ctx: null });
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
  });

  it('reads PR evidence through the canonical constrained source Action from page one', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-pr-source-deps-' });
    directories.push(fixture.rootPath);
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) } };
    resolveSessionTransportContext.mockResolvedValue({ ok: true, sessionId: 'session-1',
      rawSession: { id: 'session-1', active: true, path: fixture.rootPath },
      accountEncryptionCurrentness: { mode: 'plain' }, mode: 'plain', ctx: null });
    // The contributed plugin process is the system boundary; canonical Action
    // admission, source-input shaping, and evidence capture stay real.
    const invokeContributedAction = vi.fn(async (request: Readonly<{ input?: unknown }>) => {
      const continuation = request.input && typeof request.input === 'object' && 'continuation' in request.input
        ? request.input.continuation : undefined;
      return { ok: true as const, result: { kind: 'changedFiles', omittedRowCount: 0, projectionTruncated: false,
        ...(!continuation ? { continuation: 'source-page-two', incomplete: 'pagination' } : {}),
        rows: [{ path: continuation ? 'second.ts' : 'first.ts', status: 'modified', diffAvailable: true,
          evidence: { state: 'available', patch: '@@ -1 +1 @@\n-before\n+after\n' } }],
        comparison: { baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40),
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
  });

  it('refuses selected-session evidence outside the machine filesystem policy before capture or admission', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-summary-permission-' });
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) } };
    resolveSessionTransportContext.mockResolvedValue({ ok: true, sessionId: 'session-1',
      rawSession: { id: 'session-1', active: true, path: fixture.rootPath },
      accountEncryptionCurrentness: { mode: 'plain' }, mode: 'plain', ctx: null });
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

  it('routes detached execution.run.send through V2 preflight to the exact Session-origin machine', async () => {
    const { service } = createExecutionRunActionsService();
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      rawSession: { id: 'session-1', active: true, machineId: 'machine-1' },
      accountEncryptionCurrentness: { mode: 'plain' },
      mode: 'plain',
      ctx: null,
    });
    callMachineRpc
      .mockResolvedValueOnce({
        results: {
          'tool.executionRuns': {
            ok: true,
            data: {
              protocolVersion: 2,
              features: { detachedScope: true },
            },
          },
        },
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(service.execute('execution.run.send', {
      sessionId: null,
      runId: 'run-1',
      message: 'Continue',
    })).resolves.toEqual({ ok: true });

    expect(callMachineRpc.mock.calls.map(([request]) => ({
      machineId: request.machineId,
      method: request.method,
      request: request.request,
    }))).toEqual([
      {
        machineId: 'machine-1',
        method: RPC_METHODS.CAPABILITIES_DETECT,
        request: { requests: [{ id: 'tool.executionRuns' }] },
      },
      {
        machineId: 'machine-1',
        method: SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
        request: {
          runId: 'run-1',
          message: 'Continue',
          delivery: 'steer_if_supported',
        },
      },
    ]);
    expect(callMachineRpc.mock.calls[1]?.[0]).toMatchObject({ timeoutMs: null });
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('keeps detached stream cancellation under execution-run lifecycle ownership', async () => {
    const { service } = createExecutionRunActionsService();
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      rawSession: { id: 'session-1', active: true, machineId: 'machine-1' },
      accountEncryptionCurrentness: { mode: 'plain' },
      mode: 'plain',
      ctx: null,
    });
    callMachineRpc
      .mockResolvedValueOnce({
        results: {
          'tool.executionRuns': {
            ok: true,
            data: {
              protocolVersion: 2,
              features: { detachedScope: true },
            },
          },
        },
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(service.execute('execution.run.stream.cancel', {
      sessionId: null,
      runId: 'run-1',
      streamId: 'stream-1',
    })).resolves.toEqual({ ok: true });

    expect(callMachineRpc.mock.calls[1]?.[0]).toMatchObject({
      machineId: 'machine-1',
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
      request: { runId: 'run-1', streamId: 'stream-1' },
      timeoutMs: null,
    });
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('keeps detached stop under execution-run lifecycle ownership', async () => {
    const { service } = createExecutionRunActionsService();
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      rawSession: { id: 'session-1', active: true, machineId: 'machine-1' },
      accountEncryptionCurrentness: { mode: 'plain' },
      mode: 'plain',
      ctx: null,
    });
    callMachineRpc
      .mockResolvedValueOnce({
        results: {
          'tool.executionRuns': {
            ok: true,
            data: {
              protocolVersion: 2,
              features: { detachedScope: true },
            },
          },
        },
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(service.execute('execution.run.stop', {
      sessionId: null,
      runId: 'run-1',
    })).resolves.toEqual({ ok: true });

    expect(callMachineRpc.mock.calls[1]?.[0]).toMatchObject({
      machineId: 'machine-1',
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
      request: { runId: 'run-1' },
      timeoutMs: null,
    });
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('projects a detached execution.run.send failure returned by the exact machine', async () => {
    const { service } = createExecutionRunActionsService();
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      rawSession: { id: 'session-1', active: true, machineId: 'machine-1' },
      accountEncryptionCurrentness: { mode: 'plain' },
      mode: 'plain',
      ctx: null,
    });
    callMachineRpc
      .mockResolvedValueOnce({
        results: {
          'tool.executionRuns': {
            ok: true,
            data: {
              protocolVersion: 2,
              features: { detachedScope: true },
            },
          },
        },
      })
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

    expect(callMachineRpc.mock.calls.map(([request]) => request.method)).toEqual([
      RPC_METHODS.CAPABILITIES_DETECT,
      SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
    ]);
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['notSent', 'execution_run_target_unavailable'],
    ['outcomeUnknown', 'execution_run_send_outcome_unknown'],
  ] as const)('classifies a detached send transport failure with %s disposition', async (disposition, errorCode) => {
    const sendError = new Error(`send ${disposition}`);
    const { service } = createExecutionRunActionsService();
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      rawSession: { id: 'session-1', active: true, machineId: 'machine-1' },
      accountEncryptionCurrentness: { mode: 'plain' },
      mode: 'plain',
      ctx: null,
    });
    callMachineRpc
      .mockResolvedValueOnce({
        results: {
          'tool.executionRuns': {
            ok: true,
            data: {
              protocolVersion: 2,
              features: { detachedScope: true },
            },
          },
        },
      })
      .mockRejectedValueOnce(sendError);
    readMachineRpcRequestDisposition.mockImplementation((error) => (
      error === sendError ? disposition : null
    ));

    await expect(service.execute('execution.run.send', {
      sessionId: null,
      runId: 'run-1',
      message: 'Continue',
    })).rejects.toMatchObject({ code: errorCode });
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
        ...deps,
        isActionEnabled: () => true,
        isActionApprovalRequired: () => false,
      }),
      invokeContributedAction: vi.fn(),
    });

    await expect(service.execute('execution.run.ensure', {
      runId: 'run-1',
    })).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(resolveSessionTransportContext).not.toHaveBeenCalled();
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('preflights an attached immediate secret overlay against the exact Session machine before start dispatch', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      rawSession: { id: 'session-1', active: true, machineId: 'machine-1' },
      accountEncryptionCurrentness: { mode: 'plain' },
      mode: 'plain',
      ctx: null,
    });
    callMachineRpc.mockResolvedValueOnce({
      protocolVersion: 2,
      results: {
        'tool.executionRuns': {
          ok: true,
          data: {
            protocolVersion: 2,
            features: {
              detachedScope: true,
              startAndWait: true,
              secretReferenceOverlay: false,
            },
          },
        },
      },
    });
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
      ...deps,
      executionRunStart,
      isActionEnabled: () => true,
      isActionApprovalRequired: () => false,
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
      method: RPC_METHODS.CAPABILITIES_DETECT,
      request: { requests: [{ id: 'tool.executionRuns' }] },
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
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      rawSession,
      accountEncryptionCurrentness: { mode: 'plain' },
      mode: 'plain',
      ctx: null,
    });
    callMachineRpc.mockImplementationOnce(async () => {
      rawSession.machineId = 'machine-replaced';
      return {
        protocolVersion: 2,
        results: {
          'tool.executionRuns': {
            ok: true,
            data: {
              protocolVersion: 2,
              features: {
                detachedScope: true,
                startAndWait: true,
                exactInputResults: true,
                runScopedAgentBindings: true,
                secretReferenceOverlay: true,
              },
            },
          },
        },
      };
    });
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
    });
    const executor = createActionExecutor({
      ...deps,
      isActionEnabled: () => true,
      isActionApprovalRequired: () => false,
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
      method: RPC_METHODS.CAPABILITIES_DETECT,
    }));
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('uses the exact Session machine capability fact and refuses detached dispatch to a V1 daemon', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      rawSession: { id: 'session-1', active: true, machineId: 'machine-1' },
      accountEncryptionCurrentness: { mode: 'plain' },
      mode: 'plain',
      ctx: null,
    });
    callMachineRpc.mockResolvedValue({
      protocolVersion: 1,
      results: {
        'tool.executionRuns': {
          ok: true,
          checkedAt: 1,
          data: { available: true, intents: [], backends: {} },
        },
      },
    });
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
    });
    const executor = createActionExecutor({
      ...deps,
      isActionEnabled: () => true,
      isActionApprovalRequired: () => false,
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
      method: RPC_METHODS.CAPABILITIES_DETECT,
      request: { requests: [{ id: 'tool.executionRuns' }] },
    }));
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('classifies an unavailable V2 capability method as protocol-unsupported before start dispatch', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      rawSession: { id: 'session-1', active: true, machineId: 'machine-1' },
      accountEncryptionCurrentness: { mode: 'plain' },
      mode: 'plain',
      ctx: null,
    });
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
      ...deps,
      isActionEnabled: () => true,
      isActionApprovalRequired: () => false,
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

  it('classifies a malformed V2 capability fact as protocol-unsupported before start dispatch', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      rawSession: { id: 'session-1', active: true, machineId: 'machine-1' },
      accountEncryptionCurrentness: { mode: 'plain' },
      mode: 'plain',
      ctx: null,
    });
    callMachineRpc.mockResolvedValueOnce({
      protocolVersion: 2,
      results: {
        'tool.executionRuns': {
          ok: true,
          data: {
            protocolVersion: 1,
            features: { detachedScope: true },
          },
        },
      },
    });
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
    });
    const executor = createActionExecutor({
      ...deps,
      isActionEnabled: () => true,
      isActionApprovalRequired: () => false,
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
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      rawSession: { id: 'session-1', active: true, machineId: 'machine-1' },
      accountEncryptionCurrentness: { mode: 'plain' },
      mode: 'plain',
      ctx: null,
    });
    callMachineRpc.mockRejectedValueOnce(new Error('machine offline'));
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'cli-global',
      mode: 'plain',
      ctx: null,
    });
    const executor = createActionExecutor({
      ...deps,
      isActionEnabled: () => true,
      isActionApprovalRequired: () => false,
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
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });

    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc.mock.calls[0]?.[0]).toMatchObject({
      machineId: 'machine-1',
      method: RPC_METHODS.CAPABILITIES_DETECT,
    });
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('preserves canonical plugin cancellation when capability detection aborts before start dispatch', async () => {
    const caller = new AbortController();
    let capabilitySignal: AbortSignal | undefined;
    const { service } = createExecutionRunActionsService();
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      rawSession: { id: 'session-1', active: true, machineId: 'machine-1' },
      accountEncryptionCurrentness: { mode: 'plain' },
      mode: 'plain',
      ctx: null,
    });
    callMachineRpc.mockImplementationOnce(({ signal }: Readonly<{ signal?: AbortSignal }>) =>
      new Promise((_resolve, reject) => {
        capabilitySignal = signal;
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

    await vi.waitFor(() => expect(callMachineRpc).toHaveBeenCalledTimes(1));
    caller.abort();

    await expect(invocation).rejects.toMatchObject({ code: 'plugin_action_aborted' });
    expect(capabilitySignal?.aborted).toBe(true);
    expect(callMachineRpc.mock.calls.map(([request]) => request.method)).toEqual([
      RPC_METHODS.CAPABILITIES_DETECT,
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
      if (method === RPC_METHODS.CAPABILITIES_DETECT) {
        return {
          results: {
            'tool.executionRuns': {
              ok: true,
              data: {
                protocolVersion: 2,
                features: { detachedScope: true, startAndWait: true },
              },
            },
          },
        };
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
      ...deps,
      isActionEnabled: () => true,
      isActionApprovalRequired: () => false,
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
      RPC_METHODS.CAPABILITIES_DETECT,
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
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'origin-session',
      rawSession: { id: 'origin-session', active: true, machineId: 'machine-origin' },
      accountEncryptionCurrentness: { mode: 'plain' },
      mode: 'plain',
      ctx: null,
    });
    callMachineRpc.mockImplementation(async ({ method }: Readonly<{ method: string }>) => {
      if (method === RPC_METHODS.CAPABILITIES_DETECT) {
        return {
          results: {
            'tool.executionRuns': {
              ok: true,
              data: {
                protocolVersion: 2,
                features: { detachedScope: true, startAndWait: true },
              },
            },
          },
        };
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
      ...deps,
      isActionEnabled: () => true,
      isActionApprovalRequired: () => false,
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
      { machineId: 'machine-admitted', method: RPC_METHODS.CAPABILITIES_DETECT },
      { machineId: 'machine-admitted', method: SESSION_RPC_METHODS.EXECUTION_RUN_START },
    ]);
    expect(resolveSessionTransportContext).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce({
        results: {
          'tool.executionRuns': {
            ok: true,
            data: {
              protocolVersion: 2,
              features: { detachedScope: true, startAndWait: true },
            },
          },
        },
      })
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
      ...deps,
      isActionEnabled: () => true,
      isActionApprovalRequired: () => false,
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
