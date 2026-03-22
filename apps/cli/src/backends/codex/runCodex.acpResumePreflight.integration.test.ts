import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_CONFIG_OPTIONS_STATE_KEY,
  SESSION_MODELS_STATE_KEY,
  SESSION_MODES_STATE_KEY,
} from '@happier-dev/agents';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';

import type { Credentials } from '@/persistence';
import { createCodexPermissionHandler } from './utils/createCodexPermissionHandler';

const modelSyncFlushPendingAfterStartSpy = vi.fn(async () => {});
const sessionModeSyncFlushPendingAfterStartSpy = vi.fn(async () => {});
const configOptionSyncFlushPendingAfterStartSpy = vi.fn(async () => {});
let remoteModePublishGate: Promise<void> | null = null;
const remoteModePublishGateResolver: { current: (() => void) | null } = { current: null };
const registerRemoteSwitchHandlerSpy = vi.fn();

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
  flushTurn: vi.fn(),
  rollbackConversation: vi.fn(async () => ({ ok: false, errorCode: 'unsupported_action', errorMessage: 'unsupported' })),
}));
vi.mock('./acp/runtime', () => ({
  createCodexAcpRuntime: (...args: any[]) => createCodexAcpRuntimeSpy(...args),
}));

const createCodexAppServerRuntimeSpy = vi.fn<(...args: any[]) => any>((..._args) => ({
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
  flushTurn: vi.fn(),
  rollbackConversation: vi.fn(async () => ({ ok: true, target: { type: 'latest_turn' }, threadId: 'thread_1' })),
}));
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

let waitForMessagesOrPendingImpl: ((opts: any) => Promise<any>) | null = null;
const waitForMessagesOrPendingSpy = vi.fn<(...args: any[]) => Promise<any>>(async (opts: any) => {
  if (waitForMessagesOrPendingImpl) return await waitForMessagesOrPendingImpl(opts);
  return null;
});
vi.mock('@/agent/runtime/waitForMessagesOrPending', () => ({
  waitForMessagesOrPending: (...args: any[]) => waitForMessagesOrPendingSpy(...args),
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

vi.mock('@/agent/runtime/sessionConfigOptionOverrideSync', () => ({
  createSessionConfigOptionOverrideSynchronizer: vi.fn(() => ({
    syncFromMetadata: vi.fn(),
    flushPendingAfterStart: configOptionSyncFlushPendingAfterStartSpy,
  })),
  createAcpConfigOptionOverrideSynchronizer: vi.fn(() => ({
    syncFromMetadata: vi.fn(),
    flushPendingAfterStart: configOptionSyncFlushPendingAfterStartSpy,
  })),
}));

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
let lastOnUserMessageHandler: ((message: any) => void) | null = null;
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
        getMetadataSnapshot: vi.fn(() => ({})),
        onUserMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        updateMetadata: vi.fn(),
        updateAgentState: vi.fn(async () => {}),
        keepAlive: vi.fn(),
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        listPendingMessageQueueV2LocalIds: vi.fn(async () => []),
        discardPendingMessageQueueV2All: vi.fn(async () => {}),
        peekPendingMessageQueueV2Count: vi.fn(async () => 0),
        discardCommittedMessageLocalIds: vi.fn(async () => {}),
        popPendingMessage: vi.fn(async () => false),
        waitForMetadataUpdate: vi.fn(async () => false),
      })),
      push: vi.fn(() => ({ sendToAllDevices: vi.fn() })),
    },
    machineId: 'machine_1',
  })),
}));

const initializeBackendRunSessionSpy = vi.fn(async (opts: any) => {
  const session = opts.api.sessionSyncClient({ id: 'sess_1', metadataVersion: 1 });
  lastSessionClient = session as Record<string, any>;
  lastOnUserMessageHandler = null;
  session.onUserMessage = vi.fn((handler: (message: any) => void) => {
    lastOnUserMessageHandler = handler;
  });
  // Ensure optional methods exist for codepaths that may call them during startup.
  Object.assign(session, {
    fetchLatestUserPermissionIntentFromTranscript: vi.fn(async () => null),
    sendCodexMessage: vi.fn(),
    sendAgentMessage: vi.fn(),
  });
  return {
    session,
    reconnectionHandle: null,
    reportedSessionId: 'sess_1',
    attachedToExistingSession: false,
  };
});
vi.mock('@/agent/runtime/initializeBackendRunSession', () => ({
  initializeBackendRunSession: (opts: any) => initializeBackendRunSessionSpy(opts),
}));

