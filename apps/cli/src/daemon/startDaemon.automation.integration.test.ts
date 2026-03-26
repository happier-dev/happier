import { afterEach, describe, expect, it, vi } from 'vitest';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';
type BuildHappyCliSubprocessLaunchSpec = typeof import('@/utils/spawnHappyCLI').buildHappyCliSubprocessLaunchSpec;

const harness = vi.hoisted(() => {
  let resolveShutdown: ((value: { source: ShutdownSource; errorMessage?: string }) => void) | null = null;
  let requestShutdownRef: ((source: ShutdownSource, errorMessage?: string) => void) | null = null;
  let machineConnectionStateListener: ((state: any) => void) | null = null;
  let autoShutdownAfterAutomationStart = true;

  const automationWorkerStop = vi.fn();
  const automationWorkerRefreshAssignments = vi.fn(async () => {});
  const automationWorkerPause = vi.fn();
  const automationWorkerResume = vi.fn();
  const startAutomationWorker = vi.fn(() => {
    if (autoShutdownAfterAutomationStart && requestShutdownRef) {
      setTimeout(() => requestShutdownRef?.('happier-cli'), 0);
    }
    return {
      stop: automationWorkerStop,
      refreshAssignments: automationWorkerRefreshAssignments,
      pause: automationWorkerPause,
      resume: automationWorkerResume,
      handleServerUpdate: vi.fn(),
    };
  });

  const connectedServiceQuotasPause = vi.fn();
  const connectedServiceQuotasResume = vi.fn();
  const connectedServiceQuotasStop = vi.fn();
  const startConnectedServiceQuotasLoop = vi.fn(() => ({
    stop: connectedServiceQuotasStop,
    pause: connectedServiceQuotasPause,
    resume: connectedServiceQuotasResume,
  }));

  const apiMachine = {
    setRPCHandlers: vi.fn(),
    onUpdate: vi.fn(),
    onConnectionStateChange: vi.fn((listener: (state: any) => void) => {
      machineConnectionStateListener = listener;
      return () => {
        if (machineConnectionStateListener === listener) {
          machineConnectionStateListener = null;
        }
      };
    }),
    connect: vi.fn((params?: { onConnect?: () => void | Promise<void> }) => {
      // Simulate a reconnect so we can assert automation assignment refresh isn't
      // blocked after the one-time metadata refresh.
      void params?.onConnect?.();
      void params?.onConnect?.();
    }),
    updateMachineMetadata: vi.fn(async () => {}),
    updateDaemonState: vi.fn(async () => {}),
    shutdown: vi.fn(),
  };

  const lockHandle = { release: vi.fn(async () => {}) };

  const createDaemonShutdownController = vi.fn(() => {
    const resolvesWhenShutdownRequested = new Promise<{ source: ShutdownSource; errorMessage?: string }>((resolve) => {
      resolveShutdown = resolve;
    });
    const requestShutdown = (source: ShutdownSource, errorMessage?: string) => {
      resolveShutdown?.({ source, errorMessage });
    };
    requestShutdownRef = requestShutdown;
    return {
      requestShutdown,
      resolvesWhenShutdownRequested,
    };
  });

  return {
    startAutomationWorker,
    automationWorkerStop,
    automationWorkerRefreshAssignments,
    automationWorkerPause,
    automationWorkerResume,
    apiMachine,
    lockHandle,
    startConnectedServiceQuotasLoop,
    connectedServiceQuotasPause,
    connectedServiceQuotasResume,
    connectedServiceQuotasStop,
    createDaemonShutdownController,
    emitMachineConnectionState: (state: any) => machineConnectionStateListener?.(state),
    setAutoShutdownAfterAutomationStart: (value: boolean) => {
      autoShutdownAfterAutomationStart = value;
    },
    requestShutdown: (source: ShutdownSource) => requestShutdownRef?.(source),
  };
});

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: vi.fn(async () => ({
      machineSyncClient: () => harness.apiMachine,
    })),
  },
  isMachineContentPublicKeyMismatchError: vi.fn(() => false),
}));

vi.mock('@/api/machine/ensureMachineRegistered', () => ({
  ensureMachineRegistered: vi.fn(async ({ machineId }: { machineId: string }) => ({
    machineId,
    machine: {
      id: machineId,
      metadata: {},
    },
  })),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    logFilePath: '/tmp/happier-daemon.log',
  },
}));

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: vi.fn(async () => ({
    credentials: { token: 'token-automation', encryption: { publicKey: 'a', machineKey: 'b' } },
    machineId: 'machine-automation',
  })),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    privateKeyFile: '/tmp/key',
    happyHomeDir: '/tmp/home',
    currentCliVersion: '0.0.0-test',
    daemonSpawnExistingSessionWaitForExitMs: 5_000,
    daemonSpawnExistingSessionWaitForExitPollIntervalMs: 50,
  },
}));

