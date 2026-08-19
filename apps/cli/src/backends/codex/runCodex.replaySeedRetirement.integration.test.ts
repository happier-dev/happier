import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_CONFIG_OPTIONS_STATE_KEY,
  SESSION_MODELS_STATE_KEY,
  SESSION_MODES_STATE_KEY,
} from '@happier-dev/agents';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';

import type { Credentials } from '@/persistence';
import {
  HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY,
  serializeDaemonInitialGoalForEnv,
} from '@/agent/runtime/sessionInitialGoal';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { createCodexPermissionHandler } from './utils/createCodexPermissionHandler';
import { applyPermissionModeToCodexPermissionHandler } from './utils/applyPermissionModeToHandler';

const modelSyncFlushPendingAfterStartSpy = vi.fn(async () => {});
const sessionModeSyncFlushPendingAfterStartSpy = vi.fn(async () => {});
const configOptionSyncFlushPendingAfterStartSpy = vi.fn(async () => {});
let remoteModePublishGate: Promise<void> | null = null;
const remoteModePublishGateResolver: { current: (() => void) | null } = { current: null };
const registerRemoteSwitchHandlerSpy = vi.fn();
const refreshDaemonOpenAiCodexChatGptAuthTokensForBridgeSpy = vi.fn<(...args: any[]) => Promise<any>>(async () => ({
  accessToken: 'fresh-access',
  chatgptAccountId: 'acct_123',
  chatgptPlanType: 'plus',
}));
const notifyDaemonConnectedServiceRuntimeAuthFailureSpy = vi.fn<(...args: any[]) => Promise<any>>(async () => ({}));
const notifyDaemonConnectedServiceQuotaSnapshotSpy = vi.fn<(...args: any[]) => Promise<any>>(async () => ({ ok: true }));

vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonConnectedServiceRuntimeAuthFailure: (...args: any[]) => notifyDaemonConnectedServiceRuntimeAuthFailureSpy(...args),
  notifyDaemonConnectedServiceQuotaSnapshot: (...args: any[]) => notifyDaemonConnectedServiceQuotaSnapshotSpy(...args),
  refreshDaemonOpenAiCodexChatGptAuthTokensForBridge: (...args: any[]) => refreshDaemonOpenAiCodexChatGptAuthTokensForBridgeSpy(...args),
}));

const probeCodexAcpLoadSessionSupportSpy = vi.fn<(...args: any[]) => Promise<any>>(async (..._args) => {
  throw new Error('probe-called');
});
vi.mock('@/backends/codex/acp/probeLoadSessionSupport', () => ({
  probeCodexAcpLoadSessionSupport: (...args: any[]) => probeCodexAcpLoadSessionSupportSpy(...args),
}));

const resolveRunnerMcpServersSpy = vi.fn<(...args: any[]) => Promise<any>>(async (..._args) => {
  throw new Error('bridge-called');
});
vi.mock('@/mcp/runtime/resolveRunnerMcpServers', () => ({
  resolveRunnerMcpServers: (...args: any[]) => resolveRunnerMcpServersSpy(...args),
}));

const createCodexAcpRuntimeSpy = vi.fn<(...args: any[]) => any>((..._args) => ({
  getSessionId: () => null,
  supportsInFlightSteer: () => false,
  isTurnInFlight: () => false,
  beginTurn: vi.fn(),
  cancel: vi.fn(async () => {}),
  reset: vi.fn(async () => {}),
  startOrLoad: vi.fn(() => Promise.reject(new Error('startOrLoad-called'))),
  setSessionMode: vi.fn(async () => {}),
  setSessionModel: vi.fn(async () => {}),
  setSessionConfigOption: vi.fn(async () => {}),
  steerPrompt: vi.fn(async () => {}),
  sendPrompt: vi.fn(async () => {}),
  sendPromptWithMeta: vi.fn(async () => {}),
  compactContext: vi.fn(async () => {}),
  flushTurn: vi.fn(),
  rollbackConversation: vi.fn(async () => ({ ok: false, errorCode: 'unsupported_action', errorMessage: 'unsupported' })),
}));
vi.mock('./acp/runtime', () => ({
  createCodexAcpRuntime: (...args: any[]) => createCodexAcpRuntimeSpy(...args),
}));

