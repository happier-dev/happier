import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

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

let codexLocalLauncherImpl: ((opts: any) => Promise<any>) | null = null;
const codexLocalLauncherSpy = vi.fn<(...args: any[]) => Promise<any>>(async (opts: any) => {
  if (codexLocalLauncherImpl) return await codexLocalLauncherImpl(opts);
  throw new Error('codexLocalLauncher-called');
});
vi.mock('./codexLocalLauncher', () => ({
  codexLocalLauncher: (opts: any) => codexLocalLauncherSpy(opts),
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
        listPendingMessageQueueV2LocalIds: vi.fn(async () => []),
        discardPendingMessageQueueV2All: vi.fn(async () => {}),
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
    resolveRunnerMcpServersSpy.mockReset();
    createCodexAcpRuntimeSpy.mockClear();
    waitForMessagesOrPendingSpy.mockClear();
    waitForMessagesOrPendingImpl = null;
    codexLocalLauncherSpy.mockClear();
    codexLocalLauncherImpl = null;
    lastOnSwitchToLocal = null;
  });

  it('does not probe Codex ACP capabilities during startup for --resume sessions', async () => {
    probeCodexAcpLoadSessionSupportSpy.mockImplementationOnce(async () => {
      throw new Error('probe-called');
    });
    resolveRunnerMcpServersSpy.mockImplementationOnce(async () => {
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
    }));

    // If we ever reach the message wait loop, return null so the runner can proceed.
    waitForMessagesOrPendingImpl = async () => null;

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
});
