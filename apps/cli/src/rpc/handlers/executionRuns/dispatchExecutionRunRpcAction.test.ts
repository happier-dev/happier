import { describe, expect, it, vi } from 'vitest';
import { BrowserCommandV1Schema, FeaturesResponseSchema, type ExecutionRunPublicState } from '@happier-dev/protocol';

import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import type { ExecutionRunHostBridgeContract } from '@/agent/runtime/bridges/executionRun/executionRunBridgeContract';
import type { BrowserAutomationRoutes } from '@/daemon/browser/automation/routes';
import type { CliServerFeaturesSnapshot } from '@/features/featureDecisionService';

import { createExecutionRunRpcActionExecutor, type ExecutionRunRpcApprovalDeps } from './dispatchExecutionRunRpcAction';

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
  return {
    ...createUnusedExecutionRunBridge(),
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

describe('createExecutionRunRpcActionExecutor', () => {
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
          featureId: 'voice.agent',
          blockedBy: 'dependency',
          blockerCode: 'dependency_disabled',
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
          featureId: 'voice.agent',
          blockedBy: 'local_policy',
          blockerCode: 'flag_disabled',
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
        leaseId: 'lease_1',
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