function createDefaultCodexAppServerRuntimeMock(): any {
  return {
    getSessionId: () => null,
    supportsInFlightSteer: () => false,
    isTurnInFlight: () => false,
    beginTurn: vi.fn(),
    cancel: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    startOrLoad: vi.fn(() => Promise.reject(new Error('appServer-startOrLoad-called'))),
    setSessionMode: vi.fn(async () => {}),
    setSessionModel: vi.fn(async () => {}),
    setSessionConfigOption: vi.fn(async () => {}),
    steerPrompt: vi.fn(async () => {}),
    sendPrompt: vi.fn(async () => {}),
    setOnPromptAcceptedByProvider: vi.fn(),
    setOnUndeliverablePrompts: vi.fn(),
    compactContext: vi.fn(async () => {}),
    flushTurn: vi.fn(),
    rollbackConversation: vi.fn(async () => ({ ok: true, target: { type: 'latest_turn' }, threadId: 'thread_1' })),
  };
}

const createCodexAppServerRuntimeSpy = vi.fn<(...args: any[]) => any>((..._args) => createDefaultCodexAppServerRuntimeMock());
vi.mock('./appServer/runtime', () => ({
  createCodexAppServerRuntime: (...args: any[]) => createCodexAppServerRuntimeSpy(...args),
}));

const resolveCodexAcpSpawnSpy = vi.fn<(...args: any[]) => any>(() => ({
  command: '/tmp/codex-acp',
  args: [],
  availability: { ok: true as const, kind: 'binary', resolvedPath: '/tmp/codex-acp' },
}));
vi.mock('./acp/resolveCommand', () => ({
  resolveCodexAcpSpawn: (...args: any[]) => resolveCodexAcpSpawnSpy(...args),
}));

const validateCodexAcpSpawnAvailabilitySpy = vi.fn<(...args: any[]) => any>(() => ({ ok: true as const }));
vi.mock('./acp/spawnAvailability', () => ({
  validateCodexAcpSpawnAvailability: (...args: any[]) => validateCodexAcpSpawnAvailabilitySpy(...args),
}));

const ensureRuntimeInstallablesForLaunchSpy = vi.fn<(...args: any[]) => Promise<any>>(async () => ({
  ok: true as const,
  installedKeys: [],
}));
vi.mock('@/installables/runtime/ensureRuntimeInstallablesForLaunch', () => ({
  ensureRuntimeInstallablesForLaunch: (...args: any[]) => ensureRuntimeInstallablesForLaunchSpy(...args),
}));

let sessionInputConsumerWaitForNextInputImpl: ((opts: any) => Promise<any>) | null = null;
const inputConsumerDrainPendingSpy = vi.fn<(...args: any[]) => Promise<any>>(
  async () => ({ materialized: 0, stoppedReason: 'no_pending' }),
);
const createSessionProviderInputConsumerSpy = vi.fn((opts: any) => {
  return {
    waitForNextInput: async (waitOpts: any) => {
      if (!sessionInputConsumerWaitForNextInputImpl) return null;
      return await sessionInputConsumerWaitForNextInputImpl({
        ...opts,
        ...waitOpts,
        popPendingMessage: opts.session?.popPendingMessage,
        materializeNextPendingMessageSafely: opts.session?.materializeNextPendingMessageSafely,
        shouldAttemptPendingMaterialization: opts.session?.shouldAttemptPendingMaterialization,
        reconcilePendingQueueState: opts.session?.reconcilePendingQueueState,
        waitForMetadataUpdate: opts.session?.waitForMetadataUpdate,
      });
    },
    setPendingMaterializationRetryEpisodeExhaustedHandler: vi.fn(),
    runProviderInputDispatch: async ({ dispatch }: any) => ({ status: 'dispatched', value: await dispatch() }),
    closeProviderInputAdmissionAndWaitForDispatches: vi.fn(async () => undefined),
    drainPending: (...args: any[]) => inputConsumerDrainPendingSpy(...args),
  };
});
vi.mock('@/agent/runtime/sessionInput/SessionProviderInputConsumer', () => ({
  createSessionProviderInputConsumer: (opts: any) => createSessionProviderInputConsumerSpy(opts),
}));

vi.mock('@/agent/runtime/runtimeOverridesSynchronizer', () => ({
  initializeRuntimeOverridesSynchronizer: vi.fn(async () => ({
    syncFromMetadata: vi.fn(),
    seedFromSession: vi.fn(async () => {}),
  })),
}));

