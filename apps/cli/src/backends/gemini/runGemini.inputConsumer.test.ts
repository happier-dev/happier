import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcpTurnOutcome } from '@/agent/acp/backend/turn/_types';
import type {
  DrainPendingOptions,
  DrainPendingResult,
  MessageBatch,
} from '@/agent/runtime/sessionInput/types';
import type { SessionProviderInputConsumerOptions } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';
import { resetConnectedServiceRuntimeAuthFailureReportDedupeForTests } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import type { Credentials } from '@/persistence';

import type { GeminiMode } from './types';

type GeminiInputConsumer = {
  waitForNextInput: (opts: { abortSignal: AbortSignal }) => Promise<MessageBatch<GeminiMode, string> | null>;
  drainPending: (opts?: DrainPendingOptions) => Promise<DrainPendingResult>;
  runProviderInputDispatch: <Value>(opts: Readonly<{
    abortSignal: AbortSignal;
    dispatch: () => Promise<Value>;
  }>) => Promise<Readonly<{ status: 'dispatched'; value: Value }> | Readonly<{ status: 'cancelled' }>>;
  closeProviderInputAdmissionAndWaitForDispatches: () => Promise<void>;
};

type FakeSession = {
  sessionId: string;
  rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> };
  onUserMessage: ReturnType<typeof vi.fn>;
  getMetadataSnapshot: ReturnType<typeof vi.fn>;
  fetchLatestUserPermissionIntentFromTranscript: ReturnType<typeof vi.fn>;
  keepAlive: ReturnType<typeof vi.fn>;
  waitForMetadataUpdate: ReturnType<typeof vi.fn>;
  waitForPendingEligibilityUpdate: ReturnType<typeof vi.fn>;
  materializeNextPendingMessageSafely: ReturnType<typeof vi.fn>;
  popPendingMessage: ReturnType<typeof vi.fn>;
  shouldAttemptPendingMaterialization: ReturnType<typeof vi.fn>;
  reconcilePendingQueueState: ReturnType<typeof vi.fn>;
  getLastObservedMessageSeq: ReturnType<typeof vi.fn>;
  beginTurnAssistantTextSnapshot: ReturnType<typeof vi.fn>;
  bindProviderInputOutcomeProducer: ReturnType<typeof vi.fn>;
  blockPendingMessageDelivery: ReturnType<typeof vi.fn>;
  sendAgentMessage: ReturnType<typeof vi.fn>;
  sendSessionEvent: ReturnType<typeof vi.fn>;
  updateMetadata: ReturnType<typeof vi.fn>;
  sendSessionDeath: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

type MessageBufferRecord = { message: string; type: string };

const {
  abortPendingAcpPermissionRequestsMock,
  createGeminiBackendInstanceMock,
  createGeminiTerminalUiMock,
  createProviderEnforcedPermissionHandlerMock,
  createSessionProviderInputConsumerMock,
  createStreamedTranscriptWriterMock,
  drainPendingMock,
  emitReadyIfIdleMock,
  ensureGeminiAcpSessionMock,
  fakeBackend,
  getFakeSession,
  messageBufferRecords,
  notifyDaemonConnectedServiceRuntimeAuthFailureMock,
  providerInputOutcomeObserverMock,
  recordSessionTurnCompletedMock,
  resolveGeminiQueuedPromptWithReplaySeedMock,
  resolveGeminiSystemPromptTextMock,
  sendGeminiPromptWithRetryMock,
  setFakeSession,
  surfacePrimarySessionRuntimeIssueMock,
  waitForNextInputMock,
} = vi.hoisted(() => {
  let fakeSession: FakeSession | null = null;
  const messageBufferRecords: MessageBufferRecord[] = [];

  const fakeBackend = {
    onMessage: vi.fn(),
    startSession: vi.fn(async () => ({ sessionId: 'gemini-acp-session-1' })),
    cancel: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };

  return {
    abortPendingAcpPermissionRequestsMock: vi.fn(async () => undefined),
    createGeminiBackendInstanceMock: vi.fn(async () => ({
      backend: fakeBackend,
      model: 'gemini-2.5-pro',
      modelSource: 'explicit',
    })),
    createGeminiTerminalUiMock: vi.fn(() => ({
      mount: vi.fn(),
      unmount: vi.fn(async () => undefined),
      updateDisplayedModel: vi.fn(),
      getDisplayedModel: vi.fn(() => 'gemini-2.5-pro'),
    })),
    createProviderEnforcedPermissionHandlerMock: vi.fn(() => ({
      updateSession: vi.fn(),
      abortPendingRequestsAndFlush: vi.fn(async () => undefined),
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    })),
    createSessionProviderInputConsumerMock: vi.fn<
      (opts: SessionProviderInputConsumerOptions<GeminiMode, string>) => GeminiInputConsumer
    >(),
    createStreamedTranscriptWriterMock: vi.fn(() => ({
      flushAll: vi.fn(async () => undefined),
      setCommitProvenance: vi.fn(),
    })),
    drainPendingMock: vi.fn<(opts?: DrainPendingOptions) => Promise<DrainPendingResult>>(),
    emitReadyIfIdleMock: vi.fn(),
    ensureGeminiAcpSessionMock: vi.fn(async () => ({
      acpSessionId: 'gemini-acp-session-1',
      storedResumeId: null,
      startedFreshSession: true,
    })),
    fakeBackend,
    getFakeSession: () => {
      if (!fakeSession) {
        throw new Error('Expected fake Gemini session to be configured');
      }
      return fakeSession;
    },
    messageBufferRecords,
    notifyDaemonConnectedServiceRuntimeAuthFailureMock: vi.fn(),
    providerInputOutcomeObserverMock: vi.fn(),
    recordSessionTurnCompletedMock: vi.fn(async () => undefined),
    resolveGeminiQueuedPromptWithReplaySeedMock: vi.fn<
      (opts: { text: string; didBootstrap: boolean }) => Promise<{
        text: string;
        didBootstrap: boolean;
        seedApplied?: boolean;
        settleReplaySeedOnProviderAcceptance?: () => Promise<unknown>;
      }>
    >(async (opts) => ({
      text: opts.text,
      didBootstrap: opts.didBootstrap || true,
    })),
    resolveGeminiSystemPromptTextMock: vi.fn(async () => 'fresh system prompt'),
    sendGeminiPromptWithRetryMock: vi.fn<
      (opts: {
        prompt: string;
        onProviderPromptAccepted?: () => void;
        onProviderPromptAttemptStarted?: () => void;
        onProviderPromptEffectMayHaveOccurred?: () => void;
      }) => Promise<AcpTurnOutcome>
    >(async () => ({
      kind: 'completed',
      stopReason: 'end_turn',
    })),
    setFakeSession: (session: FakeSession) => {
      fakeSession = session;
    },
    surfacePrimarySessionRuntimeIssueMock: vi.fn(async () => undefined),
    waitForNextInputMock: vi.fn<
      (opts: { abortSignal: AbortSignal }) => Promise<MessageBatch<GeminiMode, string> | null>
    >(),
  };
});

