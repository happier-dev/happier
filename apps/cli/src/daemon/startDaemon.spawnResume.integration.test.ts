import { afterEach, describe, expect, it, vi } from 'vitest';

import { HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY } from './platform/linux/daemonSpawnedSessionCgroupSelfMigration';
import { createHttpStatusError } from '@/api/client/httpStatusError';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { waitForSessionWebhook } from './spawn/waitForSessionWebhook';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';
type BuildHappyCliSubprocessLaunchSpec = typeof import('@/utils/spawnHappyCLI').buildHappyCliSubprocessLaunchSpec;

function createRegisteredMachine(machineId: string) {
  return {
    id: machineId,
    encryptionKey: new Uint8Array([1, 2, 3, 4]),
    encryptionVariant: 'legacy' as const,
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
  };
}

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');
const { spawnChildProcess } = vi.hoisted(() => ({
  spawnChildProcess: vi.fn(() => ({
    pid: 12345,
    stdout: null,
    stderr: null,
    on: vi.fn(),
    unref: vi.fn(),
  })),
}));

const spawnHappyCliCapture = vi.hoisted(() => ({
  children: [] as Array<{
    pid: number;
    stdout: null;
    stderr: null;
    on: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  }>,
}));

const harness = vi.hoisted(() => {
  let resolveShutdown: ((value: { source: ShutdownSource; errorMessage?: string }) => void) | null = null;
  let requestShutdownRef: ((source: ShutdownSource, errorMessage?: string) => void) | null = null;
  let spawnSessionRef: ((options: any) => Promise<any>) | null = null;
  let stopSessionRef: ((sessionId: string) => Promise<boolean>) | null = null;
  let beforeShutdownRef: (() => Promise<void>) | null = null;

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

  const apiMachine = {
    setRPCHandlers: vi.fn(),
    onUpdate: vi.fn(),
    onConnectionStateChange: vi.fn(() => () => {}),
    connect: vi.fn(),
    updateMachineMetadata: vi.fn(async () => {}),
    updateDaemonState: vi.fn(async () => {}),
    awaitPendingRpcRequests: vi.fn(async () => {}),
    shutdown: vi.fn(),
  };

  return {
    apiMachine,
    createDaemonShutdownController,
    requestShutdown: (source: ShutdownSource) => requestShutdownRef?.(source),
    setSpawnSession: (fn: (options: any) => Promise<any>) => {
      spawnSessionRef = fn;
    },
    getSpawnSession: () => spawnSessionRef,
    setStopSession: (fn: (sessionId: string) => Promise<boolean>) => {
      stopSessionRef = fn;
    },
    getStopSession: () => stopSessionRef,
    setBeforeShutdown: (fn: () => Promise<void>) => {
      beforeShutdownRef = fn;
    },
    getBeforeShutdown: () => beforeShutdownRef,
    resetControlRefs: () => {
      spawnSessionRef = null;
      stopSessionRef = null;
      beforeShutdownRef = null;
    },
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

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnChildProcess,
  };
});

vi.mock('@/api/machine/ensureMachineRegistered', () => ({
  ensureMachineRegistered: vi.fn(async ({ machineId }: { machineId: string }) => ({
    machineId,
    didRotateMachineId: false,
    machine: createRegisteredMachine(machineId),
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
    credentials: {
      token: 'token-daemon',
      encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(1), machineKey: new Uint8Array(32).fill(2) },
    },
    machineId: 'machine-1',
  })),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    privateKeyFile: '/tmp/key',
    happyHomeDir: '/tmp/happy-home',
    currentCliVersion: '0.0.0-test',
    serverUrl: 'http://localhost:9999',
    daemonSpawnExistingSessionWaitForExitMs: 5_000,
    daemonSpawnExistingSessionWaitForExitPollIntervalMs: 50,
    daemonStopSessionWaitForExitMs: 15_000,
    daemonStopSessionWaitForExitPollIntervalMs: 100,
  },
}));

vi.mock('@/integrations/caffeinate', () => ({
  startCaffeinate: vi.fn(() => false),
  stopCaffeinate: vi.fn(async () => {}),
}));

vi.mock('@/ui/doctor', () => ({
  getEnvironmentInfo: vi.fn(() => ({})),
}));