vi.mock('@/agent/localControl/createLocalRemoteModeController', () => ({
  createLocalRemoteModeController: vi.fn((params: any) => ({
    publishModeState: async (nextMode: 'local' | 'remote') => {
      params.session.sendSessionEvent({ type: 'switch', mode: nextMode });
      params.session.updateAgentState((currentState: any) => ({
        ...currentState,
        controlledByUser: nextMode === 'local',
      }));
      params.session.keepAlive(params.getThinking(), nextMode);
      if (nextMode === 'remote') {
        params.setRemoteUiAllowsSwitchToLocal((await params.resolveLocalSwitchAvailability()).ok);
        params.mountRemoteUi();
        await remoteModePublishGate;
      } else {
        params.setRemoteUiAllowsSwitchToLocal(false);
        await params.unmountRemoteUi();
      }
    },
    registerRemoteSwitchHandler: () => {
      registerRemoteSwitchHandlerSpy();
      params.session.rpcHandlerManager.registerHandler('switch', async (requestParams: unknown) => {
        const to = typeof requestParams === 'object' && requestParams !== null
          ? (requestParams as { to?: unknown }).to
          : undefined;
        if (to === 'remote') return true;
        return await params.requestSwitchToLocalIfSupported();
      });
    },
  })),
}));

vi.mock('@/agent/runtime/modelOverrideSync', () => ({
  createModelOverrideSynchronizer: vi.fn(() => ({
    syncFromMetadata: vi.fn(),
    flushPendingAfterStart: modelSyncFlushPendingAfterStartSpy,
  })),
}));

vi.mock('@/agent/runtime/sessionModeOverrideSync', () => ({
  createSessionModeOverrideSynchronizer: vi.fn(() => ({
    syncFromMetadata: vi.fn(),
    flushPendingAfterStart: sessionModeSyncFlushPendingAfterStartSpy,
  })),
}));

vi.mock('@/agent/runtime/sessionConfigOptionOverrideSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/runtime/sessionConfigOptionOverrideSync')>();
  return {
    ...actual,
    createSessionConfigOptionOverrideSynchronizer: vi.fn(() => ({
      syncFromMetadata: vi.fn(),
      flushPendingAfterStart: configOptionSyncFlushPendingAfterStartSpy,
    })),
    createAcpConfigOptionOverrideSynchronizer: vi.fn(() => ({
      syncFromMetadata: vi.fn(),
      flushPendingAfterStart: configOptionSyncFlushPendingAfterStartSpy,
    })),
  };
});

vi.mock('@/backends/codex/utils/metadataOverridesWatcher', () => ({
  runMetadataOverridesWatcherLoop: vi.fn(),
}));

vi.mock('@/agent/runtime/startup/startupOverridesCache', () => ({
  readStartupOverridesCacheForBackend: vi.fn(() => null),
  writeStartupOverridesCacheForBackend: vi.fn(() => {}),
}));

vi.mock('@/agent/prompting/coding/resolveEffectiveCodingPrompt', () => ({
  resolveEffectiveCodingPromptText: vi.fn(async () => null),
}));

vi.mock('@/features/featureDecisionService', () => ({
  resolveCliFeatureDecision: vi.fn(() => ({ state: 'disabled' })),
}));

let lastOnSwitchToLocal: (() => Promise<void>) | null = null;

vi.mock('./runtime/createCodexRemoteTerminalUi', () => ({
  createCodexRemoteTerminalUi: vi.fn((opts: any) => {
    lastOnSwitchToLocal = typeof opts?.onSwitchToLocal === 'function' ? opts.onSwitchToLocal : null;
    return {
      mount: vi.fn(),
      unmount: vi.fn(async () => {}),
      setAllowSwitchToLocal: vi.fn(),
    };
  }),
}));

vi.mock('@/ui/tty/resolveHasTTY', () => ({
  resolveHasTTY: vi.fn(() => false),
}));

vi.mock('@/backends/codex/experiments', () => ({
  isExperimentalCodexAcpEnabled: vi.fn(() => true),
}));

vi.mock('./utils/resolveCodexStartingMode', () => ({
  resolveCodexStartingMode: vi.fn(() => 'remote'),
}));

vi.mock('./mcp/resolveCodexMcpServerSpawn', () => ({
  resolveCodexMcpServerSpawn: vi.fn(async () => ({
    mode: 'stdio',
    command: '/tmp/codex-mcp',
  })),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    infoDeveloper: vi.fn(),
    warn: vi.fn(),
    getLogPath: vi.fn(() => '/tmp/happier.log'),
    logFilePath: '/tmp/happier.log',
  },
}));

vi.mock('@/daemon/startDaemon', () => ({
  initialMachineMetadata: {},
}));

vi.mock('@/ui/doctor', () => ({
  getEnvironmentInfo: vi.fn(() => ({})),
}));

vi.mock('@/api/offline/serverConnectionErrors', () => ({
  connectionState: { setBackend: vi.fn(), notifyOffline: vi.fn() },
}));