vi.mock('@/agent/runtime/sessionInput/SessionProviderInputConsumer', () => ({
  createSessionProviderInputConsumer: createSessionProviderInputConsumerMock,
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  notifyDaemonConnectedServiceRuntimeAuthFailure: notifyDaemonConnectedServiceRuntimeAuthFailureMock,
}));

vi.mock('@/agent/runtime/initializeBackendApiContext', () => ({
  initializeBackendApiContext: vi.fn(async () => ({
    api: {
      push: vi.fn(() => ({ sendToAllDevices: vi.fn(async () => undefined) })),
    },
    machineId: 'machine-1',
  })),
}));

vi.mock('@/agent/runtime/initializeBackendRunSession', () => ({
  initializeBackendRunSession: vi.fn(async () => ({
    session: getFakeSession(),
    reconnectionHandle: null,
  })),
}));

vi.mock('@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue', () => ({
  recordSessionTurnCompleted: recordSessionTurnCompletedMock,
  surfacePrimarySessionRuntimeIssue: surfacePrimarySessionRuntimeIssueMock,
}));

vi.mock('@/agent/acp/backend/permissions/acpPermissionFinalization', () => ({
  abortPendingAcpPermissionRequests: abortPendingAcpPermissionRequestsMock,
}));

vi.mock('@/agent/permissions/createProviderEnforcedPermissionHandler', () => ({
  createProviderEnforcedPermissionHandler: createProviderEnforcedPermissionHandlerMock,
}));

vi.mock('@/agent/runtime/createSessionMetadata', () => ({
  createSessionMetadata: vi.fn(() => ({
    state: {},
    metadata: { path: '/tmp/gemini-test' },
  })),
}));

vi.mock('@/daemon/startDaemon', () => ({
  initialMachineMetadata: {},
}));

vi.mock('@/configuration', () => ({
  configuration: {
    startupPermissionSeedTranscriptTake: 5,
    sessionKeepAliveIdleMs: 10_000,
    sessionKeepAliveThinkingMs: 2_000,
    // Required transitively by the connected-services runtime-auth producer import in runGemini:
    // resolveExistingSessionAttachContext constructs its concurrency gate at import time. 0 = unlimited.
    daemonReattachCatchUpConcurrency: 0,
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    warn: vi.fn(),
    infoDeveloper: vi.fn(),
    getLogPath: vi.fn(() => '/tmp/happier-gemini-test.log'),
  },
}));

vi.mock('@/ui/tty/resolveHasTTY', () => ({
  resolveHasTTY: vi.fn(() => false),
}));

vi.mock('@/ui/ink/messageBuffer', () => {
  function MessageBuffer(this: { addMessage: (message: string, type: string) => void; clear: () => void }) {
    this.addMessage = vi.fn((message: string, type: string) => {
      messageBufferRecords.push({ message, type });
    });
    this.clear = vi.fn();
  }

  return { MessageBuffer };
});

vi.mock('@/agent/runtime/emitReadyIfIdle', () => ({
  emitReadyIfIdle: emitReadyIfIdleMock,
}));

vi.mock('@/agent/runtime/sendReadyWithPushNotification', () => ({
  sendReadyWithPushNotification: vi.fn(),
}));

vi.mock('@/agent/runtime/readyNotificationContext', () => ({
  getSessionNotificationTitle: vi.fn(() => 'Gemini test session'),
}));

vi.mock('@/agent/runtime/readyNotificationAssistantText', () => ({
  resolveReadyNotificationAssistantText: vi.fn(() => null),
}));

vi.mock('@/agent/runtime/turnAssistantPreviewTracker', () => ({
  createTurnAssistantPreviewTracker: vi.fn(() => ({
    reset: vi.fn(),
    getPreview: vi.fn(() => null),
  })),
}));

let lastResolveRunnerMcpServersParams: any = null;
vi.mock('@/mcp/runtime/resolveRunnerMcpServers', () => ({
  resolveRunnerMcpServers: vi.fn(async (params: any) => {
    lastResolveRunnerMcpServersParams = params;
    return {
    happierMcpServer: { stop: vi.fn() },
    mcpServers: [],
    };
  }),
}));

vi.mock('@/rpc/handlers/killSession', () => ({
  registerKillSessionHandler: vi.fn(),
}));

vi.mock('@/integrations/caffeinate', () => ({
  stopCaffeinate: vi.fn(),
}));

vi.mock('@/api/offline/serverConnectionErrors', () => ({
  connectionState: { setBackend: vi.fn() },
}));

vi.mock('@/api/session/createCurrentSessionTranscriptPort', () => ({
  createCurrentSessionTranscriptPort: vi.fn(() => ({})),
}));

vi.mock('@/api/session/streamedTranscriptWriter', () => ({
  createStreamedTranscriptWriter: createStreamedTranscriptWriterMock,
}));

vi.mock('@/api/session/sessionWritesBestEffort', () => ({
  updateMetadataBestEffort: vi.fn(async () => undefined),
}));

vi.mock('@/backends/gemini/utils/formatGeminiErrorForUi', () => ({
  formatGeminiErrorForUi: vi.fn(() => 'Gemini failed'),
}));

vi.mock('@/agent/runtime/createStartupMetadataOverrides', () => ({
  createStartupMetadataOverrides: vi.fn(() => ({})),
}));

