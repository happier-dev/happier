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

function resolvePromptLocalIds(options?: Readonly<{
  localId?: string | null;
  localIds?: readonly string[] | null;
}>): readonly string[] | null {
  return options?.localIds ?? (typeof options?.localId === 'string' ? [options.localId] : null);
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

describe('runCodex CodexACP resume behavior', () => {
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

  it('does not probe Codex ACP capabilities during startup for --resume sessions', async () => {
    probeCodexAcpLoadSessionSupportSpy.mockImplementationOnce(async () => ({
      ok: true,
      checkedAt: Date.now(),
      loadSession: true,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {},
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
    }));
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    const settingsSecretsReadKeys = [new Uint8Array(32).fill(6)];
    const outcome = await runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      resume: 'resume-123',
      accountSettingsContext: {
        source: 'network',
        settings: { codexBackendMode: 'acp', mcpServers: { shouldNotLoadOnResume: true } },
        settingsVersion: 1,
        loadedAtMs: 1,
        settingsSecretsReadKeys,
        whenRefreshed: null,
      },
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(probeCodexAcpLoadSessionSupportSpy).not.toHaveBeenCalled();
    expect(resolveRunnerMcpServersSpy.mock.calls[0]?.[0]).toMatchObject({
      accountSettings: null,
    });
    expect(createCodexPermissionHandler).toHaveBeenCalledWith(expect.objectContaining({
      getAccountSettingsSecretsReadKeys: expect.any(Function),
    }));
    const settingsReadKeysGetter = (createCodexPermissionHandler as any).mock.calls[0]?.[0]?.getAccountSettingsSecretsReadKeys as
      | (() => ReadonlyArray<Uint8Array>)
      | undefined;
    expect(settingsReadKeysGetter?.()).toEqual(settingsSecretsReadKeys);
    expect(createCodexAcpRuntimeSpy).toHaveBeenCalled();
    const createdRuntime = createCodexAcpRuntimeSpy.mock.results[0]?.value as any;
    const startOrLoad = createdRuntime?.startOrLoad as ReturnType<typeof vi.fn> | undefined;
    expect(startOrLoad?.mock.calls[0]?.[0]).toMatchObject({ resumeId: 'resume-123', importHistory: false });
    expect(outcome.ok).toBe(false);
  });

  it('runs the Codex ACP auto-install preflight before remote startup', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    await runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .catch(() => undefined);

    expect(ensureRuntimeInstallablesForLaunchSpy).toHaveBeenCalledTimes(1);
  });

  it('exposes the current Codex permission mode to the Happier MCP bridge', async () => {
    let bridgeSession: any = null;
    resolveRunnerMcpServersSpy.mockImplementationOnce(async (params: any) => {
      bridgeSession = params.session;
      return {
        happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
        mcpServers: {},
      };
    });

    const { runCodex } = await import('./runCodex');

    await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 1,
    } as any).catch(() => undefined);

    expect(bridgeSession?.getPermissionMode?.()).toBe('yolo');
  });

  it('passes attach metadata cleanup keys when existing sessions attach through MCP', async () => {
    const experiments = await import('@/backends/codex/experiments');
    (experiments.isExperimentalCodexAcpEnabled as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    await expect(
      runCodex({
        credentials,
        startedBy: 'terminal',
        startingMode: 'remote',
        existingSessionId: 'existing-123',
        permissionMode: 'read-only',
        permissionModeUpdatedAt: 1,
      } as any),
    ).rejects.toThrow(/bridge-called/);

    expect(initializeBackendRunSessionSpy).toHaveBeenCalled();
    const initializeOpts = initializeBackendRunSessionSpy.mock.calls.at(-1)?.[0] as any;
    expect(initializeOpts.metadataKeysToUnsetOnAttach).toEqual([
      'acpSessionModesV1',
      'acpSessionModelsV1',
      'acpConfigOptionsV1',
      SESSION_MODES_STATE_KEY,
      SESSION_MODELS_STATE_KEY,
      SESSION_CONFIG_OPTIONS_STATE_KEY,
    ]);
  });

  it('returns the protocol rollback error envelope when rollback is unavailable', async () => {
    sessionInputConsumerWaitForNextInputImpl = async (opts) => {
      throw new Error('wait-called');
    };

    const { runCodex } = await import('./runCodex');

    await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any).catch(() => undefined);

    const rollbackHandler = registerSessionRpcHandlerMock.mock.calls.find((call) => call[0] === 'session.rollback')?.[1];
    await expect(rollbackHandler?.({ v: 1, target: { type: 'latest_turn' } })).resolves.toEqual({
      ok: false,
      errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      errorMessage: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
    });
  });

  it('flushes pending remote override synchronizers after app-server attach startup', async () => {
    const experiments = await import('@/backends/codex/experiments');
    (experiments.isExperimentalCodexAcpEnabled as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    sessionInputConsumerWaitForNextInputImpl = async () => {
      throw new Error('wait-called');
    };
    mockAttachedSessionMetadata({ codexSessionId: 'thread-existing', codexBackendMode: 'appServer' });
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => ({
      getSessionId: () => 'thread-existing',
      supportsInFlightSteer: () => false,
      isTurnInFlight: () => false,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt: vi.fn(async () => {}),
      flushTurn: vi.fn(),
      rollbackConversation: vi.fn(async () => ({ ok: true, target: { type: 'latest_turn' }, threadId: 'thread-existing' })),
    }));

    const { runCodex } = await import('./runCodex');

    await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      existingSessionId: 'existing-123',
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 1,
      codexBackendMode: 'appServer',
    } as any).catch(() => undefined);

    expect(sessionModeSyncFlushPendingAfterStartSpy).toHaveBeenCalledTimes(1);
    expect(configOptionSyncFlushPendingAfterStartSpy).toHaveBeenCalledTimes(1);
    expect(modelSyncFlushPendingAfterStartSpy).toHaveBeenCalledTimes(1);
  });

  it('does not arm Codex ACP for daemon-started remote sessions without a TTY', async () => {
    sessionInputConsumerWaitForNextInputImpl = async () => {
      throw new Error('wait-called');
    };

    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    await runCodex(
      {
        credentials,
        startedBy: 'daemon',
        startingMode: 'remote',
        existingSessionId: 'existing-123',
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      } as any,
    ).catch(() => undefined);

    expect(createCodexAcpRuntimeSpy).not.toHaveBeenCalled();
  });

  it('fails closed for explicit --resume when Codex ACP loadSession fails', async () => {
    probeCodexAcpLoadSessionSupportSpy.mockImplementationOnce(async () => ({ ok: true, checkedAt: Date.now(), loadSession: true, agentCapabilities: { loadSession: true, sessionCapabilities: {}, promptCapabilities: { image: false, audio: false, embeddedContext: false }, mcpCapabilities: { http: false, sse: false } } } as any));
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    // If the resume attempt does not happen eagerly, the runner would otherwise wait for messages.
    // Throw if we ever reach the wait loop so the test fails fast instead of hanging.
    sessionInputConsumerWaitForNextInputImpl = async () => {
      throw new Error('wait-called');
    };

    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    const outcome = await runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      resume: 'resume-123',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(createCodexAcpRuntimeSpy).toHaveBeenCalled();
    const createdRuntime = createCodexAcpRuntimeSpy.mock.results[0]?.value as any;
    const startOrLoad = createdRuntime?.startOrLoad as ReturnType<typeof vi.fn> | undefined;
    expect(startOrLoad).toBeTruthy();
    expect(startOrLoad?.mock.calls.length).toBe(1);
    expect(startOrLoad?.mock.calls[0]?.[0]).toMatchObject({ resumeId: 'resume-123', importHistory: false });
    await expect(startOrLoad?.mock.results?.[0]?.value).rejects.toThrow(/startOrLoad-called/);

    expect(outcome.ok).toBe(false);
  });

  it('honors explicit experimentalCodexAcp when the env-backed experiment flag is off', async () => {
    const experiments = await import('@/backends/codex/experiments');
    (experiments.isExperimentalCodexAcpEnabled as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);

    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    sessionInputConsumerWaitForNextInputImpl = async () => {
      throw new Error('wait-called');
    };

    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    const outcome = await runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      resume: 'resume-123',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
      experimentalCodexAcp: true,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(createCodexAcpRuntimeSpy).toHaveBeenCalled();
    const createdRuntime = createCodexAcpRuntimeSpy.mock.results[0]?.value as any;
    const startOrLoad = createdRuntime?.startOrLoad as ReturnType<typeof vi.fn> | undefined;
    expect(startOrLoad?.mock.calls[0]?.[0]).toMatchObject({ resumeId: 'resume-123', importHistory: false });
    expect(outcome.ok).toBe(false);
  });

  it('honors explicit codexBackendMode=acp when the env-backed experiment flag is off', async () => {
    const experiments = await import('@/backends/codex/experiments');
    (experiments.isExperimentalCodexAcpEnabled as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);

    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    sessionInputConsumerWaitForNextInputImpl = async () => {
      throw new Error('wait-called');
    };

    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    const outcome = await runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      resume: 'resume-123',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
      codexBackendMode: 'acp',
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(createCodexAcpRuntimeSpy).toHaveBeenCalled();
    const createdRuntime = createCodexAcpRuntimeSpy.mock.results[0]?.value as any;
    const startOrLoad = createdRuntime?.startOrLoad as ReturnType<typeof vi.fn> | undefined;
    expect(startOrLoad?.mock.calls[0]?.[0]).toMatchObject({ resumeId: 'resume-123', importHistory: false });
    expect(outcome.ok).toBe(false);
  });

  it('uses ACP prompt metadata to confirm Codex provider acceptance after normal sends', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const sendPromptWithMeta = vi.fn(async (params: {
      text: string;
      localId?: string | null;
      meta?: Record<string, unknown>;
      onProviderPromptAccepted?: () => void;
    }) => {
      params.onProviderPromptAccepted?.();
    });
    createCodexAcpRuntimeSpy.mockImplementationOnce(() => ({
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
      rollbackConversation: vi.fn(async () => ({ ok: false, errorCode: 'unsupported_action', errorMessage: 'unsupported' })),
    }));

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async (opts) => {
      waitCallCount += 1;
      if (waitCallCount > 2) return null;
      if (waitCallCount === 1) {
        if (!lastOnUserMessageHandler) {
          throw new Error('missing-onUserMessage-handler');
        }
        lastOnUserMessageHandler({
          content: { text: 'accepted ACP prompt' },
          meta: { source: 'acp-acceptance-test' },
          localId: 'local-acp-accepted',
        }, { seq: 92 });
        return await opts.messageQueue.waitForMessagesAndGetAsString();
      }
      return null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'acp',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    if (!outcome.ok) {
      throw outcome.error;
    }

    expect(lastSessionClient?.bindProviderInputOutcomeProducer).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'codex',
      mode: 'acp',
      matchesCurrentSession: expect.any(Function),
    }));
    expect(sendPromptWithMeta).toHaveBeenCalledWith(expect.objectContaining({
      meta: { source: 'acp-acceptance-test' },
      localId: 'local-acp-accepted',
      onProviderPromptAccepted: expect.any(Function),
    }));
    expect(providerInputOutcomeObserverMock).toHaveBeenCalledWith({
      kind: 'accepted',
      localId: 'local-acp-accepted',
    });
  });

  it('prefers explicit codexBackendMode=appServer over ACP-only attach behavior', async () => {
    const experiments = await import('@/backends/codex/experiments');
    (experiments.isExperimentalCodexAcpEnabled as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    mockAttachedSessionMetadata({ codexSessionId: 'vendor-thread-existing-123' });

    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    const outcome = await runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      existingSessionId: 'existing-123',
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 1,
      experimentalCodexAcp: true,
      codexBackendMode: 'appServer',
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(initializeBackendRunSessionSpy).toHaveBeenCalled();
    const initializeOpts = initializeBackendRunSessionSpy.mock.calls.at(-1)?.[0] as any;
    expect(initializeOpts.metadataKeysToUnsetOnAttach).toEqual([
      'acpSessionModesV1',
      'acpSessionModelsV1',
      'acpConfigOptionsV1',
      SESSION_MODES_STATE_KEY,
      SESSION_MODELS_STATE_KEY,
      SESSION_CONFIG_OPTIONS_STATE_KEY,
    ]);
    expect(outcome).toMatchObject({ ok: false });
  });

  it('wires Happier MCP servers into the future app-server runtime', async () => {
    const experiments = await import('@/backends/codex/experiments');
    (experiments.isExperimentalCodexAcpEnabled as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    mockAttachedSessionMetadata({ codexSessionId: 'vendor-thread-existing-123', codexBackendMode: 'appServer' });
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {
        happier: {
          command: '/tmp/happier-mcp-bridge',
          args: ['--url', 'http://127.0.0.1:0'],
        },
      },
    }));

    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    const outcome = await runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      existingSessionId: 'existing-123',
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 1,
      experimentalCodexAcp: true,
      codexBackendMode: 'appServer',
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(createCodexAcpRuntimeSpy).not.toHaveBeenCalled();
    expect(resolveRunnerMcpServersSpy).toHaveBeenCalledTimes(1);
    expect(createCodexAppServerRuntimeSpy).toHaveBeenCalledTimes(1);
    expect(createCodexAppServerRuntimeSpy).toHaveBeenCalledWith(expect.objectContaining({
      configOverrides: [
        'mcp_servers.happier.command="/tmp/happier-mcp-bridge"',
        'mcp_servers.happier.args=["--url","http://127.0.0.1:0"]',
        'mcp_servers.happier.enabled=true',
      ],
    }));
    const runtimeArgs = createCodexAppServerRuntimeSpy.mock.calls[0]?.[0] as {
      processEnv?: NodeJS.ProcessEnv;
      configOverrides?: string[];
      transcriptSession?: {
        sendAgentMessageEphemeral?: unknown;
      };
    } | undefined;
    expect(runtimeArgs?.processEnv).toBe(process.env);
    expect(runtimeArgs?.transcriptSession?.sendAgentMessageEphemeral).toBeTypeOf('function');
    expect(runtimeArgs?.configOverrides).toEqual([
      'mcp_servers.happier.command="/tmp/happier-mcp-bridge"',
      'mcp_servers.happier.args=["--url","http://127.0.0.1:0"]',
      'mcp_servers.happier.enabled=true',
    ]);
    const createdRuntime = createCodexAppServerRuntimeSpy.mock.results[0]?.value as any;
    const startOrLoad = createdRuntime?.startOrLoad as ReturnType<typeof vi.fn> | undefined;
    expect(startOrLoad?.mock.calls[0]?.[0]).toMatchObject({
      existingSessionId: 'vendor-thread-existing-123',
      importHistory: false,
    });
    expect(outcome).toMatchObject({ ok: false });
    if (outcome.ok) throw new Error('expected runCodex to fail in test');
    const failedOutcome = outcome;
    await expect(failedOutcome.error).toEqual(expect.objectContaining({ message: expect.stringMatching(/appServer-startOrLoad-called/) }));
  });

  it('does not report a resumed app-server session ready when provider resume fails', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    let daemonReadinessResolved = false;
    initializeBackendRunSessionSpy.mockImplementationOnce(async (opts: any) => {
      const initialized = await initializeDefaultBackendRunSession(opts);
      void Promise.resolve()
        .then(async () => await opts.waitForDaemonReportReadiness?.())
        .then(() => {
          daemonReadinessResolved = true;
        });
      return initialized;
    });

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'remote',
      resume: 'resume-123',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
      codexBackendMode: 'appServer',
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    await Promise.resolve();
    expect(outcome).toMatchObject({ ok: false });
    expect(daemonReadinessResolved).toBe(false);
  });

  it('does not report an ordinary metadata-driven app-server resume ready when provider resume fails', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    let daemonReadinessResolved = false;
    initializeBackendRunSessionSpy.mockImplementationOnce(async (opts: any) => {
      const session = opts.api.sessionSyncClient({ id: 'sess_1', metadataVersion: 1 });
      Object.assign(session, {
        fetchLatestUserPermissionIntentFromTranscript: vi.fn(async () => null),
        sendCodexMessage: vi.fn(),
        sendAgentMessage: vi.fn(),
        getLastObservedMessageSeq: vi.fn(() => 0),
        bindProviderInputOutcomeProducer: vi.fn(() => providerInputOutcomeObserverMock),
        blockPendingMessageDelivery: vi.fn(async () => false),
        beginTurnAssistantTextSnapshot: vi.fn(() => ({ id: 'turn-token' })),
        getMetadataSnapshot: vi.fn(() => ({
          codexSessionId: 'vendor-thread-existing-123',
          codexBackendMode: 'appServer',
        })),
      });
      opts.configureSessionClient?.(session);
      void Promise.resolve()
        .then(async () => await opts.waitForDaemonReportReadiness?.())
        .then(() => {
          daemonReadinessResolved = true;
        });
      return {
        session,
        reconnectionHandle: null,
        reportedSessionId: 'sess_1',
        attachedToExistingSession: true,
      };
    });

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'remote',
      existingSessionId: 'existing-123',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
      codexBackendMode: 'appServer',
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    await Promise.resolve();
    expect(outcome).toMatchObject({ ok: false });
    expect(daemonReadinessResolved).toBe(false);
  });

  it('reports app-server readiness after provider resume succeeds', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    const runtime = {
      ...createDefaultCodexAppServerRuntimeMock(),
      startOrLoad: vi.fn(async () => undefined),
    };
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => runtime);
    sessionInputConsumerWaitForNextInputImpl = async () => {
      throw new Error('stop-after-resume-ready');
    };
    let daemonReadinessResolved = false;
    initializeBackendRunSessionSpy.mockImplementationOnce(async (opts: any) => {
      const initialized = await initializeDefaultBackendRunSession(opts);
      void Promise.resolve()
        .then(async () => await opts.waitForDaemonReportReadiness?.())
        .then(() => {
          daemonReadinessResolved = true;
        });
      return initialized;
    });

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'remote',
      resume: 'resume-123',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
      codexBackendMode: 'appServer',
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    await vi.waitFor(() => {
      expect(daemonReadinessResolved).toBe(true);
    });
    expect(runtime.startOrLoad).toHaveBeenCalledWith(expect.objectContaining({ resumeId: 'resume-123' }));
    expect(outcome).toMatchObject({ ok: false });
  });

  it('keeps fresh app-server session registration lazy without opening a provider thread', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    sessionInputConsumerWaitForNextInputImpl = async () => {
      throw new Error('stop-after-fresh-ready');
    };
    let daemonReadinessResolved = false;
    initializeBackendRunSessionSpy.mockImplementationOnce(async (opts: any) => {
      const initialized = await initializeDefaultBackendRunSession(opts);
      void Promise.resolve()
        .then(async () => await opts.waitForDaemonReportReadiness?.())
        .then(() => {
          daemonReadinessResolved = true;
        });
      return initialized;
    });

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'remote',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
      codexBackendMode: 'appServer',
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    await vi.waitFor(() => {
      expect(daemonReadinessResolved).toBe(true);
    });
    const createdRuntime = createCodexAppServerRuntimeSpy.mock.results[0]?.value as any;
    expect(createdRuntime.startOrLoad).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false });
  });

  it('routes Codex ChatGPT refresh bridge requests for connected-service profile selections to the daemon', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify([{
      kind: 'profile',
      serviceId: 'openai-codex',
      profileId: 'work',
    }]);
    const { runCodex } = await import('./runCodex');

    await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
    } as any).catch(() => undefined);

    const runtimeArgs = createCodexAppServerRuntimeSpy.mock.calls[0]?.[0] as {
      onChatGptAuthTokensRefresh?: (input: unknown) => Promise<unknown>;
    } | undefined;
    expect(runtimeArgs?.onChatGptAuthTokensRefresh).toBeTypeOf('function');
    await expect(runtimeArgs!.onChatGptAuthTokensRefresh!({ chatgptPlanType: 'plus' })).resolves.toEqual({
      accessToken: 'fresh-access',
      chatgptAccountId: 'acct_123',
      chatgptPlanType: 'plus',
    });
    expect(refreshDaemonOpenAiCodexChatGptAuthTokensForBridgeSpy).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      selection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'work',
      },
      chatgptPlanType: 'plus',
    });
  });

  it('routes Codex ChatGPT refresh bridge requests for connected-service group active profiles to the daemon', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify([{
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      fallbackProfileId: 'work',
      generation: 7,
    }]);
    const { runCodex } = await import('./runCodex');

    await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
    } as any).catch(() => undefined);

    const runtimeArgs = createCodexAppServerRuntimeSpy.mock.calls[0]?.[0] as {
      onChatGptAuthTokensRefresh?: (input: unknown) => Promise<unknown>;
    } | undefined;
    expect(runtimeArgs?.onChatGptAuthTokensRefresh).toBeTypeOf('function');
    await expect(runtimeArgs!.onChatGptAuthTokensRefresh!({ chatgptPlanType: null })).resolves.toEqual({
      accessToken: 'fresh-access',
      chatgptAccountId: 'acct_123',
      chatgptPlanType: 'plus',
    });
    expect(refreshDaemonOpenAiCodexChatGptAuthTokensForBridgeSpy).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'backup',
        fallbackProfileId: 'work',
        generation: 7,
      },
      chatgptPlanType: null,
    });
  });

  it('forwards provider-applied app-server quota snapshot group identity to the daemon notifier', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify([{
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      fallbackProfileId: 'work',
      generation: 7,
    }]);
    const { runCodex } = await import('./runCodex');

    await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
    } as any).catch(() => undefined);

    const runtimeArgs = createCodexAppServerRuntimeSpy.mock.calls[0]?.[0] as {
      onRateLimitSnapshot?: (rawSnapshot: unknown, context?: Readonly<{
        appliedIdentity?: Readonly<{
          serviceId: 'openai-codex';
          profileId: string;
          groupId: string;
          groupGeneration: number;
          activeAccountId: string | null;
          accountLabel: string | null;
        }> | null;
        activeAccountId?: string | null;
        accountLabel?: string | null;
      }>) => Promise<void>;
    } | undefined;
    expect(runtimeArgs?.onRateLimitSnapshot).toBeTypeOf('function');

    await runtimeArgs!.onRateLimitSnapshot!(
      { primary: { used_percent: 88 } },
      {
        appliedIdentity: {
          serviceId: 'openai-codex',
          profileId: 'backup',
          groupId: 'main',
          groupGeneration: 7,
          activeAccountId: 'acct_live_codex',
          accountLabel: 'live@example.test',
        },
        activeAccountId: 'acct_live_codex',
        accountLabel: 'live@example.test',
      },
    );

    expect(notifyDaemonConnectedServiceQuotaSnapshotSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess_1',
      serviceId: 'openai-codex',
      groupId: 'main',
      groupGeneration: 7,
      snapshot: expect.objectContaining({
        profileId: 'backup',
        activeAccountId: 'acct_live_codex',
        accountLabel: 'live@example.test',
      }),
    }));
  });

  it('routes Codex ChatGPT refresh bridge requests through the live-applied selection after direct auth apply', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify([{
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'old',
      fallbackProfileId: 'backup',
      generation: 7,
    }]);
    const { runCodex } = await import('./runCodex');

    await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
    } as any).catch(() => undefined);

    const runtimeArgs = createCodexAppServerRuntimeSpy.mock.calls[0]?.[0] as {
      onChatGptAuthTokensRefresh?: (input: unknown) => Promise<unknown>;
      onConnectedServiceAuthGenerationApplied?: (input: Readonly<{ selection: unknown }>) => Promise<void> | void;
    } | undefined;
    expect(runtimeArgs?.onChatGptAuthTokensRefresh).toBeTypeOf('function');
    expect(runtimeArgs?.onConnectedServiceAuthGenerationApplied).toBeTypeOf('function');

    await runtimeArgs!.onConnectedServiceAuthGenerationApplied!({
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'new',
        fallbackProfileId: 'old',
        generation: 8,
      },
    });
    await expect(runtimeArgs!.onChatGptAuthTokensRefresh!({ chatgptPlanType: null })).resolves.toEqual({
      accessToken: 'fresh-access',
      chatgptAccountId: 'acct_123',
      chatgptPlanType: 'plus',
    });
    expect(refreshDaemonOpenAiCodexChatGptAuthTokensForBridgeSpy).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'new',
        fallbackProfileId: 'old',
        generation: 8,
      },
      chatgptPlanType: null,
    });
  });

  it('routes Codex ChatGPT refresh bridge requests from connected-service session metadata when env binding is missing', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    mockAttachedSessionMetadata({
      codexBackendMode: 'appServer',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'backup',
          },
        },
      },
    });
    const { runCodex } = await import('./runCodex');

    const runPromise = runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
    } as any).catch(() => undefined);
    await runPromise;

    const runtimeArgs = createCodexAppServerRuntimeSpy.mock.calls[0]?.[0] as {
      onChatGptAuthTokensRefresh?: (input: unknown) => Promise<unknown>;
    } | undefined;
    expect(runtimeArgs?.onChatGptAuthTokensRefresh).toBeTypeOf('function');
    await expect(runtimeArgs!.onChatGptAuthTokensRefresh!({ chatgptPlanType: 'team' })).resolves.toEqual({
      accessToken: 'fresh-access',
      chatgptAccountId: 'acct_123',
      chatgptPlanType: 'plus',
    });
    expect(refreshDaemonOpenAiCodexChatGptAuthTokensForBridgeSpy).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      selection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'backup',
      },
      chatgptPlanType: 'team',
    });
  });

  it('routes Codex ChatGPT refresh bridge requests from current session metadata when app-server env is stale', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify([{
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'primary',
      fallbackProfileId: 'work',
      generation: 7,
    }]);
    mockAttachedSessionMetadata({
      codexBackendMode: 'appServer',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'backup',
          },
        },
      },
    });
    const { runCodex } = await import('./runCodex');

    const runPromise = runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
    } as any).catch(() => undefined);
    await runPromise;

    const runtimeArgs = createCodexAppServerRuntimeSpy.mock.calls[0]?.[0] as {
      onChatGptAuthTokensRefresh?: (input: unknown) => Promise<unknown>;
    } | undefined;
    expect(runtimeArgs?.onChatGptAuthTokensRefresh).toBeTypeOf('function');
    await expect(runtimeArgs!.onChatGptAuthTokensRefresh!({ chatgptPlanType: 'team' })).resolves.toEqual({
      accessToken: 'fresh-access',
      chatgptAccountId: 'acct_123',
      chatgptPlanType: 'plus',
    });
    expect(refreshDaemonOpenAiCodexChatGptAuthTokensForBridgeSpy).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      selection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'backup',
      },
      chatgptPlanType: 'team',
    });
  });

  it('reports failed Codex ChatGPT bridge refresh through connected-service runtime recovery', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify([{
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'backup',
      fallbackProfileId: 'work',
      generation: 7,
    }]);
    const bridgeError = new Error('connected_service_chatgpt_refresh_unavailable');
    refreshDaemonOpenAiCodexChatGptAuthTokensForBridgeSpy.mockRejectedValueOnce(bridgeError);
    notifyDaemonConnectedServiceRuntimeAuthFailureSpy.mockResolvedValueOnce({
      ok: true,
      result: {
        status: 'recovery_action_required',
        action: {
          kind: 'reconnect_profile',
          serviceId: 'openai-codex',
          profileId: 'backup',
          groupId: 'main',
          reason: 'refresh_failed',
        },
      },
    });
    const { runCodex } = await import('./runCodex');

    await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
    } as any).catch(() => undefined);

    const runtimeArgs = createCodexAppServerRuntimeSpy.mock.calls[0]?.[0] as {
      onChatGptAuthTokensRefresh?: (input: unknown) => Promise<unknown>;
    } | undefined;
    expect(runtimeArgs?.onChatGptAuthTokensRefresh).toBeTypeOf('function');
    await expect(runtimeArgs!.onChatGptAuthTokensRefresh!({ chatgptPlanType: 'plus' })).rejects.toMatchObject({
      runtimeAuthClassification: {
        kind: 'refresh_failed',
        serviceId: 'openai-codex',
        profileId: 'backup',
        groupId: 'main',
      },
    });
    expect(notifyDaemonConnectedServiceRuntimeAuthFailureSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess_1',
        switchesThisTurn: 0,
        classification: expect.objectContaining({
          kind: 'refresh_failed',
          serviceId: 'openai-codex',
          profileId: 'backup',
          groupId: 'main',
        }),
      }),
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
    const emittedMessages = (lastSessionClient?.sendSessionEvent as ReturnType<typeof vi.fn> | undefined)?.mock.calls
      .map((call) => call[0]?.message)
      .filter((message): message is string => typeof message === 'string') ?? [];
    expect(emittedMessages.some((message) => message.includes('reconnect'))).toBe(true);
  });

  it('binds explicit check-now group recovery to the authenticated replacement daemon generation', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    notifyDaemonConnectedServiceRuntimeAuthFailureSpy.mockResolvedValueOnce({
      ok: true,
      result: { status: 'switch_attempted', result: { status: 'switched', activeProfileId: 'backup' } },
    });
    const { runCodex } = await import('./runCodex');
    await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
    } as any).catch(() => undefined);

    const runtimeArgs = createCodexAppServerRuntimeSpy.mock.calls[0]?.[0] as {
      onUsageLimitGroupRecovery?: (input: unknown) => Promise<unknown>;
    } | undefined;
    expect(runtimeArgs?.onUsageLimitGroupRecovery).toBeTypeOf('function');
    await runtimeArgs!.onUsageLimitGroupRecovery!({
      classification: {
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'limited',
        groupId: 'main',
        resetsAtMs: 2_000,
        retryAfterMs: null,
        planType: null,
        rateLimits: null,
        source: 'provider_runtime_marker',
      },
    });

    expect(notifyDaemonConnectedServiceRuntimeAuthFailureSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess_1',
        classification: expect.objectContaining({ kind: 'usage_limit', groupId: 'main' }),
      }),
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
  });

  it('preserves metadata group context when a metadata-backed Codex bridge refresh fails', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    mockAttachedSessionMetadata({
      codexBackendMode: 'appServer',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'backup',
          },
        },
      },
    });
    refreshDaemonOpenAiCodexChatGptAuthTokensForBridgeSpy.mockRejectedValueOnce(
      new Error('connected_service_chatgpt_refresh_unavailable'),
    );
    notifyDaemonConnectedServiceRuntimeAuthFailureSpy.mockResolvedValueOnce({
      ok: true,
      result: {
        status: 'switch_limit_reached',
        groupId: 'main',
      },
    });
    const { runCodex } = await import('./runCodex');

    const runPromise = runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
    } as any).catch(() => undefined);
    await runPromise;

    const runtimeArgs = createCodexAppServerRuntimeSpy.mock.calls[0]?.[0] as {
      onChatGptAuthTokensRefresh?: (input: unknown) => Promise<unknown>;
    } | undefined;
    expect(runtimeArgs?.onChatGptAuthTokensRefresh).toBeTypeOf('function');
    await expect(runtimeArgs!.onChatGptAuthTokensRefresh!({ chatgptPlanType: 'plus' })).rejects.toMatchObject({
      runtimeAuthClassification: {
        kind: 'refresh_failed',
        serviceId: 'openai-codex',
        profileId: 'backup',
        groupId: 'main',
      },
    });
    expect(refreshDaemonOpenAiCodexChatGptAuthTokensForBridgeSpy).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      selection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'backup',
      },
      chatgptPlanType: 'plus',
    });
    expect(notifyDaemonConnectedServiceRuntimeAuthFailureSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess_1',
        switchesThisTurn: 0,
        classification: expect.objectContaining({
          kind: 'refresh_failed',
          serviceId: 'openai-codex',
          profileId: 'backup',
          groupId: 'main',
        }),
      }),
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
  });

  it('does not treat non-app-server codexSessionId metadata as an app-server thread id', async () => {
    const experiments = await import('@/backends/codex/experiments');
    (experiments.isExperimentalCodexAcpEnabled as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    mockAttachedSessionMetadata({ codexSessionId: 'mcp-session-123', codexBackendMode: 'mcp' });

    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    const outcome = await runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      existingSessionId: 'existing-123',
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 1,
      experimentalCodexAcp: true,
      codexBackendMode: 'appServer',
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(createCodexAppServerRuntimeSpy).toHaveBeenCalledTimes(1);
    const createdRuntime = createCodexAppServerRuntimeSpy.mock.results[0]?.value as any;
    const startOrLoad = createdRuntime?.startOrLoad as ReturnType<typeof vi.fn> | undefined;
    expect(startOrLoad?.mock.calls.some((call) => call?.[0]?.existingSessionId === 'mcp-session-123')).toBe(false);
    expect(outcome).toMatchObject({ ok: true });
  });

  it('cancels the app-server runtime when the session abort RPC is invoked mid-turn', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    sessionInputConsumerWaitForNextInputImpl = async () => {
      throw new Error('wait-called');
    };
    const cancelSpy = vi.fn(async () => {});
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => ({
      getSessionId: () => 'thread-existing',
      supportsInFlightSteer: () => false,
      isTurnInFlight: () => true,
      beginTurn: vi.fn(),
      cancel: cancelSpy,
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt: vi.fn(async () => {}),
      flushTurn: vi.fn(),
      rollbackConversation: vi.fn(async () => ({ ok: true, target: { type: 'latest_turn' }, threadId: 'thread-existing' })),
    }));

    const { runCodex } = await import('./runCodex');

    await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      existingSessionId: 'existing-123',
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 1,
      codexBackendMode: 'appServer',
    } as any).catch(() => undefined);

    const abortHandler = registerSessionRpcHandlerMock.mock.calls.find((call) => call[0] === 'abort')?.[1];
    await expect(abortHandler?.()).resolves.toBeUndefined();
    const createdPermissionHandler = (createCodexPermissionHandler as any).mock.results[0]?.value;
    expect(createdPermissionHandler?.abortPendingRequestsAndFlush).toHaveBeenCalledTimes(1);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it('prefers the linked vendor resume id over the happy session id when app-server attaches an existing session', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    const outcome = await runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      existingSessionId: 'happy-session-123',
      resume: 'vendor-thread-456',
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 1,
      codexBackendMode: 'appServer',
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(createCodexAppServerRuntimeSpy).toHaveBeenCalledTimes(1);
    const createdRuntime = createCodexAppServerRuntimeSpy.mock.results[0]?.value as any;
    const startOrLoad = createdRuntime?.startOrLoad as ReturnType<typeof vi.fn> | undefined;
    expect(startOrLoad?.mock.calls[0]?.[0]).toMatchObject({
      resumeId: 'vendor-thread-456',
      importHistory: false,
    });
    expect(outcome).toMatchObject({ ok: false });
  });

  it('allows appServer resume without the ACP-only resume error path', async () => {
    const experiments = await import('@/backends/codex/experiments');
    (experiments.isExperimentalCodexAcpEnabled as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    const outcome = await runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      resume: 'resume-123',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
      codexBackendMode: 'appServer',
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(outcome).toMatchObject({ ok: false });
    if (outcome.ok) throw new Error('expected runCodex to fail in test');
    const failedOutcome = outcome;
    expect((failedOutcome.error as Error).message).not.toMatch(/resume is only supported via ACP/i);
    expect(createCodexAcpRuntimeSpy).not.toHaveBeenCalled();
    expect(createCodexAppServerRuntimeSpy).toHaveBeenCalledTimes(1);
    const createdRuntime = createCodexAppServerRuntimeSpy.mock.results[0]?.value as any;
    const startOrLoad = createdRuntime?.startOrLoad as ReturnType<typeof vi.fn> | undefined;
    expect(startOrLoad?.mock.calls[0]?.[0]).toMatchObject({ resumeId: 'resume-123', importHistory: false });
    await expect(failedOutcome.error).toEqual(expect.objectContaining({ message: expect.stringMatching(/appServer-startOrLoad-called/) }));
  });

  it('registers a session-scoped rollback RPC that delegates to the app-server runtime', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    const { runCodex } = await import('./runCodex');
    sessionInputConsumerWaitForNextInputImpl = async () => {
      throw new Error('wait-called');
    };

    const credentials = { token: 'test' } as Credentials;
    const outcome = await runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      existingSessionId: 'existing-123',
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 1,
      codexBackendMode: 'appServer',
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(outcome.ok).toBe(false);
    const rollbackHandler = registerSessionRpcHandlerMock.mock.calls.find((call) => call[0] === 'session.rollback')?.[1];
    expect(typeof rollbackHandler).toBe('function');

    const createdRuntime = createCodexAppServerRuntimeSpy.mock.results[0]?.value as any;
    await expect(rollbackHandler?.({ v: 1, target: { type: 'latest_turn' } })).resolves.toEqual({
      ok: true,
      target: { type: 'latest_turn' },
      threadId: 'thread_1',
    });
    expect(createdRuntime.rollbackConversation).toHaveBeenCalledWith({ v: 1, target: { type: 'latest_turn' } });
  });

  it('routes /compact through the app-server runtime compaction hook in remote sessions', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const startOrLoad = vi.fn(async () => undefined);
    const sendPrompt = vi.fn(async () => undefined);
    const compactContext = vi.fn(async () => undefined);
    const flushTurn = vi.fn(async () => undefined);
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => ({
      getSessionId: () => 'thread_1',
      supportsInFlightSteer: () => false,
      isTurnInFlight: () => false,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad,
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt,
      compactContext,
      flushTurn,
      rollbackConversation: vi.fn(async () => ({ ok: true, target: { type: 'latest_turn' }, threadId: 'thread_1' })),
    }));

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async () => {
      waitCallCount += 1;
      if (waitCallCount === 1) {
        return {
          message: '/compact',
          mode: {
            permissionMode: 'default',
            permissionModeUpdatedAt: 1,
          },
          isolate: false,
          hash: 'hash-compact',
          maxUserMessageSeq: null,
          userMessageLocalIds: ['codex-compact-63'],
        };
      }
      throw new Error('stop-after-provider-local-id-test');
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'remote',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
      codexBackendMode: 'appServer',
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toEqual(expect.objectContaining({ message: 'stop-after-provider-local-id-test' }));
    }

    expect(startOrLoad).toHaveBeenCalledWith({});
    expect(compactContext).toHaveBeenCalledWith('/compact');
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(flushTurn).toHaveBeenCalled();
    expect(providerInputOutcomeObserverMock).toHaveBeenCalledWith({
      kind: 'accepted',
      localId: 'codex-compact-63',
    });
  });

  it('confirms locally consumed /clear commands when provider delivery is deferred', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const reset = vi.fn(async () => undefined);
    const sendPrompt = vi.fn(async () => undefined);
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => ({
      getSessionId: () => 'thread_1',
      supportsInFlightSteer: () => false,
      isTurnInFlight: () => false,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset,
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt,
      compactContext: vi.fn(async () => {}),
      flushTurn: vi.fn(async () => {}),
      rollbackConversation: vi.fn(async () => ({ ok: true, target: { type: 'latest_turn' }, threadId: 'thread_1' })),
    }));

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async () => {
      waitCallCount += 1;
      if (waitCallCount === 1) {
        return {
          message: '/clear',
          mode: {
            permissionMode: 'default',
            permissionModeUpdatedAt: 1,
          },
          isolate: false,
          hash: 'hash-clear',
          maxUserMessageSeq: null,
          userMessageLocalIds: ['codex-clear-64'],
        };
      }
      return null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'remote',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
      codexBackendMode: 'appServer',
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    if (!outcome.ok) {
      throw outcome.error;
    }

    expect(reset).toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(providerInputOutcomeObserverMock).toHaveBeenCalledWith({
      kind: 'accepted',
      localId: 'codex-clear-64',
    });
  });

  it('passes the requested directory to the Codex app-server runtime', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    const { runCodex } = await import('./runCodex');
    sessionInputConsumerWaitForNextInputImpl = async () => {
      throw new Error('wait-called');
    };

    const credentials = { token: 'test' } as Credentials;
    const outcome = await runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      directory: '/tmp/requested-codex-dir',
      existingSessionId: 'existing-123',
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 1,
      codexBackendMode: 'appServer',
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(outcome.ok).toBe(false);
    expect(createCodexAppServerRuntimeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: '/tmp/requested-codex-dir',
      }),
    );
  });

  it('fails closed when switching local→remote and Codex ACP loadSession fails', async () => {
    probeCodexAcpLoadSessionSupportSpy.mockImplementationOnce(async () => {
      throw new Error('probe-called');
    });
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const { createCodexLocalControlSupportResolver } = await import('./localControl/createLocalControlSupportResolver');
    (createCodexLocalControlSupportResolver as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => async () => ({ ok: true as const, backend: 'acp' }),
    );

    codexLocalLauncherImpl = async () => ({ type: 'switch', resumeId: 'resume-from-local' });

    const { resolveCodexStartingMode } = await import('./utils/resolveCodexStartingMode');
    (resolveCodexStartingMode as unknown as ReturnType<typeof vi.fn>).mockReturnValue('local');

    // If the local→remote resume attempt does not happen eagerly, the runner would otherwise wait for messages.
    // Throw if we ever reach the wait loop so the test fails fast instead of hanging.
    sessionInputConsumerWaitForNextInputImpl = async () => {
      throw new Error('wait-called');
    };

    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    const outcome = await runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      resume: null,
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(createCodexAcpRuntimeSpy).toHaveBeenCalled();
    expect(codexLocalLauncherSpy).toHaveBeenCalled();

    const createdRuntime = createCodexAcpRuntimeSpy.mock.results[0]?.value as any;
    const startOrLoad = createdRuntime?.startOrLoad as ReturnType<typeof vi.fn> | undefined;
    expect(startOrLoad).toBeTruthy();
    expect(startOrLoad?.mock.calls.length).toBe(1);
    expect(startOrLoad?.mock.calls[0]?.[0]).toMatchObject({ resumeId: 'resume-from-local', importHistory: false });

    expect(outcome.ok).toBe(false);
  });

  it('passes the requested directory into local mode launches', async () => {
    const { resolveCodexStartingMode } = await import('./utils/resolveCodexStartingMode');
    (resolveCodexStartingMode as unknown as ReturnType<typeof vi.fn>).mockReturnValue('local');
    const { resolveHasTTY } = await import('@/ui/tty/resolveHasTTY');
    (resolveHasTTY as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const { createCodexLocalControlSupportResolver } = await import('./localControl/createLocalControlSupportResolver');
    (createCodexLocalControlSupportResolver as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => async () => ({ ok: true as const, backend: 'appServer' }),
    );
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    codexLocalLauncherImpl = async () => ({ type: 'exit', code: 0 });

    const { runCodex } = await import('./runCodex');
    const credentials = { token: 'test' } as Credentials;

    await expect(runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'local',
      directory: '/tmp/requested-local-dir',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)).resolves.toBeUndefined();

    expect(codexLocalLauncherSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/tmp/requested-local-dir',
      }),
    );
  });

  it('passes the requested directory into non-fast-start local launches', async () => {
    const { resolveCodexStartingMode } = await import('./utils/resolveCodexStartingMode');
    (resolveCodexStartingMode as unknown as ReturnType<typeof vi.fn>).mockReturnValue('local');
    const { createCodexLocalControlSupportResolver } = await import('./localControl/createLocalControlSupportResolver');
    (createCodexLocalControlSupportResolver as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => async () => ({ ok: true as const, backend: 'appServer' }),
    );
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    codexLocalLauncherImpl = async () => ({ type: 'exit', code: 0 });

    const { runCodex } = await import('./runCodex');
    await expect(runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'local',
      directory: '/tmp/requested-local-dir-daemon',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)).resolves.toBeUndefined();

    expect(codexLocalLauncherSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/tmp/requested-local-dir-daemon',
      }),
    );
  });

  it('can switch remote→local while Codex ACP resume is still in progress', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const { createCodexLocalControlSupportResolver } = await import('./localControl/createLocalControlSupportResolver');
    (createCodexLocalControlSupportResolver as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => async () => ({ ok: true as const, backend: 'acp' }),
    );

    const { resolveCodexStartingMode } = await import('./utils/resolveCodexStartingMode');
    (resolveCodexStartingMode as unknown as ReturnType<typeof vi.fn>).mockReturnValue('local');

    // First local pass switches to remote with a resume id, second local pass exits.
    let localLauncherCalls = 0;
    codexLocalLauncherImpl = async () => {
      localLauncherCalls += 1;
      if (localLauncherCalls === 1) return { type: 'switch', resumeId: 'resume-from-local' };
      return { type: 'exit', code: 0 };
    };

    // The runtime will begin a loadSession that never resolves. The switch-to-local request should abort it.
    const never = new Promise<void>(() => {});
    createCodexAcpRuntimeSpy.mockImplementationOnce(() => ({
      getSessionId: () => null,
      supportsInFlightSteer: () => false,
      isTurnInFlight: () => false,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(() => never),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt: vi.fn(async () => {}),
      flushTurn: vi.fn(),
      rollbackConversation: vi.fn(async () => ({ ok: true, target: { type: 'latest_turn' }, threadId: 'thread_1' })),
    }));

    // If we ever reach the message wait loop, return null so the runner can proceed.
    sessionInputConsumerWaitForNextInputImpl = async () => null;

    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    const runPromise = runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'acp',
      resume: null,
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any);

    await expect.poll(() => createCodexAcpRuntimeSpy.mock.calls.length, { timeout: 1_000 }).toBe(1);
    await expect.poll(() => typeof lastOnSwitchToLocal, { timeout: 1_000 }).toBe('function');

    const createdRuntime = createCodexAcpRuntimeSpy.mock.results[0]?.value as any;
    expect(createdRuntime?.startOrLoad).toBeTruthy();

    await expect
      .poll(() => (createdRuntime.startOrLoad as ReturnType<typeof vi.fn>).mock.calls.length, { timeout: 1_000 })
      .toBe(1);

    await lastOnSwitchToLocal?.();

    await expect.poll(() => codexLocalLauncherSpy.mock.calls.length, { timeout: 1_000 }).toBe(2);

    await expect(runPromise).resolves.toBeUndefined();
  });

  it('eagerly resumes remote mode through app-server after switching from local', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const { createCodexLocalControlSupportResolver } = await import('./localControl/createLocalControlSupportResolver');
    (createCodexLocalControlSupportResolver as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => async () => ({ ok: true as const, backend: 'appServer' }),
    );

    codexLocalLauncherImpl = async () => ({ type: 'switch', resumeId: 'resume-from-local' });

    const { resolveCodexStartingMode } = await import('./utils/resolveCodexStartingMode');
    (resolveCodexStartingMode as unknown as ReturnType<typeof vi.fn>).mockReturnValue('local');

    sessionInputConsumerWaitForNextInputImpl = async () => {
      throw new Error('wait-called');
    };

    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    const outcome = await runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      resume: null,
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(createCodexAppServerRuntimeSpy).toHaveBeenCalled();
    expect(codexLocalLauncherSpy).toHaveBeenCalled();

    const createdRuntime = createCodexAppServerRuntimeSpy.mock.results[0]?.value as any;
    const startOrLoad = createdRuntime?.startOrLoad as ReturnType<typeof vi.fn> | undefined;
    expect(startOrLoad).toBeTruthy();
    expect(startOrLoad?.mock.calls.length).toBe(1);
    expect(startOrLoad?.mock.calls[0]?.[0]).toMatchObject({ resumeId: 'resume-from-local', importHistory: false });

    expect(outcome.ok).toBe(false);
  });

  it('can switch remote→local while app-server resume is still in progress', async () => {
    const { createCodexLocalControlSupportResolver } = await import('./localControl/createLocalControlSupportResolver');
    (createCodexLocalControlSupportResolver as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => async () => ({ ok: true as const, backend: 'appServer' }),
    );
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const { resolveCodexStartingMode } = await import('./utils/resolveCodexStartingMode');
    (resolveCodexStartingMode as unknown as ReturnType<typeof vi.fn>).mockReturnValue('local');

    let localLauncherCalls = 0;
    codexLocalLauncherImpl = async () => {
      localLauncherCalls += 1;
      if (localLauncherCalls === 1) return { type: 'switch', resumeId: 'resume-from-local' };
      return { type: 'exit', code: 0 };
    };

    const never = new Promise<void>(() => {});
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => ({
      getSessionId: () => null,
      supportsInFlightSteer: () => false,
      isTurnInFlight: () => false,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(() => never),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt: vi.fn(async () => {}),
      flushTurn: vi.fn(),
    }));

    sessionInputConsumerWaitForNextInputImpl = async () => null;

    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    const runPromise = runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      resume: null,
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any);

    await expect.poll(() => createCodexAppServerRuntimeSpy.mock.calls.length, { timeout: 1_000 }).toBe(1);
    await expect.poll(() => typeof lastOnSwitchToLocal, { timeout: 1_000 }).toBe('function');

    const createdRuntime = createCodexAppServerRuntimeSpy.mock.results[0]?.value as any;
    expect(createdRuntime?.startOrLoad).toBeTruthy();

    await expect
      .poll(() => (createdRuntime.startOrLoad as ReturnType<typeof vi.fn>).mock.calls.length, { timeout: 1_000 })
      .toBe(1);

    await lastOnSwitchToLocal?.();

    await expect.poll(() => codexLocalLauncherSpy.mock.calls.length, { timeout: 1_000 }).toBe(2);

    await expect(runPromise).resolves.toBeUndefined();
  });

  it('registers the remote switch handler before awaiting remote-mode publication', async () => {
    remoteModePublishGateResolver.current = null;
    remoteModePublishGate = new Promise<void>((resolve) => {
      remoteModePublishGateResolver.current = resolve;
    });

    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    sessionInputConsumerWaitForNextInputImpl = async () => {
      throw new Error('stop-after-registration');
    };

    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    const runPromise = runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      resume: null,
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any);

    try {
      await expect.poll(() => createCodexAcpRuntimeSpy.mock.calls.length, { timeout: 1_000 }).toBe(1);
      await expect.poll(() => registerRemoteSwitchHandlerSpy.mock.calls.length, { timeout: 250 }).toBe(1);
    } finally {
      const releaseRemoteModePublishGate = remoteModePublishGateResolver.current;
      if (releaseRemoteModePublishGate) (releaseRemoteModePublishGate as () => void)();
      remoteModePublishGate = null;
      await runPromise.catch(() => undefined);
    }
  });

  it('cancels a provider-owned app-server turn before admitting an exact interrupt-and-send message', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    let releaseCancel!: () => void;
    const cancelSettled = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const appServerRuntime = {
      ...createDefaultCodexAppServerRuntimeMock(),
      getSessionId: () => 'thread-app-server-exact-interrupt',
      // The user-facing turn flag may already be terminal while the provider runtime
      // still owns its short terminal-settlement window.
      isTurnInFlight: () => false,
      hasActiveProviderTurn: () => true,
      cancel: vi.fn(async () => {
        await cancelSettled;
      }),
    };
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => appServerRuntime);

    let queuedBeforeCancelSettled = false;
    let handoffSettledBeforeCancel = false;
    let observedPendingDeliveryAction: unknown = null;
    sessionInputConsumerWaitForNextInputImpl = async (opts) => {
      if (!lastOnUserMessageHandler) {
        throw new Error('missing-onUserMessage-handler');
      }
      const handoff = lastOnUserMessageHandler({
        content: { text: 'interrupt with this exact message' },
        meta: {},
        localId: 'local-exact-interrupt',
      }, {
        seq: 92,
        pendingProviderAction: 'interrupt_and_send',
        providerAcceptancePending: true,
      });
      let handoffSettled = false;
      const observedHandoff = Promise.resolve(handoff).then(() => {
        handoffSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      queuedBeforeCancelSettled = opts.messageQueue.size() > 0;
      handoffSettledBeforeCancel = handoffSettled;
      releaseCancel();
      await observedHandoff;
      const batch = await opts.messageQueue.waitForMessagesAndGetAsString();
      observedPendingDeliveryAction = batch?.pendingProviderAction;
      throw new Error('stop-after-exact-interrupt-admission');
    };

    const { runCodex } = await import('./runCodex');
    const outcomePromise = runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));
    const outcome = await outcomePromise;

    expect(appServerRuntime.cancel).toHaveBeenCalledTimes(1);
    expect(queuedBeforeCancelSettled).toBe(false);
    expect(handoffSettledBeforeCancel).toBe(false);
    expect(observedPendingDeliveryAction).toBe('interrupt_and_send');
    expect(appServerRuntime.steerPrompt).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toEqual(expect.objectContaining({ message: 'stop-after-exact-interrupt-admission' }));
    }
  });

  it('records a sanitized diagnostic when an exact interrupt-and-send cancellation fails before provider input', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const appServerRuntime = {
      ...createDefaultCodexAppServerRuntimeMock(),
      getSessionId: () => 'thread-app-server-interrupt-failure',
      isTurnInFlight: () => true,
      hasActiveProviderTurn: () => true,
      cancel: vi.fn(async () => {
        throw new Error('interrupt transport unavailable');
      }),
    };
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => appServerRuntime);

    sessionInputConsumerWaitForNextInputImpl = async () => {
      if (!lastOnUserMessageHandler) {
        throw new Error('missing-onUserMessage-handler');
      }
      lastSessionClient!.blockPendingMessageDelivery.mockResolvedValueOnce(true);
      await lastOnUserMessageHandler({
        content: { text: 'interrupt with this exact message' },
        meta: {},
        localId: 'local-interrupt-failure',
      }, {
        seq: 93,
        pendingProviderAction: 'interrupt_and_send',
        providerAcceptancePending: true,
      });
      return null;
    };

    const { runCodex } = await import('./runCodex');
    await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any);

    expect(lastSessionClient?.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['local-interrupt-failure'],
      reason: 'provider_rejected_before_acceptance',
    });
    const { logger } = await import('@/ui/logger');
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('interrupt-and-send'),
      expect.objectContaining({
        localIds: ['local-interrupt-failure'],
        errorName: 'Error',
        errorMessage: 'interrupt transport unavailable',
      }),
    );
  });

  it('reports provider-owned work as active and unsteerable when steer capability disappears', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    let hasActiveProviderTurn = false;
    let canSteerPrompt = false;
    const appServerRuntime = {
      ...createDefaultCodexAppServerRuntimeMock(),
      getSessionId: () => 'thread-app-server-provider-owned-work',
      startOrLoad: vi.fn(async () => {}),
      supportsInFlightSteer: () => true,
      isTurnInFlight: () => hasActiveProviderTurn,
      hasActiveProviderTurn: () => hasActiveProviderTurn,
      canSteerPrompt: () => canSteerPrompt,
    };
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => appServerRuntime);

    const observedSteerabilities: unknown[] = [];
    sessionInputConsumerWaitForNextInputImpl = async (opts) => {
      observedSteerabilities.push(opts.resolveActiveTurnSteerability?.());
      hasActiveProviderTurn = true;
      canSteerPrompt = true;
      observedSteerabilities.push(opts.resolveActiveTurnSteerability?.());
      canSteerPrompt = false;
      observedSteerabilities.push(opts.resolveActiveTurnSteerability?.());
      hasActiveProviderTurn = false;
      observedSteerabilities.push(opts.resolveActiveTurnSteerability?.());
      throw new Error('steerability-observed');
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      accountSettingsContext: {
        settings: { sessionBusySteerSendPolicy: 'server_pending' },
      },
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(observedSteerabilities).toEqual([
      'steerable',
      'steerable',
      'unsteerable',
      'steerable',
    ]);
    expect(outcome).toEqual({
      ok: false,
      error: expect.objectContaining({ message: 'steerability-observed' }),
    });
  });

  it('steers mid-turn app-server user messages even when they carry a permission-mode change', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const observeProviderInputOutcome = vi.fn();
    initializeBackendRunSessionSpy.mockImplementationOnce(async (opts: any) => {
      const initialized = await initializeDefaultBackendRunSession(opts);
      initialized.session.bindProviderInputOutcomeProducer = vi.fn(() => observeProviderInputOutcome);
      return initialized;
    });

    let observedQueuedMessageCount = 0;
    let acceptedPromptCallback: ((input: Readonly<{
      localIds?: readonly string[] | null;
      userMessageSeq: number | null;
      providerTurnId: string;
    }>) => void) | null = null;
    let releaseSteer!: () => void;
    const steerSettled = new Promise<void>((resolve) => {
      releaseSteer = resolve;
    });
    const appServerRuntime = {
	      getSessionId: () => 'thread-app-server-mode-steer',
	      supportsInFlightSteer: () => true,
	      supportsInFlightConfigApply: () => true,
	      isTurnInFlight: () => true,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async (_prompt: string, options?: { localId?: string | null; userMessageSeq?: number | null }) => {
        await steerSettled;
        acceptedPromptCallback?.({
          localIds: typeof options?.localId === 'string' ? [options.localId] : null,
          userMessageSeq: options?.userMessageSeq ?? null,
          providerTurnId: 'turn-app-server-mode-steer',
        });
      }),
      sendPrompt: vi.fn(async () => {}),
      setOnPromptAcceptedByProvider: vi.fn((callback) => {
        acceptedPromptCallback = callback;
      }),
      flushTurn: vi.fn(async () => {}),
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' }, threadId: 'thread-app-server-mode-steer' })),
    };
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => appServerRuntime);

    let handoffSettledBeforeSteer = false;
    sessionInputConsumerWaitForNextInputImpl = async (opts) => {
      if (!lastOnUserMessageHandler) {
        throw new Error('missing-onUserMessage-handler');
      }
      const handoff = lastOnUserMessageHandler({
        content: { text: 'steer after mode change' },
        meta: { permissionMode: 'read-only' },
        localId: 'local-user-message-mode-change',
      }, { seq: 92, pendingProviderAction: 'steer' });
      let handoffSettled = false;
      const observedHandoff = Promise.resolve(handoff).then(() => {
        handoffSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      handoffSettledBeforeSteer = handoffSettled;
      observedQueuedMessageCount = opts.messageQueue.size();
      releaseSteer();
      await observedHandoff;
      throw new Error('wait-called');
    };

    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    const outcome = await runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(createCodexAppServerRuntimeSpy).toHaveBeenCalledTimes(1);
    expect(handoffSettledBeforeSteer).toBe(false);
    expect(observedQueuedMessageCount).toBe(0);
	    expect(appServerRuntime.steerPrompt).toHaveBeenCalledWith('steer after mode change', {
	      metadata: { permissionMode: 'read-only' },
	      localId: 'local-user-message-mode-change',
	      userMessageSeq: 92,
	    });
	    expect(applyPermissionModeToCodexPermissionHandler).toHaveBeenCalledWith(expect.objectContaining({
	      permissionMode: 'read-only',
	    }));
	    expect(observeProviderInputOutcome).toHaveBeenCalledWith({
      kind: 'accepted',
      localId: 'local-user-message-mode-change',
      providerTurnId: 'turn-app-server-mode-steer',
    });
    expect(appServerRuntime.sendPrompt).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toEqual(expect.objectContaining({ message: 'wait-called' }));
    }
  });

  it('blocks an exact in-flight steer reported undeliverable without replaying it locally', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    initializeBackendRunSessionSpy.mockImplementationOnce(async (opts: any) => {
      const run = await initializeDefaultBackendRunSession(opts);
      let metadata: any = {
        codexSessionId: 'thread-app-server',
        codexBackendMode: 'appServer',
        replaySeedV1: {
          v: 1,
          seedText: 'STEER REPLAY SEED',
          sourceSessionId: 'parent-session',
          sourceCutoffSeqInclusive: 42,
          createdAtMs: 123,
        },
      };
      Object.assign(run.session, {
        getMetadataSnapshot: vi.fn(() => metadata),
        updateMetadata: vi.fn(async (updater: (current: any) => any) => {
          metadata = updater(metadata);
        }),
      });
      return run;
    });

    let acceptedPromptCallback: ((input: Readonly<{
      localIds?: readonly string[] | null;
      userMessageSeq: number | null;
      providerTurnId: string;
    }>) => void) | null = null;
    let undeliverableCallback:
      ((prompts: ReadonlyArray<Readonly<{ localIds?: readonly string[] | null; text: string; userMessageSeq: number | null }>>) => void)
      | null = null;
    const steerPrompt = vi.fn(async (_prompt: string, options?: {
      localId?: string | null;
      localIds?: readonly string[] | null;
      userMessageSeq?: number | null;
    }) => {
      const localIds = options?.localIds ?? (typeof options?.localId === 'string' ? [options.localId] : null);
      const userMessageSeq = options?.userMessageSeq ?? null;
      undeliverableCallback?.([{ localIds, text: 'not-used-for-replay', userMessageSeq }]);
    });
    const appServerRuntime = {
      getSessionId: () => 'thread-app-server',
      supportsInFlightSteer: () => true,
      isTurnInFlight: () => true,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt,
      sendPrompt: vi.fn(async () => {}),
      setOnPromptAcceptedByProvider: vi.fn((callback) => {
        acceptedPromptCallback = callback;
      }),
      setOnUndeliverablePrompts: vi.fn((callback) => {
        undeliverableCallback = callback;
      }),
      flushTurn: vi.fn(async () => {}),
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' }, threadId: 'thread-app-server' })),
    };
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => appServerRuntime);

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async (opts) => {
      waitCallCount += 1;
      if (waitCallCount > 1) return null;
      if (waitCallCount === 1) {
        if (!lastOnUserMessageHandler) {
          throw new Error('missing-onUserMessage-handler');
        }
        lastSessionClient!.blockPendingMessageDelivery.mockResolvedValueOnce(true);
        await lastOnUserMessageHandler({
          content: { text: 'steer after replay seed' },
          meta: { source: 'steer-undeliverable-test' },
          localId: 'local-steer-undeliverable',
        }, { seq: null, providerAcceptancePending: true, pendingProviderAction: 'steer' });
      }
      expect(opts.messageQueue.size()).toBe(0);
      return null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    if (!outcome.ok) {
      throw outcome.error;
    }

    expect(steerPrompt).toHaveBeenCalledTimes(1);
    expect(steerPrompt).toHaveBeenNthCalledWith(1, 'STEER REPLAY SEED\n\nsteer after replay seed', {
      localId: 'local-steer-undeliverable',
      metadata: { source: 'steer-undeliverable-test' },
      userMessageSeq: null,
    });
    expect(appServerRuntime.sendPrompt).not.toHaveBeenCalled();
    expect(lastSessionClient?.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['local-steer-undeliverable'],
      reason: 'provider_rejected_before_acceptance',
    });
  });

  it('admits a normal group-bound resume to the remote input boundary without a generation transition', async () => {
    mockAttachedSessionMetadata({
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            profileId: 'primary',
            groupId: 'team',
          },
        },
      },
    });
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const appServerRuntime = {
      getSessionId: () => 'thread-app-server',
      supportsInFlightSteer: () => true,
      isTurnInFlight: () => false,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt: vi.fn(async () => {}),
      flushTurn: vi.fn(async () => {}),
      rollbackConversation: vi.fn(async () => ({
        ok: true as const,
        target: { type: 'latest_turn' },
        threadId: 'thread-app-server',
      })),
    };
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => appServerRuntime);

    sessionInputConsumerWaitForNextInputImpl = async (opts) => {
      await opts.reconcilePendingQueueState({ force: true });
      throw new Error('stop-after-reconcile');
    };

    const { runCodex } = await import('./runCodex');
    const outcomePromise = runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));
    const outcome = await outcomePromise;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toEqual(expect.objectContaining({ message: 'stop-after-reconcile' }));
    }
    expect(lastSessionClient?.reconcilePendingQueueState).toHaveBeenCalledWith({ force: true });

    const consumerOptions = createSessionProviderInputConsumerSpy.mock.calls.at(-1)?.[0];
    expect(consumerOptions).not.toHaveProperty('initialProviderInputAdmissions');
    const actualConsumerModule = await vi.importActual<
      typeof import('@/agent/runtime/sessionInput/SessionProviderInputConsumer')
    >('@/agent/runtime/sessionInput/SessionProviderInputConsumer');
    const actualConsumer = actualConsumerModule.createSessionProviderInputConsumer(consumerOptions);
    consumerOptions.messageQueue.push('normally admitted Codex prompt', {
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    });
    const admissionAbort = new AbortController();
    await expect(actualConsumer.waitForNextInput({ abortSignal: admissionAbort.signal })).resolves.toEqual(expect.objectContaining({
      message: 'normally admitted Codex prompt',
    }));
  });

  it('drains pending rows through the input consumer after app-server turns', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const appServerRuntime = {
      getSessionId: () => 'thread-app-server',
      supportsInFlightSteer: () => true,
      isTurnInFlight: () => false,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt: vi.fn(async () => {}),
      flushTurn: vi.fn(async () => {}),
      rollbackConversation: vi.fn(async () => ({
        ok: true as const,
        target: { type: 'latest_turn' },
        threadId: 'thread-app-server',
      })),
    };
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => appServerRuntime);

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async () => {
      waitCallCount += 1;
      if (waitCallCount === 1) {
        if (!lastSessionClient) throw new Error('missing-session-client');
        lastSessionClient.popPendingMessage.mockImplementation(async () => {
          throw new Error('direct popPendingMessage called');
        });
        return {
          message: 'first prompt',
          mode: {
            permissionMode: 'default',
            permissionModeUpdatedAt: 1,
          },
          isolate: false,
          hash: 'hash-1',
        };
      }
      return null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    if (!outcome.ok) {
      throw outcome.error;
    }
    expect(appServerRuntime.sendPrompt).toHaveBeenCalledWith('first prompt', {
      appliedModelId: null,
      metadata: undefined,
      userMessageSeq: null,
    });
    const runtimeParams = createCodexAppServerRuntimeSpy.mock.calls[0]?.[0] as
      | { pendingQueue?: Record<string, unknown> }
      | undefined;
    expect(runtimeParams?.pendingQueue?.drainPending).toBeTypeOf('function');
    expect(runtimeParams?.pendingQueue).not.toHaveProperty('popPendingMessage');
    const consumerOptions = createSessionProviderInputConsumerSpy.mock.calls.at(-1)?.[0] as
      | { resolveActiveTurnSteerability?: () => unknown; session?: Record<string, any> }
      | undefined;
    expect(consumerOptions?.resolveActiveTurnSteerability?.()).toBe('steerable');
    expect(consumerOptions?.session).not.toHaveProperty('popPendingMessage');
    expect(consumerOptions?.session?.readRuntimeActivitySnapshotTail?.()).toEqual(
      lastSessionClient?.readRuntimeActivitySnapshotTail(),
    );
    await expect(consumerOptions?.session?.waitForRuntimeActivitySnapshotTailChange?.(4))
      .resolves.toBe(false);
    expect(lastSessionClient?.waitForRuntimeActivitySnapshotTailChange).toHaveBeenCalledWith(4);
    await (runtimeParams?.pendingQueue?.drainPending as ((opts?: unknown) => Promise<unknown>))?.({ reason: 'test-shared-consumer' });
    await expect(consumerOptions?.session?.materializeNextPendingMessageSafely?.({
      reconcileWhenEmpty: 'force',
    })).resolves.toEqual({ type: 'no_pending' });
    expect(lastSessionClient?.materializeNextPendingMessageSafely).toHaveBeenCalledWith({ reconcileWhenEmpty: 'force' });
    expect(inputConsumerDrainPendingSpy).toHaveBeenCalled();
    expect(lastSessionClient?.popPendingMessage).not.toHaveBeenCalled();

    if (!lastSessionClient) throw new Error('missing-session-client');
    delete lastSessionClient.materializeNextPendingMessageSafely;
    await expect(consumerOptions?.session?.materializeNextPendingMessageSafely?.()).resolves.toEqual({
      type: 'retryable_transport',
    });
    expect(lastSessionClient.popPendingMessage).not.toHaveBeenCalled();
  });

  it('resumes and accepts an exact pending row from predecessor metadata', async () => {
    // cli-v0.2.1 and cli-v0.2.2-preview.1775586717.26498 metadata carry the binding but
    // predate connected-service materialization identity.
    mockAttachedSessionMetadata({
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            profileId: 'primary',
            groupId: 'team',
          },
        },
      },
    });
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    let acceptedPromptCallback: ((input: Readonly<{
      localIds?: readonly string[] | null;
      userMessageSeq: number | null;
      providerTurnId: string;
    }>) => void) | null = null;
    const appServerRuntime = {
      getSessionId: () => 'thread-app-server',
      supportsInFlightSteer: () => true,
      isTurnInFlight: () => false,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt: vi.fn(async (_prompt: string, options?: { localId?: string | null; localIds?: readonly string[] | null; userMessageSeq?: number | null }) => {
        acceptedPromptCallback?.({
          localIds: options?.localIds ?? (typeof options?.localId === 'string' ? [options.localId] : null),
          userMessageSeq: options?.userMessageSeq ?? null,
          providerTurnId: 'turn-provider-owned-pending',
        });
      }),
      setOnPromptAcceptedByProvider: vi.fn((callback) => {
        acceptedPromptCallback = callback;
      }),
      flushTurn: vi.fn(async () => {}),
      rollbackConversation: vi.fn(async () => ({
        ok: true as const,
        target: { type: 'latest_turn' },
        threadId: 'thread-app-server',
      })),
    };
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => appServerRuntime);

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async () => {
      waitCallCount += 1;
      if (waitCallCount === 1) {
        return {
          message: 'provider-owned pending prompt',
          mode: {
            permissionMode: 'default',
            permissionModeUpdatedAt: 1,
            localId: 'pending-local-provider-claim',
          },
          isolate: false,
          hash: 'hash-provider-owned-pending',
          maxUserMessageSeq: null,
          userMessageLocalIds: ['pending-local-provider-claim'],
        };
      }
      return null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      resume: 'thread-app-server',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    if (!outcome.ok) {
      throw outcome.error;
    }
    expect(appServerRuntime.sendPrompt).toHaveBeenCalledWith('provider-owned pending prompt', {
      appliedModelId: null,
      metadata: undefined,
      localId: 'pending-local-provider-claim',
      userMessageSeq: null,
    });
    expect(providerInputOutcomeObserverMock).toHaveBeenCalledWith({
      kind: 'accepted',
      localId: 'pending-local-provider-claim',
      providerTurnId: 'turn-provider-owned-pending',
    });
  });

  it('marks directly requeued stale app-server steer messages as already echoed', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const appServerRuntime = {
      getSessionId: () => 'thread-app-server',
      supportsInFlightSteer: () => true,
      isTurnInFlight: () => true,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt: vi.fn(async () => {}),
      flushTurn: vi.fn(async () => {}),
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' }, threadId: 'thread-app-server' })),
    };
    appServerRuntime.steerPrompt.mockRejectedValue(Object.assign(new Error('no active turn to steer'), {
      method: 'turn/steer',
      code: -32000,
    }));
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => appServerRuntime);

    let observedSuppressUserEcho: boolean | undefined;
    sessionInputConsumerWaitForNextInputImpl = async (opts) => {
      if (!lastOnUserMessageHandler) {
        throw new Error('missing-onUserMessage-handler');
      }
      lastOnUserMessageHandler({
        content: { text: 'recover directly from stale steer' },
        meta: {},
        localId: 'local-direct-stale-steer',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const batch = await opts.messageQueue.waitForMessagesAndGetAsString();
      observedSuppressUserEcho = batch?.mode?.suppressUserEcho;
      throw new Error('stop-after-direct-requeue');
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(appServerRuntime.steerPrompt).toHaveBeenCalledWith('recover directly from stale steer', {
      metadata: {},
      localId: 'local-direct-stale-steer',
      userMessageSeq: null,
    });
    expect(observedSuppressUserEcho).toBe(true);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toEqual(expect.objectContaining({ message: 'stop-after-direct-requeue' }));
    }
  });

  it('does not requeue an app-server steer after an ambiguous transport failure', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const appServerRuntime = {
      getSessionId: () => 'thread-app-server',
      supportsInFlightSteer: () => true,
      isTurnInFlight: () => true,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {
        throw Object.assign(new Error('temporary steer transport failure'), {
          method: 'turn/steer',
          code: 'ECONNRESET',
        });
      }),
      sendPrompt: vi.fn(async () => {}),
      flushTurn: vi.fn(async () => {}),
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' }, threadId: 'thread-app-server' })),
    };
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => appServerRuntime);

    let observedQueuedMessageCount: number | null = null;
    sessionInputConsumerWaitForNextInputImpl = async (opts) => {
      if (!lastOnUserMessageHandler) {
        throw new Error('missing-onUserMessage-handler');
      }
      lastSessionClient!.blockPendingMessageDelivery.mockResolvedValueOnce(true);
      lastOnUserMessageHandler({
        content: { text: 'possibly accepted direct steer' },
        meta: {},
        localId: 'local-direct-ambiguous-steer',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      observedQueuedMessageCount = opts.messageQueue.size();
      throw new Error('stop-after-ambiguous-direct-steer');
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(appServerRuntime.steerPrompt).toHaveBeenCalledTimes(1);
    expect(lastSessionClient?.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['local-direct-ambiguous-steer'],
      reason: 'ambiguous_terminal_delivery',
    });
    expect(observedQueuedMessageCount).toBe(0);
    expect(outcome).toEqual({
      ok: false,
      error: expect.objectContaining({ message: 'stop-after-ambiguous-direct-steer' }),
    });
  });

  it('blocks exact pending custody when stale steer reports no active turn', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    mockAttachedSessionMetadata({ codexSessionId: 'thread-stale-steer', codexBackendMode: 'appServer' });

    let turnInFlight = true;
    const staleSteerError = Object.assign(new Error('no active turn to steer'), {
      method: 'turn/steer',
      code: -32000,
    });
    const sendPrompt = vi.fn(async () => {
      turnInFlight = false;
    });
    const appServerRuntime = {
      getSessionId: () => 'thread-stale-steer',
      supportsInFlightSteer: () => true,
      isTurnInFlight: () => turnInFlight,
      beginTurn: vi.fn(() => {
        turnInFlight = true;
      }),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {
        turnInFlight = true;
      }),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {
        throw staleSteerError;
      }),
      sendPrompt,
      compactContext: vi.fn(async () => {}),
      flushTurn: vi.fn(async () => {
        turnInFlight = false;
      }),
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' }, threadId: 'thread-stale-steer' })),
    };
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => appServerRuntime);

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async () => {
      waitCallCount += 1;
      if (waitCallCount === 1) {
        return {
          message: 'recover from stale steer',
          mode: {
            permissionMode: 'default',
            permissionModeUpdatedAt: 1,
            localId: 'local-stale-steer',
          },
          isolate: false,
          hash: 'hash-stale-steer',
        };
      }
      return null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      existingSessionId: 'existing-123',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(outcome).toMatchObject({ ok: true });
    expect(appServerRuntime.steerPrompt).toHaveBeenCalledWith(expect.any(String), {
      metadata: undefined,
      localId: 'local-stale-steer',
      userMessageSeq: null,
    });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(lastSessionClient?.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['local-stale-steer'],
      reason: 'steering_unavailable',
      providerEffect: 'none',
    });
    const emittedMessages = (lastSessionClient?.sendSessionEvent as ReturnType<typeof vi.fn> | undefined)?.mock.calls
      .map((call) => call[0]?.message)
      .filter((message): message is string => typeof message === 'string') ?? [];
    expect(emittedMessages.some((message) => /no active turn to steer/i.test(message))).toBe(false);
  });

  it('passes queued app-server message metadata through to sendPrompt', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const structuredInputMetadata = {
      happierStructuredInputV1: {
        skillMentions: [{ name: 'debugger', path: '/skills/debugger/SKILL.md' }],
      },
    };
    const sendPrompt = vi.fn(async () => undefined);
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => ({
      getSessionId: () => 'thread-app-server',
      supportsInFlightSteer: () => false,
      isTurnInFlight: () => false,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt,
      compactContext: vi.fn(async () => {}),
      flushTurn: vi.fn(async () => {}),
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' }, threadId: 'thread-app-server' })),
    }));

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async () => {
      waitCallCount += 1;
      if (waitCallCount === 1) {
        return {
          message: 'use the debugger skill',
          mode: {
            permissionMode: 'default',
            permissionModeUpdatedAt: 1,
            promptMetadata: structuredInputMetadata,
          },
          isolate: false,
          hash: 'hash-structured-input',
        };
      }
      return null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'remote',
      existingSessionId: 'existing-queued-steer',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    if (!outcome.ok) {
      throw outcome.error;
    }

    expect(sendPrompt).toHaveBeenCalledWith(expect.any(String), {
      appliedModelId: null,
      metadata: structuredInputMetadata,
      userMessageSeq: null,
    });
  });

  it('passes user-message seq from session.onUserMessage through the app-server prompt options', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const sendPrompt = vi.fn(async () => undefined);
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => ({
      getSessionId: () => 'thread-app-server',
      supportsInFlightSteer: () => false,
      isTurnInFlight: () => false,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt,
      setOnPromptAcceptedByProvider: vi.fn(),
      setOnUndeliverablePrompts: vi.fn(),
      compactContext: vi.fn(async () => {}),
      flushTurn: vi.fn(async () => {}),
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' }, threadId: 'thread-app-server' })),
    }));

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async (opts) => {
      waitCallCount += 1;
      if (waitCallCount > 2) return null;
      if (waitCallCount === 1) {
        if (!lastOnUserMessageHandler) {
          throw new Error('missing-onUserMessage-handler');
        }
        lastOnUserMessageHandler({
          content: { text: 'queued from transcript' },
          meta: { source: 'test' },
          localId: 'local-user-message-seq',
        }, { seq: 77 });
        return await opts.messageQueue.waitForMessagesAndGetAsString();
      }
      return null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    if (!outcome.ok) {
      throw outcome.error;
    }

    expect(sendPrompt).toHaveBeenCalledWith(expect.any(String), {
      appliedModelId: null,
      metadata: { source: 'test' },
      localId: 'local-user-message-seq',
      userMessageSeq: 77,
    });
  });

  it('settles exact app-server acceptance only through its typed outcome producer', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    let acceptedCallback:
      ((input: Readonly<{
        localIds?: readonly string[] | null;
        userMessageSeq: number | null;
        providerTurnId: string;
      }>) => void)
      | null = null;
    const sendPrompt = vi.fn(async (_prompt: string, options?: {
      localId?: string | null;
      localIds?: readonly string[] | null;
      userMessageSeq?: number | null;
    }) => {
      acceptedCallback?.({
        localIds: options?.localIds ?? (typeof options?.localId === 'string' ? [options.localId] : null),
        userMessageSeq: options?.userMessageSeq ?? null,
        providerTurnId: 'turn-exact-accepted',
      });
    });
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => ({
      getSessionId: () => 'thread-app-server',
      supportsInFlightSteer: () => false,
      isTurnInFlight: () => false,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt,
      setOnPromptAcceptedByProvider: vi.fn((callback) => {
        acceptedCallback = callback;
      }),
      setOnUndeliverablePrompts: vi.fn(),
      compactContext: vi.fn(async () => {}),
      flushTurn: vi.fn(async () => {}),
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' }, threadId: 'thread-app-server' })),
    }));

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async (opts) => {
      waitCallCount += 1;
      if (waitCallCount > 2) return null;
      if (waitCallCount === 1) {
        if (!lastOnUserMessageHandler) {
          throw new Error('missing-onUserMessage-handler');
        }
        lastOnUserMessageHandler({
          content: { text: 'accepted prompt' },
          meta: { source: 'acceptance-test' },
          localId: 'local-accepted',
        }, { seq: 78 });
        return await opts.messageQueue.waitForMessagesAndGetAsString();
      }
      return null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    if (!outcome.ok) {
      throw outcome.error;
    }

    expect(sendPrompt).toHaveBeenCalledOnce();
    expect(sendPrompt).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      localId: 'local-accepted',
      userMessageSeq: 78,
    }));
    expect(providerInputOutcomeObserverMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'accepted',
      localId: 'local-accepted',
      providerTurnId: 'turn-exact-accepted',
    }));
  });

  it('rebinds the exact app-server provider-outcome producer after session swaps', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    let capturedOnSessionSwap: ((session: Record<string, any>) => void | Promise<void>) | null = null;
    let swappedSession: Record<string, any> | null = null;
    initializeBackendRunSessionSpy.mockImplementationOnce(async (opts: any) => {
      const initialized = await initializeDefaultBackendRunSession(opts);
      capturedOnSessionSwap = opts.onSessionSwap;
      swappedSession = opts.api.sessionSyncClient({ id: 'sess_2', metadataVersion: 1 }) as Record<string, any>;
      Object.assign(swappedSession, {
        fetchLatestUserPermissionIntentFromTranscript: vi.fn(async () => null),
        getLastObservedMessageSeq: vi.fn(() => 0),
        bindProviderInputOutcomeProducer: vi.fn(() => providerInputOutcomeObserverMock),
        blockPendingMessageDelivery: vi.fn(async () => false),
        beginTurnAssistantTextSnapshot: vi.fn(() => ({ id: 'turn-token' })),
        sendCodexMessage: vi.fn(),
        sendAgentMessage: vi.fn(),
      });
      return initialized;
    });

    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => ({
      ...createDefaultCodexAppServerRuntimeMock(),
      getSessionId: () => 'thread-app-server',
      startOrLoad: vi.fn(async () => {}),
    }));

    let didSwap = false;
    sessionInputConsumerWaitForNextInputImpl = async () => {
      if (didSwap) return null;
      didSwap = true;
      if (!capturedOnSessionSwap || !swappedSession) {
        throw new Error('missing-session-swap');
      }
      await capturedOnSessionSwap(swappedSession);
      return null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    if (!outcome.ok) {
      throw outcome.error;
    }

    const observedSwappedSession = swappedSession as unknown as {
      bindProviderInputOutcomeProducer: ReturnType<typeof vi.fn>;
    };
    expect(observedSwappedSession.bindProviderInputOutcomeProducer).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'codex',
      mode: 'appServer',
      matchesCurrentSession: expect.any(Function),
    }));
  });

  it('blocks exact app-server prompts reported undeliverable without local replay', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    let acceptedCallback: ((input: Readonly<{ localIds?: readonly string[] | null; userMessageSeq: number | null }>) => void) | null = null;
    let undeliverableCallback:
      ((prompts: ReadonlyArray<Readonly<{ localIds?: readonly string[] | null; text: string; userMessageSeq: number | null }>>) => void)
      | null = null;
    const sendPrompt = vi.fn(async (_prompt: string, options?: { localId?: string | null; localIds?: readonly string[] | null; userMessageSeq?: number | null }) => {
      const userMessageSeq = options?.userMessageSeq ?? null;
      undeliverableCallback?.([{ localIds: resolvePromptLocalIds(options), text: 'not-used-for-replay', userMessageSeq }]);
    });
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => ({
      getSessionId: () => 'thread-app-server',
      supportsInFlightSteer: () => false,
      isTurnInFlight: () => false,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt,
      setOnPromptAcceptedByProvider: vi.fn((callback) => {
        acceptedCallback = callback;
      }),
      setOnUndeliverablePrompts: vi.fn((callback) => {
        undeliverableCallback = callback;
      }),
      compactContext: vi.fn(async () => {}),
      flushTurn: vi.fn(async () => {}),
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' }, threadId: 'thread-app-server' })),
    }));

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async (opts) => {
      waitCallCount += 1;
      if (waitCallCount > 1) return null;
      if (waitCallCount === 1) {
        if (!lastOnUserMessageHandler) {
          throw new Error('missing-onUserMessage-handler');
        }
        lastSessionClient!.blockPendingMessageDelivery.mockResolvedValueOnce(true);
        await lastOnUserMessageHandler({
          content: { text: 'requeue me' },
          meta: { source: 'undeliverable-test' },
          localId: 'local-undeliverable',
        }, { seq: 88, providerAcceptancePending: true, pendingProviderAction: 'send' });
      }
      const queued = await opts.messageQueue.waitForMessagesAndGetAsString();
      return queued ?? null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    if (!outcome.ok) {
      throw outcome.error;
    }

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenNthCalledWith(1, expect.any(String), expect.objectContaining({ userMessageSeq: 88 }));
    expect(lastSessionClient?.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['local-undeliverable'],
      reason: 'provider_rejected_before_acceptance',
    });
  });

  it('does not leave a duplicate app-server queue batch after runtime-internal retry accepts the prompt', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    let acceptedCallback:
      ((input: Readonly<{
        localIds?: readonly string[] | null;
        userMessageSeq: number | null;
        providerTurnId: string;
      }>) => void)
      | null = null;
    let undeliverableCallback:
      ((prompts: ReadonlyArray<Readonly<{ localIds?: readonly string[] | null; text: string; userMessageSeq: number | null }>>) => void)
      | null = null;
    const sendPrompt = vi.fn(async (_prompt: string, options?: {
      localId?: string | null;
      localIds?: readonly string[] | null;
      userMessageSeq?: number | null;
    }) => {
      const localIds = resolvePromptLocalIds(options);
      const userMessageSeq = options?.userMessageSeq ?? null;
      acceptedCallback?.({
        localIds,
        userMessageSeq,
        providerTurnId: 'turn-auth-invalidation-retry',
      });
    });
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => ({
      getSessionId: () => 'thread-app-server',
      supportsInFlightSteer: () => false,
      isTurnInFlight: () => false,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt,
      setOnPromptAcceptedByProvider: vi.fn((callback) => {
        acceptedCallback = callback;
      }),
      setOnUndeliverablePrompts: vi.fn((callback) => {
        undeliverableCallback = callback;
      }),
      compactContext: vi.fn(async () => {}),
      flushTurn: vi.fn(async () => {}),
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' }, threadId: 'thread-app-server' })),
    }));

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async (opts) => {
      waitCallCount += 1;
      if (waitCallCount > 2) return null;
      if (waitCallCount === 1) {
        if (!lastOnUserMessageHandler) {
          throw new Error('missing-onUserMessage-handler');
        }
        lastOnUserMessageHandler({
          content: { text: 'internally retried prompt' },
          meta: { source: 'auth-invalidation-internal-retry-test' },
          localId: 'local-auth-invalidation-retry',
        }, { seq: 90 });
      }
      if (waitCallCount === 2 && opts.messageQueue.size() === 0) {
        return null;
      }
      const queued = await opts.messageQueue.waitForMessagesAndGetAsString();
      return queued ?? null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    if (!outcome.ok) {
      throw outcome.error;
    }

    expect(sendPrompt).toHaveBeenCalledOnce();
    expect(providerInputOutcomeObserverMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'accepted',
      localId: 'local-auth-invalidation-retry',
    }));
  });

  it('blocks server-owned app-server prompts reported undeliverable before provider acceptance', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    let undeliverableCallback:
      ((prompts: ReadonlyArray<Readonly<{ localIds?: readonly string[] | null; text: string; userMessageSeq: number | null }>>) => void)
      | null = null;
    const sendPrompt = vi.fn(async (_prompt: string, options?: {
      localId?: string | null;
      localIds?: readonly string[] | null;
      userMessageSeq?: number | null;
    }) => {
      undeliverableCallback?.([{
        localIds: resolvePromptLocalIds(options),
        text: 'not-used-for-pending-block',
        userMessageSeq: options?.userMessageSeq ?? null,
      }]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => ({
      getSessionId: () => 'thread-app-server',
      supportsInFlightSteer: () => false,
      isTurnInFlight: () => false,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt,
      setOnPromptAcceptedByProvider: vi.fn(),
      setOnUndeliverablePrompts: vi.fn((callback) => {
        undeliverableCallback = callback;
      }),
      compactContext: vi.fn(async () => {}),
      flushTurn: vi.fn(async () => {}),
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' }, threadId: 'thread-app-server' })),
    }));

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async (opts) => {
      waitCallCount += 1;
      if (waitCallCount > 1) return null;
      if (waitCallCount === 1) {
        lastSessionClient!.blockPendingMessageDelivery.mockResolvedValueOnce(true);
        if (!lastOnUserMessageHandler) {
          throw new Error('missing-onUserMessage-handler');
        }
        lastOnUserMessageHandler({
          content: { text: 'server-owned pending prompt' },
          meta: { source: 'server-owned-undeliverable-test' },
          localId: 'local-server-owned-undeliverable',
        }, { seq: null });
      }
      const queued = await opts.messageQueue.waitForMessagesAndGetAsString();
      return queued ?? null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    if (!outcome.ok) {
      throw outcome.error;
    }

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(lastSessionClient?.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['local-server-owned-undeliverable'],
      reason: 'provider_rejected_before_acceptance',
    });
  });

  it('blocks server-owned app-server prompts when startup fails before provider send', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const sendPrompt = vi.fn(async () => {});
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => ({
      getSessionId: () => null,
      supportsInFlightSteer: () => false,
      isTurnInFlight: () => false,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {
        throw new Error('codex cli unavailable');
      }),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt,
      setOnPromptAcceptedByProvider: vi.fn(),
      setOnUndeliverablePrompts: vi.fn(),
      compactContext: vi.fn(async () => {}),
      flushTurn: vi.fn(async () => {}),
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' }, threadId: 'thread-app-server' })),
    }));

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async (opts) => {
      waitCallCount += 1;
      if (waitCallCount > 1) return null;
      lastSessionClient!.blockPendingMessageDelivery.mockResolvedValueOnce(true);
      if (!lastOnUserMessageHandler) {
        throw new Error('missing-onUserMessage-handler');
      }
      lastOnUserMessageHandler({
        content: { text: 'startup failure prompt' },
        meta: { source: 'startup-failure-test' },
        localId: 'local-startup-failure',
      }, { seq: null });
      const queued = await opts.messageQueue.waitForMessagesAndGetAsString();
      return queued ?? null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    if (!outcome.ok) {
      throw outcome.error;
    }

    expect(sendPrompt).not.toHaveBeenCalled();
    expect(lastSessionClient?.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['local-startup-failure'],
      reason: 'runtime_disposed_before_delivery',
    });
  });

  it('retains server-owned app-server custody when prompt submission fails after invocation', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    const sendPrompt = vi.fn(async () => {
      throw new Error('provider response lost after prompt invocation');
    });
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => ({
      getSessionId: () => 'thread-app-server',
      supportsInFlightSteer: () => false,
      isTurnInFlight: () => false,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt,
      setOnPromptAcceptedByProvider: vi.fn(),
      setOnUndeliverablePrompts: vi.fn(),
      compactContext: vi.fn(async () => {}),
      flushTurn: vi.fn(async () => {}),
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' }, threadId: 'thread-app-server' })),
    }));

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async (opts) => {
      waitCallCount += 1;
      if (waitCallCount > 1) return null;
      lastSessionClient!.blockPendingMessageDelivery.mockResolvedValueOnce(true);
      if (!lastOnUserMessageHandler) {
        throw new Error('missing-onUserMessage-handler');
      }
      lastOnUserMessageHandler({
        content: { text: 'possibly submitted prompt' },
        meta: { source: 'post-invocation-failure-test' },
        localId: 'local-post-invocation-failure',
      }, { seq: null });
      const queued = await opts.messageQueue.waitForMessagesAndGetAsString();
      return queued ?? null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    if (!outcome.ok) {
      throw outcome.error;
    }

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(lastSessionClient?.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['local-post-invocation-failure'],
      reason: 'ambiguous_terminal_delivery',
    });
  });

  it('blocks the exact resolved provider prompt after replay seed consumption without local replay', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    initializeBackendRunSessionSpy.mockImplementationOnce(async (opts: any) => {
      const run = await initializeDefaultBackendRunSession(opts);
      let metadata: any = {
        replaySeedV1: {
          v: 1,
          seedText: 'REPLAY SEED',
          sourceSessionId: 'parent-session',
          sourceCutoffSeqInclusive: 42,
          createdAtMs: 123,
        },
      };
      Object.assign(run.session, {
        getMetadataSnapshot: vi.fn(() => metadata),
        updateMetadata: vi.fn(async (updater: (current: any) => any) => {
          metadata = updater(metadata);
        }),
      });
      return run;
    });

    let acceptedCallback: ((input: Readonly<{ localIds?: readonly string[] | null; userMessageSeq: number | null }>) => void) | null = null;
    let undeliverableCallback:
      ((prompts: ReadonlyArray<Readonly<{ localIds?: readonly string[] | null; text: string; userMessageSeq: number | null }>>) => void)
      | null = null;
    const sendPrompt = vi.fn(async (_prompt: string, options?: { localId?: string | null; localIds?: readonly string[] | null; userMessageSeq?: number | null }) => {
      const userMessageSeq = options?.userMessageSeq ?? null;
      undeliverableCallback?.([{ localIds: resolvePromptLocalIds(options), text: 'not-used-for-replay', userMessageSeq }]);
    });
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => ({
      getSessionId: () => 'thread-app-server',
      supportsInFlightSteer: () => false,
      isTurnInFlight: () => false,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt,
      setOnPromptAcceptedByProvider: vi.fn((callback) => {
        acceptedCallback = callback;
      }),
      setOnUndeliverablePrompts: vi.fn((callback) => {
        undeliverableCallback = callback;
      }),
      compactContext: vi.fn(async () => {}),
      flushTurn: vi.fn(async () => {}),
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' }, threadId: 'thread-app-server' })),
    }));

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async (opts) => {
      waitCallCount += 1;
      if (waitCallCount > 1) return null;
      if (waitCallCount === 1) {
        if (!lastOnUserMessageHandler) {
          throw new Error('missing-onUserMessage-handler');
        }
        lastSessionClient!.blockPendingMessageDelivery.mockResolvedValueOnce(true);
        await lastOnUserMessageHandler({
          content: { text: 'continue after switch' },
          meta: { source: 'replay-seed-undeliverable-test' },
          localId: 'local-replay-seed-undeliverable',
        }, { seq: 89, providerAcceptancePending: true, pendingProviderAction: 'send' });
      }
      const queued = await opts.messageQueue.waitForMessagesAndGetAsString();
      return queued ?? null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    if (!outcome.ok) {
      throw outcome.error;
    }

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenNthCalledWith(1, 'REPLAY SEED\n\ncontinue after switch', expect.objectContaining({ userMessageSeq: 89 }));
    expect(lastSessionClient?.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['local-replay-seed-undeliverable'],
      reason: 'provider_rejected_before_acceptance',
    });
  });

  it('settles the Codex turn before surfacing connected-service recovery without duplicating the raw process error', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    const runtimeAuthClassification = {
      kind: 'auth_expired',
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: null,
      resetsAtMs: null,
      retryAfterMs: null,
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    };
    const providerError = Object.assign(new Error('unexpected status 401 Unauthorized: token_invalidated bearer secret-test-token'), {
      runtimeAuthClassification,
    });
    const appServerRuntime = {
      getSessionId: () => 'thread-runtime-auth',
      supportsInFlightSteer: () => false,
      isTurnInFlight: () => false,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {}),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt: vi.fn(async () => {
        throw providerError;
      }),
      compactContext: vi.fn(async () => {}),
      flushTurn: vi.fn(async () => {}),
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' }, threadId: 'thread-runtime-auth' })),
    };
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => appServerRuntime);
    notifyDaemonConnectedServiceRuntimeAuthFailureSpy.mockImplementationOnce(async () => {
      expect(appServerRuntime.flushTurn).toHaveBeenCalledOnce();
      return {
        ok: true,
        result: {
          status: 'credential_refreshed',
          restartRequested: true,
        },
      };
    });

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async () => {
      waitCallCount += 1;
      if (waitCallCount === 1) {
        return {
          message: 'continue after auth recovery',
          mode: {
            permissionMode: 'default',
            permissionModeUpdatedAt: 1,
          },
          isolate: false,
          hash: 'hash-runtime-auth',
        };
      }
      return null;
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(outcome).toMatchObject({ ok: true });
    expect(notifyDaemonConnectedServiceRuntimeAuthFailureSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess_1',
        switchesThisTurn: 0,
        classification: runtimeAuthClassification,
      }),
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
    const emittedMessages = (lastSessionClient?.sendSessionEvent as ReturnType<typeof vi.fn> | undefined)?.mock.calls
      .map((call) => call[0]?.message)
      .filter((message): message is string => typeof message === 'string') ?? [];
    expect(emittedMessages.some((message) => message.includes('credential refreshed'))).toBe(true);
    expect(emittedMessages.some((message) => message.startsWith('Codex process error:'))).toBe(false);
    const { logger } = await import('@/ui/logger');
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.some((call) => call.includes(providerError))).toBe(false);
    expect(warnCalls.some((call) => call.some((value) => value instanceof Error && value.message.includes('secret-test-token')))).toBe(false);
  });

  it('admits a connected-service initial-goal resume without a generation transition and starts it once', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    process.env[HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY] = serializeDaemonInitialGoalForEnv({
      objective: 'continue the goal',
    });
    mockAttachedSessionMetadata({
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            profileId: 'primary',
            groupId: 'team',
          },
        },
      },
    });
    let turnInFlight = false;
    const startOrLoad = vi.fn(async () => {
      turnInFlight = true;
    });
    const appServerRuntime = {
      getSessionId: () => 'thread-goal-resume',
      supportsInFlightSteer: () => true,
      isTurnInFlight: () => turnInFlight,
      beginTurn: vi.fn(),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad,
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt: vi.fn(async () => {
        throw new Error('sendPrompt-called');
      }),
      compactContext: vi.fn(async () => {}),
      flushTurn: vi.fn(async () => {
        turnInFlight = false;
      }),
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' }, threadId: 'thread-goal-resume' })),
    };
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => appServerRuntime);

    sessionInputConsumerWaitForNextInputImpl = async () => {
      throw new Error('wait-called');
    };

    const { runCodex } = await import('./runCodex');
    const outcomePromise = runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'daemon',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
      resume: 'thread-goal-resume',
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    const outcome = await outcomePromise;

    expect(startOrLoad).toHaveBeenCalledTimes(1);
    expect(startOrLoad).toHaveBeenCalledWith(expect.objectContaining({
      resumeId: 'thread-goal-resume',
      importHistory: false,
      initialGoal: { objective: 'continue the goal' },
    }));
    expect(appServerRuntime.sendPrompt).not.toHaveBeenCalled();
    expect(appServerRuntime.flushTurn).not.toHaveBeenCalled();
    expect(turnInFlight).toBe(true);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toEqual(expect.objectContaining({ message: 'wait-called' }));
    }
  });

  it('flushes app-server preflight state when startOrLoad fails before a native turn exists', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    let turnInFlight = false;
    let providerTurnActive = false;
    const appServerRuntime = {
      getSessionId: () => null,
      supportsInFlightSteer: () => true,
      isTurnInFlight: () => turnInFlight,
      hasActiveProviderTurn: () => providerTurnActive,
      beginTurn: vi.fn(() => {
        turnInFlight = true;
      }),
      cancel: vi.fn(async () => {}),
      reset: vi.fn(async () => {}),
      startOrLoad: vi.fn(async () => {
        throw new Error('appServer-startOrLoad-called');
      }),
      setSessionMode: vi.fn(async () => {}),
      setSessionModel: vi.fn(async () => {}),
      setSessionConfigOption: vi.fn(async () => {}),
      steerPrompt: vi.fn(async () => {}),
      sendPrompt: vi.fn(async () => {
        providerTurnActive = true;
      }),
      compactContext: vi.fn(async () => {}),
      flushTurn: vi.fn(async () => {
        turnInFlight = false;
        providerTurnActive = false;
      }),
      rollbackConversation: vi.fn(async () => ({ ok: true as const, target: { type: 'latest_turn' }, threadId: 'thread_1' })),
    };
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => appServerRuntime);

    let waitCallCount = 0;
    sessionInputConsumerWaitForNextInputImpl = async () => {
      waitCallCount += 1;
      if (waitCallCount === 1) {
        return {
          message: 'start codex',
          mode: {
            permissionMode: 'read-only',
            permissionModeUpdatedAt: 1,
          },
          isolate: false,
          hash: 'hash-preflight-failure',
        };
      }
      throw new Error('wait-called');
    };

    const { runCodex } = await import('./runCodex');
    const outcome = await runCodex({
      credentials: { token: 'test' } as Credentials,
      startedBy: 'terminal',
      startingMode: 'remote',
      codexBackendMode: 'appServer',
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 1,
    } as any)
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(appServerRuntime.beginTurn).toHaveBeenCalled();
    expect(appServerRuntime.startOrLoad).toHaveBeenCalled();
    expect(appServerRuntime.flushTurn).toHaveBeenCalled();
    expect(turnInFlight).toBe(false);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toEqual(expect.objectContaining({ message: 'wait-called' }));
    }
  });
});