vi.mock('@/integrations/caffeinate', () => ({
  startCaffeinate: vi.fn(() => false),
  stopCaffeinate: vi.fn(async () => {}),
}));

vi.mock('@/ui/doctor', () => ({
  getEnvironmentInfo: vi.fn(() => ({})),
}));

vi.mock('@/utils/spawnHappyCLI', () => ({
  buildHappyCliSubprocessInvocation: vi.fn(),
  buildHappyCliSubprocessLaunchSpec: vi.fn<BuildHappyCliSubprocessLaunchSpec>(),
  spawnHappyCLI: vi.fn(),
}));

vi.mock('@/backends/catalog', () => ({
  AGENTS: {},
  getVendorResumeSupport: vi.fn(async () => () => true),
  resolveAgentCliSubcommand: vi.fn(),
  resolveCatalogAgentId: vi.fn(() => 'codex'),
}));

vi.mock('@/persistence', () => ({
  writeDaemonState: vi.fn(),
  acquireDaemonLock: vi.fn(async () => harness.lockHandle),
  releaseDaemonLock: vi.fn(async () => {}),
  readCredentials: vi.fn(async () => null),
}));

vi.mock('./controlClient', () => ({
  cleanupDaemonState: vi.fn(async () => {}),
  isDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(async () => false),
  stopDaemon: vi.fn(async () => {}),
}));

vi.mock('./controlServer', () => ({
  startDaemonControlServer: vi.fn(async () => ({
    port: 43210,
    stop: vi.fn(async () => {}),
  })),
}));

vi.mock('./sessions/reattachFromMarkers', () => ({
  reattachTrackedSessionsFromMarkers: vi.fn(async () => {}),
}));

vi.mock('./sessions/onHappySessionWebhook', () => ({
  createOnHappySessionWebhook: vi.fn(() => vi.fn()),
}));

vi.mock('./sessions/onChildExited', () => ({
  createOnChildExited: vi.fn(() => vi.fn()),
}));

vi.mock('./sessions/visibleConsoleSpawnWaiter', () => ({
  waitForVisibleConsoleSessionWebhook: vi.fn(async () => null),
}));

vi.mock('./sessions/stopSession', () => ({
  createStopSession: vi.fn(() => vi.fn(async () => ({ stopped: true }))),
}));

vi.mock('./sessions/resolveSpawnWebhookResult', () => ({
  resolveSpawnWebhookResult: vi.fn(({ result }) => result),
}));

vi.mock('./lifecycle/heartbeat', () => ({
  startDaemonHeartbeatLoop: vi.fn(() => setInterval(() => {}, 60_000)),
}));

vi.mock('@/projectPath', () => ({
  projectPath: vi.fn(() => '/tmp/project'),
}));

vi.mock('@/integrations/tmux', () => ({
  selectPreferredTmuxSessionName: vi.fn(),
  TmuxUtilities: {},
  isTmuxAvailable: vi.fn(() => false),
}));

vi.mock('@/terminal/runtime/terminalConfig', () => ({
  resolveTerminalRequestFromSpawnOptions: vi.fn(() => null),
}));

vi.mock('@/terminal/runtime/envVarSanitization', () => ({
  validateEnvVarRecordStrict: vi.fn(() => ({ ok: true, env: {} })),
}));

vi.mock('./machine/metadata', () => ({
  getPreferredHostName: vi.fn(async () => 'host.local'),
  initialMachineMetadata: {},
}));

vi.mock('./lifecycle/shutdown', () => ({
  createDaemonShutdownController: harness.createDaemonShutdownController,
}));

vi.mock('./platform/tmux/spawnConfig', () => ({
  buildTmuxSpawnConfig: vi.fn(),
  buildTmuxWindowEnv: vi.fn(),
}));

vi.mock('./platform/windows/windowsSessionConsoleMode', () => ({
  resolveWindowsRemoteSessionConsoleMode: vi.fn(),
}));

vi.mock('./platform/windows/spawnHappyCliVisibleConsole', () => ({
  startHappySessionInVisibleWindowsConsole: vi.fn(),
}));

