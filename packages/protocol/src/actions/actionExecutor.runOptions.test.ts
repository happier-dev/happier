import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { buildAcpConfigOptionOverridesV1 } from '../sessions/metadata/metadataOverridesV1.js';

function createDeps(overrides: Partial<ActionExecutorDeps> = {}): ActionExecutorDeps {
  return {
    executionRunStart: vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' })),
    executionRunList: vi.fn(async () => ({})),
    executionRunGet: vi.fn(async () => ({})),
    executionRunSend: vi.fn(async () => ({})),
    executionRunStop: vi.fn(async () => ({})),
    executionRunAction: vi.fn(async () => ({})),
    executionRunWait: vi.fn(async () => ({})),
    sessionOpen: vi.fn(async () => ({})),
    sessionFork: vi.fn(async () => ({})),
    sessionRollback: vi.fn(async () => ({})),
    sessionSpawnNew: vi.fn(async () => ({})),
    pathsListRecent: vi.fn(async () => ({ items: [] })),
    machinesList: vi.fn(async () => ({ items: [] })),
    serversList: vi.fn(async () => ({ items: [] })),
    reviewEnginesList: vi.fn(async () => ({ items: [] })),
    agentsBackendsList: vi.fn(async () => ({ items: [] })),
    agentsModelsList: vi.fn(async () => ({ items: [] })),
    sessionSendMessage: vi.fn(async () => ({})),
    sessionPermissionRespond: vi.fn(async () => ({})),
    sessionUserActionAnswer: vi.fn(async () => ({})),
    sessionModeSet: vi.fn(async () => ({})),
    sessionModesList: vi.fn(async () => ({ items: [] })),
    sessionTargetPrimarySet: vi.fn(async () => ({})),
    sessionTargetTrackedSet: vi.fn(async () => ({})),
    sessionList: vi.fn(async () => ({})),
    sessionActivityGet: vi.fn(async () => ({})),
    sessionRecentMessagesGet: vi.fn(async () => ({})),
    resetGlobalVoiceAgent: vi.fn(),
    ...overrides,
  };
}

/**
 * DEC-2 / INV-1: Action surface resolution fails closed (see `actionSurfaceFailClosed.test.ts`),
 * so a call site must stamp the caller it models. These execution-run tests model the present-user
 * host that owns the executor — `apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts` stamps
 * `'ui'`. The internal envelope-normalization case below models the execution-run RPC dispatcher
 * (`apps/cli/src/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction.ts` stamps `'agent'`),
 * which is the only production caller of the agent-only `execution.run.ensure`.
 */
const UI_CALLER = { surface: 'ui' } as const;
const RUN_DISPATCHER_CALLER = { surface: 'agent' } as const;

const RUN_START_BASE = {
  sessionId: 's1',
  intent: 'delegate',
  backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
  instructions: 'do it',
  permissionMode: 'read_only',
  retentionPolicy: 'ephemeral',
  runClass: 'bounded',
  ioMode: 'request_response',
} as const;

const EXECUTION_RUN_WAIT_SUCCEEDED = {
  ok: true,
  status: 'succeeded',
  result: { run: { runId: 'run_1', status: 'succeeded' } },
} as const;

