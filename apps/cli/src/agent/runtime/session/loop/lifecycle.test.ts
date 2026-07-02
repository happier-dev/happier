import { describe, expect, it, vi } from 'vitest';

import type { RuntimeCheckpointToolProtocolV1 } from '@happier-dev/agents';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { Metadata } from '@/api/types';
import type { RuntimeTurnMessageHandler } from '@/agent/runtime/turns/runtimeTurnOperations';
import { runSessionLoopLifecycle, type SessionLoopLifecycleParams } from './lifecycle';

const checkpointLifecycle = Object.freeze({});

const checkpointFactory = vi.hoisted(() => vi.fn(() => checkpointLifecycle));

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
}>): SessionLoopLifecycleParams {
  const runtimeSubscribers = new Set<RuntimeTurnMessageHandler>();
  const runtime = {
    beginTurnLifecycle: vi.fn(),
    startOrLoadSession: vi.fn(async () => undefined),
    sendTurnPrompt: vi.fn(async () => undefined),
    steerInFlightTurn: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    subscribeRuntimeEvents: vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeSubscribers.add(handler);
      return () => runtimeSubscribers.delete(handler);
    }),
    respondToPermission: vi.fn(async () => undefined),
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
    sendAgentMessage: vi.fn(),
    sendUserTextMessage: vi.fn(),
    sendAgentMessageCommitted: vi.fn(async () => undefined),
    enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false as const })),
    enqueueSessionTurnMutation: vi.fn(async () => undefined),
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
    hookRuntime: null,
    messageBuffer: new MessageBuffer(),
    permissionHandler: {
      reset: vi.fn(),
      setPermissionMode: vi.fn(),
    },
    permissionModeState: {
      rebindSession: vi.fn(),
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
    happyMcpServerStop: vi.fn(),
    reconnectionHandle: null,
    startupCoordinator: null,
    runtimeState: {
      thinking: false,
    },
    setAbortRequestedCallback: vi.fn(),
    deps: {
      runPermissionModePromptLoopFn: vi.fn(async () => undefined),
      registerRunnerTerminationHandlersFn: vi.fn(() => ({
        dispose: vi.fn(),
        requestTermination: vi.fn(),
        whenTerminated: Promise.resolve({
          event: { kind: 'exit' as const, code: 0 },
          outcome: { exitCode: 0, archive: true, archiveReason: 'Exited normally' },
        }),
      })),
      registerKillSessionHandlerFn: vi.fn(),
      cleanupBackendRunResourcesFn: vi.fn(async ({ keepAliveInterval }: { keepAliveInterval: NodeJS.Timeout }) => {
        clearInterval(keepAliveInterval);
      }),
      archiveAndCloseRuntimeSessionFn: vi.fn(async () => undefined),
      startRemoteModeStaticControlFn: vi.fn(),
      renderFn: vi.fn(),
    },
    initialResumeId: '',
  };
}

describe('runSessionLoopLifecycle checkpoint controls', () => {
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
});