const spawnHappyCLI = vi.fn((argv: string[], _opts?: unknown) => {
  const child = {
    pid: 12345,
    stdout: null,
    stderr: null,
    on: vi.fn(),
    unref: vi.fn(),
  };
  spawnHappyCliCapture.children.push(child);
  return child;
});

const cgroupMigrationCapture = vi.hoisted(() => {
  const capture = {
    lastParams: null as null | { trackedSessions: Iterable<{ pid: number }> },
    migrateTrackedSessionProcessesOutOfDaemonServiceCgroup: vi.fn(async (params: { trackedSessions: Iterable<{ pid: number }> }) => {
      capture.lastParams = params;
      return [];
    }),
  };
  return capture;
});

const sessionRespawnManagerCapture = vi.hoisted(() => ({
  createSessionRunnerRespawnManager: vi.fn((params: { enabled: boolean }) => ({
    markStopRequested: vi.fn(),
    clearStopRequested: vi.fn(),
    handleUnexpectedExit: vi.fn(),
    __params: params,
  })),
}));

const buildCgroupSelfMigratingHappyCliLaunchSpec = vi.hoisted(() => vi.fn(async () => ({
  filePath: '/bin/sh',
  args: [
    '-lc',
    'target_dir="$HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR/happier-session-$$.scope" && mkdir -p "$target_dir" && printf "%s\\n" "$$" > "$target_dir/cgroup.procs" && exec "$@"',
    'sh',
    '/tmp/happier-runtime',
    'codex',
    '--happy-starting-mode',
    'remote',
    '--started-by',
    'daemon',
  ],
  env: {
    HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR: '/sys/fs/cgroup/user.slice/user-501.slice/user@501.service/app.slice',
  },
})));

vi.mock('@/utils/spawnHappyCLI', () => ({
  buildHappyCliSubprocessLaunchSpec: vi.fn<BuildHappyCliSubprocessLaunchSpec>(),
  spawnHappyCLI,
}));

vi.mock('./platform/linux/migrateTrackedSessionProcessesOutOfDaemonServiceCgroup', () => ({
  migrateTrackedSessionProcessesOutOfDaemonServiceCgroup: cgroupMigrationCapture.migrateTrackedSessionProcessesOutOfDaemonServiceCgroup,
}));

vi.mock('./platform/linux/buildCgroupSelfMigratingHappyCliLaunchSpec', () => ({
  buildCgroupSelfMigratingHappyCliLaunchSpec,
}));

vi.mock('./processSupervision/sessionRunnerRespawn', () => ({
  createSessionRunnerRespawnManager: sessionRespawnManagerCapture.createSessionRunnerRespawnManager,
}));

vi.mock('./platform/windows/windowsSessionConsoleMode', () => ({
  resolveWindowsRemoteSessionConsoleMode: vi.fn(() => 'hidden'),
}));

vi.mock('./platform/windows/spawnHappyCliVisibleConsole', () => ({
  startHappySessionInVisibleWindowsConsole: vi.fn(async () => ({ ok: true, pid: 7777 })),
}));

vi.mock('./platform/windows/spawnHappyCliWindowsTerminal', () => ({
  startHappySessionInWindowsTerminal: vi.fn(async () => ({ ok: true, pid: 8888 })),
}));

vi.mock('@/backends/catalog', () => ({
  AGENTS: {
    codex: {
      id: 'codex',
      cliSubcommand: 'codex',
      vendorResumeSupport: 'supported',
    },
  },
  requireCatalogEntry: vi.fn(() => ({
    id: 'codex',
    cliSubcommand: 'codex',
    vendorResumeSupport: 'supported',
  })),
  getVendorResumeSupport: vi.fn(async () => () => true),
  resolveAgentCliSubcommand: vi.fn(() => 'codex'),
  resolveCatalogAgentId: vi.fn(() => 'codex'),
  resolveCatalogAgentIdForCliSubcommand: vi.fn((subcommand: string) => {
    const normalized = subcommand.trim();
    return normalized === 'opencode' ? 'opencode' : normalized === 'claude' ? 'claude' : 'codex';
  }),
}));

vi.mock('@/persistence', () => ({
  writeDaemonState: vi.fn(),
  acquireDaemonLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
  releaseDaemonLock: vi.fn(async () => {}),
  readCredentials: vi.fn(async () => null),
}));

vi.mock('./controlClient', () => ({
  cleanupDaemonState: vi.fn(async () => {}),
  isDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(async () => false),
  stopDaemon: vi.fn(async () => {}),
}));