describe('createActionExecutor run options parity (model + effort)', () => {
  it('threads modelId + sessionConfigOptionOverrides on execution.run.start', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));
    const overrides = buildAcpConfigOptionOverridesV1({
      updatedAt: 1,
      overrides: { reasoning_effort: { updatedAt: 1, value: 'high' } },
    });

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, modelId: 'gpt-5.5', sessionConfigOptionOverrides: overrides },
      { ...UI_CALLER, defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    expect(executionRunStart).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ modelId: 'gpt-5.5', sessionConfigOptionOverrides: overrides }),
      undefined,
    );
  });

  it('resolves the four execution-run Session scope forms at the canonical Action boundary', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const }));
    const executor = createActionExecutor(createDeps({ executionRunStart, executionRunCheckProtocolV2 }));
    const { sessionId: _sessionId, ...startWithoutScope } = RUN_START_BASE;

    await executor.execute('execution.run.start' as any, {
      ...RUN_START_BASE,
      sessionId: 'session_explicit',
    }, { ...UI_CALLER, defaultSessionId: 'session_context' });
    await executor.execute('execution.run.start' as any, startWithoutScope, { ...UI_CALLER, defaultSessionId: 'session_context' });
    await executor.execute('execution.run.start' as any, {
      ...RUN_START_BASE,
      sessionId: null,
    }, { ...UI_CALLER, defaultSessionId: 'session_context' });
    await executor.execute('execution.run.start' as any, startWithoutScope, { ...UI_CALLER });

    expect(executionRunStart.mock.calls.map(([scope]) => scope)).toEqual([
      'session_explicit',
      'session_context',
      null,
      null,
    ]);
    expect(executionRunStart.mock.calls.every(([, request]) => !Object.hasOwn(request, 'sessionId'))).toBe(true);
    expect(executionRunCheckProtocolV2).toHaveBeenCalledTimes(2);
  });

  it('defaults an unexpected start-path exception to outcomeUnknown at the canonical Action boundary', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({
      executionRunStart,
      resolveServerIdForSessionId: () => {
        throw new Error('server lookup failed');
      },
    }));

    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'action_failed',
      error: 'server lookup failed',
      details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
    });
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only execution-run Session scope before V2 preflight or start', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const }));
    const executor = createActionExecutor(createDeps({ executionRunStart, executionRunCheckProtocolV2 }));

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, sessionId: '   ' },
      { ...UI_CALLER, defaultSessionId: 'session_context', serverId: 'server_1' },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    expect(executionRunCheckProtocolV2).not.toHaveBeenCalled();
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('preserves explicit detached scope and composes start-and-wait through the incumbent waiter', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunWait = vi.fn(async () => EXECUTION_RUN_WAIT_SUCCEEDED);
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const }));
    const executor = createActionExecutor(createDeps({
      executionRunStart,
      executionRunWait,
      executionRunCheckProtocolV2,
    }));

    const res = await executor.execute(
      'execution.run.start' as any,
      {
        ...RUN_START_BASE,
        sessionId: null,
        waitForCompletion: true,
        waitTimeoutSeconds: 12,
      },
      { ...UI_CALLER, defaultSessionId: 's1', serverId: 'server_1' },
    );

    expect(res).toEqual({
      ok: true,
      result: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        wait: EXECUTION_RUN_WAIT_SUCCEEDED,
      },
    });
    expect(executionRunStart).toHaveBeenCalledWith(
      null,
      expect.not.objectContaining({
        sessionId: expect.anything(),
        waitForCompletion: expect.anything(),
        waitTimeoutSeconds: expect.anything(),
      }),
      { serverId: 'server_1', originSessionId: 's1' },
    );
    expect(executionRunWait).toHaveBeenCalledWith(
      null,
      { runId: 'run_1', timeoutSeconds: 12 },
      { serverId: 'server_1', originSessionId: 's1' },
    );
    expect(executionRunCheckProtocolV2).toHaveBeenCalledWith(
      null,
      { detachedScope: true, startAndWait: true },
      { serverId: 'server_1', originSessionId: 's1' },
    );
  });

  it('keeps a successful start identity when caller cancellation ends only its composed wait', async () => {
    const caller = new AbortController();
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunWait = vi.fn(async (_sessionId: string | null, _request: unknown, opts?: { signal?: AbortSignal }) => {
      expect(opts?.signal).toBe(caller.signal);
      caller.abort();
      opts?.signal?.throwIfAborted();
    });
    const executionRunStop = vi.fn(async () => ({ ok: true }));
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const }));
    const executor = createActionExecutor(createDeps({
      executionRunStart,
      executionRunWait,
      executionRunStop,
      executionRunCheckProtocolV2,
    }));

    await expect(executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, waitForCompletion: true },
      { ...UI_CALLER, defaultSessionId: 's1', signal: caller.signal },
    )).resolves.toEqual({
      ok: true,
      result: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        wait: { ok: false, code: 'cancelled' },
      },
    });
    expect(executionRunStart).toHaveBeenCalledTimes(1);
    expect(executionRunStop).not.toHaveBeenCalled();
  });

  it('projects a direct waiter payload through the same strict Action result schema', async () => {
    const executionRunWait = vi.fn(async () => ({
      ok: true as const,
      status: 'succeeded',
      result: { run: { runId: 'run_1', status: 'succeeded', unexpected: true } },
    }));
    const executor = createActionExecutor(createDeps({ executionRunWait }));

    await expect(executor.execute(
      'execution.run.wait' as any,
      { sessionId: 's1', runId: 'run_1' },
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: true,
      result: EXECUTION_RUN_WAIT_SUCCEEDED,
    });
  });

  it('publishes a direct waiter timeout through the strict Action result schema', async () => {
    const executionRunWait = vi.fn(async () => ({ ok: false as const, code: 'timeout' as const }));
    const executor = createActionExecutor(createDeps({ executionRunWait }));

    await expect(executor.execute(
      'execution.run.wait' as any,
      { sessionId: 's1', runId: 'run_1' },
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({ ok: true, result: { ok: false, code: 'timeout' } });
  });

  it('unwraps the incumbent Session start service envelope before composing start-and-wait', async () => {
    const executionRunStart = vi.fn(async () => ({
      ok: true as const,
      data: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        producerMetadata: { version: 2 },
      },
    }));
    const executionRunWait = vi.fn(async () => EXECUTION_RUN_WAIT_SUCCEEDED);
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const, exactMachineId: 'machine_1' }));
    const executor = createActionExecutor(createDeps({
      executionRunStart,
      executionRunWait,
      executionRunCheckProtocolV2,
    }));

    await expect(executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, waitForCompletion: true },
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: true,
      result: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        producerMetadata: { version: 2 },
        wait: EXECUTION_RUN_WAIT_SUCCEEDED,
      },
    });
    expect(executionRunWait).toHaveBeenCalledWith(
      's1',
      { runId: 'run_1' },
      { exactMachineId: 'machine_1' },
    );
  });

  it('projects the incumbent Session start service failure as a failed Action result', async () => {
    const executionRunStart = vi.fn(async () => ({
      ok: false as const,
      code: 'execution_run_not_allowed',
      message: 'Execution runs disabled',
    }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Execution runs disabled',
      details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
    });
  });

  it('treats a complete returned Run identity as success even when the service envelope claims failure', async () => {
    const executionRunStart = vi.fn(async () => ({
      ok: false as const,
      code: 'execution_run_failed',
      message: 'contradictory failure',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toMatchObject({
      ok: true,
      result: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
      },
    });
  });

  it('treats a partial returned Run identity as outcomeUnknown even when failure details claim no run', async () => {
    const executionRunStart = vi.fn(async () => ({
      ok: false as const,
      code: 'execution_run_failed',
      message: 'contradictory partial identity',
      runId: 'run_1',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_failed',
      error: 'contradictory partial identity',
      details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
    });
  });

  it('applies identity precedence inside a successful service wrapper before reading its nested failure', async () => {
    const executionRunStart = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        data: {
          ok: false,
          code: 'execution_run_failed',
          runId: 'run_1',
          callId: 'call_1',
          sidechainId: 'call_1',
          details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          ok: false,
          code: 'execution_run_failed',
          runId: 'run_2',
          details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
        },
      });
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: true,
      result: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
      },
    });
    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_failed',
      error: 'execution_run_failed',
      details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
    });
  });

  it('preserves owner-proven no-run evidence and defaults malformed or missing start evidence to outcomeUnknown', async () => {
    const executionRunStart = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        code: 'execution_run_budget_exceeded',
        message: 'No budget',
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
      })
      .mockResolvedValueOnce({
        ok: false,
        code: 'execution_run_failed',
        message: 'Malformed evidence',
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated', retryable: true } },
      });
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toMatchObject({
      ok: false,
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toMatchObject({
      ok: false,
      details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
    });
  });

  it('keeps the returned start identity when wait observation throws after start', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunWait = vi.fn(async () => {
      throw new Error('wait transport lost');
    });
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const }));
    const executor = createActionExecutor(createDeps({
      executionRunStart,
      executionRunWait,
      executionRunCheckProtocolV2,
    }));

    await expect(executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, waitForCompletion: true },
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: true,
      result: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'call_1',
        wait: { ok: false, code: 'execution_run_failed' },
      },
    });
  });

  it('treats a successful start envelope without a complete run identity as outcome unknown', async () => {
    const executionRunStart = vi.fn(async () => ({ ok: true as const, data: {} }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    await expect(executor.execute(
      'execution.run.start' as any,
      RUN_START_BASE,
      { ...UI_CALLER, defaultSessionId: 's1' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_failed',
      error: 'execution_run_invalid_response',
      details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
    });
  });

  it('normalizes internal execution-run service envelopes only at the public Action boundary', async () => {
    const executionRunList = vi.fn(async () => ({
      ok: true as const,
      data: { runs: [] },
    }));
    const executionRunSend = vi.fn(async () => ({ ok: true as const }));
    const executionRunEnsure = vi.fn(async () => ({
      ok: true as const,
      data: {},
    }));
    const executionRunGet = vi.fn(async () => ({
      ok: false as const,
      code: 'execution_run_not_allowed',
      message: 'Execution runs disabled',
    }));
    const executor = createActionExecutor(createDeps({
      executionRunList,
      executionRunSend,
      executionRunEnsure,
      executionRunGet,
    }));

    await expect(executor.execute(
      'execution.run.list' as any,
      { sessionId: 's1' },
      RUN_DISPATCHER_CALLER,
    )).resolves.toEqual({ ok: true, result: { runs: [] } });
    await expect(executor.execute(
      'execution.run.send' as any,
      { sessionId: 's1', runId: 'run_1', message: 'Continue' },
      RUN_DISPATCHER_CALLER,
    )).resolves.toEqual({ ok: true, result: { ok: true } });
    await expect(executor.execute(
      'execution.run.ensure' as any,
      { sessionId: 's1', runId: 'run_1' },
      RUN_DISPATCHER_CALLER,
    )).resolves.toEqual({ ok: true, result: { ok: true } });
    await expect(executor.execute(
      'execution.run.get' as any,
      { sessionId: 's1', runId: 'run_1' },
      RUN_DISPATCHER_CALLER,
    )).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_not_allowed',
      error: 'Execution runs disabled',
    });
  });

  it('fails closed before detached start when the exact target lacks the V2 execution-run capability', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunCheckProtocolV2 = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'execution_run_protocol_unsupported',
      error: 'execution_run_protocol_unsupported',
    }));
    const executor = createActionExecutor(createDeps({ executionRunStart, executionRunCheckProtocolV2 }));

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, sessionId: null, waitForCompletion: true },
      { ...UI_CALLER, defaultSessionId: 's1', serverId: 'server_1' },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'execution_run_protocol_unsupported',
      error: 'execution_run_protocol_unsupported',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    expect(executionRunCheckProtocolV2).toHaveBeenCalledWith(
      null,
      { detachedScope: true, startAndWait: true },
      { serverId: 'server_1', originSessionId: 's1' },
    );
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('fails closed before a V2 start when capability negotiation is unavailable', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    for (const input of [
      { ...RUN_START_BASE, sessionId: null },
      { ...RUN_START_BASE, sessionId: 'session_explicit', waitForCompletion: true },
    ]) {
      await expect(executor.execute(
        'execution.run.start' as any,
        input,
        { ...UI_CALLER, defaultSessionId: 's1', serverId: 'server_1' },
      )).resolves.toEqual({
        ok: false,
        errorCode: 'execution_run_protocol_unsupported',
        error: 'execution_run_protocol_unsupported',
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
      });
    }
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('preserves the V2 capability owner\'s exact-machine routing through detached start-and-wait', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunWait = vi.fn(async () => EXECUTION_RUN_WAIT_SUCCEEDED);
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const, exactMachineId: 'machine_2' }));
    const executor = createActionExecutor(createDeps({
      executionRunStart,
      executionRunWait,
      executionRunCheckProtocolV2,
    }));

    await expect(executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, sessionId: null, waitForCompletion: true },
      { ...UI_CALLER, defaultSessionId: 's1', serverId: 'server_1' },
    )).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(executionRunStart).toHaveBeenCalledWith(
      null,
      expect.any(Object),
      { serverId: 'server_1', originSessionId: 's1', exactMachineId: 'machine_2' },
    );
    expect(executionRunWait).toHaveBeenCalledWith(
      null,
      { runId: 'run_1' },
      { serverId: 'server_1', originSessionId: 's1', exactMachineId: 'machine_2' },
    );
  });

  it('passes a host-stamped detached target to V2 preflight before dispatch uses its exact machine', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executionRunCheckProtocolV2 = vi.fn(async () => ({ ok: true as const, exactMachineId: 'machine_exact' }));
    const executor = createActionExecutor(createDeps({ executionRunStart, executionRunCheckProtocolV2 }));

    await expect(executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, sessionId: null },
      {
        ...UI_CALLER,
        serverId: 'server_1',
        // The mount host, not Action input, vouches for this selection.
        executionRunTargetMachineId: 'machine_mounted',
      },
    )).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(executionRunCheckProtocolV2).toHaveBeenCalledWith(
      null,
      { detachedScope: true, startAndWait: false },
      { serverId: 'server_1', targetMachineId: 'machine_mounted' },
    );
    expect(executionRunStart).toHaveBeenCalledWith(
      null,
      expect.any(Object),
      { serverId: 'server_1', targetMachineId: 'machine_mounted', exactMachineId: 'machine_exact' },
    );
  });

  it('merges the configOptions shorthand into sessionConfigOptionOverrides and strips it', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, configOptions: { reasoning_effort: 'high' } },
      { ...UI_CALLER, defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    const request = executionRunStart.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(request.configOptions).toBeUndefined();
    const overrides = request.sessionConfigOptionOverrides as { overrides: Record<string, { value: unknown }> };
    expect(overrides.overrides.reasoning_effort.value).toBe('high');
  });

  it('fails closed when configOptions conflicts with sessionConfigOptionOverrides', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));
    const overrides = buildAcpConfigOptionOverridesV1({
      updatedAt: 1,
      overrides: { reasoning_effort: { updatedAt: 1, value: 'low' } },
    });

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, sessionConfigOptionOverrides: overrides, configOptions: { reasoning_effort: 'high' } },
      { ...UI_CALLER, defaultSessionId: 's1' },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('threads modelId + merged effort into every delegate.start per-target run request', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'subagents.delegate.start' as any,
      {
        sessionId: 's1',
        backendTargetKeys: ['agent:codex', 'agent:claude'],
        instructions: 'do it',
        permissionMode: 'read_only',
        modelId: 'gpt-5.5',
        configOptions: { reasoning_effort: 'high' },
      },
      { ...UI_CALLER, defaultSessionId: 's1', callerPermissionMode: 'workspace_write' },
    );

    expect(res.ok).toBe(true);
    expect(executionRunStart).toHaveBeenCalledTimes(2);
    for (const call of executionRunStart.mock.calls) {
      const request = call[1] as Record<string, unknown>;
      expect(request.modelId).toBe('gpt-5.5');
      const overrides = request.sessionConfigOptionOverrides as { overrides: Record<string, { value: unknown }> };
      expect(overrides.overrides.reasoning_effort.value).toBe('high');
    }
  });

  it('normalizes a simple-string connectedServices selection on execution.run.start', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, connectedServices: 'openai-codex:group:happier' },
      { ...UI_CALLER, defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    const request = executionRunStart.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(request.connectedServices).toEqual({
      v: 1,
      bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'group', groupId: 'happier' } },
    });
  });

  it('fails closed and starts no run when connectedServices is malformed', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, connectedServices: 'not-a-service:bogus:x' },
      { ...UI_CALLER, defaultSessionId: 's1' },
    );

    expect(res).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('normalizes per-target simple-string connectedServices on delegate.start', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'subagents.delegate.start' as any,
      {
        sessionId: 's1',
        backendTargetKeys: ['agent:codex'],
        instructions: 'do it',
        permissionMode: 'read_only',
        connectedServicesByBackendTargetKey: { 'agent:codex': 'openai-codex:native' },
      },
      { ...UI_CALLER, defaultSessionId: 's1', callerPermissionMode: 'workspace_write' },
    );

    expect(res.ok).toBe(true);
    const request = executionRunStart.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(request.connectedServices).toEqual({
      v: 1,
      bindingsByServiceId: { 'openai-codex': { source: 'native' } },
    });
  });
});
