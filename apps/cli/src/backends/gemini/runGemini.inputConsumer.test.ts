import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcpTurnOutcome } from '@/agent/acp/backend/turn/_types';
import type {
  DrainPendingOptions,
  DrainPendingResult,
  MessageBatch,
} from '@/agent/runtime/sessionInput/types';
import type { SessionProviderInputConsumerOptions } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';
import type { Credentials } from '@/persistence';

import type { GeminiMode } from './types';

type GeminiInputConsumer = {
  waitForNextInput: (opts: { abortSignal: AbortSignal }) => Promise<MessageBatch<GeminiMode, string> | null>;
  drainPending: (opts?: DrainPendingOptions) => Promise<DrainPendingResult>;
};

type FakeSession = {
  sessionId: string;
  rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> };
  onUserMessage: ReturnType<typeof vi.fn>;
  getMetadataSnapshot: ReturnType<typeof vi.fn>;
  fetchLatestUserPermissionIntentFromTranscript: ReturnType<typeof vi.fn>;
  keepAlive: ReturnType<typeof vi.fn>;
  waitForMetadataUpdate: ReturnType<typeof vi.fn>;
  materializeNextPendingMessageSafely: ReturnType<typeof vi.fn>;
  popPendingMessage: ReturnType<typeof vi.fn>;
  shouldAttemptPendingMaterialization: ReturnType<typeof vi.fn>;
  reconcilePendingQueueState: ReturnType<typeof vi.fn>;
  getLastObservedMessageSeq: ReturnType<typeof vi.fn>;
  beginTurnAssistantTextSnapshot: ReturnType<typeof vi.fn>;
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
    recordSessionTurnCompletedMock: vi.fn(async () => undefined),
    resolveGeminiQueuedPromptWithReplaySeedMock: vi.fn(
      async (opts: { text: string; didBootstrap: boolean }) => ({
        text: opts.text,
        didBootstrap: opts.didBootstrap || true,
      }),
    ),
    resolveGeminiSystemPromptTextMock: vi.fn(async () => 'fresh system prompt'),
    sendGeminiPromptWithRetryMock: vi.fn<(opts: { prompt: string }) => Promise<AcpTurnOutcome>>(async () => ({
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
    pendingQueueIdleWakePollIntervalMs: 10,
    startupPermissionSeedTranscriptTake: 5,
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

vi.mock('@/mcp/runtime/resolveRunnerMcpServers', () => ({
  resolveRunnerMcpServers: vi.fn(async () => ({
    happierMcpServer: { stop: vi.fn() },
    mcpServers: [],
  })),
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

vi.mock('@/session/services/archiveAndCloseRuntimeSession', () => ({
  archiveAndCloseRuntimeSession: vi.fn(async () => undefined),
}));

vi.mock('@/agent/runtime/terminationArchivePolicy', () => ({
  resolveTerminationArchiveDecision: vi.fn(() => ({ archive: false })),
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
    vi.clearAllMocks();
    messageBufferRecords.length = 0;

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
    });
  });

  it('routes Gemini waits and post-turn drains through the session provider input consumer', async () => {
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
    expect(consumerOptions.session.waitForMetadataUpdate).toEqual(expect.any(Function));

    expect(waitForNextInputMock).toHaveBeenCalledTimes(2);
    expect(drainPendingMock).toHaveBeenCalledTimes(1);
    expect(drainPendingMock.mock.calls[0]?.[0]).toMatchObject({
      reason: 'gemini-turn-complete',
      logPrefix: '[Gemini]',
    });
    await expect(consumerOptions.session.popPendingMessage()).resolves.toBe(false);
    expect(getFakeSession().materializeNextPendingMessageSafely).toHaveBeenCalledWith({ reconcileWhenEmpty: 'force' });
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
});
