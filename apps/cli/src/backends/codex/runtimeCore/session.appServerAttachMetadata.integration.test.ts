import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_CONFIG_OPTIONS_STATE_KEY,
  SESSION_MODELS_STATE_KEY,
  SESSION_MODES_STATE_KEY,
} from '@happier-dev/agents';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';

import type { Credentials } from '@/persistence';

const modelSyncFlushPendingAfterStartSpy = vi.fn(async () => {});
const sessionModeSyncFlushPendingAfterStartSpy = vi.fn(async () => {});
const configOptionSyncFlushPendingAfterStartSpy = vi.fn(async () => {});
const createRuntimeOverrideSynchronizersSpy = vi.fn((..._args: any[]) => ({
  syncFromMetadata: vi.fn(),
  flushPendingAfterStart: async () => {
    await sessionModeSyncFlushPendingAfterStartSpy();
    await configOptionSyncFlushPendingAfterStartSpy();
    await modelSyncFlushPendingAfterStartSpy();
  },
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
  flushTurn: vi.fn(),
  beginTurnLifecycle: vi.fn(),
  startOrLoadSession: vi.fn((opts?: { resumeId?: string | null; importHistory?: boolean }) =>
    Promise.reject(new Error('startOrLoad-called'))),
  sendTurnPrompt: vi.fn(async (_prompt: string) => {}),
  steerInFlightTurn: vi.fn(async (_prompt: string) => {}),
  waitForTurnCompletion: vi.fn(async () => {}),
  subscribeRuntimeMessages: vi.fn(() => () => undefined),
  respondToPermission: vi.fn(async () => undefined),
  cancelTurn: vi.fn(async () => {}),
  readSessionIdentity: vi.fn(() => ({ sessionId: null })),
  updateSessionRuntimeConfig: vi.fn(async () => {}),
  resetOrDisposeRuntime: vi.fn(async () => {}),
  rollbackConversation: vi.fn(async () => ({ ok: false, errorCode: 'unsupported_action', errorMessage: 'unsupported' })),
}));
vi.mock('../acp/runtime', () => ({
  createCodexAcpRuntime: (...args: any[]) => createCodexAcpRuntimeSpy(...args),
}));

function createFakeCodexAppServerRuntime(overrides: Record<string, unknown> = {}) {
  const startOrLoad = vi.fn(async (_options: { resumeId?: string; importHistory?: boolean; existingSessionId?: string } = {}) => {
    throw new Error('appServer-startOrLoad-called');
  });
  const setSessionMode = vi.fn(async (_modeId: string) => {});
  const setSessionModel = vi.fn(async (_modelId: string) => {});
  const setSessionConfigOption = vi.fn(async (_configId: string, _value: string | number | boolean | null) => {});
  const steerPrompt = vi.fn(async (_prompt: string) => {});
  const sendPrompt = vi.fn(async (_prompt: string) => {});
  const flushTurn = vi.fn();
  const cancel = vi.fn(async () => {});
  const reset = vi.fn(async () => {});
  const baseRuntime = {
    getSessionId: () => null,
    supportsInFlightSteer: () => false,
    isTurnInFlight: () => false,
    beginTurn: vi.fn(),
    cancel,
    reset,
    startOrLoad,
    setSessionMode,
    setSessionModel,
    setSessionConfigOption,
    steerPrompt,
    sendPrompt,
    flushTurn,
    rollbackConversation: vi.fn(async () => ({ ok: true, target: { type: 'latest_turn' }, threadId: 'thread_1' })),
  };
  const effectiveRuntime = { ...baseRuntime, ...overrides };
  const runtime = {
    ...effectiveRuntime,
    beginTurnLifecycle: () => {
      effectiveRuntime.beginTurn();
    },
    startOrLoadSession: async (options?: { resumeId?: string | null; importHistory?: boolean }) => {
      await effectiveRuntime.startOrLoad({
        ...(typeof options?.resumeId === 'string' ? { resumeId: options.resumeId } : {}),
        ...(typeof options?.importHistory === 'boolean' ? { importHistory: options.importHistory } : {}),
      });
    },
    sendTurnPrompt: async (prompt: string) => {
      await effectiveRuntime.sendPrompt(prompt);
    },
    steerInFlightTurn: async (prompt: string) => {
      await effectiveRuntime.steerPrompt(prompt);
    },
    waitForTurnCompletion: async () => {
      await effectiveRuntime.flushTurn();
    },
    subscribeRuntimeMessages: () => () => undefined,
    respondToPermission: async () => undefined,
    cancelTurn: async () => {
      await effectiveRuntime.cancel();
    },
    readSessionIdentity: () => ({
      sessionId: effectiveRuntime.getSessionId(),
    }),
    updateSessionRuntimeConfig: async (update: {
      modeId?: string | null;
      modelId?: string | null;
      configOption?: { id: string; value: string | number | boolean | null } | null;
    }) => {
      if (typeof update.modeId === 'string') {
        await effectiveRuntime.setSessionMode(update.modeId);
      }
      if (typeof update.modelId === 'string') {
        await effectiveRuntime.setSessionModel(update.modelId);
      }
      if (update.configOption) {
        await effectiveRuntime.setSessionConfigOption(update.configOption.id, update.configOption.value);
      }
    },
    resetOrDisposeRuntime: async () => {
      await effectiveRuntime.reset();
    },
  };
  return runtime;
}

