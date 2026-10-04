import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserCommandV1Schema,
  buildBackendTargetKeyV2,
  FeaturesResponseSchema,
  normalizeActionsSettingsV1,
  type ExecutionRunPublicState,
} from '@happier-dev/protocol';

import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import type { ExecutionRunHostBridgeContract } from '@/agent/runtime/bridges/executionRun/executionRunBridgeContract';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { BrowserAutomationRoutes } from '@/daemon/browser/automation/routes';
import type { BrowserUiAutomationRouteOwner } from '@/daemon/runtimeActionExecutor';
import { createBrowserDaemonControlBroker } from '@/daemon/browser/control/broker';
import { createBrowserAutomationReverseDispatcher } from '@/daemon/browser/automation/reverseDispatch';
import type { CliServerFeaturesSnapshot } from '@/features/featureDecisionService';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createScopedRuntimeActionSettingsProvider } from '@/settings/scopedRuntimeActionSettingsProvider';

import {
  createExecutionRunRpcActionDeps,
  createExecutionRunRpcActionExecutor,
  type ExecutionRunRpcApprovalDeps,
} from './dispatchExecutionRunRpcAction';

afterEach(() => {
  vi.unstubAllEnvs();
});

function unusedBridgeMethod(): never {
  throw new Error('execution-run bridge should not be used for unavailable runtime action families');
}

function createUnusedExecutionRunBridge(): ExecutionRunHostBridgeContract {
  return {
    recoverRetainedRuns: async () => {},
    get: () => null,
    getRunningCount: () => 0,
    getStructuredMeta: () => null,
    getLatestToolResult: () => null,
    waitForTerminal: async () => unusedBridgeMethod(),
    waitForRunStateChange: async () => unusedBridgeMethod(),
    waitForInputTurn: async () => unusedBridgeMethod(),
    waitForOutput: async () => unusedBridgeMethod(),
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
    cancelCurrentTurn: async () => unusedBridgeMethod(),
    respondToPermissionRequest: async () => unusedBridgeMethod(),
    completePermissionRequest: async () => unusedBridgeMethod(),
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
  surface: 'agent',
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

// Authenticated host facts are input to real admission, not a mocked policy owner.
const CURRENT_SESSION_AGENT_START_CONTEXT = {
  caller: { kind: 'session', sessionId: 'sess_1', starterDepth: 0, turnDepth: 0 },
  baseline: { machineId: 'machine_1', directory: '/workspace' },
  roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'yolo',
} as const;
const CURRENT_AGENT_TARGET = {
  kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
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
      },
    }),
    isExecutionRunsEnabled: () => true,
  });
}

describe('execution-run RPC Action settings provider', () => {
  it('uses scoped runtime enablement when the endpoint environment permits the Action', async () => {
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({ v: 1, actions: {} }));
    const listPublicForRequest = vi.fn(() => []);
    const params = {
      manager: createExecutionRunBridgeWithRun({ listPublicForRequest }),
      context: { sessionId: 'sess_1', cwd: '/workspace' },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
        },
      }),
      isExecutionRunsEnabled: () => true,
      actionsSettingsProvider: createScopedRuntimeActionSettingsProvider(
        normalizeActionsSettingsV1({
          v: 1,
          actions: { 'execution.run.list': { enabled: false } },
        }),
      ),
    };
    const executor = createExecutionRunRpcActionExecutor(params);

    await expect(executor.execute('execution.run.list', { sessionId: 'sess_1' }, {
      surface: 'agent',
      authority: 'account_automation',
      defaultSessionId: 'sess_1',
    })).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(listPublicForRequest).not.toHaveBeenCalled();
  });

  it('uses scoped runtime approval policy when the endpoint environment waives approval', async () => {
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({
      v: 1,
      actions: {},
      approvalWaivedSurfaces: { 'execution.run.list': ['agent'] },
    }));
    const listPublicForRequest = vi.fn(() => []);
    const approvalsCreate = vi.fn<NonNullable<ExecutionRunRpcApprovalDeps['approvalsCreate']>>(
      async () => ({ artifactId: 'approval_execution_run_list' }),
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
    const params = {
      manager: createExecutionRunBridgeWithRun({ listPublicForRequest }),
      context: { sessionId: 'sess_1', cwd: '/workspace' },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
        },
      }),
      isExecutionRunsEnabled: () => true,
      actionsSettingsProvider: createScopedRuntimeActionSettingsProvider(
        normalizeActionsSettingsV1({
          v: 1,
          actions: { 'execution.run.list': { approvalRequiredSurfaces: ['agent'] } },
        }),
      ),
      approvalDeps: { approvalsCreate, approvalsWaitForDecision, approvalsUpdate },
    };
    const executor = createExecutionRunRpcActionExecutor(params);

    await expect(executor.execute('execution.run.list', { sessionId: 'sess_1' }, {
      surface: 'agent',
      authority: 'account_automation',
      defaultSessionId: 'sess_1',
      serverId: 'server-1',
      runtimeAccountId: 'account-1',
      actionRequestId: 'execution-run-list-request-1',
    })).resolves.toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    expect(approvalsCreate).toHaveBeenCalledOnce();
    expect(approvalsWaitForDecision).toHaveBeenCalledOnce();
    expect(listPublicForRequest).not.toHaveBeenCalled();
  });

  it('retains environment overrides through the ordinary Account settings provider', async () => {
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({
      v: 1,
      actions: { 'execution.run.list': { enabled: false } },
    }));
    const listPublicForRequest = vi.fn(() => []);
    const params = {
      manager: createExecutionRunBridgeWithRun({ listPublicForRequest }),
      context: { sessionId: 'sess_1', cwd: '/workspace' },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
        },
      }),
      isExecutionRunsEnabled: () => true,
      actionsSettingsProvider: createActionSettingsProvider(),
    };
    const executor = createExecutionRunRpcActionExecutor(params);

    await expect(executor.execute('execution.run.list', { sessionId: 'sess_1' }, {
      surface: 'agent',
      authority: 'account_automation',
      defaultSessionId: 'sess_1',
    })).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(listPublicForRequest).not.toHaveBeenCalled();
  });
});