vi.mock('./sessionSpawnArgs', () => ({
  buildHappySessionControlArgs: vi.fn(() => []),
}));

vi.mock('./startup/waitForAuthConfig', () => ({
  resolveWaitForAuthConfig: vi.fn(() => ({
    waitForAuthEnabled: false,
    waitForAuthTimeoutMs: 0,
  })),
}));

vi.mock('./startup/ensureSessionDirectory', () => ({
  ensureSessionDirectory: vi.fn(async () => ({ ok: true, directoryCreated: false })),
}));

vi.mock('./startup/waitForInitialCredentials', () => ({
  waitForInitialCredentials: vi.fn(async () => ({
    action: 'continue',
    daemonLockHandle: harness.lockHandle,
  })),
}));

vi.mock('./spawn/waitForSessionWebhook', () => ({
  waitForSessionWebhook: vi.fn(async () => null),
}));

vi.mock('./spawn/resolveSpawnChildEnvironment', () => ({
  resolveSpawnChildEnvironment: vi.fn(async () => ({
    env: {},
  })),
}));

vi.mock('./automation/automationWorker', () => ({
  startAutomationWorker: harness.startAutomationWorker,
}));

vi.mock('./connectedServices/quotas/ConnectedServiceQuotasCoordinator', () => ({
  ConnectedServiceQuotasCoordinator: vi.fn(),
}));

vi.mock('./connectedServices/quotas/createConnectedServiceQuotaFetchers', () => ({
  createConnectedServiceQuotaFetchers: vi.fn(() => []),
}));

vi.mock('./connectedServices/quotas/resolveConnectedServiceQuotasDaemonOptions', () => ({
  resolveConnectedServiceQuotasDaemonOptions: vi.fn(() => ({
    fetchTimeoutMs: 1_000,
    discoveryEnabled: false,
    discoveryIntervalMs: 60_000,
    failureBackoffMinMs: 1_000,
    failureBackoffMaxMs: 60_000,
    failureBackoffJitterPct: 0,
  })),
}));

vi.mock('./connectedServices/quotas/resolveConnectedServicesQuotasDaemonEnabled', () => ({
  resolveConnectedServicesQuotasDaemonEnabled: vi.fn(async () => true),
}));

vi.mock('./connectedServices/quotas/startConnectedServiceQuotasLoop', () => ({
  startConnectedServiceQuotasLoop: harness.startConnectedServiceQuotasLoop,
}));

vi.mock('./shutdownPolicy', () => ({
  getDaemonShutdownExitCode: vi.fn(() => 0),
  getDaemonShutdownWatchdogTimeoutMs: vi.fn(() => 10_000),
}));