vi.mock('@/integrations/caffeinate', () => ({
  stopCaffeinate: vi.fn(),
}));

vi.mock('@/rpc/handlers/killSession', () => ({
  registerKillSessionHandler: vi.fn(),
}));

vi.mock('./utils/createCodexPermissionHandler', () => ({
  createCodexPermissionHandler: vi.fn(() => ({
    abortPendingRequestsAndFlush: vi.fn(async () => {}),
    reset: vi.fn(),
    updateSession: vi.fn(),
    handleToolCall: vi.fn(async () => ({ decision: 'approved' })),
  })),
}));

vi.mock('./utils/applyPermissionModeToHandler', () => ({
  applyPermissionModeToCodexPermissionHandler: vi.fn(),
}));

vi.mock('./utils/diffProcessor', () => ({
  DiffProcessor: vi.fn(() => ({
    reset: vi.fn(),
    flushTurn: vi.fn(),
  })),
}));

vi.mock('./localControl/createLocalControlSupportResolver', () => ({
  createCodexLocalControlSupportResolver: vi.fn(() => async () => ({ ok: false as const, reason: 'test' })),
}));

let codexLocalLauncherImpl: ((opts: any) => Promise<any>) | null = null;
const codexLocalLauncherSpy = vi.fn<(...args: any[]) => Promise<any>>(async (opts: any) => {
  if (codexLocalLauncherImpl) return await codexLocalLauncherImpl(opts);
  throw new Error('codexLocalLauncher-called');
});
const registerSessionRpcHandlerMock = vi.fn();
/**
 * The replay seed lives in session metadata and retirement is a metadata write, so this
 * harness needs a metadata store that actually mutates — a frozen snapshot mock cannot tell
 * a retired seed from a live one.
 */
const sessionMetadataStore: { current: Record<string, any> } = { current: {} };
let lastSessionClient: Record<string, any> | null = null;
const providerInputOutcomeObserverMock = vi.fn();
let lastOnUserMessageHandler: ((message: any, info?: {
  seq: number | null;
  pendingProviderAction?: 'send' | 'steer' | 'interrupt_and_send';
  providerAcceptancePending?: boolean;
}) => void | Promise<void>) | null = null;
vi.mock('./codexLocalLauncher', () => ({
  codexLocalLauncher: (opts: any) => codexLocalLauncherSpy(opts),
}));

vi.mock('@/agent/runtime/initializeBackendApiContext', () => ({
  initializeBackendApiContext: vi.fn(async () => ({
    api: {
      getOrCreateSession: vi.fn(async () => ({ id: 'sess_1', metadataVersion: 1 })),
      sessionSyncClient: vi.fn(() => ({
        sessionId: 'sess_1',
        rpcHandlerManager: { registerHandler: registerSessionRpcHandlerMock, invokeLocal: vi.fn() },
        ensureMetadataSnapshot: vi.fn(async () => ({})),
        getMetadataSnapshot: vi.fn(() => ({
          connectedServiceMaterializationIdentityV1: {
            v: 1,
            id: 'csm_codex_integration',
            createdAtMs: 1,
          },
        })),
        onUserMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        updateMetadata: vi.fn(),
        updateAgentState: vi.fn(async () => {}),
        keepAlive: vi.fn(),
        sendAgentMessageCommitted: vi.fn(async () => {}),
        sendAgentMessageEphemeral: vi.fn(),
        getLastObservedMessageSeq: vi.fn(() => 0),
        bindProviderInputOutcomeProducer: vi.fn(() => providerInputOutcomeObserverMock),
        blockPendingMessageDelivery: vi.fn(async () => false),
        beginTurnAssistantTextSnapshot: vi.fn(() => ({ id: 'turn-token' })),
        materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' })),
        readRuntimeActivitySnapshotTail: vi.fn(() => ({
          sequence: 4,
          custody: null,
          settlement: {
            identity: {
              mutationKey: 'activity-idle-3',
              admissionOrder: 3,
            },
            desiredValue: { state: 'idle', activeCount: 0 },
            result: 'unchanged',
            committedProjection: {
              state: 'idle',
              activeCount: 0,
              observedAt: 100,
              revision: 41,
            },
            committedRevision: 41,
          },
        })),
        waitForRuntimeActivitySnapshotTailChange: vi.fn(async () => false),
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        listPendingMessageQueueV2LocalIds: vi.fn(async () => []),
        discardPendingMessageQueueV2All: vi.fn(async () => {}),
        peekPendingMessageQueueV2Count: vi.fn(async () => 0),
        discardCommittedMessageLocalIds: vi.fn(async () => {}),
        popPendingMessage: vi.fn(async () => false),
        reconcilePendingQueueState: vi.fn(async () => false),
        waitForMetadataUpdate: vi.fn(async () => false),
      })),
      push: vi.fn(() => ({ sendToAllDevices: vi.fn() })),
    },
    machineId: 'machine_1',
  })),
}));