vi.mock('@/daemon/ownership/evaluateCurrentDaemonOwner', () => ({
  evaluateCurrentDaemonOwner: vi.fn(async () => ({ kind: 'none' })),
}));

vi.mock('@/daemon/ownership/daemonServiceInventory', () => ({
  evaluateDaemonStartupServiceConflict: vi.fn(async () => ({ kind: 'none' })),
}));

vi.mock('./controlServer', () => ({
  startDaemonControlServer: vi.fn(async ({
    spawnSession,
    stopSession,
    beforeShutdown,
  }: {
    spawnSession: (options: any) => Promise<any>;
    stopSession: (sessionId: string) => Promise<boolean>;
    beforeShutdown?: () => Promise<void>;
  }) => {
    harness.setSpawnSession(spawnSession);
    harness.setStopSession(stopSession);
    if (beforeShutdown) {
      harness.setBeforeShutdown(beforeShutdown);
    }
    return {
      port: 43210,
      stop: vi.fn(async () => {}),
    };
  }),
}));

vi.mock('./sessions/reattachFromMarkers', () => ({
  reattachTrackedSessionsFromMarkers: vi.fn(async () => ({ orphanedDeadDaemonSessions: [] })),
}));

vi.mock('./sessions/onHappySessionWebhook', () => ({
  createOnHappySessionWebhook: vi.fn(() => vi.fn()),
}));

vi.mock('./sessions/isSessionRunnerActive', () => ({
  isSessionRunnerActive: vi.fn(async () => false),
}));

vi.mock('./sessions/onChildExited', () => ({
  createOnChildExited: vi.fn(() => vi.fn()),
}));

vi.mock('./sessions/visibleConsoleSpawnWaiter', () => ({
  waitForVisibleConsoleSessionWebhook: vi.fn(async () => ({ type: 'success', sessionId: 'sess_visible_console' })),
}));

vi.mock('./sessions/stopSession', () => ({
  createStopSession: vi.fn(() => vi.fn(async () => ({ stopped: true }))),
}));

vi.mock('./sessions/resolveSpawnWebhookResult', () => ({
  resolveSpawnWebhookResult: vi.fn(({ result }: { result: any }) => result),
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
  isTmuxAvailable: vi.fn(async () => false),
}));

vi.mock('./lifecycle/shutdown', () => ({
  createDaemonShutdownController: harness.createDaemonShutdownController,
}));

vi.mock('./startup/waitForAuthConfig', () => ({
  resolveWaitForAuthConfig: vi.fn(() => ({
    waitForAuthEnabled: false,
    waitForAuthTimeoutMs: 0,
  })),
}));

vi.mock('./startup/waitForInitialCredentials', () => ({
  waitForInitialCredentials: vi.fn(async () => ({
    action: 'continue',
    daemonLockHandle: { release: vi.fn(async () => {}) },
  })),
}));

vi.mock('./startup/ensureSessionDirectory', () => ({
  ensureSessionDirectory: vi.fn(async () => ({ ok: true, directoryCreated: false })),
}));

vi.mock('./spawn/waitForSessionWebhook', () => ({
  waitForSessionWebhook: vi.fn(async () => ({ type: 'success', sessionId: 'sess_plain' })),
}));

vi.mock('./automation/automationWorker', () => ({
  startAutomationWorker: vi.fn(() => ({
    stop: vi.fn(),
    refreshAssignments: vi.fn(async () => {}),
    handleServerUpdate: vi.fn(),
  })),
}));

vi.mock('./memory/memoryWorker', () => ({
  startMemoryWorker: vi.fn(() => ({
    stop: vi.fn(),
  })),
}));

vi.mock('./shutdownPolicy', () => ({
  getDaemonShutdownExitCode: vi.fn(() => 0),
  getDaemonShutdownWatchdogTimeoutMs: vi.fn(() => 10_000),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: vi.fn(async () =>
    createSessionRecordFixture({
      id: 'sess_plain',
      encryptionMode: 'plain',
      metadata: JSON.stringify({ flavor: 'codex', codexSessionId: 'vendor-plain-1', path: '/tmp' }),
      dataEncryptionKey: null,
    }),
  ),
}));

vi.mock('./sessionAttachFile', () => ({
  createSessionAttachFile: vi.fn(async () => ({
    filePath: '/tmp/attach.json',
    cleanup: vi.fn(async () => {}),
  })),
}));

