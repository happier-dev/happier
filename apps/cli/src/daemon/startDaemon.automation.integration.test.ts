import { afterEach, describe, expect, it, vi } from 'vitest';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';

const harness = vi.hoisted(() => {
  let resolveShutdown: ((value: { source: ShutdownSource; errorMessage?: string }) => void) | null = null;
  let requestShutdownRef: ((source: ShutdownSource, errorMessage?: string) => void) | null = null;

  const automationWorkerStop = vi.fn();
  const automationWorkerRefreshAssignments = vi.fn(async () => {});
  const startAutomationWorker = vi.fn(() => {
    if (requestShutdownRef) {
      setTimeout(() => requestShutdownRef?.('happier-cli'), 0);
    }
    return {
      stop: automationWorkerStop,
      refreshAssignments: automationWorkerRefreshAssignments,
    };
  });

  const apiMachine = {
    setRPCHandlers: vi.fn(),
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
    apiMachine,
    lockHandle,
    createDaemonShutdownController,
    requestShutdown: (source: ShutdownSource) => requestShutdownRef?.(source),
  };
});

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: vi.fn(async () => ({
      machineSyncClient: () => harness.apiMachine,
    })),
  },
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
  buildHappyCliSubprocessLaunchSpec: vi.fn(),
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

vi.mock('./shutdownPolicy', () => ({
  getDaemonShutdownExitCode: vi.fn(() => 0),
  getDaemonShutdownWatchdogTimeoutMs: vi.fn(() => 10_000),
}));

describe('startDaemon automation wiring (integration)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