async function initializeDefaultBackendRunSession(opts: any): Promise<any> {
  const session = opts.api.sessionSyncClient({ id: 'sess_1', metadataVersion: 1 });
  lastSessionClient = session as Record<string, any>;
  lastOnUserMessageHandler = null;
  session.onUserMessage = vi.fn((handler: (message: any, info?: { seq: number | null }) => void) => {
    lastOnUserMessageHandler = handler;
  });
  // Ensure optional methods exist for codepaths that may call them during startup.
  Object.assign(session, {
    fetchLatestUserPermissionIntentFromTranscript: vi.fn(async () => null),
    getLastObservedMessageSeq: vi.fn(() => 0),
    bindProviderInputOutcomeProducer: vi.fn(() => providerInputOutcomeObserverMock),
    blockPendingMessageDelivery: vi.fn(async () => false),
    beginTurnAssistantTextSnapshot: vi.fn(() => ({ id: 'turn-token' })),
    sendCodexMessage: vi.fn(),
    sendAgentMessage: vi.fn(),
    getMetadataSnapshot: vi.fn(() => sessionMetadataStore.current),
    updateMetadata: vi.fn((updater: (current: any) => any) => {
      sessionMetadataStore.current = updater(sessionMetadataStore.current) ?? sessionMetadataStore.current;
    }),
  });
  opts.configureSessionClient?.(session);
  return {
    session,
    reconnectionHandle: null,
    reportedSessionId: 'sess_1',
    attachedToExistingSession: false,
  };
}

const initializeBackendRunSessionSpy = vi.fn(async (opts: any) => initializeDefaultBackendRunSession(opts));
vi.mock('@/agent/runtime/initializeBackendRunSession', () => ({
  initializeBackendRunSession: (opts: any) => initializeBackendRunSessionSpy(opts),
}));

function mockAttachedSessionMetadata(metadata: Record<string, unknown>): void {
  initializeBackendRunSessionSpy.mockImplementationOnce(async (opts: any) => {
    const session = opts.api.sessionSyncClient({ id: 'sess_1', metadataVersion: 1 });
    lastSessionClient = session as Record<string, any>;
    lastOnUserMessageHandler = null;
    session.onUserMessage = vi.fn((handler: (message: any, info?: { seq: number | null }) => void) => {
      lastOnUserMessageHandler = handler;
    });
    Object.assign(session, {
      fetchLatestUserPermissionIntentFromTranscript: vi.fn(async () => null),
      sendCodexMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      getLastObservedMessageSeq: vi.fn(() => 0),
      bindProviderInputOutcomeProducer: vi.fn(() => providerInputOutcomeObserverMock),
      blockPendingMessageDelivery: vi.fn(async () => false),
      beginTurnAssistantTextSnapshot: vi.fn(() => ({ id: 'turn-token' })),
      getMetadataSnapshot: vi.fn(() => ({ ...metadata })),
    });
    opts.configureSessionClient?.(session);
    return {
      session,
      reconnectionHandle: null,
      reportedSessionId: 'sess_1',
      attachedToExistingSession: false,
    };
  });
}

const SEED_TEXT = 'REPLAY SEED CARRY-OVER CONTEXT';

/**
 * Drives two queued prompts through a Codex ACP run. The first send reports provider
 * acceptance through `sendPromptWithMeta`'s own callback and then fails the way an aborted
 * ACP turn does; the second send only records the prompt Codex received.
 */