vi.mock('@/agent/runtime/runnerTerminationHandlers', () => ({
  registerRunnerTerminationHandlers: vi.fn(() => ({
    requestTermination: vi.fn(),
    whenTerminated: Promise.resolve(),
    dispose: vi.fn(),
  })),
}));

vi.mock('@/agent/runtime/runtimeOverridesSynchronizer', () => ({
  initializeRuntimeOverridesSynchronizer: vi.fn(async () => ({
    syncFromMetadata: vi.fn(),
    seedFromSession: vi.fn(async () => undefined),
  })),
}));

vi.mock('@/settings/permissions/permissionModeSeed', () => ({
  resolvePermissionModeSeedForAgentStart: vi.fn(() => ({ mode: 'default' })),
}));

vi.mock('@/settings/notifications/notificationsPolicy', () => ({
  shouldSendReadyPushNotification: vi.fn(() => false),
}));

vi.mock('@/agent/runtime/resolveAttachedRunRuntimeContext', () => ({
  resolveAttachedRunRuntimeContext: vi.fn(() => ({
    runtimeDirectory: '/tmp/gemini-test',
    sessionMetadataSnapshot: null,
    resolvedMetadata: { path: '/tmp/gemini-test' },
  })),
}));

vi.mock('@/backends/gemini/utils/diffProcessor', () => ({
  GeminiDiffProcessor: class {
    reset(): void {}
    completeTurn(): void {}
  },
}));

vi.mock('@/backends/gemini/utils/config', () => ({
  readGeminiLocalConfig: vi.fn(() => ({ model: null })),
  saveGeminiModelToConfig: vi.fn(),
  getInitialGeminiModel: vi.fn(() => 'gemini-2.5-pro'),
}));

vi.mock('@/backends/gemini/runtime/createGeminiBackendMessageHandler', () => ({
  createGeminiBackendMessageHandler: vi.fn(() => vi.fn()),
}));

vi.mock('@/backends/gemini/runtime/createGeminiBackendInstance', () => ({
  createGeminiBackendInstance: createGeminiBackendInstanceMock,
}));

vi.mock('@/backends/gemini/runtime/ensureGeminiAcpSession', () => ({
  ensureGeminiAcpSession: ensureGeminiAcpSessionMock,
}));

vi.mock('@/backends/gemini/runtime/freshSessionSystemPromptState', () => ({
  resolveShouldPrependAppendSystemPromptOnNextFreshSessionPrompt: vi.fn(() => true),
}));

vi.mock('@/backends/gemini/runtime/sendGeminiPromptWithRetry', () => ({
  sendGeminiPromptWithRetry: sendGeminiPromptWithRetryMock,
}));

vi.mock('@/backends/gemini/runtime/createGeminiTerminalUi', () => ({
  createGeminiTerminalUi: createGeminiTerminalUiMock,
}));

vi.mock('@/backends/gemini/runtime/resolveGeminiQueuedPromptWithReplaySeed', () => ({
  resolveGeminiQueuedPromptWithReplaySeed: resolveGeminiQueuedPromptWithReplaySeedMock,
}));

vi.mock('@/backends/gemini/runtime/formatGeminiPromptDebugSummary', () => ({
  formatGeminiPromptDebugSummary: vi.fn(() => 'Gemini prompt summary'),
}));

vi.mock('@/backends/gemini/prompting/resolveGeminiSystemPromptText', () => ({
  resolveGeminiSystemPromptText: resolveGeminiSystemPromptTextMock,
}));

vi.mock('@/features/featureDecisionService', () => ({
  resolveCliFeatureDecision: vi.fn(() => ({ state: 'disabled' })),
}));

vi.mock('@/cloud/connectedServices/resolveConnectedServiceCredentials', () => ({
  resolveConnectedServiceCredentials: vi.fn(async () => new Map()),
}));

vi.mock('@/cloud/decodeJwtPayload', () => ({
  decodeJwtPayload: vi.fn(() => null),
}));

