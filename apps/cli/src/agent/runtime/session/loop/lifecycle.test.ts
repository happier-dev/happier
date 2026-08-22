import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { RuntimeCheckpointToolProtocolV1 } from '@happier-dev/agents';
import {
  AgentSessionRuntimeEventV1Schema,
  type AgentSessionRuntimeEventV1,
} from '@happier-dev/protocol';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { Metadata } from '@/api/types';
import type { ApiClient } from '@/api/api';
import { createDeferredStartupBootstrap } from '@/agent/runtime/startup/createDeferredStartupBootstrap';
import {
  computeRunnerTerminationOutcome,
  type RunnerTerminationEvent,
  type RunnerTerminationOutcome,
} from '@/agent/runtime/lifecycle/runnerTerminationOutcome';
import type { RuntimeTurnMessageHandler } from '@/agent/runtime/turns/runtimeTurnOperations';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

const { loggerDebugMock } = vi.hoisted(() => ({
  loggerDebugMock: vi.fn(),
}));

vi.mock('@/ui/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui/logger')>();
  return {
    ...actual,
    logger: new Proxy(actual.logger, {
      get(target, property, receiver) {
        if (property === 'debug') return loggerDebugMock;
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
});

import { runSessionLoopLifecycle, type SessionLoopLifecycleParams } from './lifecycle';
import type { DaemonAgentRuntimeTurnContributionsBridge } from '../process/agentRuntimeDaemonTurnContributionsBridge';

const RETIRED_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY =
  'HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE';

const checkpointLifecycle = Object.freeze({});

const checkpointFactory = vi.hoisted(() => vi.fn(() => checkpointLifecycle));

let nextRuntimeEventSequence = 0;

function canonicalRuntimeEvent(input: Readonly<Record<string, unknown>>): AgentSessionRuntimeEventV1 {
  return AgentSessionRuntimeEventV1Schema.parse({
    sequence: ++nextRuntimeEventSequence,
    ...input,
    ...(input.kind === 'turn-start' && input.startedBy === undefined
      ? { startedBy: 'host' }
      : {}),
  });
}

type RunPermissionModePromptLoopFn = NonNullable<
  NonNullable<SessionLoopLifecycleParams['deps']>['runPermissionModePromptLoopFn']
>;
type NotifyDaemonConnectedServiceTurnLifecycleFn = NonNullable<
  NonNullable<SessionLoopLifecycleParams['deps']>['notifyDaemonConnectedServiceTurnLifecycleFn']
>;

vi.mock('@/agent/runtime/checkpoints/repositoryCheckpointPromptLifecycle', () => ({
  createRepositoryCheckpointPromptLifecycle: checkpointFactory,
}));

function createMetadata(): Metadata {
  return {
    path: '/tmp/project',
    host: 'test-host',
    homeDir: '/tmp',
    happyHomeDir: '/tmp/.happier',
    happyLibDir: '/tmp/.happier/lib',
    happyToolsDir: '/tmp/.happier/tools',
  };
}

const machineMetadata = {
  host: 'test-host',
  platform: 'darwin',
  happyCliVersion: '0.0.0-test',
  homeDir: '/tmp',
  happyHomeDir: '/tmp/.happier',
  happyLibDir: '/tmp/.happier/lib',
};

function createLifecycleParams(overrides?: Readonly<{
  policyAgentId?: string;
  checkpointToolProtocol?: RuntimeCheckpointToolProtocolV1;
  runPermissionModePromptLoopFn?: RunPermissionModePromptLoopFn;
  hookRuntime?: SessionLoopLifecycleParams['hookRuntime'];
}>): SessionLoopLifecycleParams {
  const runtimeSubscribers = new Set<RuntimeTurnMessageHandler>();
  const runtime = {
    beginTurnLifecycle: vi.fn(),
    sendTurnPrompt: vi.fn(async () => undefined),
    steerInFlightTurn: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    subscribeRuntimeEvents: vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeSubscribers.add(handler);
      return () => runtimeSubscribers.delete(handler);
    }),
    cancelTurn: vi.fn(async () => undefined),
    readSessionIdentity: vi.fn(() => ({ sessionId: 'provider-session-1' })),
    updateSessionRuntimeConfig: vi.fn(async () => undefined),
    resetOrDisposeRuntime: vi.fn(async () => undefined),
  };
  const session = {
    sessionId: 'session-1',
    rpcHandlerManager: {
      sessionId: 'session-1',
      registerHandler: vi.fn(),
    },
    getMetadataSnapshot: vi.fn(() => createMetadata()),
    keepAlive: vi.fn(),
    enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const })),
    enqueueSessionTurnMutation: vi.fn(async () => undefined),
    endSessionAndClose: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };

  return {
    opts: {
      credentials: {
        token: 'test-token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(),
        },
      },
    },
    config: {
      flavor: 'default',
      policyAgentId: overrides?.policyAgentId ?? 'codex',
      backendDisplayName: 'Test Agent',
      uiLogPrefix: '[Test]',
      providerName: 'Test Agent',
      waitingForCommandLabel: 'Test Agent',
      agentMessageType: 'opencode',
      runtimeActivityApplicability: 'not_applicable',
      machineMetadata,
      terminalDisplay: () => null,
      formatPromptErrorMessage: (error: unknown) => String(error),
      shouldRenderTerminalDisplay: () => false,
      ...(overrides?.checkpointToolProtocol
        ? { checkpointToolProtocol: overrides.checkpointToolProtocol }
        : {}),
    } as SessionLoopLifecycleParams['config'],
    api: {
      push: () => ({
        sendToAllDevices: vi.fn(),
        sendToAllDevicesAsync: vi.fn(async () => undefined),
      }),
    },
    session: session as unknown as SessionLoopLifecycleParams['session'],
    runtime,
    hookRuntime: overrides?.hookRuntime ?? null,
    messageBuffer: new MessageBuffer(),
    permissionHandler: {
      reset: vi.fn(),
      setPermissionMode: vi.fn(),
    },
    permissionModeState: {
      rebindSession: vi.fn(),
      releaseRejectedBeforeProviderPromptIdentity: vi.fn(),
      getCurrentPermissionMode: vi.fn(() => 'default' as const),
      getCurrentPermissionModeUpdatedAt: vi.fn(() => 0),
      setCurrentPermissionMode: vi.fn(),
      setCurrentPermissionModeUpdatedAt: vi.fn(),
      messageQueue: {
        reset: vi.fn(),
        size: vi.fn(() => 0),
      } as unknown as SessionLoopLifecycleParams['permissionModeState']['messageQueue'],
    },
    sessionSwapStrategy: {
      requestSessionSwap: vi.fn(async () => undefined),
    },
    runtimeDirectory: '/tmp/project',
    runtimeMetadata: createMetadata(),
    machineId: 'machine-1',
    memoryRecallGuidanceEnabled: false,
    policyAgentId: overrides?.policyAgentId ?? 'codex',
    setActiveAgentCompositionToolSelection: vi.fn(),
    happyMcpServerStop: vi.fn(),
    reconnectionHandle: null,
    startupCoordinator: null,
    runtimeState: {
      thinking: false,
    },
    setAbortRequestedCallback: vi.fn(),
    transitionModelSelection: vi.fn(async (selection) => ({
      ok: true as const,
      status: 'already_active' as const,
      activeSelection: selection,
    })),
    deps: {
      runPermissionModePromptLoopFn: overrides?.runPermissionModePromptLoopFn ?? vi.fn(async () => undefined),
      registerRunnerTerminationHandlersFn: vi.fn(() => ({
        dispose: vi.fn(),
        requestTermination: vi.fn(),
        whenTerminated: Promise.resolve({
          event: { kind: 'exit' as const, code: 0 },
          outcome: computeRunnerTerminationOutcome({ kind: 'exit', code: 0 }),
        }),
      })),
      registerKillSessionHandlerFn: vi.fn(),
      cleanupBackendRunResourcesFn: vi.fn(async ({ keepAliveInterval }: { keepAliveInterval: NodeJS.Timeout }) => {
        clearInterval(keepAliveInterval);
      }),
      startRemoteModeStaticControlFn: vi.fn(),
      renderFn: vi.fn(),
    },
    initialResumeId: '',
  };
}

function createRevokedTranscriptFailure(privateTranscript: string): object {
  const hostile = Proxy.revocable({ privateTranscript }, {});
  hostile.revoke();
  return hostile.proxy;
}

function loggerReceivedIdentity(value: unknown): boolean {
  return loggerDebugMock.mock.calls.some((call) => call.some((argument) => argument === value));
}