async function runTwoCodexAcpPromptsWithFirstTurnAborted(params: Readonly<{
  reportAcceptanceBeforeAbort: boolean;
}>): Promise<{ providerPrompts: string[]; seedAtEachSend: any[] }> {
  sessionMetadataStore.current = {
    connectedServiceMaterializationIdentityV1: {
      v: 1,
      id: 'csm_codex_integration',
      createdAtMs: 1,
    },
    replaySeedV1: {
      v: 1,
      seedText: SEED_TEXT,
      sourceSessionId: 'source-session',
      sourceCutoffSeqInclusive: 12,
      createdAtMs: 1,
    },
  };
  resolveRunnerMcpServersSpy.mockImplementation(async () => ({
    happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
    mcpServers: {},
  }));

  const providerPrompts: string[] = [];
  const seedAtEachSend: any[] = [];
  let sendCount = 0;
  const sendPromptWithMeta = vi.fn(async (promptParams: {
    text: string;
    localId?: string | null;
    meta?: Record<string, unknown>;
    onProviderPromptAccepted?: () => void;
  }) => {
    sendCount += 1;
    providerPrompts.push(promptParams.text);
    seedAtEachSend.push({ ...(sessionMetadataStore.current.replaySeedV1 ?? {}) });
    if (sendCount > 1) return;
    if (params.reportAcceptanceBeforeAbort) {
      // Codex took custody of the prompt: the ACP submission-evidence seam publishes
      // acceptance here, long before the prompt call resolves.
      promptParams.onProviderPromptAccepted?.();
    }
    // ...and the user then aborts the turn, so the prompt call itself rejects.
    const abort = new Error('Cancelled by user');
    abort.name = 'AbortError';
    throw abort;
  });

  createCodexAcpRuntimeSpy.mockImplementation(() => ({
    getSessionId: () => 'thread-acp',
    supportsInFlightSteer: () => false,
    isTurnInFlight: () => false,
    beginTurn: vi.fn(),
    cancel: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    startOrLoad: vi.fn(async () => 'thread-acp'),
    setSessionMode: vi.fn(async () => {}),
    setSessionModel: vi.fn(async () => {}),
    setSessionConfigOption: vi.fn(async () => {}),
    steerPrompt: vi.fn(async () => {}),
    sendPrompt: vi.fn(async () => {}),
    sendPromptWithMeta,
    compactContext: vi.fn(async () => {}),
    flushTurn: vi.fn(async () => {}),
    rollbackConversation: vi.fn(async () => ({
      ok: false,
      errorCode: 'unsupported_action',
      errorMessage: 'unsupported',
    })),
  }));

  let waitCallCount = 0;
  sessionInputConsumerWaitForNextInputImpl = async (opts) => {
    waitCallCount += 1;
    if (waitCallCount > 2) return null;
    if (!lastOnUserMessageHandler) {
      throw new Error('missing-onUserMessage-handler');
    }
    lastOnUserMessageHandler(
      waitCallCount === 1
        ? { content: { text: 'first user message' }, localId: 'local-1' }
        : { content: { text: 'Continue' }, localId: 'local-2' },
      { seq: 90 + waitCallCount },
    );
    return await opts.messageQueue.waitForMessagesAndGetAsString();
  };

  const { runCodex } = await import('./runCodex');
  await runCodex({
    credentials: { token: 'test' } as Credentials,
    startedBy: 'terminal',
    startingMode: 'remote',
    codexBackendMode: 'acp',
    permissionMode: 'default',
    permissionModeUpdatedAt: 1,
  } as any);

  return { providerPrompts, seedAtEachSend };
}

/**
 * The app-server twin of the ACP case. Its `sendPrompt()` stays pending for the whole turn
 * and publishes acceptance out-of-band through `setOnPromptAcceptedByProvider`, so this is
 * the seam where a completion-gated retirement is furthest from the acceptance edge.
 */