describe('createExecutionRunRpcActionExecutor', () => {
  it('resolves the current UI automation owner for Session actions and refuses after provider retirement', async () => {
    const broker = createBrowserDaemonControlBroker();
    const calls: unknown[] = [];
    let owner: BrowserUiAutomationRouteOwner | null = {
      ownsAutomationView: broker.ownsView,
      uiAutomation: createBrowserAutomationReverseDispatcher({ getMachineClient: () => ({
        hasConnectedClientRpcHandler: () => true,
        callConnectedClientRpc: async (_method, input) => {
          calls.push(input);
          return { ok: true, result: { v: 1, outcome: 'no_active', canceledCount: 0 } };
        },
      }) }),
    };
    const deps = createExecutionRunRpcActionDeps({
      manager: createUnusedExecutionRunBridge(),
      context: { sessionId: 'sess_1', cwd: '/workspace', getBrowserUiAutomation: () => owner,
        getServerFeaturesSnapshot: () => BROWSER_DIAGNOSTICS_RUNTIME_ACTIONS_ENABLED },
      policy: resolveExecutionRunPolicy({ defaults: {
        maxConcurrentRuns: null, boundedTimeoutMs: null, reviewBoundedTimeoutMs: null, maxTurns: null,
      } }),
      isExecutionRunsEnabled: () => true,
    });
    const request = { actionId: 'browser.automation.cancelActive',
      input: { browserSessionId: 'session:sess_1:right-sidebar', viewId: 'visible-view' },
      context: { surface: 'agent', defaultSessionId: 'sess_1', authority: 'present_user' } } as const;
    expect(await deps.runtimeActionExecute?.(request)).toEqual({ v: 1, outcome: 'no_active', canceledCount: 0 });
    owner = null;
    expect(await deps.runtimeActionExecute?.(request)).toMatchObject({ errorCode: 'runtime_action_disabled' });
    expect(calls).toEqual([{ v: 1, sessionId: 'sess_1', actionId: request.actionId, input: request.input, authority: 'present_user' }]);
  });

  it('binds the exact Workflow observation sink to a detached start with a local input id', async () => {
    const workflowObservationSink = { commit: vi.fn(async () => undefined) };
    const start = vi.fn(async () => ({
      runId: 'run_detached_1', callId: 'call_detached_1', sidechainId: 'sidechain_detached_1',
    }));
    const deps = createExecutionRunRpcActionDeps({
      manager: { ...createUnusedExecutionRunBridge(), start },
      context: { sessionId: null, cwd: '/workspace' },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null, boundedTimeoutMs: null, reviewBoundedTimeoutMs: null,
          maxTurns: null
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    await expect(deps.executionRunStart?.(null, {
      ...AGENT_EXECUTION_RUN_START_REQUEST,
      sessionId: null,
      localInputId: 'workflow-input-1',
    }, { workflowObservationSink })).resolves.toMatchObject({ runId: 'run_detached_1' });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      localInputId: 'workflow-input-1',
      workflowObservationSink,
    }));
  });

  it('forwards the exact detached send interaction and Workflow observation owners to the retained turn', async () => {
    const structuredInput = {
      v: 1 as const,
      mentions: [{
        kind: 'happier.file',
        ref: 'file:src/index.ts',
        token: '@src/index.ts',
        label: 'index.ts',
      }],
    };
    const permissionRequestStore = {
      publishRequest: vi.fn(async () => undefined),
      publishRequestAndWait: vi.fn(async () => ({
        requestId: 'permission_1',
        status: 'approved' as const,
        decision: 'approved' as const,
        completedAt: 2,
      })),
      registerResponseTargetHandler: vi.fn(() => () => undefined),
    };
    const workflowObservationSink = { commit: vi.fn(async () => undefined) };
    const send = vi.fn(async () => ({ ok: true }));
    const run = {
      runId: 'run_detached_1',
      callId: 'call_detached_1',
      sidechainId: 'sidechain_detached_1',
      intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      status: 'running',
      startedAtMs: 1,
      sessionId: null,
      depth: 0,
      backendId: 'codex',
      instructions: 'Continue the workflow.',
    } satisfies ExecutionRunState;
    const deps = createExecutionRunRpcActionDeps({
      manager: {
        ...createUnusedExecutionRunBridge(),
        get: (runId) => runId === run.runId ? run : null,
        send,
      },
      context: { sessionId: null, cwd: '/workspace' },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    await expect(deps.detachedExecutionRunSend?.(null, {
      sessionId: null,
      runId: run.runId,
      message: 'Continue',
      localInputId: 'workflow-input-b',
      structuredInput,
    }, { permissionRequestStore, workflowObservationSink })).resolves.toEqual({ ok: true });

    expect(send).toHaveBeenCalledWith(run.runId, expect.objectContaining({
      message: 'Continue',
      localInputId: 'workflow-input-b',
      structuredInput,
      permissionRequestStore,
      workflowObservationSink,
    }));
  });

  it('routes Session-owned Run listing through the injected scoped runtime list dependency', async () => {
    const sessionList = vi.fn(async () => ({
      sessions: [],
      nextCursor: 'cursor_v1_next',
      hasNext: true,
      attentionNextCursor: 'cursor_v1_attention',
      attentionHasNext: true,
      queryVersion: 1,
    }));
    const query = {
      v: 1,
      storage: 'active',
      includeInactive: false,
      attention: 'any',
      scope: 'my_work',
      audiences: [],
      tagIds: [],
      limit: 17,
    } as const;
    const contextWithScopedList = { sessionId: 'sess_1', cwd: '/workspace', sessionList };
    const executor = createExecutionRunRpcActionExecutor({
      manager: createUnusedExecutionRunBridge(),
      context: contextWithScopedList,
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });
    await expect(executor.execute('session.list', { query, view: 'summary' }, {
      surface: 'agent',
      authority: 'account_automation',
      defaultSessionId: 'sess_1',
      runtimeAccountId: 'account-1',
      sessionListAccess: 'current_session',
      serverId: 'home-a',
      bypassApprovals: true,
    })).resolves.toMatchObject({
      ok: true,
      result: {
        sessions: [],
        nextCursor: 'cursor_v1_next',
        hasNext: true,
        attentionNextCursor: 'cursor_v1_attention',
        attentionHasNext: true,
        queryVersion: 1,
      },
    });
    expect(sessionList).toHaveBeenCalledWith(expect.objectContaining({
      query,
      view: 'summary',
      serverId: 'home-a',
    }));
  });

  it('keeps Session listing unavailable in the detached execution-run host', async () => {
    const sessionList = vi.fn(async () => ({ sessions: [] }));
    const contextWithUnsafeAccountList = { sessionId: null, cwd: '/workspace', sessionList };
    const executor = createExecutionRunRpcActionExecutor({
      manager: createUnusedExecutionRunBridge(),
      context: contextWithUnsafeAccountList,
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    await expect(executor.execute('session.list', {}, {
      surface: 'agent',
      authority: 'account_automation',
      bypassApprovals: true,
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.list',
    });
    expect(sessionList).not.toHaveBeenCalled();
  });

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

  it('keeps Discussion launch provenance in the fixed Session scope without treating it as authority', async () => {
    const start = vi.fn(async () => ({
      runId: 'run_started_1',
      callId: 'call_started_1',
      sidechainId: 'sidechain_started_1',
    }));
    const executor = createAgentExecutionRunStartExecutor(start);
    const launchOrigin = {
      kind: 'session_discussion',
      sessionId: 'sess_1',
      discussionId: 'discussion_1',
      messageIds: ['message_1'],
      draftCorrelationId: 'draft_1',
    } as const;

    await expect(executor.execute('execution.run.start', {
      ...AGENT_EXECUTION_RUN_START_REQUEST,
    }, {
      surface: 'rpc',
      defaultSessionId: 'sess_1',
      sessionInputSource: launchOrigin,
    })).resolves.toMatchObject({ ok: true });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ launchOrigin }));
  });

  it('accepts the canonical Agent target and lowers it at daemon admission', async () => {
    const start = vi.fn(async () => ({
      runId: 'run_started_1',
      callId: 'call_started_1',
      sidechainId: 'sidechain_started_1',
    }));
    const executor = createAgentExecutionRunStartExecutor(start);

    await expect(executor.execute('execution.run.start', {
      ...AGENT_EXECUTION_RUN_START_REQUEST,
      backendTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
    }, { surface: 'rpc', agentStartContext: CURRENT_SESSION_AGENT_START_CONTEXT })).resolves.toMatchObject({ ok: true });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    }));
  });

  it('admits attached deferred input and carries the Workflow request identity only to the Run manager', async () => {
    const start = vi.fn(async () => ({
      runId: 'run_workflow_1',
      callId: 'call_workflow_1',
      sidechainId: 'sidechain_workflow_1',
    }));
    const executor = createAgentExecutionRunStartExecutor(start);
    const actionCaller = {
      kind: 'workflowRun' as const,
      runId: 'workflow_run_1',
      authorization: {
        admittedPermissionCeiling: 'safe-yolo' as const,
        principal: { kind: 'host' as const },
      },
    };

    const result = await executor.execute('execution.run.start', {
      ...AGENT_EXECUTION_RUN_START_REQUEST,
      intent: 'agent',
      backendTarget: CURRENT_AGENT_TARGET,
      instructions: undefined,
      initialInput: { kind: 'deferred_session_pending' },
      permissionMode: 'safe-yolo',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    }, {
      ...APPROVED_INTERNAL_RUNTIME_ACTION_CONTEXT,
      actionCaller,
      agentStartContext: { ...CURRENT_SESSION_AGENT_START_CONTEXT,
        caller: { kind: 'originless', runId: actionCaller.runId, runDepth: 0, runOriginSessionId: 'sess_1' } },
      actionRequestId: 'workflow-input-v2:stable:execution-run-start',
    });
    expect(result).toEqual({
      ok: true,
      result: {
        runId: 'run_workflow_1',
        callId: 'call_workflow_1',
        sidechainId: 'sidechain_workflow_1',
      },
    });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      initialInput: { kind: 'deferred_session_pending' },
      actionRequestId: 'workflow-input-v2:stable:execution-run-start',
    }));
  });

  it('rejects deferred Session Pending input in the detached Run host', async () => {
    const start = vi.fn(async () => ({
      runId: 'run_unexpected',
      callId: 'call_unexpected',
      sidechainId: 'sidechain_unexpected',
    }));
    const executor = createExecutionRunRpcActionExecutor({
      manager: { ...createUnusedExecutionRunBridge(), start },
      context: { sessionId: null, cwd: '/workspace' },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    await expect(executor.execute('execution.run.start', {
      ...AGENT_EXECUTION_RUN_START_REQUEST,
      sessionId: null,
      intent: 'agent',
      instructions: undefined,
      initialInput: { kind: 'deferred_session_pending' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    }, {
      surface: 'rpc',
      authority: 'account_automation',
      bypassApprovals: true,
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'execution_run_invalid_action_input',
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('rejects deferred Session Pending input without host-stamped Workflow provenance', async () => {
    const start = vi.fn(async () => ({
      runId: 'run_unexpected',
      callId: 'call_unexpected',
      sidechainId: 'sidechain_unexpected',
    }));
    const executor = createAgentExecutionRunStartExecutor(start);

    await expect(executor.execute('execution.run.start', {
      ...AGENT_EXECUTION_RUN_START_REQUEST,
      intent: 'agent',
      instructions: undefined,
      initialInput: { kind: 'deferred_session_pending' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
    }, {
      surface: 'rpc',
      defaultSessionId: 'sess_1',
      bypassApprovals: true,
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'execution_run_invalid_action_input',
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('preserves Workflow-authored mode and runtime descriptor through RPC admission', async () => {
    const start = vi.fn(async () => ({
      runId: 'run_started_1', callId: 'call_started_1', sidechainId: 'sidechain_started_1',
    }));
    const executor = createAgentExecutionRunStartExecutor(start);
    const runtimeDescriptorV1 = {
      v: 1 as const,
      agentId: 'happier.agent.codex/codex',
      agent: { backendMode: 'acp' },
    };

    await expect(executor.execute('execution.run.start', {
      ...AGENT_EXECUTION_RUN_START_REQUEST,
      acpSessionModeId: 'plan',
      runtimeDescriptorV1,
    }, { surface: 'rpc' })).resolves.toMatchObject({ ok: true });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      acpSessionModeId: 'plan',
      runtimeDescriptorV1,
    }));
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
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    await expect(executor.execute(actionId, input, { surface: 'rpc' })).resolves.toMatchObject({
      ok: false,
      errorCode: actionId === 'execution.run.send'
        ? 'session_input_target_update_required'
        : actionId === 'execution.run.action'
          ? 'execution_run_scope_mismatch'
          : 'execution_run_not_found',
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

    const providerStart = vi.fn(async () => {
      throw Object.assign(new Error('Saved Secret selection changed'), {
        code: 'provider_binding_changed',
        details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
      });
    });
    const providerExecutor = createAgentExecutionRunStartExecutor(providerStart);
    await expect(providerExecutor.execute(
      'execution.run.start',
      AGENT_EXECUTION_RUN_START_REQUEST,
      { surface: 'rpc' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'provider_binding_changed',
      error: 'Saved Secret selection changed',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
  });

  it('starts an attached Run on its own Team selection without touching its parent Session', async () => {
    // `PLAN.md` §2.3: an attached Run is its own independently owned binding.
    // Starting it on B must not rewrite the parent Session's model or binding.
    const start = vi.fn(async (_request: Parameters<ExecutionRunHostBridgeContract['start']>[0]) => (
      { runId: 'run_team_own', callId: 'call_team_own', sidechainId: 'side_team_own' }
    ));
    const executor = createExecutionRunRpcActionExecutor({
      manager: { ...createUnusedExecutionRunBridge(), start },
      context: { sessionId: 'sess_1', cwd: '/workspace' },
      policy: resolveExecutionRunPolicy({
        defaults: { maxConcurrentRuns: null, boundedTimeoutMs: null, reviewBoundedTimeoutMs: null, maxTurns: null },
      }),
      isExecutionRunsEnabled: () => true,
    });
    const selection = {
      kind: 'team_credential_provider_model' as const,
      resourceId: 'resource-b',
      teamId: 'team-b',
      expectedResourceRevision: 7,
      agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }),
      modelId: 'team-model-b',
      deliveryMode: 'brokered' as const,
    };

    await expect(executor.execute('execution.run.start', {
      ...AGENT_EXECUTION_RUN_START_REQUEST,
      modelId: selection.modelId,
      teamCredentialModel: selection,
    }, { surface: 'rpc' })).resolves.toMatchObject({ ok: true, result: { runId: 'run_team_own' } });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess_1', teamCredentialModel: selection }));
  });

  it('grants the consented Team visibility through the Session access owner before opening the Run', async () => {
    const order: string[] = [];
    const grantAttachedRunTeamVisibility = vi.fn(async () => {
      order.push('team-visibility');
      return { ok: true as const };
    });
    const start = vi.fn(async (_request: Parameters<ExecutionRunHostBridgeContract['start']>[0]) => {
      order.push('run-start');
      return { runId: 'run_team_1', callId: 'call_team_1', sidechainId: 'side_team_1' };
    });
    const executor = createExecutionRunRpcActionExecutor({
      manager: { ...createUnusedExecutionRunBridge(), start },
      context: {
        sessionId: 'sess_1',
        cwd: '/workspace',
        grantAttachedRunTeamVisibility,
      },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });
    const selection = {
      kind: 'team_credential_provider_model' as const,
      resourceId: 'resource-1',
      teamId: 'team-1',
      expectedResourceRevision: 7,
      agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }),
      modelId: 'team-model',
      // The selection carries the resolved route the caller committed to.
      deliveryMode: 'brokered',
    };

    await expect(executor.execute('execution.run.start', {
      ...AGENT_EXECUTION_RUN_START_REQUEST,
      modelId: selection.modelId,
      teamCredentialModel: selection,
      teamCredentialSessionBindingConsent: {
        v: 1,
        sessionId: 'sess_1',
        teamId: selection.teamId,
        resourceId: selection.resourceId,
        expectedResourceRevision: selection.expectedResourceRevision,
      },
    }, { surface: 'rpc' })).resolves.toMatchObject({ ok: true, result: { runId: 'run_team_1' } });

    expect(order).toEqual(['team-visibility', 'run-start']);
    expect(grantAttachedRunTeamVisibility).toHaveBeenCalledWith({
      sessionId: 'sess_1', teamId: 'team-1',
      requiredTeamCredential: {
        resourceId: selection.resourceId,
        expectedResourceRevision: selection.expectedResourceRevision,
        deliveryMode: selection.deliveryMode,
      },
    });
    const managerRequest = start.mock.calls[0]?.[0];
    expect(managerRequest).toBeDefined();
    expect(managerRequest).toMatchObject({ teamCredentialModel: selection });
    expect(managerRequest).not.toHaveProperty('teamCredentialSessionBindingConsent');
  });

  it('does not open the Run when the consented Team visibility grant is refused', async () => {
    const grantAttachedRunTeamVisibility = vi.fn(async () => ({
      ok: false as const, error: 'access_removed', errorCode: 'execution_run_team_session_binding_rejected',
    }));
    const start = vi.fn(async () => ({ runId: 'unexpected', callId: 'unexpected', sidechainId: 'unexpected' }));
    const executor = createExecutionRunRpcActionExecutor({
      manager: { ...createUnusedExecutionRunBridge(), start },
      context: { sessionId: 'sess_1', cwd: '/workspace', grantAttachedRunTeamVisibility },
      policy: resolveExecutionRunPolicy({
        defaults: { maxConcurrentRuns: null, boundedTimeoutMs: null, reviewBoundedTimeoutMs: null, maxTurns: null },
      }),
      isExecutionRunsEnabled: () => true,
    });
    const selection = {
      kind: 'team_credential_provider_model' as const,
      resourceId: 'resource-1',
      teamId: 'team-1',
      expectedResourceRevision: 7,
      agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }),
      modelId: 'team-model',
      deliveryMode: 'brokered' as const,
    };

    await expect(executor.execute('execution.run.start', {
      ...AGENT_EXECUTION_RUN_START_REQUEST,
      modelId: selection.modelId,
      teamCredentialModel: selection,
      teamCredentialSessionBindingConsent: {
        v: 1, sessionId: 'sess_1', teamId: 'team-1', resourceId: 'resource-1', expectedResourceRevision: 7,
      },
    }, { surface: 'rpc' })).resolves.toMatchObject({ ok: false, errorCode: 'execution_run_team_session_binding_rejected' });
    expect(start).not.toHaveBeenCalled();
  });

  it('rejects stale attached Team consent without mutating the Session or opening a Run', async () => {
    const grantAttachedRunTeamVisibility = vi.fn(async () => ({ ok: true as const }));
    const start = vi.fn(async () => ({ runId: 'unexpected', callId: 'unexpected', sidechainId: 'unexpected' }));
    const executor = createExecutionRunRpcActionExecutor({
      manager: { ...createUnusedExecutionRunBridge(), start },
      context: { sessionId: 'sess_1', cwd: '/workspace', grantAttachedRunTeamVisibility },
      policy: resolveExecutionRunPolicy({
        defaults: { maxConcurrentRuns: null, boundedTimeoutMs: null, reviewBoundedTimeoutMs: null, maxTurns: null },
      }),
      isExecutionRunsEnabled: () => true,
    });
    const selection = {
      kind: 'team_credential_provider_model' as const,
      resourceId: 'resource-1',
      teamId: 'team-1',
      expectedResourceRevision: 7,
      agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }),
      modelId: 'team-model',
      // The selection carries the resolved route the caller committed to.
      deliveryMode: 'brokered',
    };

    await expect(executor.execute('execution.run.start', {
      ...AGENT_EXECUTION_RUN_START_REQUEST,
      modelId: selection.modelId,
      teamCredentialModel: selection,
      teamCredentialSessionBindingConsent: {
        v: 1,
        sessionId: 'sess_1',
        teamId: 'team-1',
        resourceId: 'resource-1',
        expectedResourceRevision: 6,
      },
    }, { surface: 'rpc' })).resolves.toMatchObject({ ok: false });

    expect(grantAttachedRunTeamVisibility).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('keeps a detached Team model start independent from Session binding authority', async () => {
    const grantAttachedRunTeamVisibility = vi.fn(async () => ({ ok: true as const }));
    const start = vi.fn(async () => ({ runId: 'run_detached_team', callId: 'call_detached_team', sidechainId: 'side_detached_team' }));
    const executor = createExecutionRunRpcActionExecutor({
      manager: { ...createUnusedExecutionRunBridge(), start },
      context: { sessionId: null, cwd: '/workspace', grantAttachedRunTeamVisibility },
      policy: resolveExecutionRunPolicy({
        defaults: { maxConcurrentRuns: null, boundedTimeoutMs: null, reviewBoundedTimeoutMs: null, maxTurns: null },
      }),
      isExecutionRunsEnabled: () => true,
    });
    const selection = {
      kind: 'team_credential_provider_model' as const,
      resourceId: 'resource-personal',
      teamId: 'team-1',
      expectedResourceRevision: 7,
      agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }),
      modelId: 'team-model',
      // The selection carries the resolved route the caller committed to.
      deliveryMode: 'brokered',
    };

    await expect(executor.execute('execution.run.start', {
      ...AGENT_EXECUTION_RUN_START_REQUEST,
      sessionId: null,
      modelId: selection.modelId,
      teamCredentialModel: selection,
    }, { surface: 'rpc' })).resolves.toMatchObject({ ok: true, result: { runId: 'run_detached_team' } });

    expect(grantAttachedRunTeamVisibility).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null, teamCredentialModel: selection }));
  });

  it('rejects escalation above the active turn ceiling after the session mode widens', async () => {
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
      { ...AGENT_EXECUTION_RUN_START_REQUEST, backendTarget: CURRENT_AGENT_TARGET },
      {
        surface: 'agent',
        // The host stamps the admitted current-Session corpus for every
        // autonomous surface; without it the shared scope guard refuses before
        // the turn-ceiling check this test exercises.
        defaultSessionId: AGENT_EXECUTION_RUN_START_REQUEST.sessionId,
        // The mutable Session mode has widened after the first turn was admitted.
        callerPermissionMode: 'yolo',
        causalPermissionAuthority: firstTurnAuthority,
        agentStartContext: CURRENT_SESSION_AGENT_START_CONTEXT,
      } as unknown as Parameters<typeof executor.execute>[2],
    )).resolves.toEqual({
      ok: false,
      errorCode: 'permission_escalation_denied',
      error: 'permission_escalation_denied',
      details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
    });
    expect(start).not.toHaveBeenCalled();

    await expect(executor.execute(
      'execution.run.start',
      { ...AGENT_EXECUTION_RUN_START_REQUEST, backendTarget: CURRENT_AGENT_TARGET },
      {
        surface: 'agent',
        defaultSessionId: AGENT_EXECUTION_RUN_START_REQUEST.sessionId,
        callerPermissionMode: 'yolo',
        // A later independently admitted turn may carry a new ceiling.
        causalPermissionAuthority: laterTurnAuthority,
        agentStartContext: CURRENT_SESSION_AGENT_START_CONTEXT,
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
        defaultSessionId: AGENT_EXECUTION_RUN_START_REQUEST.sessionId,
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
        defaultSessionId: AGENT_EXECUTION_RUN_START_REQUEST.sessionId,
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
            run: publicRun,
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
          waitForTerminal: async (_runId, options) => await new Promise<void>((_resolve, reject) => {
            const signal = options?.signal;
            if (!signal) return;
            const onAbort = () => reject(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          }),
        },
        context: { sessionId: null, cwd: '/workspace' },
        policy: resolveExecutionRunPolicy({
          defaults: {
            maxConcurrentRuns: null,
            boundedTimeoutMs: null,
            reviewBoundedTimeoutMs: null,
            maxTurns: null,
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
      await expect(result).resolves.toMatchObject({
        ok: true,
        result: {
          runId: 'run_detached_waiting_1',
          callId: 'call_detached_waiting_1',
          sidechainId: 'sidechain_detached_waiting_1',
          wait: {
            ok: true,
            status: 'running',
            disposition: 'observation_timeout',
            runId: 'run_detached_waiting_1',
            timeoutMs: 1_000,
          },
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

  it('fails closed from the daemon cache when a feature-gated start has no published snapshot', async () => {
    vi.stubEnv('HAPPIER_FEATURE_VOICE__ENABLED', '1');
    vi.stubEnv('HAPPIER_FEATURE_VOICE_AGENT__ENABLED', '1');
    const start = vi.fn();
    try {
      const executor = createExecutionRunRpcActionExecutor({
        manager: { ...createUnusedExecutionRunBridge(), start },
        context: { sessionId: 'sess_1', cwd: '/workspace', serverUrl: 'https://must-not-be-read.example' },
        policy: resolveExecutionRunPolicy({
          defaults: {
            maxConcurrentRuns: null,
            boundedTimeoutMs: null,
            reviewBoundedTimeoutMs: null,
            maxTurns: null,
          },
        }),
        isExecutionRunsEnabled: () => true,
      });

      await expect(executor.execute('execution.run.start', {
        sessionId: 'sess_1',
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Voice turn.',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
      }, { surface: 'rpc', defaultSessionId: 'sess_1' })).resolves.toMatchObject({
        ok: false,
        errorCode: 'execution_run_not_allowed',
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
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    const result = await executor.execute('browser.navigate', {
      commandId: 'cmd_1',
      kind: 'navigate',
      browserSessionId: 'sess_1',
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
        browserControl: { dispatchCommand, listViews: () => { throw new Error('Unexpected browser view listing'); } },
        getServerFeaturesSnapshot: () => BROWSER_CONTROL_RUNTIME_ACTIONS_ENABLED,
      },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });
    const command = {
      commandId: 'cmd_1',
      kind: 'navigate',
      browserSessionId: 'sess_1',
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
    expect(dispatchCommand).toHaveBeenCalledWith(command, APPROVED_INTERNAL_RUNTIME_ACTION_CONTEXT);
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
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    const result = await executor.execute('execution.run.action', {
      runId: 'run_1',
      actionId: 'browser.diagnostics.snapshot',
      input: { browserSessionId: 'sess_1', viewId: 'view_1' },
    }, { surface: 'rpc', defaultSessionId: 'sess_1' });

    expect(result).toEqual({
      ok: true,
      result: {
        ok: true,
        result: diagnosticSnapshot,
      },
    });
    expect(diagnostics.dispatch).toHaveBeenCalledWith('browser.diagnostics.snapshot', {
      browserSessionId: 'sess_1',
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
    }, {
      surface: 'rpc',
      authority: 'account_automation',
      defaultSessionId: 'sess_1',
      serverId: 'server-1',
      runtimeAccountId: 'account-1',
      actionRequestId: 'browser-click-request-1',
    });

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
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    const result = await executor.execute('execution.run.action', {
      runId: 'run_1',
      actionId: 'browser.diagnostics.snapshot',
      input: { browserSessionId: 'sess_1', viewId: 'view_1' },
    }, { surface: 'rpc', defaultSessionId: 'sess_1' });

    expect(result).toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_diagnostics_route_unavailable',
    });
    expect(diagnostics.dispatch).not.toHaveBeenCalled();
  });

  it('returns the same lossless terminal projection from execution-run get and wait', async () => {
    const waitForInputTurn = vi.fn(async () => null);
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
      status: 'succeeded',
      startedAtMs: 1,
      finishedAtMs: 2,
    } satisfies ExecutionRunPublicState;
    const runState = {
      ...run,
      sessionId: 'sess_1',
      depth: 0,
      backendId: 'codex',
      instructions: 'Inspect the change.',
      latestToolResult: false,
    } satisfies ExecutionRunState;
    const manager: ExecutionRunHostBridgeContract = {
      ...createUnusedExecutionRunBridge(),
      waitForInputTurn,
      get: (runId) => runId === run.runId ? runState : null,
      getPublic: (runId) => runId === run.runId ? run : null,
      getLatestToolResult: () => false,
      getStructuredMeta: () => ({
        kind: 'execution_result',
        payload: { accepted: false, count: 0 },
      }),
    };
    const deps = createExecutionRunRpcActionDeps({
      manager,
      context: { sessionId: 'sess_1', cwd: '/workspace' },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });
    const expectedResult = {
      run,
      latestToolResult: false,
      structuredMeta: {
        kind: 'execution_result',
        payload: { accepted: false, count: 0 },
      },
    };

    const observationController = new AbortController();
    await expect(deps.executionRunGet('sess_1', {
      runId: 'run_1',
      includeStructured: true,
      waitForInputId: 'input_1',
    }, { signal: observationController.signal })).resolves.toEqual(expectedResult);
    expect(waitForInputTurn).toHaveBeenCalledWith(
      'run_1',
      'input_1',
      observationController.signal,
    );
    await expect(deps.executionRunWait('sess_1', {
      runId: 'run_1',
    })).resolves.toEqual({
      ok: true,
      status: 'succeeded',
      result: expectedResult,
    });
  });

  it('returns the exact waited input result even if the live latest-turn projection has advanced', async () => {
    const requestedTurn = {
      turnId: 'turn-requested', inputIds: ['input-requested'], state: 'completed' as const,
      result: { kind: 'text' as const, value: 'requested result' },
    };
    const latestTurn = {
      turnId: 'turn-latest', inputIds: ['input-latest'], state: 'completed' as const,
      result: { kind: 'text' as const, value: 'later result' },
    };
    const run = {
      runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1', intent: 'agent',
      backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' },
      permissionMode: 'default', retentionPolicy: 'resumable' as const,
      runClass: 'long_lived' as const, ioMode: 'request_response' as const,
      status: 'running' as const, startedAtMs: 1,
      inputTurns: { occurrenceId: 'occurrence-1', last: latestTurn },
    } satisfies ExecutionRunPublicState;
    const manager: ExecutionRunHostBridgeContract = {
      ...createUnusedExecutionRunBridge(),
      waitForInputTurn: vi.fn(async () => ({ occurrenceId: 'occurrence-1', turn: requestedTurn })),
      get: () => ({
        ...run, sessionId: 'sess_1', depth: 0, backendId: 'codex', instructions: '',
      } satisfies ExecutionRunState),
      getPublic: () => run,
    };
    const deps = createExecutionRunRpcActionDeps({
      manager,
      context: { sessionId: 'sess_1', cwd: '/workspace' },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null, boundedTimeoutMs: null, reviewBoundedTimeoutMs: null,
          maxTurns: null
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    await expect(deps.executionRunGet('sess_1', {
      runId: 'run_1', waitForInputId: 'input-requested', includeStructured: false,
    })).resolves.toMatchObject({
      run: { inputTurns: { occurrenceId: 'occurrence-1', last: requestedTurn } },
    });
  });

  it('detaches the bridge terminal observer when an execution-run wait times out', async () => {
    vi.useFakeTimers();
    let observerSignal: AbortSignal | undefined;
    const waitForTerminal = vi.fn(async (
      _runId: string,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => await new Promise<void>((resolve, reject) => {
      observerSignal = options?.signal;
      const signal = options?.signal;
      if (!signal) return;
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }));
    const deps = createExecutionRunRpcActionDeps({
      manager: createExecutionRunBridgeWithRun({ waitForTerminal }),
      context: { sessionId: 'sess_1', cwd: '/workspace' },
      policy: resolveExecutionRunPolicy({
        defaults: {
          maxConcurrentRuns: null,
          boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null,
          maxTurns: null,
        },
      }),
      isExecutionRunsEnabled: () => true,
    });

    try {
      const waiting = deps.executionRunWait('sess_1', {
        runId: 'run_1',
        timeoutSeconds: 0.001,
      });
      await vi.advanceTimersByTimeAsync(1);

      await expect(waiting).resolves.toMatchObject({
        ok: true,
        status: 'running',
        disposition: 'observation_timeout',
        runId: 'run_1',
      });
      expect(waitForTerminal).toHaveBeenCalledOnce();
      expect(observerSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
