import { buildBackendTargetKeyV2, createActionExecutor, readBackendTargetRefV2 } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import type {
  ActionsService,
  PluginActionInputById,
  PluginActionResultById,
  PluginInvocableActionId,
} from '@happier-dev/plugin-sdk/actions';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  readMachineRpcRequestDisposition,
}));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));

import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { createPluginActionCallerMaterializationFixture } from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import { createCliActionDeps } from './createCliActionDeps';

const executionMaterialization = createPluginActionCallerMaterializationFixture('acme.execution');

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
  invoke(service: ActionsService): Promise<PluginActionResultById[K]>;
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
      generation: 'generation-1',
      surface: 'agent',
      session: { id: 'session-1' },
      signal: retirement.signal,
      isGenerationCurrent: () => !retirement.signal.aborted,
    },
    actionExecutor,
    invokeContributedAction: vi.fn(),
  });
  return { service, retirement };
}

describe('createCliActionDeps execution-run plugin bindings', () => {
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
  });

  it('routes SCM diff-summary through the supplied canonical Action boundary without a direct run transport', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      rawSession: { id: 'session-1', active: true, path: '/workspace' },
      accountEncryptionCurrentness: { mode: 'plain' },
      mode: 'plain',
      ctx: null,
    });
    const output = {
      success: true as const,
      summaryMarkdown: '## Summary',
      sourceKey: 'workingTree:/workspace',
      metadata: {
        source: { kind: 'workingTree' as const },
        sourceKey: 'workingTree:/workspace',
      },
    };
    const executeCanonicalAction = vi.fn(async (actionId: string, _input: unknown) => {
      if (actionId === 'execution.run.start') {
        return {
          ok: true as const,
          result: {
            runId: 'run-1',
            callId: 'call-1',
            sidechainId: 'sidechain-1',
            wait: {
              ok: true as const,
              status: 'succeeded' as const,
              result: { run: { runId: 'run-1', status: 'succeeded' as const } },
            },
          },
        };
      }
      if (actionId === 'execution.run.get') {
        return {
          ok: true as const,
          result: {
            run: { runId: 'run-1', status: 'succeeded' as const },
            latestToolResult: output,
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
        cwd: '/workspace',
        source: { kind: 'workingTree' },
        modelSelector: {
          backendTargetKey: buildBackendTargetKeyV2({
            kind: 'backend',
            backendId: 'codex',
            sourceKind: 'built_in',
          }),
        },
      },
      context: { defaultSessionId: 'session-1' },
      executeCanonicalAction,
    })).resolves.toEqual(output);
    expect(executeCanonicalAction).toHaveBeenNthCalledWith(1, 'execution.run.start', expect.objectContaining({
      waitForCompletion: true,
    }));
    expect(executeCanonicalAction.mock.calls[0]?.[1]).not.toHaveProperty('sessionId');
    expect(executeCanonicalAction).toHaveBeenNthCalledWith(2, 'execution.run.get', {
      runId: 'run-1',
      includeStructured: true,
    });
    expect(callSessionRpc).not.toHaveBeenCalled();
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
    createExecutionRunSuccessCase('execution.run.send', { runId: 'run-1', message: 'Continue' }, { ok: true }, { ok: true }),
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
    createExecutionRunAction('execution.run.send', { runId: 'run-1', message: 'Continue' }),
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
        generation: 'generation-1',
        surface: 'agent',
        session: { id: 'session-1' },
        signal: new AbortController().signal,
        isGenerationCurrent: () => true,
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
    }, { defaultSessionId: 'session-1' })).resolves.toEqual({
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
    }, { defaultSessionId: 'session-1' })).resolves.toEqual({
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
            protocolVersion: 2,
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
    }, { defaultSessionId: 'session-1' })).resolves.toEqual({
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
    }, { defaultSessionId: 'session-1' })).resolves.toEqual({
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
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) {
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
      SESSION_RPC_METHODS.EXECUTION_RUN_GET,
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