vi.mock('./machine/metadata', () => ({
  getPreferredHostName: vi.fn(async () => 'host.local'),
  initialMachineMetadata: {},
}));

vi.mock('./connectedServices/quotas/resolveConnectedServicesQuotasDaemonEnabled', () => ({
  resolveConnectedServicesQuotasDaemonEnabled: vi.fn(async () => false),
}));

describe('startDaemon spawn resume wiring (integration)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    harness.resetControlRefs();
    spawnHappyCLI.mockClear();
    spawnHappyCliCapture.children.length = 0;
    spawnChildProcess.mockClear();
    buildCgroupSelfMigratingHappyCliLaunchSpec.mockClear();
    cgroupMigrationCapture.migrateTrackedSessionProcessesOutOfDaemonServiceCgroup.mockClear();
    cgroupMigrationCapture.lastParams = null;
    sessionRespawnManagerCapture.createSessionRunnerRespawnManager.mockClear();
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
    delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
    delete process.env.HAPPIER_DAEMON_DIAGNOSTIC_DISABLE_MACHINE_SYNC;
    delete process.env.HAPPIER_DAEMON_DIAGNOSTIC_DISABLE_AUTOMATION_WORKER;
    delete process.env.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED;
    delete process.env.HAPPIER_DAEMON_STOP_SESSION_WAIT_FOR_EXIT_MS;
    delete process.env.HAPPIER_DAEMON_STOP_SESSION_WAIT_FOR_EXIT_POLL_INTERVAL_MS;
  });

  it('leaves daemon session runner respawn disabled unless explicitly enabled', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    delete process.env.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED;

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (sessionRespawnManagerCapture.createSessionRunnerRespawnManager.mock.calls.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(sessionRespawnManagerCapture.createSessionRunnerRespawnManager).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      );

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('tracks respawn environment variables from the effective launched Claude child env', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    const claudeConfigDirOriginal = process.env.CLAUDE_CONFIG_DIR;
    const startupSourceOriginal = process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-config';
    delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;

    try {
      const backendsCatalog = await import('@/backends/catalog');
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      const { claudeDaemonSpawnHooks } = await import('@/backends/claude/daemon/spawnHooks');

      const trackedSessionCapture: {
        current: Map<number, {
          pid: number;
          spawnOptions?: {
            environmentVariables?: Record<string, string>;
          };
        }> | null;
      } = { current: null };

      vi.mocked(backendsCatalog.requireCatalogEntry).mockImplementation(() => ({
        id: 'claude',
        cliSubcommand: 'claude',
        vendorResumeSupport: 'supported',
        getDaemonSpawnHooks: async () => ({
          ...claudeDaemonSpawnHooks,
          validateSpawn: async () => ({ ok: true as const }),
        }),
      }));
      vi.mocked(backendsCatalog.resolveCatalogAgentId).mockReturnValue('claude');
      vi.mocked(backendsCatalog.resolveAgentCliSubcommand).mockReturnValue('claude');
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ pidToTrackedSession }) => {
        trackedSessionCapture.current = pidToTrackedSession as typeof trackedSessionCapture.current;
        return vi.fn();
      });

      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; !spawnSession && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const spawnResult = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        token: 't',
      });

      expect(spawnResult.type).toBe('success');

      const directLaunchCall = spawnHappyCLI.mock.calls[0];
      const wrappedLaunchCall = spawnChildProcess.mock.calls[0] as unknown;
      const wrappedLaunchOptions =
        Array.isArray(wrappedLaunchCall) && wrappedLaunchCall.length >= 3
          ? (wrappedLaunchCall[2] as { env?: Record<string, string> } | undefined)
          : undefined;
      const launchedEnv = directLaunchCall
        ? (directLaunchCall[1] as { env?: Record<string, string> } | undefined)?.env
        : wrappedLaunchOptions?.env;

      if (!launchedEnv) {
        throw new Error('Expected daemon session spawn to capture the launched child environment');
      }

      expect(launchedEnv?.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-config');

      const trackedSessions = trackedSessionCapture.current;
      if (!trackedSessions) {
        throw new Error('Expected tracked session map from webhook wiring');
      }

      expect(trackedSessions.get(12345)?.spawnOptions?.environmentVariables?.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-config');

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      const backendsCatalog = await import('@/backends/catalog');
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      vi.mocked(backendsCatalog.requireCatalogEntry).mockImplementation(() => ({
        id: 'codex',
        cliSubcommand: 'codex',
        vendorResumeSupport: 'supported',
      }));
      vi.mocked(backendsCatalog.resolveCatalogAgentId).mockReturnValue('codex');
      vi.mocked(backendsCatalog.resolveAgentCliSubcommand).mockReturnValue('codex');
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(() => vi.fn());
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      if (claudeConfigDirOriginal === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = claudeConfigDirOriginal;
      }
      if (startupSourceOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
      } else {
        process.env.HAPPIER_DAEMON_STARTUP_SOURCE = startupSourceOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('launches daemon-managed session runners as detached ignored-stdio children and unreferences them', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; !spawnSession && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        token: 't',
      });

      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const firstCall = spawnHappyCLI.mock.calls[0];
      if (!firstCall) {
        throw new Error('Expected spawnHappyCLI to be called');
      }

      expect(firstCall[1]).toEqual(expect.objectContaining({
        detached: true,
        stdio: 'ignore',
      }));
      const launchOptions = firstCall as unknown as [unknown, unknown, unknown?];
      expect(launchOptions[2]).toEqual({ preferWindowsPackagedBinary: true });

      const launchedChild = spawnHappyCliCapture.children[0];
      if (!launchedChild) {
        throw new Error('Expected spawned child to be captured');
      }
      expect(launchedChild.unref).toHaveBeenCalledTimes(1);

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('derives vendor resume id from existing session metadata and passes --resume to the spawned runner', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; !spawnSession && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_plain',
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const firstCall = spawnHappyCLI.mock.calls[0];
      if (!firstCall) {
        throw new Error('Expected spawnHappyCLI to be called');
      }
      const argv = firstCall[0];
      expect(argv).toEqual(expect.arrayContaining(['--existing-session', 'sess_plain']));
      expect(argv).toEqual(expect.arrayContaining(['--resume', 'vendor-plain-1']));

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('tags daemon-spawned session runners as stack process kind=session (does not inherit infra)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    const stackEnvFileOriginal = process.env.HAPPIER_STACK_ENV_FILE;
    const stackProcessKindOriginal = process.env.HAPPIER_STACK_PROCESS_KIND;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.HAPPIER_STACK_ENV_FILE = '/tmp/stack.env';
    process.env.HAPPIER_STACK_PROCESS_KIND = 'infra';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const firstCall = spawnHappyCLI.mock.calls[0];
      if (!firstCall) {
        throw new Error('Expected spawnHappyCLI to be called');
      }
      const opts = firstCall[1] as { env?: NodeJS.ProcessEnv } | undefined;
      expect(opts?.env?.HAPPIER_STACK_PROCESS_KIND).toBe('session');

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      if (stackEnvFileOriginal === undefined) {
        delete process.env.HAPPIER_STACK_ENV_FILE;
      } else {
        process.env.HAPPIER_STACK_ENV_FILE = stackEnvFileOriginal;
      }
      if (stackProcessKindOriginal === undefined) {
        delete process.env.HAPPIER_STACK_PROCESS_KIND;
      } else {
        process.env.HAPPIER_STACK_PROCESS_KIND = stackProcessKindOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('spawns regular linux background-service runners through a pre-exec cgroup self-migration wrapper before provider children start', async () => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
    process.env.HAPPIER_DAEMON_STARTUP_SOURCE = 'background-service';

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(spawnHappyCLI).not.toHaveBeenCalled();
      expect(buildCgroupSelfMigratingHappyCliLaunchSpec).toHaveBeenCalledTimes(1);
      expect(spawnChildProcess).toHaveBeenCalledTimes(1);
      const spawnCall = spawnChildProcess.mock.calls[0] as unknown as [string, string[], { env?: NodeJS.ProcessEnv } | undefined] | undefined;
      const spawnFilePath = spawnCall?.[0];
      const spawnArgs = spawnCall?.[1];
      const spawnOptions = spawnCall?.[2];
      expect(spawnFilePath).toBe('/bin/sh');
      expect(spawnArgs).toEqual(expect.arrayContaining(['-lc']));
      expect(spawnArgs?.join(' ')).toContain('happier-session-$$.scope');
      expect(spawnArgs?.join(' ')).toContain('exec "$@"');
      expect(spawnOptions?.env?.HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR).toContain('/sys/fs/cgroup/');
      expect(spawnOptions?.env?.[HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY]).toBe('1');

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('migrates reattached linux background-service session runners out of the daemon service cgroup during startup', async () => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
    process.env.HAPPIER_DAEMON_STARTUP_SOURCE = 'background-service';

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async ({ pidToTrackedSession }) => {
        pidToTrackedSession.set(6480, {
          pid: 6480,
          startedBy: 'daemon',
          happySessionId: 'sess-6480',
          reattachedFromDiskMarker: true,
        });
        return { orphanedDeadDaemonSessions: [] };
      });

      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();

      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (cgroupMigrationCapture.migrateTrackedSessionProcessesOutOfDaemonServiceCgroup.mock.calls.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(cgroupMigrationCapture.migrateTrackedSessionProcessesOutOfDaemonServiceCgroup).toHaveBeenCalledTimes(1);
      const migrationParams = cgroupMigrationCapture.lastParams;
      if (!migrationParams) {
        throw new Error('Expected cgroup migration helper to be called');
      }
      const trackedSessionsArg = Array.from(migrationParams.trackedSessions as Iterable<{ pid: number }>);
      expect(trackedSessionsArg).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pid: 6480,
          }),
        ]),
      );

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('keeps live reattached daemon sessions running under their original CLI runtime during startup', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async ({ pidToTrackedSession }) => {
        pidToTrackedSession.set(6480, {
          pid: 6480,
          startedBy: 'daemon',
          happySessionId: 'sess-stale-6480',
          reattachedFromDiskMarker: true,
          processCommand:
            'bun C:/hq/windetachedfix-007/happier-v0.2.4-windows-x64/package-dist/index.mjs codex --happy-starting-mode remote --started-by daemon --existing-session sess-stale-6480',
          spawnOptions: {
            directory: '/tmp/workspace-stale',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          },
        } as any);
        return { orphanedDeadDaemonSessions: [] };
      });

      const stopSessionModule = await import('./sessions/stopSession');
      const stopSessionSpy = vi.fn(async () => true);
      vi.mocked(stopSessionModule.createStopSession).mockReturnValue(stopSessionSpy as any);

      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();

      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (harness.getSpawnSession()) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(stopSessionSpy).not.toHaveBeenCalled();
      expect(spawnHappyCLI).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('waits for a stop-requested tracked runner to be observed exited before stop returns', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      vi.resetModules();
      harness.resetControlRefs();
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async ({ pidToTrackedSession }) => {
        pidToTrackedSession.set(6480, {
          pid: 6480,
          startedBy: 'daemon',
          happySessionId: 'sess-stop-6480',
          reattachedFromDiskMarker: true,
          stopRequestedAtMs: 123,
        } as any);
        return { orphanedDeadDaemonSessions: [] };
      });

      const onChildExitedModule = await import('./sessions/onChildExited');
      const onChildExitedSpy = vi.fn();
      vi.mocked(onChildExitedModule.createOnChildExited).mockReturnValue(onChildExitedSpy);

      const waitForExitModule = await import('./sessions/waitForExistingSessionExitIfStopRequested');
      const waitForExitSpy = vi.spyOn(waitForExitModule, 'waitForExistingSessionExitIfStopRequested')
        .mockImplementation(async (params: any) => {
          params.onExitObserved?.(6480, { reason: 'process-missing', code: null, signal: null });
        });

      const stopSessionModule = await import('./sessions/stopSession');
      vi.mocked(stopSessionModule.createStopSession).mockImplementation(({ pidToTrackedSession }) => {
        return vi.fn(async (sessionId: string) => {
          for (const trackedSession of pidToTrackedSession.values()) {
            if (trackedSession.happySessionId === sessionId) {
              trackedSession.stopRequestedAtMs = Date.now();
            }
          }
          return true;
        }) as any;
      });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (harness.getStopSession()) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const stopSession = harness.getStopSession();
      if (!stopSession) {
        throw new Error('Expected stopSession to be registered');
      }

      await expect(stopSession('sess-stop-6480')).resolves.toBe(true);

      expect(waitForExitSpy).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess-stop-6480',
      }));
      expect(onChildExitedSpy).toHaveBeenCalledWith(6480, {
        reason: 'process-missing',
        code: null,
        signal: null,
      });
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('spawns an existing session without re-fetching it when a pre-resolved attach payload is supplied', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    vi.mocked(waitForSessionWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'sess-pre-resolved-1',
    });
    vi.mocked(fetchSessionByIdCompat).mockRejectedValue(new Error('fetch should not be needed when the attach payload is pre-resolved'));

    try {
      const { startDaemon } = await import('./startDaemon');
      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      await expect(
        spawnSession({
          directory: '/tmp/workspace-pre-resolved',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          existingSessionId: 'sess-pre-resolved-1',
          existingSessionAttachPayload: { v: 2, encryptionMode: 'plain' } as any,
        }),
      ).resolves.toEqual({ type: 'success', sessionId: 'sess-pre-resolved-1' });

      expect(fetchSessionByIdCompat).not.toHaveBeenCalled();
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      expect(spawnHappyCLI.mock.calls[0]?.[0]).toEqual(
        expect.arrayContaining([
          'codex',
          '--happy-starting-mode',
          'remote',
          '--started-by',
          'daemon',
          '--existing-session',
          'sess-pre-resolved-1',
        ]),
      );

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('normalizes ~/ session directories before spawning the child runner and seeding requested-directory env', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    const homeOriginal = process.env.HOME;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.HOME = '/Users/tester';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      await spawnSession({
        directory: '~/Documents',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const firstCall = spawnHappyCLI.mock.calls[0];
      if (!firstCall) {
        throw new Error('Expected spawnHappyCLI to be called');
      }
      const opts = firstCall[1] as { cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
      expect(opts?.cwd).toBe('/Users/tester/Documents');
      expect(opts?.env?.HAPPIER_SESSION_REQUESTED_DIRECTORY).toBe('/Users/tester/Documents');

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      if (homeOriginal === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = homeOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('allows macOS background-service spawns targeting Documents', async () => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    const startupSourceOriginal = process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
    const homeOriginal = process.env.HOME;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.HAPPIER_DAEMON_STARTUP_SOURCE = 'background-service';
    process.env.HOME = '/Users/tester';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const result = await spawnSession({
        directory: '~/Documents/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(result).toEqual({ type: 'success', sessionId: 'sess_plain' });
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const firstCall = spawnHappyCLI.mock.calls[0];
      if (!firstCall) {
        throw new Error('Expected spawnHappyCLI to be called');
      }
      const opts = firstCall[1] as { cwd?: string } | undefined;
      expect(opts?.cwd).toBe('/Users/tester/Documents/project');

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      if (startupSourceOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
      } else {
        process.env.HAPPIER_DAEMON_STARTUP_SOURCE = startupSourceOriginal;
      }
      if (homeOriginal === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = homeOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('passes the canonical existing session id hint through to the webhook waiter for attach spawns', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    const waitForSessionWebhookMock = vi.mocked(waitForSessionWebhook);
    waitForSessionWebhookMock.mockImplementationOnce(async () => ({
      type: 'success',
      sessionId: 'sess_plain',
    }));

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_plain',
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(result).toEqual({ type: 'success', sessionId: 'sess_plain' });
      expect(waitForSessionWebhookMock).toHaveBeenCalledTimes(1);
      const firstCall = waitForSessionWebhookMock.mock.calls[0]?.[0];
      expect(typeof firstCall?.resolveExistingSessionId).toBe('function');
      expect(firstCall?.resolveExistingSessionId?.()).toBe('sess_plain');

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      waitForSessionWebhookMock.mockReset();
      waitForSessionWebhookMock.mockImplementation(async () => ({ type: 'success', sessionId: 'sess_plain' }));
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('routes configured ACP backend attach spawns through the acp-catalog command with preset args', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
        existingSessionId: 'sess_plain',
        token: 't',
      });

      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const firstCall = spawnHappyCLI.mock.calls[0];
      if (!firstCall) {
        throw new Error('Expected spawnHappyCLI to be called');
      }
      const argv = firstCall[0];
      expect(argv[0]).toBe('acp-catalog');
      expect(argv).toEqual(expect.arrayContaining(['--backend', 'custom-kiro']));
      expect(argv).toEqual(expect.arrayContaining(['--existing-session', 'sess_plain']));

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      spawnHappyCLI.mockClear();
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('returns INVALID_REQUEST when the existing session cannot be fetched for resume', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(null);

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_missing',
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(result).toEqual({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Existing session not found or access denied for resume.',
      });

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('returns UNEXPECTED when fetching the existing session fails before resume attach', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    vi.mocked(fetchSessionByIdCompat).mockRejectedValueOnce(new Error('fetch exploded'));

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_fetch_error',
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(result).toEqual({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Failed to fetch existing session for resume.',
      });

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('returns not_authenticated when fetching the existing session fails with stale auth before resume attach', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    vi.mocked(fetchSessionByIdCompat).mockRejectedValueOnce(
      createHttpStatusError(401, 'Unauthorized (401)', 'not_authenticated'),
    );

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_stale_auth',
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(result).toEqual({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'not_authenticated',
      });

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('defers shutdown completion until pending machine RPC requests settle', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.HAPPIER_DAEMON_DIAGNOSTIC_DISABLE_MACHINE_SYNC = 'false';
    process.env.HAPPIER_DAEMON_DIAGNOSTIC_DISABLE_AUTOMATION_WORKER = 'false';
    delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
    delete process.env.HAPPIER_DAEMON_WAIT_FOR_AUTH;

    harness.apiMachine.setRPCHandlers.mockClear();
    harness.apiMachine.awaitPendingRpcRequests.mockClear();

    let resolvePendingRpc!: () => void;
    harness.apiMachine.awaitPendingRpcRequests.mockImplementationOnce(
      async () => await new Promise<void>((resolve) => {
        resolvePendingRpc = resolve;
      }),
    );

    try {
	      vi.resetModules();
	      const persistence = await import('@/persistence');
	      vi.mocked(persistence.readCredentials).mockResolvedValue({
	        token: 'token_1',
	        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
	      });
	      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      for (let attempt = 0; harness.apiMachine.setRPCHandlers.mock.calls.length === 0 && attempt < 200; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const hasMachineSync = harness.apiMachine.setRPCHandlers.mock.calls.length > 0;

      for (let attempt = 0; !harness.getBeforeShutdown() && attempt < 200; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const resolvedBeforeShutdown = harness.getBeforeShutdown();
      if (!resolvedBeforeShutdown) throw new Error('Expected beforeShutdown to be registered');

      if (!hasMachineSync) {
        await resolvedBeforeShutdown();
        expect(harness.apiMachine.awaitPendingRpcRequests).toHaveBeenCalledTimes(0);
        harness.requestShutdown('happier-cli');
        await run;
        return;
      }

      let settled = false;
      const waitForBeforeShutdown = resolvedBeforeShutdown().then(() => {
        settled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(harness.apiMachine.awaitPendingRpcRequests).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      resolvePendingRpc();
      await waitForBeforeShutdown;

      expect(settled).toBe(true);

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      const persistence = await import('@/persistence');
      vi.mocked(persistence.readCredentials).mockResolvedValue(null);
      harness.apiMachine.awaitPendingRpcRequests.mockReset();
      harness.apiMachine.awaitPendingRpcRequests.mockImplementation(async () => {});
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('uses the visible Windows console spawner when the resolved launch mode is console', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const { buildHappyCliSubprocessLaunchSpec } = await import('@/utils/spawnHappyCLI');
      const { resolveWindowsRemoteSessionConsoleMode } = await import('./platform/windows/windowsSessionConsoleMode');
      const { startHappySessionInVisibleWindowsConsole } = await import('./platform/windows/spawnHappyCliVisibleConsole');
      const { startDaemon } = await import('./startDaemon');

      vi.mocked(buildHappyCliSubprocessLaunchSpec).mockReturnValue({
        runtime: 'node',
        filePath: '/tmp/happier',
        args: ['codex', '--happy-starting-mode', 'remote'],
        env: { EXTRA: '1' },
      });
      vi.mocked(resolveWindowsRemoteSessionConsoleMode).mockReturnValue('console');

      run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_plain',
        token: 't',
        codexBackendMode: 'acp',
        windowsRemoteSessionConsole: 'visible',
      });

      expect(startHappySessionInVisibleWindowsConsole).toHaveBeenCalledWith(expect.objectContaining({
        filePath: '/tmp/happier',
        args: expect.arrayContaining(['codex', '--happy-starting-mode', 'remote']),
        workingDirectory: '/tmp',
      }));
      expect(buildHappyCliSubprocessLaunchSpec).toHaveBeenCalledWith(
        expect.any(Array),
        { preferWindowsPackagedBinary: true },
      );
      expect(spawnHappyCLI).not.toHaveBeenCalled();
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

});