function createFakeSession(): FakeSession {
  return {
    sessionId: 'session-1',
    rpcHandlerManager: { registerHandler: vi.fn() },
    onUserMessage: vi.fn(),
    getMetadataSnapshot: vi.fn(() => ({ path: '/tmp/gemini-test' })),
    fetchLatestUserPermissionIntentFromTranscript: vi.fn(async () => null),
    keepAlive: vi.fn(),
    waitForMetadataUpdate: vi.fn(async () => false),
    waitForPendingEligibilityUpdate: vi.fn(async () => false),
    materializeNextPendingMessageSafely: vi.fn(
      async (): Promise<MaterializeNextPendingResult> => ({ type: 'no_pending' }),
    ),
    popPendingMessage: vi.fn(async () => {
      throw new Error('Gemini must drain pending through the input consumer');
    }),
    shouldAttemptPendingMaterialization: vi.fn(() => true),
    reconcilePendingQueueState: vi.fn(async () => false),
    getLastObservedMessageSeq: vi.fn(() => 10),
    beginTurnAssistantTextSnapshot: vi.fn(() => 'turn-token-1'),
    bindProviderInputOutcomeProducer: vi.fn(() => providerInputOutcomeObserverMock),
    blockPendingMessageDelivery: vi.fn(async () => true),
    sendAgentMessage: vi.fn(),
    sendSessionEvent: vi.fn(),
    updateMetadata: vi.fn(async () => undefined),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe('runGemini input consumer migration', () => {
  const credentials: Credentials = {
    token: 'test-token',
    encryption: { type: 'legacy', secret: new Uint8Array([1]) },
  };

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    resetConnectedServiceRuntimeAuthFailureReportDedupeForTests();
    messageBufferRecords.length = 0;
    lastResolveRunnerMcpServersParams = null;

    const session = createFakeSession();
    setFakeSession(session);

    waitForNextInputMock
      .mockResolvedValueOnce({
        message: 'queued prompt text',
        mode: {
          permissionMode: 'safe-yolo',
          model: 'gemini-2.5-pro',
          originalUserMessage: 'visible user text',
          appendSystemPrompt: 'custom system addendum',
          localId: 'local-1',
          replaySeedAllowed: false,
        },
        isolate: false,
        hash: 'mode-hash-1',
      })
      .mockResolvedValueOnce(null);

    drainPendingMock.mockResolvedValue({ materialized: 0, stoppedReason: 'no_pending' });
    createSessionProviderInputConsumerMock.mockReturnValue({
      waitForNextInput: waitForNextInputMock,
      drainPending: drainPendingMock,
      runProviderInputDispatch: vi.fn(async ({ abortSignal, dispatch }) =>
        abortSignal.aborted
          ? { status: 'cancelled' as const }
          : { status: 'dispatched' as const, value: await dispatch() }),
      closeProviderInputAdmissionAndWaitForDispatches: vi.fn(async () => undefined),
    });
  });

  it('suppresses failed-turn raw fallback when the daemon handled a superseded source tuple', async () => {
    vi.stubEnv('HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON', JSON.stringify([{
      kind: 'group',
      serviceId: 'gemini',
      groupId: 'gemini-main',
      activeProfileId: 'leeroy',
      fallbackProfileId: 'backup',
      generation: 2,
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    }]));
    notifyDaemonConnectedServiceRuntimeAuthFailureMock.mockResolvedValue({
      ok: true,
      result: {
        status: 'recovery_superseded',
        reason: 'source_tuple_mismatch',
        serviceId: 'gemini',
        groupId: 'gemini-main',
        profileId: 'leeroy',
      },
    });
    sendGeminiPromptWithRetryMock.mockReset();
    sendGeminiPromptWithRetryMock.mockResolvedValueOnce({
      kind: 'failed',
      error: new Error('RESOURCE_EXHAUSTED: RAW_PROVIDER_ERROR'),
    });
    const session = getFakeSession();
    const { runGemini } = await import('./runGemini');

    await expect(runGemini({ credentials })).resolves.toBeUndefined();

    expect(session.sendSessionEvent).toHaveBeenCalledWith({
      type: 'message',
      message: 'Connected-service account already updated; the old turn was interrupted.',
    });
    expect(surfacePrimarySessionRuntimeIssueMock).not.toHaveBeenCalled();
  });

  it('uses a slower heartbeat cadence while idle and the foreground cadence during an active turn', async () => {
    vi.useFakeTimers();
    const session = createFakeSession();
    setFakeSession(session);

    let releaseIdleWait!: (message: MessageBatch<GeminiMode, string>) => void;
    const idleWait = new Promise<MessageBatch<GeminiMode, string>>((resolve) => {
      releaseIdleWait = resolve;
    });
    const activeMessage: MessageBatch<GeminiMode, string> = {
      message: 'active prompt',
      mode: {
        permissionMode: 'safe-yolo',
        model: 'gemini-2.5-pro',
        originalUserMessage: 'active prompt',
        appendSystemPrompt: null,
        localId: 'local-active-heartbeat',
        replaySeedAllowed: true,
      },
      isolate: false,
      hash: 'mode-hash-active',
    };
    waitForNextInputMock.mockReset();
    waitForNextInputMock
      .mockImplementationOnce(async () => await idleWait)
      .mockResolvedValueOnce(null);

    let finishActiveTurn!: (outcome: AcpTurnOutcome) => void;
    const activeTurn = new Promise<AcpTurnOutcome>((resolve) => {
      finishActiveTurn = resolve;
    });
    sendGeminiPromptWithRetryMock.mockReset();
    sendGeminiPromptWithRetryMock.mockImplementationOnce(async () => await activeTurn);

    const { runGemini } = await import('./runGemini');
    const runPromise = runGemini({ credentials });

    try {
      for (let attempt = 0; attempt < 20 && session.keepAlive.mock.calls.length === 0; attempt += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(session.keepAlive.mock.calls).toEqual([[false, 'remote']]);

      await vi.advanceTimersByTimeAsync(2_000);
      const idleHeartbeatCalls = session.keepAlive.mock.calls.map((call) => [...call]);
      expect(idleHeartbeatCalls).toEqual([[false, 'remote']]);

      await vi.advanceTimersByTimeAsync(7_999);
      expect(session.keepAlive).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(session.keepAlive).toHaveBeenCalledTimes(2);
      expect(session.keepAlive).toHaveBeenLastCalledWith(false, 'remote');

      releaseIdleWait(activeMessage);
      for (
        let attempt = 0;
        attempt < 40 && !session.keepAlive.mock.calls.some(([thinking]) => thinking === true);
        attempt += 1
      ) {
        await vi.advanceTimersByTimeAsync(0);
      }
      const activeStartCallCount = session.keepAlive.mock.calls.length;
      expect(session.keepAlive).toHaveBeenLastCalledWith(true, 'remote');

      await vi.advanceTimersByTimeAsync(1_999);
      expect(session.keepAlive).toHaveBeenCalledTimes(activeStartCallCount);
      await vi.advanceTimersByTimeAsync(1);
      expect(session.keepAlive).toHaveBeenCalledTimes(activeStartCallCount + 1);
      expect(session.keepAlive).toHaveBeenLastCalledWith(true, 'remote');
    } finally {
      releaseIdleWait(activeMessage);
      finishActiveTurn({ kind: 'completed', stopReason: 'end_turn' });
      try {
        await runPromise;
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it('uses the exact materialized Gemini provider email without resolving an ambient default profile', async () => {
    vi.stubEnv('HAPPIER_GEMINI_CONNECTED_SERVICE_PROVIDER_EMAIL', 'selected-account@example.com');
    const { resolveConnectedServiceCredentials } = await import('@/cloud/connectedServices/resolveConnectedServiceCredentials');
    const { runGemini } = await import('./runGemini');

    await expect(runGemini({ credentials })).resolves.toBeUndefined();

    expect(createGeminiBackendInstanceMock).toHaveBeenCalledWith(expect.objectContaining({
      currentUserEmail: 'selected-account@example.com',
    }));
    expect(resolveConnectedServiceCredentials).not.toHaveBeenCalled();
  });

  it('binds the managed Happier session id into the Gemini child environment', async () => {
    const { runGemini } = await import('./runGemini');

    await expect(runGemini({ credentials })).resolves.toBeUndefined();

    expect(createGeminiBackendInstanceMock).toHaveBeenCalledWith(expect.objectContaining({
      processEnv: expect.objectContaining({
        HAPPIER_SESSION_ID: 'session-1',
      }),
    }));
  });

  it('routes Gemini waits and post-turn drains through the session provider input consumer', async () => {
    getFakeSession().getMetadataSnapshot.mockReturnValue({
      path: '/tmp/gemini-test',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          gemini: {
            source: 'connected',
            selection: 'group',
            profileId: 'primary',
            groupId: 'team',
          },
        },
      },
    });
    const { runGemini } = await import('./runGemini');

    await expect(runGemini({ credentials })).resolves.toBeUndefined();

    expect(createSessionProviderInputConsumerMock).toHaveBeenCalledTimes(1);

    const firstConsumerCall = createSessionProviderInputConsumerMock.mock.calls[0];
    if (!firstConsumerCall) {
      throw new Error('Expected Gemini to create a session provider input consumer');
    }
    const [consumerOptions] = firstConsumerCall;
    expect(consumerOptions.onMetadataUpdate).toEqual(expect.any(Function));
    expect(consumerOptions.session.materializeNextPendingMessageSafely).toEqual(expect.any(Function));
    expect(consumerOptions.session.waitForPendingEligibilityUpdate).toEqual(expect.any(Function));
    expect(consumerOptions).not.toHaveProperty('initialProviderInputAdmissions');

    const actualConsumerModule = await vi.importActual<
      typeof import('@/agent/runtime/sessionInput/SessionProviderInputConsumer')
    >('@/agent/runtime/sessionInput/SessionProviderInputConsumer');
    const actualConsumer = actualConsumerModule.createSessionProviderInputConsumer(consumerOptions);
    consumerOptions.messageQueue.push('normally admitted Gemini prompt', {
      permissionMode: 'safe-yolo',
      model: 'gemini-2.5-pro',
      originalUserMessage: 'normally admitted Gemini prompt',
      appendSystemPrompt: null,
      localId: 'local-startup-blocked',
      replaySeedAllowed: true,
    });
    const admissionAbort = new AbortController();
    await expect(actualConsumer.waitForNextInput({ abortSignal: admissionAbort.signal })).resolves.toEqual(expect.objectContaining({
      message: 'normally admitted Gemini prompt',
    }));

    expect(waitForNextInputMock).toHaveBeenCalledTimes(2);
    expect(drainPendingMock).toHaveBeenCalledTimes(1);
    expect(drainPendingMock.mock.calls[0]?.[0]).toMatchObject({
      reason: 'gemini-turn-complete',
      logPrefix: '[Gemini]',
    });
    expect(consumerOptions.session).not.toHaveProperty('popPendingMessage');
    expect(getFakeSession().popPendingMessage).not.toHaveBeenCalled();

    expect(createGeminiBackendInstanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionMode: 'safe-yolo',
        model: 'gemini-2.5-pro',
      }),
    );
    expect(ensureGeminiAcpSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        currentPromptText: 'queued prompt text',
      }),
    );
    expect(resolveGeminiQueuedPromptWithReplaySeedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        localId: 'local-1',
        replaySeedAllowed: false,
      }),
    );
    expect(resolveGeminiSystemPromptTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseOverride: 'custom system addendum',
      }),
    );
    expect(messageBufferRecords).toContainEqual({ message: 'visible user text', type: 'user' });
    expect(sendGeminiPromptWithRetryMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        prompt: expect.stringContaining('queued prompt text'),
      }),
    );
    expect(emitReadyIfIdleMock).toHaveBeenCalledTimes(1);
  });

  it('exposes the current Gemini permission mode to the Happier MCP bridge', async () => {
    const { resolvePermissionModeSeedForAgentStart } = await import('@/settings/permissions/permissionModeSeed');
    vi.mocked(resolvePermissionModeSeedForAgentStart).mockReturnValueOnce({ mode: 'yolo', source: 'explicit' });
    const { runGemini } = await import('./runGemini');

    await expect(runGemini({ credentials, permissionMode: 'yolo' })).resolves.toBeUndefined();

    expect(lastResolveRunnerMcpServersParams?.session?.getPermissionMode?.()).toBe('yolo');
  });

  it('binds Gemini ACP as the exact provider-outcome producer', async () => {
    const session = createFakeSession();
    setFakeSession(session);
    waitForNextInputMock.mockReset();
    waitForNextInputMock.mockResolvedValueOnce(null);

    const { runGemini } = await import('./runGemini');

    await runGemini({ credentials });

    expect(session.bindProviderInputOutcomeProducer).toHaveBeenCalledTimes(1);
    expect(session.bindProviderInputOutcomeProducer).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'gemini',
      mode: 'acp',
      matchesCurrentSession: expect.any(Function),
    }));
  });

  it('confirms consumed pending rows when Gemini reports provider prompt acceptance', async () => {
    const session = createFakeSession();
    setFakeSession(session);
    waitForNextInputMock.mockReset();
    waitForNextInputMock
      .mockResolvedValueOnce({
        message: 'queued prompt text',
        mode: {
          permissionMode: 'safe-yolo',
          model: 'gemini-2.5-pro',
          originalUserMessage: 'visible user text',
          appendSystemPrompt: null,
          localId: 'local-accepted',
          replaySeedAllowed: true,
        },
        isolate: false,
        hash: 'mode-hash-1',
        maxUserMessageSeq: 42,
        userMessageLocalIds: ['local-accepted'],
        providerAcceptancePending: true,
      })
      .mockResolvedValueOnce(null);

    let resolvePrompt!: (outcome: AcpTurnOutcome) => void;
    const promptCompletion = new Promise<AcpTurnOutcome>((resolve) => {
      resolvePrompt = resolve;
    });
    sendGeminiPromptWithRetryMock.mockReset();
    sendGeminiPromptWithRetryMock.mockImplementationOnce(async (params) => {
      params.onProviderPromptAccepted?.();
      return await promptCompletion;
    });

    const { runGemini } = await import('./runGemini');

    const runPromise = runGemini({ credentials });
    try {
      await vi.waitFor(() => {
        expect(providerInputOutcomeObserverMock).toHaveBeenCalledTimes(1);
      });
      expect(session.bindProviderInputOutcomeProducer).toHaveBeenCalledWith(expect.objectContaining({
        providerId: 'gemini',
        mode: 'acp',
        matchesCurrentSession: expect.any(Function),
      }));
      expect(providerInputOutcomeObserverMock).toHaveBeenCalledWith({
        kind: 'accepted',
        localId: 'local-accepted',
        appliedModelId: 'gemini-2.5-pro',
      });
      expect(createStreamedTranscriptWriterMock.mock.results[0]?.value.setCommitProvenance).toHaveBeenCalledWith({
        kind: 'non_dependent',
        source: 'external',
      });
      expect(session.blockPendingMessageDelivery).not.toHaveBeenCalled();
    } finally {
      resolvePrompt({ kind: 'completed', stopReason: 'end_turn' });
      await runPromise;
    }
  });

  it('reports possible provider effect when the Gemini prompt response is lost', async () => {
    const session = createFakeSession();
    setFakeSession(session);
    waitForNextInputMock.mockReset();
    waitForNextInputMock
      .mockResolvedValueOnce({
        message: 'queued prompt text',
        mode: {
          permissionMode: 'safe-yolo',
          model: 'gemini-2.5-pro',
          originalUserMessage: 'visible user text',
          appendSystemPrompt: null,
          localId: 'local-rejected',
          replaySeedAllowed: true,
        },
        isolate: false,
        hash: 'mode-hash-1',
        maxUserMessageSeq: null,
        userMessageLocalIds: ['local-rejected'],
        providerAcceptancePending: true,
      })
      .mockResolvedValueOnce(null);

    sendGeminiPromptWithRetryMock.mockReset();
    sendGeminiPromptWithRetryMock.mockImplementationOnce(async (params) => {
      params.onProviderPromptAttemptStarted?.();
      params.onProviderPromptEffectMayHaveOccurred?.();
      throw new Error('Gemini prompt response was lost');
    });

    const { runGemini } = await import('./runGemini');

    await expect(runGemini({ credentials })).resolves.toBeUndefined();

    expect(providerInputOutcomeObserverMock).toHaveBeenCalledWith({
      kind: 'effect_may_have_occurred',
      localId: 'local-rejected',
    });
    expect(session.blockPendingMessageDelivery).not.toHaveBeenCalled();
  });

  it('reports an exact pre-effect rejection when Gemini fails before invoking session/prompt', async () => {
    const session = createFakeSession();
    setFakeSession(session);
    waitForNextInputMock.mockReset();
    waitForNextInputMock
      .mockResolvedValueOnce({
        message: 'queued prompt text',
        mode: {
          permissionMode: 'safe-yolo',
          model: 'gemini-2.5-pro',
          originalUserMessage: 'visible user text',
          appendSystemPrompt: null,
          localId: 'local-runtime-unavailable',
          replaySeedAllowed: true,
        },
        isolate: false,
        hash: 'mode-hash-1',
        maxUserMessageSeq: 51,
        userMessageLocalIds: ['local-runtime-unavailable'],
        providerAcceptancePending: true,
      })
      .mockResolvedValueOnce(null);
    ensureGeminiAcpSessionMock.mockRejectedValueOnce(new Error('Gemini runtime unavailable'));

    const { runGemini } = await import('./runGemini');

    await expect(runGemini({ credentials })).resolves.toBeUndefined();

    expect(sendGeminiPromptWithRetryMock).not.toHaveBeenCalled();
    expect(providerInputOutcomeObserverMock).toHaveBeenCalledWith({
      kind: 'rejected_before_effect',
      localId: 'local-runtime-unavailable',
      reason: 'runtime_disposed_before_delivery',
    });
  });

  it('ignores stale abort requests after a cancelled Gemini turn so later pending input can run', async () => {
    const firstMode: GeminiMode = {
      permissionMode: 'safe-yolo',
      model: 'gemini-2.5-pro',
      originalUserMessage: 'cancelled visible text',
      appendSystemPrompt: null,
      localId: 'local-cancelled',
      replaySeedAllowed: true,
    };
    const secondMode: GeminiMode = {
      ...firstMode,
      originalUserMessage: 'follow-up visible text',
      localId: 'local-follow-up',
    };

    waitForNextInputMock.mockReset();
    waitForNextInputMock
      .mockResolvedValueOnce({
        message: 'cancelled prompt text',
        mode: firstMode,
        isolate: false,
        hash: 'mode-hash-1',
      })
      .mockImplementationOnce(async () => {
        const abortHandler = getFakeSession().rpcHandlerManager.registerHandler.mock.calls.find(
          ([name]) => name === 'abort',
        )?.[1] as (() => Promise<void>) | undefined;
        if (!abortHandler) {
          throw new Error('Expected Gemini abort handler to be registered');
        }
        await abortHandler();
        return {
          message: 'follow-up prompt text',
          mode: secondMode,
          isolate: false,
          hash: 'mode-hash-1',
        };
      })
      .mockResolvedValueOnce(null);

    sendGeminiPromptWithRetryMock.mockReset();
    sendGeminiPromptWithRetryMock
      .mockResolvedValueOnce({ kind: 'aborted', stopReason: 'cancelled' })
      .mockResolvedValueOnce({ kind: 'completed', stopReason: 'end_turn' });

    const { runGemini } = await import('./runGemini');

    await expect(runGemini({ credentials })).resolves.toBeUndefined();

    expect(sendGeminiPromptWithRetryMock).toHaveBeenCalledTimes(2);
    expect(sendGeminiPromptWithRetryMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ prompt: expect.stringContaining('cancelled prompt text') }),
    );
    expect(sendGeminiPromptWithRetryMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ prompt: expect.stringContaining('follow-up prompt text') }),
    );
    expect(surfacePrimarySessionRuntimeIssueMock).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'cancelled', provider: 'gemini' }),
    );
    expect(fakeBackend.cancel).not.toHaveBeenCalled();
  });

  it('reports an unsupported active steer as rejected before provider effect', async () => {
    const session = createFakeSession();
    setFakeSession(session);
    waitForNextInputMock.mockReset();
    waitForNextInputMock
      .mockResolvedValueOnce({
        message: 'initial active prompt',
        mode: {
          permissionMode: 'safe-yolo',
          model: 'gemini-2.5-pro',
          originalUserMessage: 'initial active prompt',
          appendSystemPrompt: null,
          localId: 'local-initial-active',
          replaySeedAllowed: true,
        },
        isolate: false,
        hash: 'mode-hash-1',
      })
      .mockResolvedValueOnce(null);

    sendGeminiPromptWithRetryMock.mockReset();
    sendGeminiPromptWithRetryMock.mockImplementationOnce(async () => {
      const onUserMessage = session.onUserMessage.mock.calls[0]?.[0] as
        | ((message: unknown, info: unknown) => void)
        | undefined;
      if (!onUserMessage) {
        throw new Error('Expected Gemini onUserMessage handler to be registered');
      }
      onUserMessage({
        content: { text: 'exact active steer' },
        meta: {},
        localId: 'local-gemini-steer',
      }, {
        seq: 52,
        pendingProviderAction: 'steer',
        providerAcceptancePending: true,
      });
      return { kind: 'completed', stopReason: 'end_turn' };
    });

    const { runGemini } = await import('./runGemini');
    await expect(runGemini({ credentials })).resolves.toBeUndefined();

    expect(providerInputOutcomeObserverMock).toHaveBeenCalledWith({
      kind: 'rejected_before_effect',
      localId: 'local-gemini-steer',
      reason: 'steering_unavailable',
    });
    expect(session.blockPendingMessageDelivery).not.toHaveBeenCalled();
  });

  it('reports an exact interrupt-and-send input as rejected when cancellation fails before enqueue', async () => {
    const session = createFakeSession();
    setFakeSession(session);
    waitForNextInputMock.mockReset();
    waitForNextInputMock
      .mockResolvedValueOnce({
        message: 'initial active prompt',
        mode: {
          permissionMode: 'safe-yolo',
          model: 'gemini-2.5-pro',
          originalUserMessage: 'initial active prompt',
          appendSystemPrompt: null,
          localId: 'local-initial-active',
          replaySeedAllowed: true,
        },
        isolate: false,
        hash: 'mode-hash-1',
      })
      .mockResolvedValueOnce(null);
    fakeBackend.cancel.mockRejectedValueOnce(new Error('cancel failed'));

    sendGeminiPromptWithRetryMock.mockReset();
    sendGeminiPromptWithRetryMock.mockImplementationOnce(async () => {
      const onUserMessage = session.onUserMessage.mock.calls[0]?.[0] as
        | ((message: unknown, info: unknown) => void)
        | undefined;
      if (!onUserMessage) {
        throw new Error('Expected Gemini onUserMessage handler to be registered');
      }
      onUserMessage({
        content: { text: 'exact failed interrupt message' },
        meta: {},
        localId: 'local-gemini-failed-interrupt',
      }, {
        seq: 54,
        pendingProviderAction: 'interrupt_and_send',
        providerAcceptancePending: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { kind: 'aborted', stopReason: 'cancelled' };
    });

    const { runGemini } = await import('./runGemini');
    await expect(runGemini({ credentials })).resolves.toBeUndefined();

    expect(providerInputOutcomeObserverMock).toHaveBeenCalledWith({
      kind: 'rejected_before_effect',
      localId: 'local-gemini-failed-interrupt',
      reason: 'provider_rejected_before_acceptance',
    });
    expect(session.blockPendingMessageDelivery).not.toHaveBeenCalled();
  });

  it('cancels the active Gemini turn before admitting an exact interrupt-and-send message', async () => {
    const session = createFakeSession();
    setFakeSession(session);
    waitForNextInputMock.mockReset();
    waitForNextInputMock
      .mockResolvedValueOnce({
        message: 'initial active prompt',
        mode: {
          permissionMode: 'safe-yolo',
          model: 'gemini-2.5-pro',
          originalUserMessage: 'initial active prompt',
          appendSystemPrompt: null,
          localId: 'local-initial-active',
          replaySeedAllowed: true,
        },
        isolate: false,
        hash: 'mode-hash-1',
      })
      .mockImplementationOnce(async () => {
        const consumerOptions = createSessionProviderInputConsumerMock.mock.calls[0]?.[0];
        const batch = await consumerOptions?.messageQueue.waitForMessagesAndGetAsString();
        return batch ?? null;
      })
      .mockResolvedValueOnce(null);

    let releaseCancel!: () => void;
    const cancelSettled = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    fakeBackend.cancel.mockImplementationOnce(async () => {
      await cancelSettled;
    });

    let queuedBeforeCancelSettled = false;
    let handoffSettledBeforeCancel = false;
    sendGeminiPromptWithRetryMock.mockReset();
    sendGeminiPromptWithRetryMock
      .mockImplementationOnce(async () => {
        const onUserMessage = session.onUserMessage.mock.calls[0]?.[0] as
          | ((message: unknown, info: unknown) => void)
          | undefined;
        if (!onUserMessage) {
          throw new Error('Expected Gemini onUserMessage handler to be registered');
        }
        const handoff = onUserMessage({
          content: { text: 'exact Gemini interrupt message' },
          meta: {},
          localId: 'local-gemini-exact-interrupt',
        }, {
          seq: 51,
          pendingProviderAction: 'interrupt_and_send',
          providerAcceptancePending: true,
        });
        let handoffSettled = false;
        const observedHandoff = Promise.resolve(handoff).then(() => {
          handoffSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const consumerOptions = createSessionProviderInputConsumerMock.mock.calls[0]?.[0];
        queuedBeforeCancelSettled = (consumerOptions?.messageQueue.size() ?? 0) > 0;
        handoffSettledBeforeCancel = handoffSettled;
        releaseCancel();
        await observedHandoff;
        return { kind: 'aborted', stopReason: 'cancelled' };
      })
      .mockResolvedValueOnce({ kind: 'completed', stopReason: 'end_turn' });

    const { runGemini } = await import('./runGemini');
    await expect(runGemini({ credentials })).resolves.toBeUndefined();

    expect(fakeBackend.cancel).toHaveBeenCalledTimes(1);
    expect(queuedBeforeCancelSettled).toBe(false);
    expect(handoffSettledBeforeCancel).toBe(false);
    expect(sendGeminiPromptWithRetryMock).toHaveBeenCalledTimes(2);
    expect(sendGeminiPromptWithRetryMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ prompt: expect.stringContaining('exact Gemini interrupt message') }),
    );
    expect(session.blockPendingMessageDelivery).not.toHaveBeenCalled();
  });
  it('retires the replay seed once Gemini accepted the prompt even when that turn then aborts', async () => {
    setFakeSession(createFakeSession());

    const seedPrefix = '<<replay-seed-carry-over>>\n';
    const settlements: Array<ReturnType<typeof vi.fn>> = [];
    let seedLive = true;
    // Mirrors the real owner: a live seed is prefixed onto the prompt and retires only when
    // its own settlement runs, so a re-prefixed follow-up is the observable double-delivery.
    const resolveWithLiveSeed = async (opts: { text: string; didBootstrap: boolean }) => {
      if (!seedLive) return { text: opts.text, didBootstrap: true, seedApplied: false };
      const settle = vi.fn(async () => {
        seedLive = false;
      });
      settlements.push(settle);
      return {
        text: `${seedPrefix}${opts.text}`,
        didBootstrap: true,
        seedApplied: true,
        settleReplaySeedOnProviderAcceptance: settle,
      };
    };
    resolveGeminiQueuedPromptWithReplaySeedMock
      .mockImplementationOnce(resolveWithLiveSeed)
      .mockImplementationOnce(resolveWithLiveSeed);

    const mode: GeminiMode = {
      permissionMode: 'safe-yolo',
      model: 'gemini-2.5-pro',
      originalUserMessage: 'seeded visible text',
      appendSystemPrompt: null,
      localId: 'local-seeded',
      replaySeedAllowed: true,
    };
    waitForNextInputMock.mockReset();
    waitForNextInputMock
      .mockResolvedValueOnce({
        message: 'seeded prompt text',
        mode,
        isolate: false,
        hash: 'mode-hash-1',
        userMessageLocalIds: ['local-seeded'],
        providerAcceptancePending: true,
      })
      .mockResolvedValueOnce({
        message: 'follow-up prompt text',
        mode: { ...mode, localId: 'local-follow-up' },
        isolate: false,
        hash: 'mode-hash-1',
        userMessageLocalIds: ['local-follow-up'],
        providerAcceptancePending: true,
      })
      .mockResolvedValueOnce(null);

    sendGeminiPromptWithRetryMock.mockReset();
    sendGeminiPromptWithRetryMock
      .mockImplementationOnce(async (params) => {
        params.onProviderPromptAttemptStarted?.();
        // Gemini accepted the seeded prompt; the turn is aborted only afterwards.
        params.onProviderPromptAccepted?.();
        const abortError = new Error('Aborted by user');
        abortError.name = 'AbortError';
        throw abortError;
      })
      .mockImplementationOnce(async (params) => {
        params.onProviderPromptAccepted?.();
        return { kind: 'completed', stopReason: 'end_turn' };
      });

    const { runGemini } = await import('./runGemini');
    await expect(runGemini({ credentials })).resolves.toBeUndefined();

    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toHaveBeenCalledTimes(1);
    expect(sendGeminiPromptWithRetryMock).toHaveBeenCalledTimes(2);
    expect(sendGeminiPromptWithRetryMock.mock.calls[0]?.[0]?.prompt).toContain(seedPrefix);
    expect(sendGeminiPromptWithRetryMock.mock.calls[1]?.[0]?.prompt).not.toContain(seedPrefix);
  });

  it('keeps the replay seed live when the Gemini send fails before confirming delivery', async () => {
    setFakeSession(createFakeSession());

    const seedPrefix = '<<replay-seed-carry-over>>\n';
    const settlements: Array<ReturnType<typeof vi.fn>> = [];
    let seedLive = true;
    // Mirrors the real owner: a live seed is prefixed onto the prompt and retires only when
    // its own settlement runs, so a re-prefixed follow-up is the observable double-delivery.
    const resolveWithLiveSeed = async (opts: { text: string; didBootstrap: boolean }) => {
      if (!seedLive) return { text: opts.text, didBootstrap: true, seedApplied: false };
      const settle = vi.fn(async () => {
        seedLive = false;
      });
      settlements.push(settle);
      return {
        text: `${seedPrefix}${opts.text}`,
        didBootstrap: true,
        seedApplied: true,
        settleReplaySeedOnProviderAcceptance: settle,
      };
    };
    resolveGeminiQueuedPromptWithReplaySeedMock
      .mockImplementationOnce(resolveWithLiveSeed)
      .mockImplementationOnce(resolveWithLiveSeed);

    const mode: GeminiMode = {
      permissionMode: 'safe-yolo',
      model: 'gemini-2.5-pro',
      originalUserMessage: 'seeded visible text',
      appendSystemPrompt: null,
      localId: 'local-undelivered',
      replaySeedAllowed: true,
    };
    waitForNextInputMock.mockReset();
    waitForNextInputMock
      .mockResolvedValueOnce({
        message: 'seeded prompt text',
        mode,
        isolate: false,
        hash: 'mode-hash-1',
        userMessageLocalIds: ['local-undelivered'],
        providerAcceptancePending: true,
      })
      .mockResolvedValueOnce({
        message: 'retry prompt text',
        mode: { ...mode, localId: 'local-retry' },
        isolate: false,
        hash: 'mode-hash-1',
        userMessageLocalIds: ['local-retry'],
        providerAcceptancePending: true,
      })
      .mockResolvedValueOnce(null);

    sendGeminiPromptWithRetryMock.mockReset();
    sendGeminiPromptWithRetryMock
      .mockImplementationOnce(async () => {
        // No acceptance signal: delivery is unproven, so the seed must survive.
        throw new Error('gemini session/prompt failed');
      })
      .mockImplementationOnce(async (params) => {
        params.onProviderPromptAccepted?.();
        return { kind: 'completed', stopReason: 'end_turn' };
      });

    const { runGemini } = await import('./runGemini');
    await expect(runGemini({ credentials })).resolves.toBeUndefined();

    expect(settlements).toHaveLength(2);
    expect(settlements[0]).not.toHaveBeenCalled();
    expect(settlements[1]).toHaveBeenCalledTimes(1);
    expect(sendGeminiPromptWithRetryMock).toHaveBeenCalledTimes(2);
    expect(sendGeminiPromptWithRetryMock.mock.calls[1]?.[0]?.prompt).toContain(seedPrefix);
  });
});