function mockAttachedSessionMetadata(metadata: Record<string, unknown>): void {
  initializeBackendRunSessionSpy.mockImplementationOnce(async (opts: any) => {
    const session = opts.api.sessionSyncClient({ id: 'sess_1', metadataVersion: 1 });
    lastSessionClient = session as Record<string, any>;
    lastOnUserMessageHandler = null;
    session.onUserMessage = vi.fn((handler: (message: any) => void) => {
      lastOnUserMessageHandler = handler;
    });
    Object.assign(session, {
      fetchLatestUserPermissionIntentFromTranscript: vi.fn(async () => null),
      sendCodexMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      getMetadataSnapshot: vi.fn(() => ({ ...metadata })),
    });
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
    probeCodexAcpLoadSessionSupportSpy.mockReset();
    resolveRunnerMcpServersSpy.mockReset();
    createCodexAcpRuntimeSpy.mockClear();
    createCodexAppServerRuntimeSpy.mockClear();
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
    waitForMessagesOrPendingSpy.mockClear();
    waitForMessagesOrPendingImpl = null;
    codexLocalLauncherSpy.mockClear();
    codexLocalLauncherImpl = null;
    registerSessionRpcHandlerMock.mockReset();
    modelSyncFlushPendingAfterStartSpy.mockClear();
    sessionModeSyncFlushPendingAfterStartSpy.mockClear();
    configOptionSyncFlushPendingAfterStartSpy.mockClear();
    registerRemoteSwitchHandlerSpy.mockClear();
    remoteModePublishGate = null;
    lastSessionClient = null;
    lastOnUserMessageHandler = null;
    lastOnSwitchToLocal = null;
    const experiments = await import('@/backends/codex/experiments');
    (experiments.isExperimentalCodexAcpEnabled as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const { resolveCodexStartingMode } = await import('./utils/resolveCodexStartingMode');
    (resolveCodexStartingMode as unknown as ReturnType<typeof vi.fn>).mockReturnValue('remote');
    const { createCodexLocalControlSupportResolver } = await import('./localControl/createLocalControlSupportResolver');
    (createCodexLocalControlSupportResolver as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => async () => ({ ok: false as const, reason: 'test' }),
    );
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
    waitForMessagesOrPendingImpl = async () => {
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
    waitForMessagesOrPendingImpl = async () => {
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
    waitForMessagesOrPendingImpl = async () => {
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
    waitForMessagesOrPendingImpl = async () => {
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

    waitForMessagesOrPendingImpl = async () => {
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

    waitForMessagesOrPendingImpl = async () => {
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
        'mcp_servers.happier__happier.command="/tmp/happier-mcp-bridge"',
        'mcp_servers.happier__happier.args=["--url","http://127.0.0.1:0"]',
        'mcp_servers.happier__happier.enabled=true',
      ],
    }));
    const runtimeArgs = createCodexAppServerRuntimeSpy.mock.calls[0]?.[0] as {
      processEnv?: NodeJS.ProcessEnv;
      configOverrides?: string[];
    } | undefined;
    expect(runtimeArgs?.processEnv).toBe(process.env);
    expect(runtimeArgs?.configOverrides).toEqual([
      'mcp_servers.happier__happier.command="/tmp/happier-mcp-bridge"',
      'mcp_servers.happier__happier.args=["--url","http://127.0.0.1:0"]',
      'mcp_servers.happier__happier.enabled=true',
    ]);
    const createdRuntime = createCodexAppServerRuntimeSpy.mock.results[0]?.value as any;
    const startOrLoad = createdRuntime?.startOrLoad as ReturnType<typeof vi.fn> | undefined;
    expect(startOrLoad?.mock.calls[0]?.[0]).toMatchObject({ existingSessionId: 'vendor-thread-existing-123' });
    expect(outcome).toMatchObject({ ok: false });
    if (outcome.ok) throw new Error('expected runCodex to fail in test');
    const failedOutcome = outcome;
    await expect(failedOutcome.error).toEqual(expect.objectContaining({ message: expect.stringMatching(/appServer-startOrLoad-called/) }));
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
    waitForMessagesOrPendingImpl = async () => {
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
    waitForMessagesOrPendingImpl = async () => {
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

  it('passes the requested directory to the Codex app-server runtime', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));
    const { runCodex } = await import('./runCodex');
    waitForMessagesOrPendingImpl = async () => {
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
    waitForMessagesOrPendingImpl = async () => {
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
    waitForMessagesOrPendingImpl = async () => null;

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

    waitForMessagesOrPendingImpl = async () => {
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

    waitForMessagesOrPendingImpl = async () => null;

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

    waitForMessagesOrPendingImpl = async () => {
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

  it('queues mid-turn user messages for app-server sessions and publishes inFlightSteer=false', async () => {
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    let observedQueuedMessageText: string | null = null;
    let observedQueuedMessageCount = 0;
    const appServerRuntime = {
      getSessionId: () => 'thread-app-server',
      supportsInFlightSteer: () => false,
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
    createCodexAppServerRuntimeSpy.mockImplementationOnce(() => appServerRuntime);

    waitForMessagesOrPendingImpl = async (opts) => {
      if (!lastOnUserMessageHandler) {
        throw new Error('missing-onUserMessage-handler');
      }
      lastOnUserMessageHandler({
        content: { text: 'queue now' },
        meta: {},
        localId: 'local-user-message-1',
      });
      observedQueuedMessageCount = opts.messageQueue.size();
      const queued = await opts.messageQueue.waitForMessagesAndGetAsString(new AbortController().signal);
      observedQueuedMessageText = queued?.message ?? null;
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
    expect(lastOnUserMessageHandler).toBeTypeOf('function');
    expect(observedQueuedMessageCount).toBe(1);
    expect(observedQueuedMessageText).toBe('queue now');
    expect(appServerRuntime.steerPrompt).not.toHaveBeenCalled();
    expect(appServerRuntime.sendPrompt).not.toHaveBeenCalled();
    expect(lastSessionClient?.updateAgentState).toHaveBeenCalled();
    const updatedAgentState = (lastSessionClient?.updateAgentState as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.({});
    expect(updatedAgentState?.capabilities?.inFlightSteer).toBe(false);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toEqual(expect.objectContaining({ message: 'wait-called' }));
    }
  });
});
