import { describe, expect, it, vi } from 'vitest';
import { BrowserCommandV1Schema, FeaturesResponseSchema, type ExecutionRunPublicState } from '@happier-dev/protocol';

import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import type { ExecutionRunHostBridgeContract } from '@/agent/runtime/bridges/executionRun/executionRunBridgeContract';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { BrowserAutomationRoutes } from '@/daemon/browser/automation/routes';
import type { CliServerFeaturesSnapshot } from '@/features/featureDecisionService';

import {
  createExecutionRunRpcActionDeps,
  createExecutionRunRpcActionExecutor,
  type ExecutionRunRpcApprovalDeps,
} from './dispatchExecutionRunRpcAction';

function unusedBridgeMethod(): never {
  throw new Error('execution-run bridge should not be used for unavailable runtime action families');
}

function createUnusedExecutionRunBridge(): ExecutionRunHostBridgeContract {
  return {
    get: () => null,
    getRunningCount: () => 0,
    getStructuredMeta: () => null,
    getLatestToolResult: () => null,
    waitForTerminal: async () => unusedBridgeMethod(),
    getPublic: () => null,
    listPublic: () => [],
    listPublicForRequest: () => [],
    getDepthByRunId: () => null,
    getDepthByCallId: () => null,
    start: async () => unusedBridgeMethod(),
    send: async () => unusedBridgeMethod(),
    ensure: async () => unusedBridgeMethod(),
    ensureOrStart: async () => unusedBridgeMethod(),
    startTurnStream: async () => unusedBridgeMethod(),
    readTurnStream: async () => unusedBridgeMethod(),
    cancelTurnStream: async () => unusedBridgeMethod(),
    stop: async () => unusedBridgeMethod(),
    respondToPermissionRequest: async () => unusedBridgeMethod(),
    applyAction: async () => unusedBridgeMethod(),
  };
}

function createExecutionRunBridgeWithRun(
  overrides: Partial<ExecutionRunHostBridgeContract> = {},
): ExecutionRunHostBridgeContract {
  const run = {
    runId: 'run_1',
    callId: 'call_1',
    sidechainId: 'sidechain_1',
    intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    permissionMode: 'default',
    retentionPolicy: 'ephemeral',
    runClass: 'bounded',
    ioMode: 'request_response',
    status: 'running',
    startedAtMs: 1,
  } satisfies ExecutionRunPublicState;
  const runState = {
    ...run,
    sessionId: 'sess_1',
    depth: 0,
    backendId: 'codex',
    instructions: 'Inspect the change.',
  } satisfies ExecutionRunState;
  return {
    ...createUnusedExecutionRunBridge(),
    get: (runId: string) => (runId === run.runId ? runState : null),
    getPublic: (runId: string) => (runId === run.runId ? run : null),
    ...overrides,
  };
}

function readyServerFeatures(features: Record<string, unknown>): CliServerFeaturesSnapshot {
  return {
    status: 'ready',
    features: FeaturesResponseSchema.parse({ features }),
  };
}

const LOCAL_SERVICES_RUNTIME_ACTIONS_ENABLED = readyServerFeatures({
  localServices: {
    enabled: true,
    inventory: { enabled: true },
    launcher: { enabled: true },
  },
  browser: {
    enabled: true,
    viewTargets: { enabled: true },
  },
});

const BROWSER_CONTROL_RUNTIME_ACTIONS_ENABLED = readyServerFeatures({
  browser: {
    enabled: true,
    viewTargets: { enabled: true },
    internal: { enabled: true },
    sidecar: { enabled: true },
  },
});

const SIMULATOR_RUNTIME_ACTIONS_ENABLED = readyServerFeatures({
  devices: {
    enabled: true,
    simulatorPreview: { enabled: true },
  },
  machines: {
    enabled: true,
    liveStream: { enabled: true },
  },
  browser: {
    enabled: true,
    viewTargets: { enabled: true },
  },
});

const BROWSER_DIAGNOSTICS_RUNTIME_ACTIONS_ENABLED = readyServerFeatures({
  browser: {
    enabled: true,
    viewTargets: { enabled: true },
    internal: { enabled: true },
    sidecar: { enabled: true },
    diagnostics: { enabled: true },
    context: { enabled: true },
    automation: { enabled: true },
    recording: { enabled: true, attachments: { enabled: true } },
  },
});

const BROWSER_AUTOMATION_RUNTIME_ACTIONS_ENABLED = readyServerFeatures({
  browser: {
    enabled: true,
    viewTargets: { enabled: true },
    internal: { enabled: true },
    sidecar: { enabled: true },
    diagnostics: { enabled: true },
    context: { enabled: true },
    automation: { enabled: true },
    recording: { enabled: true, attachments: { enabled: true } },
  },
});