async function runTwoCodexAppServerPromptsWithFirstTurnAborted(params: Readonly<{
  reportAcceptanceBeforeAbort: boolean;
}>): Promise<{ providerPrompts: string[]; seedAtEachSend: any[] }> {
  sessionMetadataStore.current = {
    connectedServiceMaterializationIdentityV1: {
      v: 1,
      id: 'csm_codex_integration',
      createdAtMs: 1,
    },
    replaySeedV1: {
      v: 1,
      seedText: SEED_TEXT,
      sourceSessionId: 'source-session',
      sourceCutoffSeqInclusive: 12,
      createdAtMs: 1,
    },
  };
  resolveRunnerMcpServersSpy.mockImplementation(async () => ({
    happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
    mcpServers: {},
  }));

  const providerPrompts: string[] = [];
  const seedAtEachSend: any[] = [];
  let sendCount = 0;
  let acceptedCallback:
    ((input: Readonly<{
      localIds?: readonly string[] | null;
      userMessageSeq: number | null;
      providerTurnId: string;
    }>) => void)
    | null = null;
  const sendPrompt = vi.fn(async (prompt: string, options?: {
    localId?: string | null;
    localIds?: readonly string[] | null;
    userMessageSeq?: number | null;
  }) => {
    sendCount += 1;
    providerPrompts.push(prompt);
    seedAtEachSend.push({ ...(sessionMetadataStore.current.replaySeedV1 ?? {}) });
    if (sendCount > 1) return;
    if (params.reportAcceptanceBeforeAbort) {
      // `turn/start` was acknowledged: the runtime publishes acceptance here, while its
      // own sendPrompt() is still awaiting the turn promise.
      acceptedCallback?.({
        localIds: options?.localIds ?? (options?.localId ? [options.localId] : null),
        userMessageSeq: options?.userMessageSeq ?? null,
        providerTurnId: 'turn-app-server-1',
      });
    }
    const abort = new Error('Cancelled by user');
    abort.name = 'AbortError';
    throw abort;
  });

  createCodexAppServerRuntimeSpy.mockImplementation(() => ({
    getSessionId: () => 'thread-app-server',
    supportsInFlightSteer: () => false,
    isTurnInFlight: () => false,
    beginTurn: vi.fn(),
    cancel: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    startOrLoad: vi.fn(async () => 'thread-app-server'),
    setSessionMode: vi.fn(async () => {}),
    setSessionModel: vi.fn(async () => {}),
    setSessionConfigOption: vi.fn(async () => {}),
    steerPrompt: vi.fn(async () => {}),
    sendPrompt,
    setOnPromptAcceptedByProvider: vi.fn((callback: any) => {
      acceptedCallback = callback;
    }),
    setOnUndeliverablePrompts: vi.fn(),
    compactContext: vi.fn(async () => {}),
    flushTurn: vi.fn(async () => {}),
    rollbackConversation: vi.fn(async () => ({
      ok: true as const,
      target: { type: 'latest_turn' },
      threadId: 'thread-app-server',
    })),
  }));

  let waitCallCount = 0;
  sessionInputConsumerWaitForNextInputImpl = async (opts) => {
    waitCallCount += 1;
    if (waitCallCount > 2) return null;
    if (!lastOnUserMessageHandler) {
      throw new Error('missing-onUserMessage-handler');
    }
    lastOnUserMessageHandler(
      waitCallCount === 1
        ? { content: { text: 'first user message' }, localId: 'local-1' }
        : { content: { text: 'Continue' }, localId: 'local-2' },
      { seq: 90 + waitCallCount },
    );
    return await opts.messageQueue.waitForMessagesAndGetAsString();
  };

  const { runCodex } = await import('./runCodex');
  await runCodex({
    credentials: { token: 'test' } as Credentials,
    startedBy: 'daemon',
    startingMode: 'remote',
    codexBackendMode: 'appServer',
    permissionMode: 'default',
    permissionModeUpdatedAt: 1,
  } as any);

  return { providerPrompts, seedAtEachSend };
}