const createCodexAppServerRuntimeSpy = vi.fn<(...args: any[]) => any>((..._args) => createFakeCodexAppServerRuntime());
vi.mock('../appServer/runtime', () => ({
  createCodexAppServerRuntime: (...args: any[]) => createCodexAppServerRuntimeSpy(...args),
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
  setupRuntimeMetadataDrivenOverridesSync: vi.fn(async () => ({
    runtimeControlSync: createRuntimeOverrideSynchronizersSpy(),
    syncOverridesFromMetadata: vi.fn(),
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

vi.mock('@/backends/codex/experiments', () => ({
  isExperimentalCodexAcpEnabled: vi.fn(() => true),
}));

vi.mock('../mcp/resolveCodexMcpServerSpawn', () => ({
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

vi.mock('../utils/createCodexPermissionHandler', () => ({
  createCodexPermissionHandler: vi.fn(() => ({
    reset: vi.fn(),
    updateSession: vi.fn(),
    handleToolCall: vi.fn(async () => ({ decision: 'approved' })),
  })),
}));

vi.mock('../utils/applyPermissionModeToHandler', () => ({
  applyPermissionModeToCodexPermissionHandler: vi.fn(),
}));

vi.mock('../utils/diffProcessor', () => ({
  DiffProcessor: vi.fn(() => ({
    reset: vi.fn(),
    flushTurn: vi.fn(),
  })),
}));

vi.mock('../terminalRuntime/supportResolver', () => ({
  createCodexTerminalRuntimeSupportResolver: vi.fn(() => async () => ({ ok: false as const, reason: 'test' })),
}));

const registerSessionRpcHandlerMock = vi.fn();
let lastSessionClient: Record<string, any> | null = null;
let lastOnUserMessageHandler: ((message: any) => void) | null = null;

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

describe('runCodex app-server attach metadata behavior', () => {
  beforeEach(async () => {
    probeCodexAcpLoadSessionSupportSpy.mockReset();
    resolveRunnerMcpServersSpy.mockReset();
    createCodexAcpRuntimeSpy.mockClear();
    createCodexAppServerRuntimeSpy.mockClear();
    waitForMessagesOrPendingSpy.mockClear();
    waitForMessagesOrPendingImpl = null;
    registerSessionRpcHandlerMock.mockReset();
    modelSyncFlushPendingAfterStartSpy.mockClear();
    sessionModeSyncFlushPendingAfterStartSpy.mockClear();
    configOptionSyncFlushPendingAfterStartSpy.mockClear();
    createRuntimeOverrideSynchronizersSpy.mockClear();
    lastSessionClient = null;
    lastOnUserMessageHandler = null;
    const experiments = await import('@/backends/codex/experiments');
    (experiments.isExperimentalCodexAcpEnabled as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const { createCodexTerminalRuntimeSupportResolver } = await import('../terminalRuntime/supportResolver');
    (createCodexTerminalRuntimeSupportResolver as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => async () => ({ ok: false as const, reason: 'test' }),
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
    waitForMessagesOrPendingImpl = async () => {
      throw new Error('wait-called');
    };

    const { runCodex } = await import('./session');

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
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) {
      expect(outcome.error).toEqual(expect.objectContaining({ message: 'wait-called' }));
    }
  });

});