describe('runSessionLoopLifecycle checkpoint controls', () => {
  it('awaits startup authority preparation before entering the prompt loop', async () => {
    const order: string[] = [];
    let releaseStartup!: () => void;
    const startupGate = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const runPermissionModePromptLoopFn: RunPermissionModePromptLoopFn =
      vi.fn(async () => {
        order.push('prompt-loop');
      });
    const baseParams = createLifecycleParams({
      policyAgentId: 'codex',
      runPermissionModePromptLoopFn,
    });
    const createSendReady = vi.fn(() => vi.fn());
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        createSendReady,
      },
      startupCoordinator: {
        start: async () => {
          order.push('startup:start');
          await startupGate;
          order.push('startup:ready');
        },
        cleanup: vi.fn(async () => undefined),
      },
    };

    const lifecycle = runSessionLoopLifecycle(params);
    await vi.waitFor(() => {
      expect(order).toContain('startup:start');
    });
    expect(createSendReady).not.toHaveBeenCalled();
    expect(runPermissionModePromptLoopFn).not.toHaveBeenCalled();

    releaseStartup();
    await lifecycle;

    expect(order).toEqual([
      'startup:start',
      'startup:ready',
      'prompt-loop',
    ]);
    expect(createSendReady).toHaveBeenCalledOnce();
  });

  it('propagates startup authority preparation failure without entering the prompt loop', async () => {
    const authorityFailure = new Error('required startup authority refresh failed');
    const runPermissionModePromptLoopFn: RunPermissionModePromptLoopFn =
      vi.fn(async () => undefined);
    const cleanup = vi.fn(async () => undefined);
    const baseParams = createLifecycleParams({
      policyAgentId: 'codex',
      runPermissionModePromptLoopFn,
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      startupCoordinator: {
        start: vi.fn(async () => {
          throw authorityFailure;
        }),
        cleanup,
      },
    };

    await expect(runSessionLoopLifecycle(params)).rejects.toBe(authorityFailure);

    expect(runPermissionModePromptLoopFn).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('does not enter the provider prompt loop when initial Session creation has no durable custody', async () => {
    const runPermissionModePromptLoopFn: RunPermissionModePromptLoopFn =
      vi.fn(async () => undefined);
    const bootstrap = await createDeferredStartupBootstrap({
      credentials: { token: 'test-token' } as never,
      startedBy: 'terminal',
      initialMachineId: 'machine-1',
      machineMetadata,
      sessionTag: 'initial-offline-custody-test',
      initialMetadata: createMetadata(),
      createInitializedSessionMetadata: (machineId) => ({
        metadata: { ...createMetadata(), machineId },
        state: {},
      }),
      uiLogPrefix: '[Test]',
      startupMetadataOverrides: {
        permissionModeOverride: { mode: 'default', updatedAt: 1 },
      },
      deps: {
        initializeBackendApiContextFn: async () => ({
          api: {
            getOrCreateSession: vi.fn(async () => null),
            sessionSyncClient: vi.fn(),
            push: () => ({
              sendToAllDevices: vi.fn(),
              sendToAllDevicesAsync: vi.fn(async () => undefined),
            }),
          } as unknown as ApiClient,
          machineId: 'machine-1',
        }),
      },
    });
    const baseParams = createLifecycleParams({ runPermissionModePromptLoopFn });

    await expect(runSessionLoopLifecycle({
      ...baseParams,
      startupCoordinator: {
        start: bootstrap.start,
        cancel: bootstrap.cancel,
        cleanup: bootstrap.cleanup,
      },
    })).rejects.toMatchObject({
      name: 'BackendRunSessionUnavailableError',
      code: 'backend_run_session_unavailable',
    });

    expect(runPermissionModePromptLoopFn).not.toHaveBeenCalled();
    expect(baseParams.runtime.sendTurnPrompt).not.toHaveBeenCalled();
  });

  it('does not log a hostile startup cleanup rejection after startup fails', async () => {
    loggerDebugMock.mockClear();
    const authorityFailure = new Error('required startup authority refresh failed');
    const hostileCleanupFailure = createRevokedTranscriptFailure(
      'private startup instructions must not enter cleanup logs',
    );
    const baseParams = createLifecycleParams({
      policyAgentId: 'codex',
      runPermissionModePromptLoopFn: vi.fn(async () => undefined),
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      startupCoordinator: {
        start: vi.fn(async () => {
          throw authorityFailure;
        }),
        cleanup: vi.fn(async () => {
          throw hostileCleanupFailure;
        }),
      },
    };

    await expect(runSessionLoopLifecycle(params)).rejects.toBe(authorityFailure);

    expect(loggerReceivedIdentity(hostileCleanupFailure)).toBe(false);
    expect(loggerDebugMock).toHaveBeenCalledWith(
      '[Test] Shared startup coordinator cleanup failed after startup rejection (non-fatal)',
      { error: 'startup_coordinator_cleanup_failed' },
    );
  });

  it('uses provider-neutral checkpoint protocol config instead of inferring from provider id', async () => {
    checkpointFactory.mockClear();
    const params = createLifecycleParams({
      policyAgentId: 'codex',
      checkpointToolProtocol: 'claude',
    });

    await runSessionLoopLifecycle(params);

    expect(checkpointFactory).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'claude',
      provider: 'opencode',
    }));
  });

  it('passes pending queue delivery timing from account settings into the permission prompt loop', async () => {
    let observedPendingQueueDeliveryTiming: unknown;
    const runPermissionModePromptLoopFn: RunPermissionModePromptLoopFn = vi.fn(async (loopParams) => {
      observedPendingQueueDeliveryTiming = loopParams.pendingQueueDeliveryTiming;
    });
    const params = createLifecycleParams({ policyAgentId: 'codex', runPermissionModePromptLoopFn });
    params.opts.accountSettingsContext = {
      source: 'network',
      settings: {
        sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
      } as any,
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    };

    await runSessionLoopLifecycle(params);

    expect(observedPendingQueueDeliveryTiming).toBe('after_runtime_idle');
  });
});

