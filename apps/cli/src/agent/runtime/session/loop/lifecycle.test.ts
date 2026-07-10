import { describe, expect, it, vi } from 'vitest';

import type { RuntimeCheckpointToolProtocolV1 } from '@happier-dev/agents';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { Metadata } from '@/api/types';
import type { RuntimeTurnMessageHandler } from '@/agent/runtime/turns/runtimeTurnOperations';
import { runSessionLoopLifecycle, type SessionLoopLifecycleParams } from './lifecycle';

const checkpointLifecycle = Object.freeze({});

const checkpointFactory = vi.hoisted(() => vi.fn(() => checkpointLifecycle));

type RunPermissionModePromptLoopFn = NonNullable<
  NonNullable<SessionLoopLifecycleParams['deps']>['runPermissionModePromptLoopFn']
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
      runPermissionModePromptLoopFn: overrides?.runPermissionModePromptLoopFn ?? vi.fn(async () => undefined),
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

describe('runSessionLoopLifecycle runtime transcript projection', () => {
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
          runtimeEventHandler?.({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-stream-1',
            delta: { text: 'partial token' },
          });
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

  it('projects turn-failed runtime issues into visible durable diagnostics when no assistant text was committed', async () => {
    const baseParams = createLifecycleParams({ policyAgentId: 'opencode' });
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
      deps: {
        ...baseParams.deps,
        runPermissionModePromptLoopFn: vi.fn(async () => {
          runtimeEventHandler?.({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-1',
            startedBy: 'user',
          });
          runtimeEventHandler?.({
            kind: 'turn-failed',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-1',
            issue: {
              v: 1,
              scope: 'primary_session',
              status: 'failed',
              code: 'opencode_empty_provider_response',
              source: 'agent_session_error',
              agentId: 'opencode',
              occurredAt: 2,
              sanitizedPreview: 'OpenCode completed provider tool work but returned no assistant message.',
            },
          });
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      {
        type: 'message',
        message: expect.stringContaining('OpenCode completed provider tool work but returned no assistant message.'),
      },
      {
        localId: 'turn-1:runtime_issue',
        meta: expect.objectContaining({
          runtimeIssueCode: 'opencode_empty_provider_response',
          runtimeIssueSource: 'agent_session_error',
        }),
      },
    );
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      { type: 'turn_failed', id: 'turn-1' },
      {
        localId: 'turn-1:turn_failed',
        meta: expect.objectContaining({
          source: 'runtime',
          runtimeIssueCode: 'opencode_empty_provider_response',
        }),
      },
    );
    expect(session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'fail',
      turnId: 'turn-1',
      issue: expect.objectContaining({
        code: 'opencode_empty_provider_response',
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
          runtimeEventHandler?.({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-2',
            startedBy: 'user',
          });
          runtimeEventHandler?.({
            kind: 'transcript-agent-message-committed',
            sessionId: 'session-1',
            emittedAtMs: 2,
            agentId: 'claude',
            localId: 'turn-2:provider-error',
            body: { type: 'message', message: 'Claude authentication failed.' },
          });
          runtimeEventHandler?.({
            kind: 'turn-failed',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-2',
            issue: {
              v: 1,
              scope: 'primary_session',
              status: 'failed',
              code: 'claude_authentication_failed',
              source: 'auth_error',
              agentId: 'claude',
              occurredAt: 3,
              sanitizedPreview: 'Claude authentication failed.',
            },
          });
        }),
      },
    };

    await runSessionLoopLifecycle(params);

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'claude',
      { type: 'message', message: 'Claude authentication failed.' },
      { localId: 'turn-2:provider-error' },
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
          runtimeEventHandler?.({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-3',
            startedBy: 'user',
          });
          runtimeEventHandler?.({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-3',
            delta: { text: 'Partial answer before failure.' },
          });
          runtimeEventHandler?.({
            kind: 'turn-failed',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-3',
            issue: {
              v: 1,
              scope: 'primary_session',
              status: 'failed',
              code: 'cursor_runtime_error',
              source: 'agent_session_error',
              agentId: 'cursor',
              occurredAt: 3,
              sanitizedPreview: 'Cursor failed after streaming partial output.',
            },
          });
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

  it('keeps permission-blocked runtime diagnostics visible after an assistant preamble', async () => {
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
          runtimeEventHandler?.({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-permission-denied',
            startedBy: 'user',
          });
          runtimeEventHandler?.({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-permission-denied',
            delta: { text: 'I need to inspect the repo first.' },
          });
          runtimeEventHandler?.({
            kind: 'turn-failed',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-permission-denied',
            issue: {
              v: 1,
              scope: 'primary_session',
              status: 'failed',
              code: 'opencode_permission_denied',
              source: 'permission_blocked',
              agentId: 'opencode',
              occurredAt: 3,
              sanitizedPreview: 'OpenCode permission request was denied.',
            },
          });
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
      { type: 'message', message: 'OpenCode permission request was denied.' },
      expect.objectContaining({ localId: 'turn-permission-denied:runtime_issue' }),
    );
    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      { type: 'turn_failed', id: 'turn-permission-denied' },
      expect.objectContaining({ localId: 'turn-permission-denied:turn_failed' }),
    );
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
          runtimeEventHandler?.({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-4',
            startedBy: 'user',
          });
          runtimeEventHandler?.({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-4',
            delta: { text: 'Visible partial answer.' },
          });
          runtimeEventHandler?.({
            kind: 'turn-failed',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-4',
            issue: {
              v: 1,
              scope: 'primary_session',
              status: 'failed',
              code: 'cursor_runtime_error',
              source: 'agent_session_error',
              agentId: 'cursor',
              occurredAt: 3,
              sanitizedPreview: 'Cursor failed after streaming partial output.',
            },
          });
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
          runtimeEventHandler?.({
            kind: 'transcript-agent-message-committed',
            sessionId: 'session-1',
            emittedAtMs: 1,
            agentId: 'opencode',
            localId: 'turn-1:turn_failed',
            body: { type: 'turn_failed', id: 'turn-1' },
          });
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
        { type: 'turn_failed', id: 'turn-1' },
        { localId: 'turn-1:turn_failed' },
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
          runtimeEventHandler?.({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-1',
            startedBy: 'user',
          });
          runtimeEventHandler?.({
            kind: 'transcript-agent-message-committed',
            sessionId: 'session-1',
            emittedAtMs: 2,
            agentId: 'antigravity',
            localId: 'turn-1:assistant',
            body: { type: 'message', message: 'Antigravity answered.' },
          });
          runtimeEventHandler?.({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-1',
          });
        }),
      },
    };

    const runPromise = runSessionLoopLifecycle(params);

    await vi.waitFor(() => {
      expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
        'antigravity',
        { type: 'message', message: 'Antigravity answered.' },
        { localId: 'turn-1:assistant' },
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
          runtimeEventHandler?.({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-1',
            startedBy: 'user',
          });
          runtimeEventHandler?.({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-1',
            delta: { text: 'Cursor ' },
          });
          runtimeEventHandler?.({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-1',
            delta: { text: 'answered.' },
          });
          runtimeEventHandler?.({
            kind: 'turn-complete',
            sessionId: 'session-1',
            emittedAtMs: 4,
            turnId: 'turn-1',
          });
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
          runtimeEventHandler?.({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
            turnId: 'turn-1',
            startedBy: 'user',
          });
          runtimeEventHandler?.({
            kind: 'message-delta',
            sessionId: 'session-1',
            emittedAtMs: 2,
            turnId: 'turn-1',
            delta: { text: 'Before tool.' },
          });
          runtimeEventHandler?.({
            kind: 'tool-call',
            sessionId: 'session-1',
            emittedAtMs: 3,
            turnId: 'turn-1',
            toolCallId: 'tool-1',
            toolName: 'read_file',
            toolInput: { path: 'README.md' },
          });
          runtimeEventHandler?.({
            kind: 'transcript-agent-message-committed',
            sessionId: 'session-1',
            emittedAtMs: 4,
            agentId: 'cursor',
            localId: 'turn-1:tool',
            body: { type: 'tool_call', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } },
          });
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
      expect.objectContaining({ type: 'tool_call' }),
      expect.objectContaining({ localId: 'turn-1:tool' }),
    );

    releaseStreamCommit();
    await runPromise;

    expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'cursor',
      expect.objectContaining({ type: 'tool_call' }),
      expect.objectContaining({ localId: 'turn-1:tool' }),
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
            runtimeEventHandler?.({
              kind: 'transcript-agent-message-committed',
              sessionId: 'session-1',
              emittedAtMs: 2,
              agentId: 'antigravity',
              localId: 'turn-1:assistant',
              body: { type: 'message', message: 'This projection never resolves.' },
            });
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
      emitRuntimeEvent({
        kind: 'transcript-agent-message-committed',
        sessionId: 'session-1',
        emittedAtMs: 2,
        agentId: 'antigravity',
        localId: 'turn-1:assistant',
        body: { type: 'message', message: 'This projection never resolves.' },
      });
      await vi.waitFor(() => {
        expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
          'antigravity',
          { type: 'message', message: 'This projection never resolves.' },
          expect.objectContaining({ localId: 'turn-1:assistant' }),
        );
      });

      emitRuntimeEvent({
        kind: 'tool-call',
        sessionId: 'session-1',
        emittedAtMs: 3,
        turnId: 'turn-2',
        toolCallId: 'call-1',
        toolName: 'Bash',
        toolInput: { cmd: 'pwd' },
      });
      await Promise.resolve();
      expect(session.enqueueAgentMessageCommitted).not.toHaveBeenCalledWith(
        'opencode',
        expect.objectContaining({ type: 'tool-call' }),
        expect.objectContaining({ localId: 'turn-2:call-1:tool-call' }),
      );

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
        'opencode',
        expect.objectContaining({ type: 'tool-call' }),
        expect.objectContaining({ localId: 'turn-2:call-1:tool-call' }),
      );
    } finally {
      releasePromptLoop();
      if (runPromise) {
        await runPromise;
      }
    }
  });
});