describe('startDaemon automation wiring (integration)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    harness.setAutoShutdownAfterAutomationStart(true);
  });

  it('checks same-version daemon compatibility after auth resolves the current machine id', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const { authAndSetupMachineIfNeeded } = await import('@/ui/auth');
      const { isDaemonRunningCurrentlyInstalledHappyVersion } = await import('./controlClient');
      (isDaemonRunningCurrentlyInstalledHappyVersion as unknown as { mockResolvedValueOnce: (value: unknown) => void }).mockResolvedValueOnce(true);

      const { startDaemon } = await import('./startDaemon');
      await startDaemon();

      expect(authAndSetupMachineIfNeeded).toHaveBeenCalledTimes(1);
      expect(isDaemonRunningCurrentlyInstalledHappyVersion).toHaveBeenCalledWith({
        expectedMachineId: 'machine-automation',
      });
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('restarts a same-version daemon when machine registration rotates the machine id before startup', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const { ensureMachineRegistered } = await import('@/api/machine/ensureMachineRegistered');
      const ensureMachineRegisteredMock = ensureMachineRegistered as unknown as {
        mockImplementation: (impl: (params: { machineId: string }) => unknown) => void;
      };
      ensureMachineRegisteredMock.mockImplementation(async ({ machineId }: { machineId: string }) => {
        const resolvedMachineId = machineId === 'machine-automation' ? 'machine-rotated' : machineId;
        return {
          machineId: resolvedMachineId,
          didRotateMachineId: resolvedMachineId !== machineId,
          machine: {
            id: resolvedMachineId,
            metadata: {},
          },
        };
      });

      const { isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } = await import('./controlClient');
      (isDaemonRunningCurrentlyInstalledHappyVersion as unknown as {
        mockImplementation: (impl: (params?: { expectedMachineId?: string | null }) => boolean) => void;
      }).mockImplementation((params?: { expectedMachineId?: string | null }) => (
        params?.expectedMachineId === 'machine-automation'
      ));

      const { writeDaemonState } = await import('@/persistence');
      const { startDaemon } = await import('./startDaemon');
      await startDaemon();

      expect(stopDaemon).toHaveBeenCalledTimes(1);
      expect(writeDaemonState).toHaveBeenCalledWith(expect.objectContaining({
        machineId: 'machine-rotated',
      }));
      expect(harness.startAutomationWorker).toHaveBeenCalledTimes(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('retries machine registration after a transient failure', async () => {
    vi.useRealTimers();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const retryDelayOriginal = process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS;
    process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS = '0';

    try {
      const { ensureMachineRegistered } = await import('@/api/machine/ensureMachineRegistered');
      (ensureMachineRegistered as unknown as { mockRejectedValueOnce: (value: unknown) => void }).mockRejectedValueOnce(
        new Error('transient machine registration failure'),
      );

      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      // Allow the bootstrap retry loop (0ms delay) to tick.
      const ensureMachineRegisteredMock = ensureMachineRegistered as unknown as { mock: { calls: unknown[][] } };
      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (ensureMachineRegisteredMock.mock.calls.length >= 2) break;
      }

      expect(ensureMachineRegistered).toHaveBeenCalledTimes(2);
      expect(harness.apiMachine.connect).toHaveBeenCalledTimes(1);
      expect(harness.startAutomationWorker).toHaveBeenCalledTimes(1);

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (retryDelayOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS;
      } else {
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS = retryDelayOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('writes daemon state even when machine registration fails', async () => {
    vi.useRealTimers();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const { ensureMachineRegistered } = await import('@/api/machine/ensureMachineRegistered');
      (ensureMachineRegistered as unknown as { mockRejectedValue: (value: unknown) => void }).mockRejectedValue(
        new Error('machine registration failure'),
      );

      const { writeDaemonState } = await import('@/persistence');
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(writeDaemonState).toHaveBeenCalledTimes(1);

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('starts automation worker after machine sync bootstrap and stops it on shutdown', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const { startDaemon } = await import('./startDaemon');
      await startDaemon();

      expect(harness.startAutomationWorker).toHaveBeenCalledTimes(1);
      expect(harness.startAutomationWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'token-automation',
          machineId: 'machine-automation',
        }),
      );
      expect(harness.apiMachine.setRPCHandlers).toHaveBeenCalledTimes(1);
      expect(harness.apiMachine.connect).toHaveBeenCalledTimes(1);
      expect(harness.apiMachine.updateMachineMetadata).toHaveBeenCalledTimes(1);
      expect(harness.automationWorkerRefreshAssignments).toHaveBeenCalledTimes(2);
      expect(harness.automationWorkerStop).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('does not leak bearer tokens when machine registration fails', async () => {
    vi.useRealTimers();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const leakedBearer = 'Bearer super-secret-token';

      const { ensureMachineRegistered } = await import('@/api/machine/ensureMachineRegistered');
      (ensureMachineRegistered as unknown as { mockRejectedValueOnce: (value: unknown) => void }).mockRejectedValueOnce({
        isAxiosError: true,
        name: 'AxiosError',
        message: 'Request failed with status code 401',
        response: { status: 401 },
        config: {
          method: 'post',
          url: 'http://127.0.0.1:3009/v1/machines',
          headers: { Authorization: leakedBearer },
        },
      });

      const { logger } = await import('@/ui/logger');
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));
      harness.requestShutdown('happier-cli');
      await run;

      const warnMock = (logger as any).warn as any;
      const debugMock = (logger as any).debug as any;
      const serialized = JSON.stringify([...warnMock.mock.calls, ...debugMock.mock.calls]);
      expect(serialized).not.toContain(leakedBearer);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('pauses daemon background loops until machine connectivity is online and resumes them afterwards', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(harness.apiMachine.onConnectionStateChange).toHaveBeenCalledTimes(1);

      harness.emitMachineConnectionState({
        phase: 'idle',
        reason: null,
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastErrorMessage: null,
      });

      expect(harness.automationWorkerPause).toHaveBeenCalledTimes(1);

      harness.emitMachineConnectionState({
        phase: 'online',
        reason: 'initial_connect',
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: null,
        lastErrorMessage: null,
      });

      expect(harness.automationWorkerResume).toHaveBeenCalledTimes(1);

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });
});