describe('runSessionLoopLifecycle daemon exact-turn custody', () => {
  it('disposes the runtime as session_closed before explicit killSession requests runner termination', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'claude' });
    const order: string[] = [];
    let killSession: (() => Promise<void>) | null = null;
    let releasePromptLoop!: () => void;
    const promptLoopReleased = new Promise<void>((resolve) => {
      releasePromptLoop = resolve;
    });
    const runtime = baseParams.runtime as unknown as {
      resetOrDisposeRuntime: ReturnType<typeof vi.fn>;
    };
    runtime.resetOrDisposeRuntime.mockImplementation(async (reason?: string) => {
      order.push(`runtime_disposed:${reason ?? 'missing'}`);
    });
    const requestTermination = vi.fn(() => {
      order.push('termination_requested');
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        registerKillSessionHandlerFn: vi.fn((_manager, handler) => {
          killSession = handler;
        }),
        registerRunnerTerminationHandlersFn: vi.fn(() => ({
          dispose: vi.fn(),
          requestTermination,
          whenTerminated: Promise.resolve({
            event: { kind: 'killSession' as const },
            outcome: computeRunnerTerminationOutcome({ kind: 'killSession' }),
          }),
        })),
        runPermissionModePromptLoopFn: vi.fn(async () => {
          await promptLoopReleased;
        }),
      },
    };

    const runPromise = runSessionLoopLifecycle(params);
    await vi.waitFor(() => expect(killSession).not.toBeNull());
    const explicitStop = killSession as (() => Promise<void>) | null;
    if (!explicitStop) throw new Error('Expected killSession handler registration');

    await explicitStop();

    expect(order).toEqual(['runtime_disposed:session_closed', 'termination_requested']);
    releasePromptLoop();
    await runPromise;
  });

  it('keeps the runner alive when explicit killSession runtime disposal fails', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'claude' });
    let killSession: (() => Promise<void>) | null = null;
    let releasePromptLoop!: () => void;
    const promptLoopReleased = new Promise<void>((resolve) => {
      releasePromptLoop = resolve;
    });
    const disposalError = new Error('injected runtime disposal failure');
    const runtime = baseParams.runtime as unknown as {
      resetOrDisposeRuntime: ReturnType<typeof vi.fn>;
    };
    runtime.resetOrDisposeRuntime.mockImplementation(async (reason?: string) => {
      if (reason === 'session_closed') throw disposalError;
    });
    const requestTermination = vi.fn();
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        registerKillSessionHandlerFn: vi.fn((_manager, handler) => {
          killSession = handler;
        }),
        registerRunnerTerminationHandlersFn: vi.fn(() => ({
          dispose: vi.fn(),
          requestTermination,
          whenTerminated: Promise.resolve({
            event: { kind: 'killSession' as const },
            outcome: computeRunnerTerminationOutcome({ kind: 'killSession' }),
          }),
        })),
        runPermissionModePromptLoopFn: vi.fn(async () => {
          await promptLoopReleased;
        }),
      },
    };

    const runPromise = runSessionLoopLifecycle(params);
    await vi.waitFor(() => expect(killSession).not.toBeNull());
    const explicitStop = killSession as (() => Promise<void>) | null;
    if (!explicitStop) throw new Error('Expected killSession handler registration');

    await expect(explicitStop()).rejects.toBe(disposalError);
    expect(requestTermination).not.toHaveBeenCalled();

    releasePromptLoop();
    await runPromise;
  });

  it('disposes the runtime as host_shutdown when a signal terminates the runner', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'claude' });
    const termination = {
      onTerminate: null as ((event: RunnerTerminationEvent, outcome: RunnerTerminationOutcome) => void | Promise<void>) | null,
    };
    let releasePromptLoop!: () => void;
    const promptLoopReleased = new Promise<void>((resolve) => {
      releasePromptLoop = resolve;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        registerRunnerTerminationHandlersFn: vi.fn((registration) => {
          termination.onTerminate = registration.onTerminate;
          return {
            dispose: vi.fn(),
            requestTermination: vi.fn(),
            whenTerminated: new Promise<Readonly<{
              event: RunnerTerminationEvent;
              outcome: RunnerTerminationOutcome;
            }>>(() => undefined),
          };
        }),
        cleanupBackendRunResourcesFn: vi.fn(async ({ keepAliveInterval, resetRuntime }) => {
          clearInterval(keepAliveInterval);
          await resetRuntime();
        }),
        runPermissionModePromptLoopFn: vi.fn(async () => {
          await promptLoopReleased;
        }),
      },
    };

    const runPromise = runSessionLoopLifecycle(params);
    await vi.waitFor(() => expect(termination.onTerminate).not.toBeNull());
    const onTerminate = termination.onTerminate;
    if (!onTerminate) throw new Error('Expected runner termination handler registration');

    await onTerminate(
      { kind: 'signal', signal: 'SIGTERM' },
      computeRunnerTerminationOutcome({ kind: 'signal', signal: 'SIGTERM' }),
    );

    expect(baseParams.runtime.resetOrDisposeRuntime).toHaveBeenCalledWith('host_shutdown');
    releasePromptLoop();
    await runPromise;
  });

  it('durably ends the active API session before daemon-started SIGTERM cleanup completes', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'grok' });
    const termination = {
      onTerminate: null as ((event: RunnerTerminationEvent, outcome: RunnerTerminationOutcome) => void | Promise<void>) | null,
    };
    let releasePromptLoop!: () => void;
    const promptLoopReleased = new Promise<void>((resolve) => {
      releasePromptLoop = resolve;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      opts: { ...baseParams.opts, startedBy: 'daemon' },
      deps: {
        ...baseParams.deps,
        registerRunnerTerminationHandlersFn: vi.fn((registration) => {
          termination.onTerminate = registration.onTerminate;
          return {
            dispose: vi.fn(),
            requestTermination: vi.fn(),
            whenTerminated: new Promise<Readonly<{
              event: RunnerTerminationEvent;
              outcome: RunnerTerminationOutcome;
            }>>(() => undefined),
          };
        }),
        runPermissionModePromptLoopFn: vi.fn(async () => {
          await promptLoopReleased;
        }),
      },
    };

    const runPromise = runSessionLoopLifecycle(params);
    await vi.waitFor(() => expect(termination.onTerminate).not.toBeNull());
    const onTerminate = termination.onTerminate;
    if (!onTerminate) throw new Error('Expected runner termination handler registration');

    await onTerminate(
      { kind: 'signal', signal: 'SIGTERM' },
      computeRunnerTerminationOutcome({ kind: 'signal', signal: 'SIGTERM' }),
    );

    expect(baseParams.session.endSessionAndClose).toHaveBeenCalledOnce();
    expect(baseParams.session.close).not.toHaveBeenCalled();
    releasePromptLoop();
    await runPromise;
  });

  it('admits cancellation transcript output before semantic session termination', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'grok' });
    const termination = {
      onTerminate: null as ((event: RunnerTerminationEvent, outcome: RunnerTerminationOutcome) => void | Promise<void>) | null,
    };
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    let releaseTranscriptAdmission!: () => void;
    const transcriptAdmissionReleased = new Promise<void>((resolve) => {
      releaseTranscriptAdmission = resolve;
    });
    let releasePromptLoop!: () => void;
    const promptLoopReleased = new Promise<void>((resolve) => {
      releasePromptLoop = resolve;
    });
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
      endSessionAndClose: ReturnType<typeof vi.fn>;
    };
    session.enqueueAgentMessageCommitted.mockImplementation(async () => {
      await transcriptAdmissionReleased;
      return { persisted: true, delivered: false };
    });
    const runtime = baseParams.runtime as unknown as {
      cancelTurn: ReturnType<typeof vi.fn>;
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents.mockImplementation((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    runtime.cancelTurn.mockImplementation(async () => {
      runtimeEventHandler?.(canonicalRuntimeEvent({
        kind: 'turn-cancelled',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'turn-1',
        agentTurnId: 'agent-turn-1',
        cause: 'hostShutdown',
      }));
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        registerRunnerTerminationHandlersFn: vi.fn((registration) => {
          termination.onTerminate = registration.onTerminate;
          return {
            dispose: vi.fn(),
            requestTermination: vi.fn(),
            whenTerminated: new Promise<Readonly<{
              event: RunnerTerminationEvent;
              outcome: RunnerTerminationOutcome;
            }>>(() => undefined),
          };
        }),
        runPermissionModePromptLoopFn: vi.fn(async () => {
          await promptLoopReleased;
        }),
      },
    };

    const runPromise = runSessionLoopLifecycle(params);
    await vi.waitFor(() => expect(termination.onTerminate).not.toBeNull());
    const onTerminate = termination.onTerminate;
    if (!onTerminate) throw new Error('Expected runner termination handler registration');

    const terminationPromise = onTerminate(
      { kind: 'signal', signal: 'SIGTERM' },
      computeRunnerTerminationOutcome({ kind: 'killSession' }),
    );
    await vi.waitFor(() => expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledOnce());
    expect(session.endSessionAndClose).not.toHaveBeenCalled();

    releaseTranscriptAdmission();
    await terminationPromise;
    expect(session.endSessionAndClose).toHaveBeenCalledOnce();
    expect(session.enqueueAgentMessageCommitted.mock.invocationCallOrder[0]).toBeLessThan(
      session.endSessionAndClose.mock.invocationCallOrder[0]!,
    );

    releasePromptLoop();
    await runPromise;
  });

  it('routes a confirmed terminal UI exit through the runner termination owner', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const runtime = baseParams.runtime as unknown as {
      cancelTurn: ReturnType<typeof vi.fn>;
    };
    let releaseCancel!: () => void;
    const cancelReleased = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    runtime.cancelTurn.mockImplementation(async () => {
      await cancelReleased;
    });
    const termination = {
      onTerminate: null as ((event: RunnerTerminationEvent, outcome: RunnerTerminationOutcome) => void | Promise<void>) | null,
    };
    let resolveTerminated!: (value: Readonly<{
      event: RunnerTerminationEvent;
      outcome: RunnerTerminationOutcome;
    }>) => void;
    const whenTerminated = new Promise<Readonly<{
      event: RunnerTerminationEvent;
      outcome: RunnerTerminationOutcome;
    }>>((resolve) => {
      resolveTerminated = resolve;
    });
    const requestTermination = vi.fn((event: RunnerTerminationEvent) => {
      const onTerminate = termination.onTerminate;
      if (!onTerminate) throw new Error('Expected runner termination handler registration');
      const outcome: RunnerTerminationOutcome = computeRunnerTerminationOutcome(event);
      void Promise.resolve(onTerminate(event, outcome)).then(() => {
        resolveTerminated({ event, outcome });
      });
    });
    const renderedElements: Array<Readonly<{
      props: Readonly<Record<string, unknown>>;
    }>> = [];
    const order: string[] = [];
    let releaseCleanup!: () => void;
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const sessionEndAndClose = baseParams.session.endSessionAndClose as unknown as ReturnType<typeof vi.fn>;
    sessionEndAndClose.mockImplementation(async () => {
      order.push('end');
    });
    const cleanupBackendRunResourcesFn = vi.fn(async (
      { keepAliveInterval }: { keepAliveInterval: NodeJS.Timeout },
    ) => {
      clearInterval(keepAliveInterval);
      order.push('cleanup:start');
      await cleanupReleased;
      order.push('cleanup:end');
    });
    const renderFn: NonNullable<
      NonNullable<SessionLoopLifecycleParams['deps']>['renderFn']
    > = vi.fn((element) => {
      renderedElements.push(element as Readonly<{
        props: Readonly<Record<string, unknown>>;
      }>);
      return {
        rerender: vi.fn(),
        unmount: vi.fn(),
        waitUntilExit: vi.fn(async () => undefined),
        cleanup: vi.fn(),
        clear: vi.fn(),
      };
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      opts: {
        ...baseParams.opts,
        startedBy: 'terminal',
      },
      config: {
        ...baseParams.config,
        shouldRenderTerminalDisplay: () => true,
      },
      deps: {
        ...baseParams.deps,
        cleanupBackendRunResourcesFn,
        renderFn,
        registerRunnerTerminationHandlersFn: vi.fn((registration) => {
          termination.onTerminate = registration.onTerminate;
          return {
            dispose: vi.fn(),
            requestTermination,
            whenTerminated,
          };
        }),
        runPermissionModePromptLoopFn: vi.fn(async (loopParams) => {
          const signal = loopParams.getAbortSignal();
          if (signal.aborted) return;
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }),
      },
    };
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    try {
      const runPromise = runSessionLoopLifecycle(params);
      await vi.waitFor(() => {
        expect(renderedElements).toHaveLength(1);
        expect(termination.onTerminate).not.toBeNull();
      });
      const onExit = renderedElements[0]?.props.onExit;
      if (typeof onExit !== 'function') throw new Error('Expected terminal display exit handler');

      let exitSettled = false;
      const exitPromise = Promise.resolve(onExit()).then(() => {
        exitSettled = true;
      });
      await vi.waitFor(() => {
        expect(runtime.cancelTurn).toHaveBeenCalledOnce();
      });
      await new Promise((resolve) => setImmediate(resolve));
      const cleanupStartedBeforeAbortSettled =
        cleanupBackendRunResourcesFn.mock.calls.length > 0;
      releaseCancel();
      await vi.waitFor(() => {
        expect(baseParams.session.endSessionAndClose).toHaveBeenCalledOnce();
        expect(cleanupBackendRunResourcesFn).toHaveBeenCalledOnce();
      });
      await new Promise((resolve) => setImmediate(resolve));
      const exitSettledBeforeCleanup = exitSettled;
      releaseCleanup();
      await exitPromise;
      await runPromise;

      expect(cleanupStartedBeforeAbortSettled).toBe(false);
      expect(order).toEqual([
        'end',
        'cleanup:start',
        'cleanup:end',
      ]);
      expect(exitSettledBeforeCleanup).toBe(false);
      expect(requestTermination).toHaveBeenCalledWith({
        kind: 'signal',
        signal: 'SIGINT',
      });
      // A terminal-started session that terminates stays unarchived and resumable.
      expect(baseParams.session.endSessionAndClose).toHaveBeenCalledOnce();
    } finally {
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }
  });

  it('drains host shutdown work before closing the session', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const order: string[] = [];
    const termination = {
      onTerminate: null as ((event: RunnerTerminationEvent, outcome: RunnerTerminationOutcome) => void | Promise<void>) | null,
    };
    let releasePromptLoop!: () => void;
    const promptLoopReleased = new Promise<void>((resolve) => {
      releasePromptLoop = resolve;
    });
    const sessionClose = baseParams.session.close as unknown as ReturnType<typeof vi.fn>;
    sessionClose.mockImplementation(async () => {
      order.push('close');
    });
    const sessionEndAndClose = baseParams.session.endSessionAndClose as unknown as ReturnType<typeof vi.fn>;
    sessionEndAndClose.mockImplementation(async () => {
      order.push('end');
      await sessionClose();
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
      },
      deps: {
        ...baseParams.deps,
        onBeforeSessionClose: async () => {
          order.push('drain');
        },
        registerRunnerTerminationHandlersFn: vi.fn((registration) => {
          termination.onTerminate = registration.onTerminate;
          return {
            dispose: vi.fn(),
            requestTermination: vi.fn((_event: RunnerTerminationEvent) => undefined),
            whenTerminated: new Promise<Readonly<{
              event: RunnerTerminationEvent;
              outcome: RunnerTerminationOutcome;
            }>>(() => {}),
          };
        }),
        runPermissionModePromptLoopFn: vi.fn(async () => {
          await promptLoopReleased;
        }),
      },
    };

    const lifecycle = runSessionLoopLifecycle(params);
    await vi.waitFor(() => expect(termination.onTerminate).not.toBeNull());
    const onTerminate = termination.onTerminate;
    if (!onTerminate) throw new Error('Expected runner termination handler registration');
    await onTerminate(
      { kind: 'signal', signal: 'SIGINT' },
      computeRunnerTerminationOutcome({ kind: 'signal', signal: 'SIGINT' }),
    );

    expect(order).toEqual(['drain', 'end', 'close']);
    releasePromptLoop();
    await lifecycle;
  });

  it('does not close the session when host shutdown work rejects', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const shutdownError = new Error('session_closed');
    const termination = {
      onTerminate: null as ((event: RunnerTerminationEvent, outcome: RunnerTerminationOutcome) => void | Promise<void>) | null,
    };
    let releasePromptLoop!: () => void;
    const promptLoopReleased = new Promise<void>((resolve) => {
      releasePromptLoop = resolve;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
      },
      deps: {
        ...baseParams.deps,
        onBeforeSessionClose: async () => {
          throw shutdownError;
        },
        registerRunnerTerminationHandlersFn: vi.fn((registration) => {
          termination.onTerminate = registration.onTerminate;
          return {
            dispose: vi.fn(),
            requestTermination: vi.fn((_event: RunnerTerminationEvent) => undefined),
            whenTerminated: new Promise<Readonly<{
              event: RunnerTerminationEvent;
              outcome: RunnerTerminationOutcome;
            }>>(() => {}),
          };
        }),
        runPermissionModePromptLoopFn: vi.fn(async () => {
          await promptLoopReleased;
        }),
      },
    };

    const lifecycle = runSessionLoopLifecycle(params);
    await vi.waitFor(() => expect(termination.onTerminate).not.toBeNull());
    const onTerminate = termination.onTerminate;
    if (!onTerminate) throw new Error('Expected runner termination handler registration');
    await expect(onTerminate(
      { kind: 'signal', signal: 'SIGINT' },
      computeRunnerTerminationOutcome({ kind: 'uncaughtException' }),
    )).rejects.toBe(shutdownError);
    expect(baseParams.session.close).not.toHaveBeenCalled();
    releasePromptLoop();
    await lifecycle;
  });

  it('publishes exact turn identity to the daemon only after durable runtime mutation acceptance', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const notifyDaemonConnectedServiceTurnLifecycleFn = vi.fn<NotifyDaemonConnectedServiceTurnLifecycleFn>(async (input) => ({
      status: 'continue' as const,
      turnCustody: {
        status: 'recorded' as const,
        activeTurnId:
          input.event === 'task_started'
            ? input.turnId ?? null
            : null,
      },
    }));
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      opts: {
        ...baseParams.opts,
        startedBy: 'daemon',
      },
      deps: {
        ...baseParams.deps,
        notifyDaemonConnectedServiceTurnLifecycleFn,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-exact-1',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-exact-1',
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    await vi.waitFor(() => expect(notifyDaemonConnectedServiceTurnLifecycleFn).toHaveBeenCalledTimes(2));
    expect(notifyDaemonConnectedServiceTurnLifecycleFn).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1',
      event: 'task_started',
      turnId: 'turn-exact-1',
    });
    expect(notifyDaemonConnectedServiceTurnLifecycleFn).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1',
      event: 'assistant_message_end',
      terminalStatus: 'completed',
      turnId: 'turn-exact-1',
    });
  });

  it('does not finish runner cleanup until a rejected exact begin reaches marker custody', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    let releaseRecorded!: () => void;
    const recorded = new Promise<void>((resolve) => {
      releaseRecorded = resolve;
    });
    const notifyDaemonConnectedServiceTurnLifecycleFn = vi.fn<NotifyDaemonConnectedServiceTurnLifecycleFn>(async (input) => {
      if (notifyDaemonConnectedServiceTurnLifecycleFn.mock.calls.length === 1) {
        return {
          status: 'continue' as const,
          turnCustody: { status: 'ignored_marker_not_updated' as const, activeTurnId: null },
        };
      }
      await recorded;
      return {
        status: 'continue' as const,
        turnCustody: {
          status: 'recorded' as const,
          activeTurnId: input.turnId ?? null,
        },
      };
    });
    const cleanupBackendRunResourcesFn = vi.fn(async ({ keepAliveInterval }: { keepAliveInterval: NodeJS.Timeout }) => {
      clearInterval(keepAliveInterval);
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      opts: { ...baseParams.opts, startedBy: 'daemon' },
      deps: {
        ...baseParams.deps,
        cleanupBackendRunResourcesFn,
        notifyDaemonConnectedServiceTurnLifecycleFn,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-exact-retry',
            startedBy: 'host',
          }));
        }),
      },
    };

    let settled = false;
    const run = runSessionLoopLifecycle(params).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(notifyDaemonConnectedServiceTurnLifecycleFn).toHaveBeenCalledTimes(2));
    expect((baseParams.session as any).enqueueSessionTurnMutation).not.toHaveBeenCalled();
    expect(cleanupBackendRunResourcesFn).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    releaseRecorded();
    await run;
    expect(cleanupBackendRunResourcesFn).toHaveBeenCalledOnce();
    expect(settled).toBe(true);
  });

  it('retains the exact daemon marker without logging a hostile terminal mutation rejection', async () => {
    loggerDebugMock.mockClear();
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const hostileFailure = createRevokedTranscriptFailure(
      'private terminal mutation transcript must not enter logs',
    );
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const session = baseParams.session as unknown as {
      enqueueSessionTurnMutation: ReturnType<typeof vi.fn>;
    };
    session.enqueueSessionTurnMutation.mockImplementation(async (mutation) => {
      if (mutation.action === 'complete') {
        throw hostileFailure;
      }
    });
    let daemonActiveTurnId: string | null = null;
    const notifyDaemonConnectedServiceTurnLifecycleFn = vi.fn<NotifyDaemonConnectedServiceTurnLifecycleFn>(async (input) => {
      daemonActiveTurnId = input.event === 'task_started' ? input.turnId ?? null : null;
      return {
        status: 'continue' as const,
        turnCustody: {
          status: 'recorded' as const,
          activeTurnId: daemonActiveTurnId,
        },
      };
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      opts: { ...baseParams.opts, startedBy: 'daemon' },
      deps: {
        ...baseParams.deps,
        notifyDaemonConnectedServiceTurnLifecycleFn,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-terminal-rejection',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-terminal-rejection',
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'complete',
      turnId: 'turn-terminal-rejection',
    }));
    expect(notifyDaemonConnectedServiceTurnLifecycleFn).toHaveBeenCalledTimes(1);
    expect(notifyDaemonConnectedServiceTurnLifecycleFn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      event: 'task_started',
      turnId: 'turn-terminal-rejection',
    });
    expect(daemonActiveTurnId).toBe('turn-terminal-rejection');
    expect(loggerReceivedIdentity(hostileFailure)).toBe(false);
    expect(loggerDebugMock).toHaveBeenCalledWith(
      '[Test] Runtime terminal turn mutation failed',
      {
        error: 'runtime_terminal_turn_mutation_failed',
        action: 'complete',
      },
    );
  });
});

