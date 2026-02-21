import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

const probeCodexAcpLoadSessionSupportSpy = vi.fn<(...args: any[]) => Promise<any>>(async (..._args) => {
  throw new Error('probe-called');
});
vi.mock('@/backends/codex/acp/probeLoadSessionSupport', () => ({
  probeCodexAcpLoadSessionSupport: (...args: any[]) => probeCodexAcpLoadSessionSupportSpy(...args),
}));

const createHappierMcpBridgeSpy = vi.fn<(...args: any[]) => Promise<any>>(async (..._args) => {
  throw new Error('bridge-called');
});
vi.mock('@/agent/runtime/createHappierMcpBridge', () => ({
  createHappierMcpBridge: (...args: any[]) => createHappierMcpBridgeSpy(...args),
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
}));
vi.mock('./acp/runtime', () => ({
  createCodexAcpRuntime: (...args: any[]) => createCodexAcpRuntimeSpy(...args),
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

vi.mock('@/agent/runtime/modelOverrideSync', () => ({
  createModelOverrideSynchronizer: vi.fn(() => ({
    syncFromMetadata: vi.fn(),
    flushPendingAfterStart: vi.fn(async () => {}),
  })),
}));

vi.mock('@/backends/codex/utils/metadataOverridesWatcher', () => ({
  runMetadataOverridesWatcherLoop: vi.fn(),
}));

vi.mock('@/agent/runtime/startup/startupOverridesCache', () => ({
  readStartupOverridesCacheForBackend: vi.fn(() => null),
  writeStartupOverridesCacheForBackend: vi.fn(() => {}),
}));

vi.mock('./runtime/createCodexRemoteTerminalUi', () => ({
  createCodexRemoteTerminalUi: vi.fn(() => ({
    mount: vi.fn(),
    unmount: vi.fn(async () => {}),
    setAllowSwitchToLocal: vi.fn(),
  })),
}));

vi.mock('@/ui/tty/resolveHasTTY', () => ({
  resolveHasTTY: vi.fn(() => false),
}));

vi.mock('@/backends/codex/experiments', () => ({
  isExperimentalCodexAcpEnabled: vi.fn(() => true),
  isExperimentalCodexVendorResumeEnabled: vi.fn(() => false),
}));

vi.mock('./utils/resolveCodexStartingMode', () => ({
  resolveCodexStartingMode: vi.fn(() => 'remote'),
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

vi.mock('./localControl/createLocalControlSupportResolver', () => ({
  createCodexLocalControlSupportResolver: vi.fn(() => async () => ({ ok: false as const, reason: 'test' })),
}));

vi.mock('@/agent/runtime/initializeBackendApiContext', () => ({
  initializeBackendApiContext: vi.fn(async () => ({
    api: {
      getOrCreateSession: vi.fn(async () => ({ id: 'sess_1', metadataVersion: 1 })),
      sessionSyncClient: vi.fn(() => ({
        sessionId: 'sess_1',
        rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn() },
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

describe('runCodex CodexACP resume behavior', () => {
  beforeEach(() => {
    probeCodexAcpLoadSessionSupportSpy.mockReset();
    createHappierMcpBridgeSpy.mockReset();
    createCodexAcpRuntimeSpy.mockClear();
    waitForMessagesOrPendingSpy.mockClear();
    waitForMessagesOrPendingImpl = null;
  });

  it('does not probe Codex ACP capabilities during startup for --resume sessions', async () => {
    probeCodexAcpLoadSessionSupportSpy.mockImplementationOnce(async () => {
      throw new Error('probe-called');
    });
    createHappierMcpBridgeSpy.mockImplementationOnce(async () => {
      throw new Error('bridge-called');
    });

    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;
    await expect(
      runCodex({
        credentials,
        startedBy: 'terminal',
        startingMode: 'remote',
        resume: 'resume-123',
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      } as any),
    ).rejects.toThrow(/bridge-called/);
  });

  it('fails closed for explicit --resume when Codex ACP loadSession fails', async () => {
    probeCodexAcpLoadSessionSupportSpy.mockImplementationOnce(async () => ({ ok: true, checkedAt: Date.now(), loadSession: true, agentCapabilities: { loadSession: true, sessionCapabilities: {}, promptCapabilities: { image: false, audio: false, embeddedContext: false }, mcpCapabilities: { http: false, sse: false } } } as any));
    createHappierMcpBridgeSpy.mockImplementationOnce(async () => ({
      happierMcpServer: { url: 'http://127.0.0.1:0', stop: vi.fn() },
      mcpServers: {},
    }));

    // Feed a single message so the runner attempts to start/load the ACP session.
    let delivered = false;
    waitForMessagesOrPendingImpl = async () => {
      if (delivered) return null;
      delivered = true;
      return {
        message: 'hello',
        mode: { permissionMode: 'default', permissionModeUpdatedAt: 1, localId: null, model: null },
        isolate: false,
        hash: 'hash',
      };
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
    expect(waitForMessagesOrPendingSpy).toHaveBeenCalled();
    const createdRuntime = createCodexAcpRuntimeSpy.mock.results[0]?.value as any;
    const startOrLoad = createdRuntime?.startOrLoad as ReturnType<typeof vi.fn> | undefined;
    expect(startOrLoad).toBeTruthy();
    expect(startOrLoad?.mock.calls.length).toBe(1);
    expect(startOrLoad?.mock.calls[0]?.[0]).toMatchObject({ resumeId: 'resume-123' });
    await expect(startOrLoad?.mock.results?.[0]?.value).rejects.toThrow(/startOrLoad-called/);

    expect(outcome.ok).toBe(false);
  });
});