const APPROVED_INTERNAL_RUNTIME_ACTION_CONTEXT = {
  defaultSessionId: 'sess_1',
  bypassApprovals: true,
} as const;

const AGENT_EXECUTION_RUN_START_REQUEST = {
  sessionId: 'sess_1',
  intent: 'delegate',
  backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
  instructions: 'Inspect the change.',
  permissionMode: 'yolo',
  retentionPolicy: 'ephemeral',
  runClass: 'bounded',
  ioMode: 'request_response',
} as const;

function createAgentExecutionRunStartExecutor(start: ExecutionRunHostBridgeContract['start']) {
  return createExecutionRunRpcActionExecutor({
    manager: {
      ...createUnusedExecutionRunBridge(),
      start,
    },
    context: { sessionId: 'sess_1', cwd: '/workspace' },
    policy: resolveExecutionRunPolicy({
      defaults: {
        maxConcurrentRuns: null,
        boundedTimeoutMs: null,
        reviewBoundedTimeoutMs: null,
        maxTurns: null,
        maxDepth: 3,
      },
    }),
    isExecutionRunsEnabled: () => true,
  });
}

describe('createExecutionRunRpcActionExecutor', () => {
  it('rejects malformed explicit review intent input before creating a run', async () => {
    const start = vi.fn(async () => ({
      runId: 'run_started_1',
      callId: 'call_started_1',
      sidechainId: 'sidechain_started_1',
    }));
    const executor = createAgentExecutionRunStartExecutor(start);

    await expect(executor.execute('execution.run.start', {
      ...AGENT_EXECUTION_RUN_START_REQUEST,
      intent: 'review',
      permissionMode: 'read_only',
      intentInput: { engineIds: [] },
    }, { surface: 'rpc' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'execution_run_invalid_action_input',
      error: expect.stringContaining('review intentInput'),
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('normalizes partial explicit review intent input before creating a run', async () => {
    const start = vi.fn(async () => ({
      runId: 'run_started_1',
      callId: 'call_started_1',
      sidechainId: 'sidechain_started_1',
    }));
    const executor = createAgentExecutionRunStartExecutor(start);

    await expect(executor.execute('execution.run.start', {
      ...AGENT_EXECUTION_RUN_START_REQUEST,
      intent: 'review',
      permissionMode: 'read_only',
      intentInput: {
        changeType: 'committed',
        base: { kind: 'none' },
      },
    }, { surface: 'rpc' })).resolves.toMatchObject({ ok: true });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      intentInput: expect.objectContaining({
        engineIds: ['codex'],
        instructions: 'Inspect the change.',
        changeType: 'committed',
        base: { kind: 'none' },
      }),
    }));
  });

  it.each([
    {
      name: 'foreign Session start',
      actionId: 'execution.run.start',
      input: {
        ...AGENT_EXECUTION_RUN_START_REQUEST,
        sessionId: 'sess_foreign',
        permissionMode: 'read_only',
      },
    },
    {
      name: 'foreign Session control',
      actionId: 'execution.run.stop',
      input: { sessionId: 'sess_foreign', runId: 'run_foreign_1' },
    },
    {
      name: 'explicit detached start',
      actionId: 'execution.run.start',
      input: {
        ...AGENT_EXECUTION_RUN_START_REQUEST,
        sessionId: null,
        permissionMode: 'read_only',
      },
    },
    {
      name: 'explicit detached control',
      actionId: 'execution.run.stop',
      input: { sessionId: null, runId: 'run_foreign_1' },
    },
  ] as const)('rejects $name at the public Action boundary before a manager effect', async ({ actionId, input }) => {
    const start = vi.fn(async () => ({ runId: 'run_started_1', callId: 'call_started_1', sidechainId: 'sidechain_started_1' }));
    const get = vi.fn(() => null);
    const send = vi.fn(async () => ({ ok: true }));
    const ensure = vi.fn(async () => ({ ok: true }));
    const startTurnStream = vi.fn(async () => ({ ok: true as const, streamId: 'stream_1' }));
    const readTurnStream = vi.fn(async () => ({ ok: true as const, streamId: 'stream_1', events: [], nextCursor: 0, done: true }));
    const cancelTurnStream = vi.fn(async () => ({ ok: true as const }));
    const stop = vi.fn(async () => ({ ok: true }));
    const applyAction = vi.fn(async () => ({ ok: true }));
    const executor = createExecutionRunRpcActionExecutor({
      manager: {
        ...createUnusedExecutionRunBridge(),
        start,
        get,
        send,
        ensure,
        startTurnStream,
        readTurnStream,
        cancelTurnStream,
        stop,
        applyAction,
      },
      context: { sessionId: 'sess_1', cwd: '/workspace' },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
          maxDepth: 3,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    await expect(executor.execute(actionId, input, { surface: 'rpc' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'execution_run_scope_mismatch',
    });

    for (const effect of [start, get, send, ensure, startTurnStream, readTurnStream, cancelTurnStream, stop, applyAction]) {
      expect(effect).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['execution.run.send', { sessionId: 'sess_1', runId: 'run_foreign_1', message: 'Continue' }],
    ['execution.run.ensure', { sessionId: 'sess_1', runId: 'run_foreign_1' }],
    ['execution.run.ensure_or_start', { sessionId: 'sess_1', runId: 'run_foreign_1' }],
    ['execution.run.stream.start', { sessionId: 'sess_1', runId: 'run_foreign_1', message: 'Continue' }],
    ['execution.run.stream.read', { sessionId: 'sess_1', runId: 'run_foreign_1', streamId: 'stream_foreign_1', cursor: 0 }],
    ['execution.run.stream.cancel', { sessionId: 'sess_1', runId: 'run_foreign_1', streamId: 'stream_foreign_1' }],
    ['execution.run.stop', { sessionId: 'sess_1', runId: 'run_foreign_1' }],
    ['execution.run.action', { sessionId: 'sess_1', runId: 'run_foreign_1', actionId: 'task.commit', input: {} }],
  ] as const)('does not mutate a foreign run through %s when the outer scope is authoritative', async (actionId, input) => {
    const foreignRun = {
      runId: 'run_foreign_1',
      callId: 'call_foreign_1',
      sidechainId: 'sidechain_foreign_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      status: 'running',
      startedAtMs: 1,
      sessionId: 'sess_foreign',
      depth: 0,
      backendId: 'codex',
      instructions: 'Foreign run.',
    } satisfies ExecutionRunState;
    const start = vi.fn(async () => ({ runId: 'run_started_1', callId: 'call_started_1', sidechainId: 'sidechain_started_1' }));
    const send = vi.fn(async () => ({ ok: true }));
    const ensure = vi.fn(async () => ({ ok: true }));
    const startTurnStream = vi.fn(async () => ({ ok: true as const, streamId: 'stream_1' }));
    const readTurnStream = vi.fn(async () => ({ ok: true as const, streamId: 'stream_1', events: [], nextCursor: 0, done: true }));
    const cancelTurnStream = vi.fn(async () => ({ ok: true as const }));
    const stop = vi.fn(async () => ({ ok: true }));
    const applyAction = vi.fn(async () => ({ ok: true }));
    const executor = createExecutionRunRpcActionExecutor({
      manager: {
        ...createUnusedExecutionRunBridge(),
        get: (runId) => runId === foreignRun.runId ? foreignRun : null,
        start,
        send,
        ensure,
        startTurnStream,
        readTurnStream,
        cancelTurnStream,
        stop,
        applyAction,
      },
      context: { sessionId: 'sess_1', cwd: '/workspace' },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
          maxDepth: 3,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    await expect(executor.execute(actionId, input, { surface: 'rpc' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'execution_run_not_found',
    });

    for (const effect of [start, send, ensure, startTurnStream, readTurnStream, cancelTurnStream, stop, applyAction]) {
      expect(effect).not.toHaveBeenCalled();
    }
  });

  it('keeps a nested ensure-or-start request at its already-authorized scope', async () => {
    const start = vi.fn(async () => ({
      runId: 'run_scoped_1',
      callId: 'call_scoped_1',
      sidechainId: 'sidechain_scoped_1',
    }));
    const deps = createExecutionRunRpcActionDeps({
      manager: {
        ...createUnusedExecutionRunBridge(),
        start,
      },
      context: { sessionId: 'sess_1', cwd: '/workspace' },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
          maxDepth: 3,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });
    const ensureOrStart = deps.executionRunEnsureOrStart;
    if (!ensureOrStart) throw new Error('executionRunEnsureOrStart is required');

    await expect(ensureOrStart('sess_1', {
      start: {
        ...AGENT_EXECUTION_RUN_START_REQUEST,
        // This raw nested value is not scope authority; the outer operation is.
        sessionId: null,
      },
    })).resolves.toEqual({ ok: true, runId: 'run_scoped_1', created: true });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess_1' }));
  });

  it('distinguishes daemon setup failure before manager.start from an unclassified manager failure', async () => {
    const preStart = vi.fn(async () => ({
      runId: 'run_pre_start',
      callId: 'call_pre_start',
      sidechainId: 'side_pre_start',
    }));
    const preStartExecutor = createExecutionRunRpcActionExecutor({
      manager: { ...createUnusedExecutionRunBridge(), start: preStart },
      context: {
        sessionId: 'sess_1',
        cwd: '/workspace',
        resolveAccountSettings: async () => {
          throw new Error('settings unavailable');
        },
      },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
          maxDepth: 3,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    await expect(preStartExecutor.execute(
      'execution.run.start',
      AGENT_EXECUTION_RUN_START_REQUEST,
      { surface: 'rpc' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_failed',
      error: 'settings unavailable',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    expect(preStart).not.toHaveBeenCalled();

    const managerStart = vi.fn(async () => {
      throw new Error('manager disconnected');
    });
    const postStartExecutor = createAgentExecutionRunStartExecutor(managerStart);

    await expect(postStartExecutor.execute(
      'execution.run.start',
      AGENT_EXECUTION_RUN_START_REQUEST,
      { surface: 'rpc' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'execution_run_failed',
      error: 'manager disconnected',
      details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
    });
  });

  it('keeps an agent-started execution run at its active turn ceiling after the session mode widens', async () => {
    const start = vi.fn(async () => ({
      runId: 'run_causal_1',
      callId: 'call_causal_1',
      sidechainId: 'side_causal_1',
    }));
    const executor = createAgentExecutionRunStartExecutor(start);
    const firstTurnAuthority = {
      kind: 'admittedSessionInputV1',
      admittedPermissionCeiling: 'default',
    } as const;
    const laterTurnAuthority = {
      kind: 'admittedSessionInputV1',
      admittedPermissionCeiling: 'yolo',
    } as const;

    await expect(executor.execute(
      'execution.run.start',
      AGENT_EXECUTION_RUN_START_REQUEST,
      {
        surface: 'agent',
        // The mutable Session mode has widened after the first turn was admitted.
        callerPermissionMode: 'yolo',
        causalPermissionAuthority: firstTurnAuthority,
      } as unknown as Parameters<typeof executor.execute>[2],
    )).resolves.toEqual({
      ok: true,
      result: {
        runId: 'run_causal_1',
        callId: 'call_causal_1',
        sidechainId: 'side_causal_1',
      },
    });

    await expect(executor.execute(
      'execution.run.start',
      AGENT_EXECUTION_RUN_START_REQUEST,
      {
        surface: 'agent',
        callerPermissionMode: 'yolo',
        // A later independently admitted turn may carry a new ceiling.
        causalPermissionAuthority: laterTurnAuthority,
      } as unknown as Parameters<typeof executor.execute>[2],
    )).resolves.toEqual({
      ok: true,
      result: {
        runId: 'run_causal_1',
        callId: 'call_causal_1',
        sidechainId: 'side_causal_1',
      },
    });

    expect(start).toHaveBeenNthCalledWith(1, expect.objectContaining({
      permissionMode: 'default',
      causalPermissionAuthority: firstTurnAuthority,
    }));
    expect(start).toHaveBeenNthCalledWith(2, expect.objectContaining({
      permissionMode: 'yolo',
      causalPermissionAuthority: laterTurnAuthority,
    }));
  });

  it('does not start an agent execution run when its active-turn authority is missing or malformed', async () => {
    const start = vi.fn(async () => ({
      runId: 'run_causal_missing_1',
      callId: 'call_causal_missing_1',
      sidechainId: 'side_causal_missing_1',
    }));
    const executor = createAgentExecutionRunStartExecutor(start);

    await expect(executor.execute(
      'execution.run.start',
      AGENT_EXECUTION_RUN_START_REQUEST,
      {
        surface: 'agent',
        callerPermissionMode: 'yolo',
        causalPermissionAuthority: null,
      } as unknown as Parameters<typeof executor.execute>[2],
    )).resolves.toEqual({
      ok: false,
      errorCode: 'causal_permission_authority_invalid',
      error: 'causal_permission_authority_invalid',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });

    await expect(executor.execute(
      'execution.run.start',
      AGENT_EXECUTION_RUN_START_REQUEST,
      {
        surface: 'agent',
        callerPermissionMode: 'yolo',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'not-a-permission-mode',
        },
      } as unknown as Parameters<typeof executor.execute>[2],
    )).resolves.toEqual({
      ok: false,
      errorCode: 'causal_permission_authority_invalid',
      error: 'causal_permission_authority_invalid',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });

    expect(start).not.toHaveBeenCalled();
  });

  it('uses the incumbent waiter for an exact detached start-and-wait without dispatching a second run', async () => {
    const start = vi.fn(async () => ({
      runId: 'run_detached_1',
      callId: 'call_detached_1',
      sidechainId: 'sidechain_detached_1',
    }));
    const publicRun = {
      runId: 'run_detached_1',
      callId: 'call_detached_1',
      sidechainId: 'sidechain_detached_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      status: 'succeeded',
      startedAtMs: 1,
      finishedAtMs: 2,
    } satisfies ExecutionRunPublicState;
    const runState = {
      ...publicRun,
      sessionId: null,
      depth: 0,
      backendId: 'codex',
      instructions: 'Summarize the change.',
    } satisfies ExecutionRunState;
    const getPublic = vi.fn(() => publicRun);
    const executor = createExecutionRunRpcActionExecutor({
      manager: {
        ...createUnusedExecutionRunBridge(),
        start,
        get: (runId) => runId === publicRun.runId ? runState : null,
        getPublic,
      },
      context: { sessionId: null, cwd: '/workspace' },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
          maxDepth: 3,
        },
      }),
      isExecutionRunsEnabled: () => true,
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
      waitForCompletion: true,
      waitTimeoutSeconds: 5,
    }, { surface: 'rpc' })).resolves.toEqual({
      ok: true,
      result: {
        runId: 'run_detached_1',
        callId: 'call_detached_1',
        sidechainId: 'sidechain_detached_1',
        wait: {
          ok: true,
          status: 'succeeded',
          result: {
            run: {
              runId: publicRun.runId,
              status: publicRun.status,
            },
          },
        },
      },
    });

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null }));
    expect(getPublic).toHaveBeenCalledWith('run_detached_1');
  });

  it('times out detached observation without stopping or dispatching the admitted run again', async () => {
    vi.useFakeTimers();
    try {
      const start = vi.fn(async () => ({
        runId: 'run_detached_waiting_1',
        callId: 'call_detached_waiting_1',
        sidechainId: 'sidechain_detached_waiting_1',
      }));
      const stop = vi.fn(async () => ({ ok: true }));
      const publicRun = {
        runId: 'run_detached_waiting_1',
        callId: 'call_detached_waiting_1',
        sidechainId: 'sidechain_detached_waiting_1',
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        status: 'running',
        startedAtMs: 1,
      } satisfies ExecutionRunPublicState;
      const runState = {
        ...publicRun,
        sessionId: null,
        depth: 0,
        backendId: 'codex',
        instructions: 'Summarize the change.',
      } satisfies ExecutionRunState;
      const executor = createExecutionRunRpcActionExecutor({
        manager: {
          ...createUnusedExecutionRunBridge(),
          start,
          stop,
          get: (runId) => runId === publicRun.runId ? runState : null,
          getPublic: (runId) => runId === publicRun.runId ? publicRun : null,
        },
        context: { sessionId: null, cwd: '/workspace' },
        policy: resolveExecutionRunPolicy({
          defaults: {
            maxConcurrentRuns: null,
            boundedTimeoutMs: null,
            reviewBoundedTimeoutMs: null,
            maxTurns: null,
            maxDepth: 3,
          },
        }),
        isExecutionRunsEnabled: () => true,
      });

      const result = executor.execute('execution.run.start', {
        sessionId: null,
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        instructions: 'Summarize the change.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        waitForCompletion: true,
        waitTimeoutSeconds: 1,
      }, { surface: 'rpc' });

      await vi.advanceTimersByTimeAsync(0);
      expect(start).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(result).resolves.toEqual({
        ok: true,
        result: {
          runId: 'run_detached_waiting_1',
          callId: 'call_detached_waiting_1',
          sidechainId: 'sidechain_detached_waiting_1',
          wait: { ok: false, code: 'timeout' },
        },
      });
      expect(start).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the canonical voice.agent dependency blocker when root voice is disabled', async () => {
    vi.stubEnv('HAPPIER_FEATURE_VOICE__ENABLED', '1');
    vi.stubEnv('HAPPIER_FEATURE_VOICE_AGENT__ENABLED', '1');
    const start = vi.fn(async () => ({
      runId: 'run_voice',
      callId: 'call_voice',
      sidechainId: 'sidechain_voice',
    }));

    try {
      const executor = createExecutionRunRpcActionExecutor({
        manager: {
          ...createUnusedExecutionRunBridge(),
          start,
        },
        context: {
          sessionId: 'sess_1',
          cwd: '/workspace',
          getServerFeaturesSnapshot: () => readyServerFeatures({
            execution: { enabled: true, runs: { enabled: true } },
            voice: { enabled: false, agent: { enabled: true } },
          }),
        },
        policy: resolveExecutionRunPolicy({
          defaults: {
            maxConcurrentRuns: null,
            boundedTimeoutMs: null,
            reviewBoundedTimeoutMs: null,
            maxTurns: null,
            maxDepth: 3,
          },
        }),
        isExecutionRunsEnabled: () => true,
      });

      const result = await executor.execute('execution.run.start', {
        sessionId: 'sess_1',
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Voice turn.',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
      }, { surface: 'rpc', defaultSessionId: 'sess_1' });

      expect(result).toEqual({
        ok: false,
        error: 'Voice feature disabled',
        errorCode: 'execution_run_not_allowed',
        details: {
          executionRunStart: { v: 1, runCreation: 'noRunCreated' },
        },
      });
      expect(start).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses voice-agent starts when voice.agent local policy is disabled even if root voice is enabled', async () => {
    vi.stubEnv('HAPPIER_FEATURE_VOICE__ENABLED', '1');
    vi.stubEnv('HAPPIER_FEATURE_VOICE_AGENT__ENABLED', '0');
    const start = vi.fn(async () => ({
      runId: 'run_voice',
      callId: 'call_voice',
      sidechainId: 'sidechain_voice',
    }));

    try {
      const executor = createExecutionRunRpcActionExecutor({
        manager: {
          ...createUnusedExecutionRunBridge(),
          start,
        },
        context: {
          sessionId: 'sess_1',
          cwd: '/workspace',
          getServerFeaturesSnapshot: () => readyServerFeatures({
            execution: { enabled: true, runs: { enabled: true } },
            voice: { enabled: true, agent: { enabled: true } },
          }),
        },
        policy: resolveExecutionRunPolicy({
          defaults: {
            maxConcurrentRuns: null,
            boundedTimeoutMs: null,
            reviewBoundedTimeoutMs: null,
            maxTurns: null,
            maxDepth: 3,
          },
        }),
        isExecutionRunsEnabled: () => true,
      });

      const result = await executor.execute('execution.run.start', {
        sessionId: 'sess_1',
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Voice turn.',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
      }, { surface: 'rpc', defaultSessionId: 'sess_1' });

      expect(result).toEqual({
        ok: false,
        error: 'Voice feature disabled',
        errorCode: 'execution_run_not_allowed',
        details: {
          executionRunStart: { v: 1, runCreation: 'noRunCreated' },
        },
      });
      expect(start).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('starts voice-agent runs when the canonical voice.agent decision is enabled', async () => {
    vi.stubEnv('HAPPIER_FEATURE_VOICE__ENABLED', '1');
    vi.stubEnv('HAPPIER_FEATURE_VOICE_AGENT__ENABLED', '1');
    const start = vi.fn(async () => ({
      runId: 'run_voice',
      callId: 'call_voice',
      sidechainId: 'sidechain_voice',
    }));

    try {
      const executor = createExecutionRunRpcActionExecutor({
        manager: {
          ...createUnusedExecutionRunBridge(),
          start,
        },
        context: {
          sessionId: 'sess_1',
          cwd: '/workspace',
          getServerFeaturesSnapshot: () => readyServerFeatures({
            execution: { enabled: true, runs: { enabled: true } },
            voice: { enabled: true, agent: { enabled: true } },
          }),
        },
        policy: resolveExecutionRunPolicy({
          defaults: {
            maxConcurrentRuns: null,
            boundedTimeoutMs: null,
            reviewBoundedTimeoutMs: null,
            maxTurns: null,
            maxDepth: 3,
          },
        }),
        isExecutionRunsEnabled: () => true,
      });

      const result = await executor.execute('execution.run.start', {
        sessionId: 'sess_1',
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Voice turn.',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
      }, { surface: 'rpc', defaultSessionId: 'sess_1' });

      expect(result).toEqual({
        ok: true,
        result: {
          runId: 'run_voice',
          callId: 'call_voice',
          sidechainId: 'sidechain_voice',
        },
      });
      expect(start).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('routes local-services runtime actions through execution-run RPC local-service routes when available', async () => {
    const snapshot = {
      v: 1 as const,
      machineId: 'machine_1',
      generatedAt: 2_000,
      refreshState: 'idle' as const,
      entries: [],
      diagnostics: [],
    };
    const inventoryRoutes = {
      getSnapshot: vi.fn(async () => snapshot),
      refreshSnapshot: vi.fn(async () => snapshot),
    };
    const executor = createExecutionRunRpcActionExecutor({
      manager: createUnusedExecutionRunBridge(),
      context: {
        sessionId: 'sess_1',
        cwd: '/workspace',
        localServices: { inventoryRoutes },
        getServerFeaturesSnapshot: () => LOCAL_SERVICES_RUNTIME_ACTIONS_ENABLED,
      },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
          maxDepth: 3,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    const result = await executor.execute('localServices.inventory.list', {
      machineId: 'machine_1',
    }, APPROVED_INTERNAL_RUNTIME_ACTION_CONTEXT);

    expect(result).toEqual({ ok: true, result: snapshot });
    expect(inventoryRoutes.getSnapshot).toHaveBeenCalledOnce();
    expect(inventoryRoutes.refreshSnapshot).not.toHaveBeenCalled();
  });

  it('routes local-services launcher start through execution-run RPC local-service routes when available', async () => {
    const launcherResponse = {
      protocolVersion: 1 as const,
      machineId: 'machine_1',
      targetId: 'managed:web',
      status: 'denied' as const,
      reasonCode: 'launcher_start_unsupported',
      snapshot: {
        v: 1 as const,
        machineId: 'machine_1',
        sessionId: 'sess_1',
        updatedAt: 2_000,
        targets: [],
      },
    };
    const launcherRoutes = {
      getSnapshot: vi.fn(),
      startTarget: vi.fn(async () => launcherResponse),
    };
    const executor = createExecutionRunRpcActionExecutor({
      manager: createUnusedExecutionRunBridge(),
      context: {
        sessionId: 'sess_1',
        cwd: '/workspace',
        localServices: { launcherRoutes },
        getServerFeaturesSnapshot: () => LOCAL_SERVICES_RUNTIME_ACTIONS_ENABLED,
      },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
          maxDepth: 3,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    const request = {
      machineId: 'machine_1',
      targetId: 'managed:web',
      sessionId: 'sess_1',
    };
    const result = await executor.execute(
      'localServices.launcher.start',
      request,
      APPROVED_INTERNAL_RUNTIME_ACTION_CONTEXT,
    );

    expect(result).toEqual({ ok: true, result: launcherResponse });
    expect(launcherRoutes.startTarget).toHaveBeenCalledWith(request);
    expect(launcherRoutes.getSnapshot).not.toHaveBeenCalled();
  });

  it('routes simulator runtime actions through execution-run RPC simulator routes when available', async () => {
    const snapshot = {
      v: 1 as const,
      machineId: 'machine_1',
      generatedAt: 2_000,
      refreshState: 'idle' as const,
      resources: [],
      diagnostics: [],
    };
    const simulatorPreview = {
      getSnapshot: vi.fn(async () => snapshot),
      dispatchAction: vi.fn(),
    };
    const executor = createExecutionRunRpcActionExecutor({
      manager: createUnusedExecutionRunBridge(),
      context: {
        sessionId: 'sess_1',
        cwd: '/workspace',
        simulatorPreview,
        getServerFeaturesSnapshot: () => SIMULATOR_RUNTIME_ACTIONS_ENABLED,
      },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
          maxDepth: 3,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    const result = await executor.execute('devices.simulator.list', {
      type: 'simulator.devices.list',
    }, APPROVED_INTERNAL_RUNTIME_ACTION_CONTEXT);

    expect(result).toEqual({ ok: true, result: snapshot });
    expect(simulatorPreview.getSnapshot).toHaveBeenCalledOnce();
    expect(simulatorPreview.dispatchAction).not.toHaveBeenCalled();
  });

  it('installs a fail-closed runtime action executor bridge', async () => {
    const executor = createExecutionRunRpcActionExecutor({
      manager: createUnusedExecutionRunBridge(),
      context: {
        sessionId: 'sess_1',
        cwd: '/workspace',
      },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
          maxDepth: 3,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    const result = await executor.execute('browser.navigate', {
      commandId: 'cmd_1',
      kind: 'navigate',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      url: 'https://example.com',
    }, APPROVED_INTERNAL_RUNTIME_ACTION_CONTEXT);

    expect(result).toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_control_route_unavailable',
    });
  });

  it('routes browser control through an injected daemon control route', async () => {
    const dispatchCommand = vi.fn(async (command: unknown) => {
      const parsed = BrowserCommandV1Schema.parse(command);
      return {
        v: 1 as const,
        commandId: parsed.commandId,
        status: 'dispatched' as const,
        adapterKind: 'chromiumSidecar' as const,
        events: [],
      };
    });
    const executor = createExecutionRunRpcActionExecutor({
      manager: createUnusedExecutionRunBridge(),
      context: {
        sessionId: 'sess_1',
        cwd: '/workspace',
        browserControl: { dispatchCommand },
        getServerFeaturesSnapshot: () => BROWSER_CONTROL_RUNTIME_ACTIONS_ENABLED,
      },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
          maxDepth: 3,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });
    const command = {
      commandId: 'cmd_1',
      kind: 'navigate',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      url: 'https://example.com',
    };

    const result = await executor.execute(
      'browser.navigate',
      command,
      APPROVED_INTERNAL_RUNTIME_ACTION_CONTEXT,
    );

    expect(result).toEqual({
      ok: true,
      result: {
        v: 1,
        commandId: 'cmd_1',
        status: 'dispatched',
        adapterKind: 'chromiumSidecar',
        events: [],
      },
    });
    expect(dispatchCommand).toHaveBeenCalledWith(command);
  });

  it('routes execution.run.action runtime ids through the canonical daemon runtime executor', async () => {
    const diagnosticSnapshot = {
      v: 1 as const,
      machineId: 'machine_1',
      generatedAt: 2_000,
      refreshState: 'idle' as const,
      events: [],
      diagnostics: [],
    };
    const diagnostics = {
      dispatch: vi.fn(async () => diagnosticSnapshot),
    };
    const applyAction = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'execution_run_action_not_supported',
      error: 'profile action unsupported',
    }));
    const executor = createExecutionRunRpcActionExecutor({
      manager: createExecutionRunBridgeWithRun({ applyAction }),
      context: {
        sessionId: 'sess_1',
        cwd: '/workspace',
        browserDiagnostics: diagnostics,
        getServerFeaturesSnapshot: () => BROWSER_DIAGNOSTICS_RUNTIME_ACTIONS_ENABLED,
      },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
          maxDepth: 3,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    const result = await executor.execute('execution.run.action', {
      runId: 'run_1',
      actionId: 'browser.diagnostics.snapshot',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }, { surface: 'rpc', defaultSessionId: 'sess_1' });

    expect(result).toEqual({
      ok: true,
      result: {
        ok: true,
        result: diagnosticSnapshot,
      },
    });
    expect(diagnostics.dispatch).toHaveBeenCalledWith('browser.diagnostics.snapshot', {
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
    });
    expect(applyAction).not.toHaveBeenCalled();
  });

  it('refuses execution.run.action mutating browser runtime ids until agent approval is granted', async () => {
    const automationDispatch = vi.fn<BrowserAutomationRoutes['dispatch']>(async () => ({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'unexpected_automation_dispatch',
    }));
    const approvalsCreate = vi.fn<NonNullable<ExecutionRunRpcApprovalDeps['approvalsCreate']>>(
      async () => ({ artifactId: 'approval_browser_click' }),
    );
    const approvalsWaitForDecision = vi.fn<NonNullable<ExecutionRunRpcApprovalDeps['approvalsWaitForDecision']>>(
      async ({ request }) => ({
        decision: 'reject',
        request: {
          ...request,
          status: 'rejected',
          decision: { kind: 'reject', decidedAtMs: 2 },
          updatedAtMs: 2,
        },
      }),
    );
    const approvalsUpdate = vi.fn<NonNullable<ExecutionRunRpcApprovalDeps['approvalsUpdate']>>(
      async () => ({ ok: true }),
    );
    const executor = createExecutionRunRpcActionExecutor({
      manager: createExecutionRunBridgeWithRun(),
      context: {
        sessionId: 'sess_1',
        cwd: '/workspace',
        browserAutomation: { dispatch: automationDispatch },
        getServerFeaturesSnapshot: () => BROWSER_AUTOMATION_RUNTIME_ACTIONS_ENABLED,
      },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
          maxDepth: 3,
        },
      }),
      isExecutionRunsEnabled: () => true,
      approvalDeps: {
        approvalsCreate,
        approvalsWaitForDecision,
        approvalsUpdate,
      },
    });

    const result = await executor.execute('execution.run.action', {
      runId: 'run_1',
      actionId: 'browser.automation.click',
      input: {
        v: 1,
        automationRequestId: 'automation_1',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        navigationGeneration: 1,
        actionKind: 'click',
        requestedBy: 'agent',
        requesterRef: { kind: 'agent', id: 'agent_1' },
        payload: { selector: '#submit' },
        timeoutMs: 5_000,
      },
    }, { surface: 'rpc', defaultSessionId: 'sess_1' });

    expect(result).toEqual({
      ok: false,
      errorCode: 'approval_rejected',
      error: 'approval_rejected',
    });
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        actionId: 'browser.automation.click',
        createdBy: expect.objectContaining({ surface: 'agent', sessionId: 'sess_1' }),
        requestedSurface: 'agent',
      }),
    }));
    expect(approvalsWaitForDecision).toHaveBeenCalledOnce();
    expect(automationDispatch).not.toHaveBeenCalled();
  });

  it('keeps execution.run.action runtime ids fail-closed when the browser gate is absent', async () => {
    const diagnostics = {
      dispatch: vi.fn(async () => ({ unreachable: true })),
    };
    const executor = createExecutionRunRpcActionExecutor({
      manager: createExecutionRunBridgeWithRun(),
      context: {
        sessionId: 'sess_1',
        cwd: '/workspace',
        browserDiagnostics: diagnostics,
      },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
          maxDepth: 3,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    const result = await executor.execute('execution.run.action', {
      runId: 'run_1',
      actionId: 'browser.diagnostics.snapshot',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }, { surface: 'rpc', defaultSessionId: 'sess_1' });

    expect(result).toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_diagnostics_route_unavailable',
    });
    expect(diagnostics.dispatch).not.toHaveBeenCalled();
  });
});