describe('runSessionLoopLifecycle runtime transcript projection', () => {
  it('fans strict agent-session lifecycle classes into Host Events without coupling producer success', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const publishHostRuntimeEvent = vi.fn<(event: AgentSessionRuntimeEventV1) => void>(() => {
      throw new Error('Host Event listener failure');
    });
    const events = [
      canonicalRuntimeEvent({
        kind: 'turn-complete',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'turn-1',
      }),
      canonicalRuntimeEvent({
        kind: 'runtime-ended',
        sessionId: 'session-1',
        emittedAtMs: 2,
        cause: 'providerEnded',
        retryable: false,
      }),
      canonicalRuntimeEvent({
        kind: 'runtime-activity-snapshot',
        sessionId: 'session-1',
        emittedAtMs: 3,
        state: 'idle',
        activeCount: 0,
      }),
    ] as const;
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        publishHostRuntimeEvent,
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          for (const event of events) runtimeEventHandler?.(event);
        }),
      },
    };

    await expect(runSessionLoopLifecycle(params)).resolves.toBeUndefined();

    expect(publishHostRuntimeEvent.mock.calls.map(([event]) => event)).toEqual(events);
  });

  it('fails closed before provider effects when required runtime event subscription rejects', async () => {
    loggerDebugMock.mockClear();
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const hostileFailure = createRevokedTranscriptFailure(
      'private runtime subscription transcript must not enter logs',
    );
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn(() => {
      throw hostileFailure;
    });
    const runPermissionModePromptLoopFn = vi.fn(async () => undefined);
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn,
      },
    };

    await expect(runSessionLoopLifecycle(params)).rejects.toMatchObject({
      code: 'runtime_event_subscription_required',
    });

    expect(loggerReceivedIdentity(hostileFailure)).toBe(false);
    expect(runPermissionModePromptLoopFn).not.toHaveBeenCalled();
    expect(baseParams.deps.cleanupBackendRunResourcesFn).toHaveBeenCalledOnce();
  });

  it('does not log a hostile runtime cancellation rejection', async () => {
    loggerDebugMock.mockClear();
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const hostileFailure = createRevokedTranscriptFailure(
      'private cancellation transcript must not enter logs',
    );
    let abortRequested: (() => void | Promise<void>) | null = null;
    const runtime = baseParams.runtime as unknown as {
      cancelTurn: ReturnType<typeof vi.fn>;
    };
    runtime.cancelTurn.mockRejectedValue(hostileFailure);
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      setAbortRequestedCallback: (callback) => {
        abortRequested = callback;
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          await abortRequested?.();
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(loggerReceivedIdentity(hostileFailure)).toBe(false);
    expect(loggerDebugMock).toHaveBeenCalledWith(
      '[Test] Failed to cancel current operation (non-fatal)',
      { error: 'runtime_cancel_failed' },
    );
  });

  it('lets canonical runtime cancellation own the durable transcript marker without an abort-side duplicate', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    let abortRequested: (() => void | Promise<void>) | null = null;
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
      cancelTurn: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    runtime.cancelTurn.mockImplementation(async () => {
      runtimeEventHandler?.(canonicalRuntimeEvent({
        kind: 'turn-cancelled',
        sessionId: 'session-1',
        emittedAtMs: 2,
        turnId: 'turn-1',
        agentTurnId: 'agent-turn-1',
        cause: 'user',
      }));
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      setAbortRequestedCallback: (callback) => {
        abortRequested = callback;
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-1',
            startedBy: 'host',
          }));
          await abortRequested?.();
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(baseParams.session.enqueueAgentMessageCommitted).toHaveBeenCalledOnce();
    expect(baseParams.session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'codex',
      { type: 'turn_cancelled', id: 'agent-turn-1' },
      expect.objectContaining({
        localId: 'agent-turn-1:turn_cancelled',
        provenance: { kind: 'non_dependent', source: 'external' },
      }),
    );
    expect(baseParams.session.enqueueSessionTurnMutation).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cancel', turnId: 'turn-1' }),
    );
  });

  it('classifies a hostile remote handoff rejection without logging or synchronizing it', async () => {
    loggerDebugMock.mockClear();
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const hostileFailure = createRevokedTranscriptFailure(
      'private remote handoff transcript must not enter logs or sync',
    );
    let agentState: Record<string, unknown> = {};
    const session = baseParams.session as unknown as {
      updateAgentState: ReturnType<typeof vi.fn>;
    };
    session.updateAgentState = vi.fn(async (
      updater: (state: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      agentState = updater(agentState);
    });
    const requestGracefulRemoteHandoff = vi.fn(async () => {
      throw hostileFailure;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      terminalRemoteModeLoop: {
        startingMode: 'terminal',
        remoteExitCode: 0,
        runTerminal: vi.fn(async () => ({ type: 'switch' as const })),
        runRemote: vi.fn(async () => 'exit' as const),
        onModeChange: vi.fn(),
        requestGracefulRemoteHandoff,
      },
      deps: {
        ...baseParams.deps,
        runTerminalRemoteSessionModeLoopFn: vi.fn(async (options) => {
          await options.onBeforeIteration?.('terminal');
          return 0;
        }),
        runPermissionModePromptLoopFn: vi.fn(async (loopParams) => {
          await expect(loopParams.beforePendingMaterialize?.()).resolves.toBe(false);
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(requestGracefulRemoteHandoff).toHaveBeenCalledWith(
      'pending_queue_after_terminal_boundary',
    );
    expect(loggerReceivedIdentity(hostileFailure)).toBe(false);
    expect(loggerDebugMock).toHaveBeenCalledWith(
      '[Test] Failed to request remote handoff',
      {
        error: 'remote_handoff_failed',
        reason: 'pending_queue_after_terminal_boundary',
      },
    );
    expect(agentState).toMatchObject({
      terminalControl: {
        pendingHandoffV1: {
          status: 'switch_failed',
          detail: 'remote_handoff_failed',
        },
      },
    });
  });

  it('closes the session exactly once when the initial terminal child exits', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      opts: {
        ...baseParams.opts,
        startedBy: 'terminal',
        startingMode: 'terminal',
      },
      terminalRemoteModeLoop: {
        startingMode: 'terminal',
        remoteExitCode: 0,
        runTerminal: vi.fn(async () => ({ type: 'exit' as const, code: 0 })),
        runRemote: vi.fn(async () => 'exit' as const),
        onModeChange: vi.fn(),
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async (loopParams) => {
          const signal = loopParams.getAbortSignal();
          if (signal.aborted) return;
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(baseParams.session.endSessionAndClose).toHaveBeenCalledOnce();
    expect(baseParams.deps.cleanupBackendRunResourcesFn).toHaveBeenCalledOnce();
  });

  it('uses an injected foreground daemon bridge for agent context transforms without a process-global handoff', async () => {
    const previousTokenFile =
      process.env[RETIRED_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY];
    delete process.env[RETIRED_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY];
    const transformedPayload = Object.freeze({
      sessionId: 'session-1',
      agentId: 'codex',
      prompt: 'daemon-transformed',
    });
    const agentComposition = {
      kind: 'composition' as const,
      managedPluginIds: ['example.agent-context-companion'],
      selectedTools: [{
        pluginId: 'example.agent-context-companion',
        localId: 'review-summary-tool',
      }],
      selectedToolBindings: [{
        tool: {
          toolId: 'example.agent-context-companion/review-summary-tool',
          actionId: 'review-summary',
          name: 'review_summary',
          title: 'Review summary',
          description: 'Summarize the bounded review transcript.',
          inputSchema: { type: 'object', additionalProperties: false },
          surfaces: ['agent', 'mcp'],
        },
        expectedContributorImmutableGenerationId: 'generation-g',
      }],
      promptAssetBlocks: [],
      toolPromptContributions: [],
      additionalInstructions: [{
        pluginId: 'example.agent-context-companion',
        text: 'Use the bounded review cursor for this next turn.',
      }],
    } satisfies Awaited<ReturnType<DaemonAgentRuntimeTurnContributionsBridge['resolveAgentComposition']>>;
    const daemonTurnContributionsBridge = {
      resolvePrompt: vi.fn(),
      resolveAgentComposition: vi.fn(async () => agentComposition),
      resolveComposerReference: vi.fn(async () => {
        throw new Error('composer reference was not requested');
      }),
      resolveComposerAttachment: vi.fn(async () => ({
        attachments: [{
          instanceId: 'review-1',
          status: 'ready' as const,
          context: 'Fresh review context.',
          data: { refreshed: true },
        }],
      })),
      afterComposerAttachmentMessageAccepted: vi.fn(async () => {}),
      transformAgentContext: vi.fn(async () => transformedPayload),
      transformSessionInput: vi.fn(),
      transformAgentRequest: vi.fn(),
    } satisfies DaemonAgentRuntimeTurnContributionsBridge;
    let observedPayload: unknown = null;
    let observedErrorPolicy: unknown = null;
    let observedComposition: unknown = null;
    let observedAttachment: unknown = null;
    try {
      const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
      const deps = {
        ...baseParams.deps,
        daemonTurnContributionsBridge,
        runPermissionModePromptLoopFn: vi.fn(async (loopParams) => {
          observedErrorPolicy = loopParams.transformAgentContextErrorPolicy;
          observedPayload = await loopParams.transformAgentContextBeforeDispatch?.({
            sessionId: 'session-1',
            agentId: 'codex',
            prompt: 'original',
          });
          observedComposition = await loopParams.resolveAgentCompositionBeforeDispatch?.({
            signal: new AbortController().signal,
          });
          observedAttachment = await loopParams.resolveComposerAttachmentForDispatch!({
            sessionId: 'session-1',
            attachment: {
              pluginId: 'acme.review',
              localId: 'review-comment',
            },
            request: {
              sessionId: 'session-1',
              localId: 'local-1',
              attachments: [{
                instanceId: 'review-1',
                key: 'review-1',
                value: { reviewId: '42' },
              }],
            },
            signal: new AbortController().signal,
          });
        }),
      } satisfies SessionLoopLifecycleParams['deps'];
      const params: SessionLoopLifecycleParams = {
        ...baseParams,
        deps,
      };

      await runSessionLoopLifecycle(params);

      expect(observedPayload).toEqual(transformedPayload);
      expect(observedErrorPolicy).toBe('throw');
      expect(observedAttachment).toEqual({
        attachments: [{
          instanceId: 'review-1',
          status: 'ready',
          context: 'Fresh review context.',
          data: { refreshed: true },
        }],
      });
      expect(daemonTurnContributionsBridge.transformAgentContext).toHaveBeenCalledWith({
        sessionId: 'session-1',
        payload: {
          sessionId: 'session-1',
          agentId: 'codex',
          prompt: 'original',
        },
        signal: expect.any(AbortSignal),
      });
      expect(daemonTurnContributionsBridge.resolveAgentComposition).toHaveBeenCalledWith({
        sessionId: 'session-1',
        runtimeFamily: 'hostSession',
        machineId: 'machine-1',
        featureIds: ['execution.runs'],
        signal: expect.any(AbortSignal),
      });
      expect(daemonTurnContributionsBridge.resolveComposerAttachment).toHaveBeenCalledWith({
        sessionId: 'session-1',
        attachment: {
          pluginId: 'acme.review',
          localId: 'review-comment',
        },
        request: {
          sessionId: 'session-1',
          localId: 'local-1',
          attachments: [{
            instanceId: 'review-1',
            key: 'review-1',
            value: { reviewId: '42' },
          }],
        },
        signal: expect.any(AbortSignal),
      });
      expect(observedComposition).toEqual({
        managedPluginIds: ['example.agent-context-companion'],
        selectedTools: [{
          pluginId: 'example.agent-context-companion',
          localId: 'review-summary-tool',
        }],
        selectedToolBindings: [{
          tool: {
            toolId: 'example.agent-context-companion/review-summary-tool',
            actionId: 'review-summary',
            name: 'review_summary',
            title: 'Review summary',
            description: 'Summarize the bounded review transcript.',
            inputSchema: { type: 'object', additionalProperties: false },
            surfaces: ['agent', 'mcp'],
          },
          expectedContributorImmutableGenerationId: 'generation-g',
        }],
        prompt: expect.stringContaining('Use the bounded review cursor for this next turn.'),
      });
    } finally {
      if (previousTokenFile === undefined) {
        delete process.env[RETIRED_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY];
      } else {
        process.env[RETIRED_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY] =
          previousTokenFile;
      }
    }
  });

  it('ignores a legacy process-global daemon bridge handoff without an explicit runner contribution bridge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-stream-hook-daemon-child-'));
    const tokenFilePath = join(root, 'handoff.json');
    const previousTokenFile =
      process.env[RETIRED_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY];
    await writeFile(tokenFilePath, JSON.stringify({
      v: 1,
      token: 'bridge-token',
      descriptor: {
        v: 1,
        pluginId: 'happier.agent.codex',
        pluginVersion: '1.2.3',
        agentId: 'codex',
        backendId: 'codex',
        generation: 'generation-stream',
      },
    }), 'utf8');
    process.env[RETIRED_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY] =
      tokenFilePath;
    vi.spyOn(
      pluginReloadController,
      'tryAcquireRuntimeRegistry',
    );
    try {
      const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
      let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
      const runtime = baseParams.runtime as unknown as {
        subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
      };
      runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
        runtimeEventHandler = handler;
        return () => undefined;
      });
      const params: SessionLoopLifecycleParams = {
        ...baseParams,
        deps: {
          ...baseParams.deps,
          runPermissionModePromptLoopFn: vi.fn(async () => {
            runtimeEventHandler?.(canonicalRuntimeEvent({
              kind: 'message-delta',
              sessionId: 'session-1',
              emittedAtMs: 2,
              turnId: 'turn-stream-daemon',
              channel: 'assistant',
              text: 'daemon-owned token',
            }));
          }),
        },
      };

      await runSessionLoopLifecycle(params);

      expect(pluginReloadController.tryAcquireRuntimeRegistry).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      if (previousTokenFile === undefined) {
        delete process.env[RETIRED_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY];
      } else {
        process.env[RETIRED_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY] =
          previousTokenFile;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('observes message-delta runtime events through agent.stream.token without blocking projection', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const observeAgentStreamToken = vi.fn(async () => undefined);
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        observeAgentStreamToken,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-stream-1',
            channel: 'assistant',
            text: 'partial token',
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(observeAgentStreamToken).toHaveBeenCalledWith({
      sessionId: 'session-1',
      agentId: 'codex',
      runtimeFamily: 'hostSession',
      turnId: 'turn-stream-1',
      tokenText: 'partial token',
      streamKind: 'assistant',
      timestampMs: 2,
    });
  });

  it('does not retain an arbitrary agent.stream.token observer rejection', async () => {
    loggerDebugMock.mockClear();
    const baseParams = createLifecycleParams({ policyAgentId: 'codex' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const hostile = Proxy.revocable({}, {});
    hostile.revoke();
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        observeAgentStreamToken: async () => {
          throw hostile.proxy;
        },
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-stream-private-rejection',
            channel: 'assistant',
            text: 'private token',
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(loggerDebugMock).toHaveBeenCalledWith(
      '[Test] agent.stream.token observer failed (non-fatal)',
    );
  });

  it('projects turn-failed runtime issues into visible durable diagnostics when no assistant text was committed', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'opencode' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
      enqueueSessionTurnMutation: ReturnType<typeof vi.fn>;
      getTurnAssistantTextSnapshotStore: ReturnType<typeof vi.fn>;
    };
    session.getTurnAssistantTextSnapshotStore = vi.fn(() => ({
      getCurrentTurnSnapshot: () => ({ seq: 42, source: 'committed' }),
    }));
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-1',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-failed',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-1',
            diagnostic: {
              code: 'opencode_empty_provider_response',
              severity: 'error',
              message: 'OpenCode completed provider tool work but returned no assistant message.',
              details: { agentId: 'opencode' },
            },
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      {
        type: 'message',
        message: expect.stringContaining('Provider session failed'),
      },
      {
        localId: 'turn-1:runtime_issue',
        meta: expect.objectContaining({
          runtimeIssueCode: 'agent_session_error',
          runtimeIssueSource: 'agent_session_error',
        }),
        provenance: { kind: 'non_dependent', source: 'background' },
      },
    );
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      { type: 'turn_failed', id: 'turn-1' },
      {
        localId: 'turn-1:turn_failed',
        meta: expect.objectContaining({
          source: 'runtime',
          runtimeIssueCode: 'agent_session_error',
        }),
        provenance: { kind: 'non_dependent', source: 'background' },
      },
    );
    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'fail',
      turnId: 'turn-1',
      issue: expect.objectContaining({
        code: 'agent_session_error',
      }),
    }));
  });

  it('does not add a generic runtime diagnostic when the runtime already committed assistant text for the failed turn', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'claude' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
    };
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        agentMessageType: 'claude',
        providerName: 'Claude',
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-2',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'transcript-message-committed',
            sessionId: 'session-1',
            emittedAtMs: 2,
            messageId: 'turn-2:provider-error',
            role: 'assistant',
            text: 'Claude authentication failed.',
            turnId: 'turn-2',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-failed',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-2',
            diagnostic: {
              code: 'claude_authentication_failed',
              severity: 'error',
              message: 'Claude authentication failed.',
              details: { agentId: 'claude' },
            },
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'claude',
      { type: 'message', message: 'Claude authentication failed.' },
      {
        localId: 'turn-2:provider-error',
        provenance: { kind: 'non_dependent', source: 'external' },
      },
    );
    expect(session.enqueueAgentMessageCommitted).not.toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({
        type: 'message',
        message: expect.stringContaining('turn failed'),
      }),
      expect.objectContaining({ localId: 'turn-2:runtime_issue' }),
    );
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'claude',
      { type: 'turn_failed', id: 'turn-2' },
      expect.objectContaining({ localId: 'turn-2:turn_failed' }),
    );
  });

  it('does not add a generic runtime diagnostic when the runtime already streamed assistant text before failing', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'cursor' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
    };
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        agentMessageType: 'cursor',
        providerName: 'Cursor',
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-3',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-3',
            channel: 'assistant',
            text: 'Partial answer before failure.',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-failed',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-3',
            diagnostic: {
              code: 'cursor_runtime_error',
              severity: 'error',
              message: 'Cursor failed after streaming partial output.',
              details: { agentId: 'cursor' },
            },
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'cursor',
      { type: 'message', message: 'Partial answer before failure.' },
      expect.objectContaining({
        meta: expect.objectContaining({
          happierStreamSegmentV1: expect.objectContaining({
            segmentState: 'interrupted',
          }),
        }),
      }),
    );
    expect(session.enqueueAgentMessageCommitted).not.toHaveBeenCalledWith(
      'cursor',
      expect.objectContaining({
        type: 'message',
        message: expect.stringContaining('turn failed'),
      }),
      expect.objectContaining({ localId: 'turn-3:runtime_issue' }),
    );
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'cursor',
      { type: 'turn_failed', id: 'turn-3' },
      expect.objectContaining({ localId: 'turn-3:turn_failed' }),
    );
  });

  it('keeps permission-blocked runtime diagnostics visible after an assistant preamble without trusting diagnostic identity', async () => {
    const spoofedAgentId = 'spoofed-diagnostic-agent';
    const spoofedAgentTurnId = 'spoofed-diagnostic-agent-turn';
    const hostAgentTurnId = 'host-agent-turn-permission-denied';
    const baseParams = createLifecycleParams({ policyAgentId: 'opencode' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
    };
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        agentMessageType: 'opencode',
        providerName: 'OpenCode',
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-permission-denied',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-permission-denied',
            channel: 'assistant',
            text: 'I need to inspect the repo first.',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-failed',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-permission-denied',
            agentTurnId: hostAgentTurnId,
            diagnostic: {
              code: 'opencode_permission_denied',
              severity: 'error',
              message: 'OpenCode permission request was denied.',
              details: {
                v: 1,
                source: 'permission_blocked',
                agentId: spoofedAgentId,
                agentTurnId: spoofedAgentTurnId,
              },
            },
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      { type: 'message', message: 'I need to inspect the repo first.' },
      expect.any(Object),
    );
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      { type: 'message', message: 'Permission blocked' },
      expect.objectContaining({
        localId: 'turn-permission-denied:runtime_issue',
        meta: expect.objectContaining({
          runtimeIssueCode: 'permission_blocked',
          runtimeIssueSource: 'permission_blocked',
          runtimeIssueProvider: 'opencode',
          runtimeIssueProviderTurnId: hostAgentTurnId,
        }),
      }),
    );
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      { type: 'turn_failed', id: 'turn-permission-denied' },
      expect.objectContaining({ localId: 'turn-permission-denied:turn_failed' }),
    );
    expect(JSON.stringify(session.enqueueAgentMessageCommitted.mock.calls)).not.toContain(spoofedAgentId);
    expect(JSON.stringify(session.enqueueAgentMessageCommitted.mock.calls)).not.toContain(spoofedAgentTurnId);
  });

  it('flushes streamed assistant text before publishing a turn-failed marker', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'cursor' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
    };
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        agentMessageType: 'cursor',
        providerName: 'Cursor',
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-4',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-4',
            channel: 'assistant',
            text: 'Visible partial answer.',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-failed',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-4',
            diagnostic: {
              code: 'cursor_runtime_error',
              severity: 'error',
              message: 'Cursor failed after streaming partial output.',
              details: { agentId: 'cursor' },
            },
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    const streamedAssistantCallIndex = session.enqueueAgentMessageCommitted.mock.calls.findIndex(([provider, body, opts]) => {
      return provider === 'cursor'
        && body.type === 'message'
        && body.message === 'Visible partial answer.'
        && opts.meta?.happierStreamSegmentV1?.segmentState === 'interrupted';
    });
    const turnFailedCallIndex = session.enqueueAgentMessageCommitted.mock.calls.findIndex(([provider, body, opts]) => {
      return provider === 'cursor'
        && body.type === 'turn_failed'
        && body.id === 'turn-4'
        && opts.localId === 'turn-4:turn_failed';
    });

    expect(streamedAssistantCallIndex).toBeGreaterThanOrEqual(0);
    expect(turnFailedCallIndex).toBeGreaterThanOrEqual(0);
    expect(session.enqueueAgentMessageCommitted.mock.invocationCallOrder[streamedAssistantCallIndex]!).toBeLessThan(
      session.enqueueAgentMessageCommitted.mock.invocationCallOrder[turnFailedCallIndex]!,
    );
  });

  it('waits for runtime transcript projection durability before cleanup completes', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'opencode' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    let releaseCommit!: () => void;
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
    };
    session.enqueueAgentMessageCommitted = vi.fn(async () => {
      await commitReleased;
      return { persisted: true as const, delivered: false as const };
    });
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const cleanupBackendRunResourcesFn = vi.fn(async ({ keepAliveInterval }: { keepAliveInterval: NodeJS.Timeout }) => {
      clearInterval(keepAliveInterval);
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        cleanupBackendRunResourcesFn,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'transcript-message-committed',
            sessionId: 'session-1',
            emittedAtMs: 1,
            messageId: 'turn-1:terminal-note',
            role: 'assistant',
            text: 'Terminal failure marker',
            turnId: 'turn-1',
          }));
        }),
      },
    };

    let settled = false;
    const runPromise = runSessionLoopLifecycle(params).then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
        'opencode',
        { type: 'message', message: 'Terminal failure marker' },
        expect.objectContaining({
          localId: 'turn-1:terminal-note',
          provenance: { kind: 'non_dependent', source: 'external' },
        }),
      );
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
    expect(cleanupBackendRunResourcesFn).not.toHaveBeenCalled();

    releaseCommit();
    await runPromise;

    expect(settled).toBe(true);
    expect(cleanupBackendRunResourcesFn).toHaveBeenCalledTimes(1);
  });

  it('does not log a hostile runtime transcript projection rejection', async () => {
    loggerDebugMock.mockClear();
    const baseParams = createLifecycleParams({ policyAgentId: 'opencode' });
    const hostileFailure = createRevokedTranscriptFailure(
      'private projected transcript must not enter logs',
    );
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
    };
    session.enqueueAgentMessageCommitted.mockRejectedValue(hostileFailure);
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'transcript-message-committed',
            sessionId: 'session-1',
            emittedAtMs: 1,
            messageId: 'turn-private-projection:assistant',
            role: 'assistant',
            text: 'private projected transcript must not enter logs',
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(loggerReceivedIdentity(hostileFailure)).toBe(false);
    expect(loggerDebugMock).toHaveBeenCalledWith(
      '[Test] Runtime transcript projection failed (non-fatal)',
      {
        error: 'runtime_transcript_projection_failed',
        eventKind: 'transcript-message-committed',
      },
    );
  });

  it('waits for transcript projection durability before publishing terminal turn mutations', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'antigravity' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    let releaseCommit!: () => void;
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
      enqueueSessionTurnMutation: ReturnType<typeof vi.fn>;
    };
    session.enqueueAgentMessageCommitted = vi.fn(async () => {
      await commitReleased;
      return { persisted: true as const, delivered: false as const };
    });
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-1',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'transcript-message-committed',
            sessionId: 'session-1',
            emittedAtMs: 2,
            messageId: 'turn-1:assistant',
            role: 'assistant',
            text: 'Antigravity answered.',
            turnId: 'turn-1',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-1',
          }));
        }),
      },
    };

    const runPromise = runSessionLoopLifecycle(params);

    await vi.waitFor(() => {
      expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
        'antigravity',
        { type: 'message', message: 'Antigravity answered.' },
        expect.objectContaining({
          localId: 'turn-1:assistant',
          provenance: { kind: 'non_dependent', source: 'external' },
        }),
      );
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'begin',
      turnId: 'turn-1',
    }));
    expect(session.enqueueSessionTurnMutation).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'complete',
      turnId: 'turn-1',
    }));

    releaseCommit();
    await runPromise;

    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'complete',
      turnId: 'turn-1',
    }));
  });

  it('projects public runtime message deltas before publishing terminal turn mutations', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'cursor' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
      enqueueSessionTurnMutation: ReturnType<typeof vi.fn>;
    };
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        agentMessageType: 'cursor',
        providerName: 'Cursor',
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-1',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-1',
            channel: 'assistant',
            text: 'Cursor ',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-1',
            channel: 'assistant',
            text: 'answered.',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 4,
            turnId: 'turn-1',
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'cursor',
      { type: 'message', message: 'Cursor answered.' },
      expect.objectContaining({
        meta: expect.objectContaining({
          happierStreamSegmentV1: expect.objectContaining({
            segmentKind: 'assistant',
            segmentState: 'complete',
          }),
        }),
      }),
    );
    const committedCallOrder = session.enqueueAgentMessageCommitted.mock.invocationCallOrder.at(-1);
    const completeMutationCall = session.enqueueSessionTurnMutation.mock.calls.findIndex((call) => {
      const [mutation] = call;
      return mutation?.action === 'complete' && mutation.turnId === 'turn-1';
    });
    expect(committedCallOrder).toBeDefined();
    expect(completeMutationCall).toBeGreaterThanOrEqual(0);
    expect(committedCallOrder).toBeLessThan(
      session.enqueueSessionTurnMutation.mock.invocationCallOrder[completeMutationCall]!,
    );
    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'complete',
        turnId: 'turn-1',
        transcriptAnchors: { finalAssistantMessageSeq: 42 },
      }),
    );
  });

  it('serializes runtime transcript projections so tool-boundary flushes complete before later transcript rows', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'cursor' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    let releaseStreamCommit!: () => void;
    const streamCommitReleased = new Promise<void>((resolve) => {
      releaseStreamCommit = resolve;
    });
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
    };
    session.enqueueAgentMessageCommitted = vi.fn(async (_provider, body, opts) => {
      if (
        body.type === 'message'
        && body.message === 'Before tool.'
        && opts.meta?.happierStreamSegmentV1
      ) {
        await streamCommitReleased;
      }
      return { persisted: true as const, delivered: false as const };
    });
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      config: {
        ...baseParams.config,
        agentMessageType: 'cursor',
        providerName: 'Cursor',
      },
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-1',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-1',
            channel: 'assistant',
            text: 'Before tool.',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'tool-call',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-1',
            toolCallId: 'tool-1',
            toolName: 'read_file',
            input: { path: 'README.md' },
          }));
        }),
      },
    };

    const runPromise = runSessionLoopLifecycle(params);

    await vi.waitFor(() => {
      expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
        'cursor',
        { type: 'message', message: 'Before tool.' },
        expect.objectContaining({
          meta: expect.objectContaining({
            happierStreamSegmentV1: expect.objectContaining({
              segmentState: 'streaming',
            }),
          }),
        }),
      );
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(session.enqueueAgentMessageCommitted).not.toHaveBeenCalledWith(
      'cursor',
      expect.objectContaining({ type: 'tool-call' }),
      expect.objectContaining({ localId: expect.stringMatching(/^acp-call-v1:/) }),
    );

    releaseStreamCommit();
    await runPromise;

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'cursor',
      expect.objectContaining({ type: 'tool-call' }),
      expect.objectContaining({ localId: expect.stringMatching(/^acp-call-v1:/) }),
    );
  });

  it('bounds transcript projection waits so cleanup cannot hang forever', async () => {
    vi.useFakeTimers();
    try {
      const baseParams = createLifecycleParams({ policyAgentId: 'antigravity' });
      let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
      const session = baseParams.session as unknown as {
        enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
      };
      session.enqueueAgentMessageCommitted = vi.fn(() => new Promise(() => undefined));
      const runtime = baseParams.runtime as unknown as {
        subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
      };
      runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
        runtimeEventHandler = handler;
        return () => undefined;
      });
      const cleanupBackendRunResourcesFn = vi.fn(async ({ keepAliveInterval }: { keepAliveInterval: NodeJS.Timeout }) => {
        clearInterval(keepAliveInterval);
      });
      const params: SessionLoopLifecycleParams = {
        ...baseParams,
        deps: {
          ...baseParams.deps,
          runtimeTranscriptProjectionDrainTimeoutMs: 10,
          cleanupBackendRunResourcesFn,
          runPermissionModePromptLoopFn: vi.fn(async () => {
            runtimeEventHandler?.(canonicalRuntimeEvent({
              kind: 'transcript-message-committed',
              sessionId: 'session-1',
              emittedAtMs: 2,
              messageId: 'turn-1:assistant',
              role: 'assistant',
              text: 'This projection never resolves.',
              turnId: 'turn-1',
            }));
          }),
        },
      };

      const runPromise = runSessionLoopLifecycle(params);

      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
      }
      expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(9);
      expect(cleanupBackendRunResourcesFn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => {
        expect(cleanupBackendRunResourcesFn).toHaveBeenCalledTimes(1);
      });

      await runPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the serialized transcript projection chain so later runtime events can still project', async () => {
    let releasePromptLoop: () => void = () => undefined;
    let runPromise: Promise<void> | null = null;
    try {
      const baseParams = createLifecycleParams({ policyAgentId: 'antigravity' });
      let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
      const getRuntimeEventHandler = (): RuntimeTurnMessageHandler => {
        if (runtimeEventHandler === null) {
          throw new Error('Expected runtime event handler to be registered');
        }
        return runtimeEventHandler;
      };
      const session = baseParams.session as unknown as {
        enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
      };
      session.enqueueAgentMessageCommitted = vi.fn((_provider: unknown, _body: unknown, opts: unknown) => {
        const options = opts && typeof opts === 'object' && !Array.isArray(opts)
          ? opts as Readonly<{ localId?: unknown }>
          : null;
        if (options?.localId === 'turn-1:assistant') {
          return new Promise(() => undefined);
        }
        return Promise.resolve({ persisted: true as const, delivered: false as const });
      });
      const runtime = baseParams.runtime as unknown as {
        subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
      };
      runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
        runtimeEventHandler = handler;
        return () => undefined;
      });
      const promptLoopReleased = new Promise<void>((resolve) => {
        releasePromptLoop = resolve;
      });
      const params: SessionLoopLifecycleParams = {
        ...baseParams,
        deps: {
          ...baseParams.deps,
          runtimeTranscriptProjectionDrainTimeoutMs: 10,
          runPermissionModePromptLoopFn: vi.fn(async () => {
            await promptLoopReleased;
          }),
        },
      };

      runPromise = runSessionLoopLifecycle(params);

      await vi.waitFor(() => {
        expect(runtimeEventHandler).not.toBeNull();
      });
      const emitRuntimeEvent = getRuntimeEventHandler();
      emitRuntimeEvent(canonicalRuntimeEvent({
        kind: 'transcript-message-committed',
        sessionId: 'session-1',
        emittedAtMs: 2,
        messageId: 'turn-1:assistant',
        role: 'assistant',
        text: 'This projection never resolves.',
        turnId: 'turn-1',
      }));
      await vi.waitFor(() => {
        expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
          'antigravity',
          { type: 'message', message: 'This projection never resolves.' },
          expect.objectContaining({ localId: 'turn-1:assistant' }),
        );
      });

      emitRuntimeEvent(canonicalRuntimeEvent({
        kind: 'tool-call',
        sessionId: 'session-1',
        emittedAtMs: 3,
        turnId: 'turn-2',
        toolCallId: 'call-1',
        toolName: 'Bash',
        input: { cmd: 'pwd' },
      }));
      await Promise.resolve();
      expect(session.enqueueAgentMessageCommitted).not.toHaveBeenCalledWith(
        'opencode',
        expect.objectContaining({ type: 'tool-call' }),
        expect.objectContaining({
          localId: expect.stringMatching(/^acp-call-v1:/),
          meta: expect.objectContaining({ runtimeTurnId: 'turn-2' }),
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
        'opencode',
        expect.objectContaining({ type: 'tool-call' }),
        expect.objectContaining({
          localId: expect.stringMatching(/^acp-call-v1:/),
          meta: expect.objectContaining({ runtimeTurnId: 'turn-2' }),
        }),
      );
    } finally {
      releasePromptLoop();
      if (runPromise) {
        await runPromise;
      }
    }
  });
});

