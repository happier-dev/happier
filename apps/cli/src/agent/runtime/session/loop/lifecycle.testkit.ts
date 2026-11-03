import { vi } from 'vitest';
import type { RuntimeCheckpointToolProtocolV1 } from '@happier-dev/agents';
import type { Metadata } from '@/api/types';
import type { RuntimeTurnMessageHandler } from '@/agent/runtime/turns/runtimeTurnOperations';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createUnsettledReplaySeedRetirement } from '@/agent/runtime/replaySeed/unsettledReplaySeedRetirement';
import { computeRunnerTerminationOutcome } from '@/agent/runtime/lifecycle/runnerTerminationOutcome';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { createManualCompactionQueue } from '@/agent/runtime/queueSpecialCommands';
import type { SessionLoopLifecycleParams } from './lifecycle';
type RunPermissionModePromptLoopFn = NonNullable<NonNullable<SessionLoopLifecycleParams['deps']>['runPermissionModePromptLoopFn']>;

export function createMetadata(): Metadata {
  return {
    path: '/tmp/project',
    host: 'test-host',
    homeDir: '/tmp',
    happyHomeDir: '/tmp/.happier',
    happyLibDir: '/tmp/.happier/lib',
    happyToolsDir: '/tmp/.happier/tools',
  };
}

export const machineMetadata = {
  host: 'test-host',
  platform: 'darwin',
  happyCliVersion: '0.0.0-test',
  homeDir: '/tmp',
  happyHomeDir: '/tmp/.happier',
  happyLibDir: '/tmp/.happier/lib',
};

export function createLifecycleParams(overrides?: Readonly<{
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
    setOnPromptDeliveryOutcome: vi.fn(),
    resetOrDisposeRuntime: vi.fn(async () => undefined),
  };
  const session = {
    ...createMutableApiSessionClientFixture({ sessionId: 'session-1', metadata: createMetadata() }),
    sessionId: 'session-1',
    rpcHandlerManager: {
      sessionId: 'session-1',
      registerHandler: vi.fn(),
    },
    getMetadataSnapshot: vi.fn(() => createMetadata()),
    fetchLatestUserPermissionIntentFromTranscript: vi.fn(async () => null),
    waitForMetadataUpdate: vi.fn((signal?: AbortSignal) => new Promise<boolean>((resolve) => {
      if (signal?.aborted) resolve(false);
      else signal?.addEventListener('abort', () => resolve(false), { once: true });
    })),
    keepAlive: vi.fn(),
    retireUndispatchedProviderInput: vi.fn(),
    enqueueSessionEventCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const })),
    enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const })),
    enqueueSessionTurnMutation: vi.fn(async () => undefined),
    endSessionAndClose: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };

  const messageQueue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
    mode => mode.permissionMode, { batcher: combinePermissionModeQueuedPrompts });
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
      agentMessageType: overrides?.policyAgentId ?? 'codex',
      runtimeActivityApplicability: 'not_applicable',
      machineMetadata,
      loadTerminalDisplay: async () => () => null,
      formatPromptErrorMessage: (error: unknown) => String(error),
      shouldRenderTerminalDisplay: () => false,
      ...(overrides?.checkpointToolProtocol
        ? { checkpointToolProtocol: overrides.checkpointToolProtocol }
        : {}),
    } as SessionLoopLifecycleParams['config'],
    api: {
      push: () => ({
        sendToAllDevices: vi.fn(),
        sendToAllDevicesAsync: vi.fn(async () => true),
      }),
    },
    session: session as unknown as SessionLoopLifecycleParams['session'],
    runtime,
    hookRuntime: overrides?.hookRuntime ?? runtime,
    registerProviderAcceptedEffect: vi.fn(),
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
      messageQueue,
      manualCompaction: createManualCompactionQueue({ queue: messageQueue, readText: message => message.text, isAvailable: () => false }),
      replaySeedRetirement: createUnsettledReplaySeedRetirement(),
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
      cleanupBackendRunResourcesFn: vi.fn(async ({ stopKeepAlive }: { stopKeepAlive: () => void }) => {
        stopKeepAlive();
      }),
      startRemoteModeStaticControlFn: vi.fn(),
      renderFn: vi.fn(),
    },
    initialResumeId: '',
  };
}