describe('runCodex replay seed retirement', () => {
  beforeEach(async () => {
    providerInputOutcomeObserverMock.mockReset();
    probeCodexAcpLoadSessionSupportSpy.mockReset();
    resolveRunnerMcpServersSpy.mockReset();
    createCodexAcpRuntimeSpy.mockClear();
    createCodexAppServerRuntimeSpy.mockReset();
    createCodexAppServerRuntimeSpy.mockImplementation((..._args) => createDefaultCodexAppServerRuntimeMock());
    resolveCodexAcpSpawnSpy.mockReset();
    validateCodexAcpSpawnAvailabilitySpy.mockReset();
    ensureRuntimeInstallablesForLaunchSpy.mockReset();
    resolveCodexAcpSpawnSpy.mockImplementation(() => ({
      command: '/tmp/codex-acp',
      args: [],
      availability: { ok: true as const, kind: 'binary', resolvedPath: '/tmp/codex-acp' },
    }));
    validateCodexAcpSpawnAvailabilitySpy.mockImplementation(() => ({ ok: true as const }));
    ensureRuntimeInstallablesForLaunchSpy.mockResolvedValue({ ok: true as const, installedKeys: [] });
    initializeBackendRunSessionSpy.mockReset();
    initializeBackendRunSessionSpy.mockImplementation(async (opts: any) => initializeDefaultBackendRunSession(opts));
    sessionInputConsumerWaitForNextInputImpl = null;
    inputConsumerDrainPendingSpy.mockClear();
    createSessionProviderInputConsumerSpy.mockClear();
    codexLocalLauncherSpy.mockClear();
	    codexLocalLauncherImpl = null;
	    vi.mocked(createCodexPermissionHandler).mockClear();
	    vi.mocked(applyPermissionModeToCodexPermissionHandler).mockClear();
	    registerSessionRpcHandlerMock.mockReset();
    modelSyncFlushPendingAfterStartSpy.mockClear();
    sessionModeSyncFlushPendingAfterStartSpy.mockClear();
    configOptionSyncFlushPendingAfterStartSpy.mockClear();
    registerRemoteSwitchHandlerSpy.mockClear();
    refreshDaemonOpenAiCodexChatGptAuthTokensForBridgeSpy.mockReset();
    refreshDaemonOpenAiCodexChatGptAuthTokensForBridgeSpy.mockImplementation(async () => ({
      accessToken: 'fresh-access',
      chatgptAccountId: 'acct_123',
      chatgptPlanType: 'plus',
    }));
    notifyDaemonConnectedServiceRuntimeAuthFailureSpy.mockReset();
    notifyDaemonConnectedServiceRuntimeAuthFailureSpy.mockImplementation(async () => ({}));
    notifyDaemonConnectedServiceQuotaSnapshotSpy.mockReset();
    notifyDaemonConnectedServiceQuotaSnapshotSpy.mockImplementation(async () => ({ ok: true }));
    remoteModePublishGate = null;
    lastSessionClient = null;
    lastOnUserMessageHandler = null;
    lastOnSwitchToLocal = null;
    delete process.env[HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY];
    delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    const experiments = await import('@/backends/codex/experiments');
    (experiments.isExperimentalCodexAcpEnabled as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const { resolveCodexStartingMode } = await import('./utils/resolveCodexStartingMode');
    (resolveCodexStartingMode as unknown as ReturnType<typeof vi.fn>).mockReturnValue('remote');
    const { createCodexLocalControlSupportResolver } = await import('./localControl/createLocalControlSupportResolver');
    (createCodexLocalControlSupportResolver as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => async () => ({ ok: false as const, reason: 'test' }),
    );
    const { resetConnectedServiceRuntimeAuthFailureReportDedupeForTests } = await import(
      '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon'
    );
    resetConnectedServiceRuntimeAuthFailureReportDedupeForTests();
  });


  it('retires the seed on confirmed delivery even when the turn is then aborted', async () => {
    const { providerPrompts, seedAtEachSend } = await runTwoCodexAcpPromptsWithFirstTurnAborted({
      reportAcceptanceBeforeAbort: true,
    });

    expect(providerPrompts).toHaveLength(2);
    expect(providerPrompts[0]).toContain(SEED_TEXT);
    // The incident: Codex already holds the seed, so the next prompt must not carry it again.
    expect(providerPrompts[1]).not.toContain(SEED_TEXT);
    expect(seedAtEachSend[1]).toMatchObject({
      seedText: '',
      appliedToLocalId: 'local-1',
    });
  });

  it('keeps the seed live when delivery was never confirmed', async () => {
    const { providerPrompts, seedAtEachSend } = await runTwoCodexAcpPromptsWithFirstTurnAborted({
      reportAcceptanceBeforeAbort: false,
    });

    expect(providerPrompts).toHaveLength(2);
    expect(providerPrompts[0]).toContain(SEED_TEXT);
    // Unconfirmed delivery keeps the documented safety margin: better twice than never.
    expect(providerPrompts[1]).toContain(SEED_TEXT);
    expect(seedAtEachSend[1].seedText).toBe(SEED_TEXT);
    expect(seedAtEachSend[1].appliedToLocalId).toBeUndefined();
  });

  it('retires the seed on app-server acceptance even when the turn is then aborted', async () => {
    const { providerPrompts, seedAtEachSend } = await runTwoCodexAppServerPromptsWithFirstTurnAborted({
      reportAcceptanceBeforeAbort: true,
    });

    expect(providerPrompts).toHaveLength(2);
    expect(providerPrompts[0]).toContain(SEED_TEXT);
    expect(providerPrompts[1]).not.toContain(SEED_TEXT);
    expect(seedAtEachSend[1]).toMatchObject({
      seedText: '',
      appliedToLocalId: 'local-1',
    });
  });

  it('keeps the seed live when the app-server never accepted the prompt', async () => {
    const { providerPrompts, seedAtEachSend } = await runTwoCodexAppServerPromptsWithFirstTurnAborted({
      reportAcceptanceBeforeAbort: false,
    });

    expect(providerPrompts).toHaveLength(2);
    expect(providerPrompts[0]).toContain(SEED_TEXT);
    expect(providerPrompts[1]).toContain(SEED_TEXT);
    expect(seedAtEachSend[1].seedText).toBe(SEED_TEXT);
    expect(seedAtEachSend[1].appliedToLocalId).toBeUndefined();
  });
});