describe('runSessionLoopLifecycle required transcript admission', () => {
  it('terminalizes as a typed failure instead of success after an earlier stable tool admission loses custody', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'cursor' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
      enqueueSessionTurnMutation: ReturnType<typeof vi.fn>;
    };
    session.enqueueAgentMessageCommitted.mockImplementation(async (_provider, body) => ({
      persisted: body.type !== 'tool-result',
      delivered: false,
    }));
    const notifyDaemonConnectedServiceTurnLifecycleFn = vi.fn<NotifyDaemonConnectedServiceTurnLifecycleFn>(async (input) => ({
      status: 'continue' as const,
      turnCustody: {
        status: 'recorded' as const,
        activeTurnId: input.event === 'task_started' ? input.turnId ?? null : null,
      },
    }));
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      opts: { ...baseParams.opts, startedBy: 'daemon' },
      deps: {
        ...baseParams.deps,
        notifyDaemonConnectedServiceTurnLifecycleFn,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-required-output',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'tool-result',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-required-output',
            toolCallId: 'tool-1',
            output: { text: 'stable result' },
          }));
          await new Promise((resolve) => setImmediate(resolve));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-required-output',
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueSessionTurnMutation).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'complete',
      turnId: 'turn-required-output',
    }));
    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'fail',
      turnId: 'turn-required-output',
      issue: expect.objectContaining({
        code: 'runtime_transcript_required_admission_failed',
        source: 'stream_error',
      }),
    }));
    expect(notifyDaemonConnectedServiceTurnLifecycleFn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'assistant_message_end',
      turnId: 'turn-required-output',
      terminalStatus: 'failed',
    }));
  });

  it('keeps ephemeral progress loss non-fatal for terminal success', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'cursor' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const session = baseParams.session as unknown as {
      enqueueSessionTurnMutation: ReturnType<typeof vi.fn>;
      sendAgentMessageEphemeral: ReturnType<typeof vi.fn>;
      getEphemeralStreamConnectionEpoch: ReturnType<typeof vi.fn>;
    };
    session.sendAgentMessageEphemeral = vi.fn(async () => ({
      accepted: false as const,
      epoch: 1,
      reason: 'disconnected' as const,
    }));
    session.getEphemeralStreamConnectionEpoch = vi.fn(() => 1);
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-ephemeral-progress',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'tool-progress',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-ephemeral-progress',
            toolCallId: 'tool-1',
            progress: { toolName: 'Read', status: 'running' },
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-ephemeral-progress',
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'complete',
      turnId: 'turn-ephemeral-progress',
    }));
  });

  it('terminalizes as a typed failure when required projection custody does not settle before the drain deadline', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'antigravity' });
    let runtimeEventHandler: RuntimeTurnMessageHandler | null = null;
    const runtime = baseParams.runtime as unknown as {
      subscribeRuntimeEvents: ReturnType<typeof vi.fn>;
    };
    runtime.subscribeRuntimeEvents = vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeEventHandler = handler;
      return () => undefined;
    });
    const session = baseParams.session as unknown as {
      enqueueAgentMessageCommitted: ReturnType<typeof vi.fn>;
      enqueueSessionTurnMutation: ReturnType<typeof vi.fn>;
    };
    session.enqueueAgentMessageCommitted = vi.fn(() => new Promise(() => undefined));
    const params: SessionLoopLifecycleParams = {
      ...baseParams,
      deps: {
        ...baseParams.deps,
        runtimeTranscriptProjectionDrainTimeoutMs: 10,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-projection-timeout',
            startedBy: 'host',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'transcript-message-committed',
            sessionId: 'session-1',
            emittedAtMs: 2,
            messageId: 'turn-projection-timeout:assistant',
            role: 'assistant',
            text: 'Pending required answer',
            turnId: 'turn-projection-timeout',
          }));
          runtimeEventHandler?.(canonicalRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-projection-timeout',
          }));
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueSessionTurnMutation).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'complete',
      turnId: 'turn-projection-timeout',
    }));
    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'fail',
      turnId: 'turn-projection-timeout',
      issue: expect.objectContaining({
        code: 'runtime_transcript_required_admission_failed',
      }),
    }));
  });
});
