import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { configuration } from '@/configuration';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createLocalSessionHandoffMetadataStore } from '@/session/handoff/metadata/localSessionHandoffMetadataStore';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { waitForSessionWebhook } from './spawn/waitForSessionWebhook';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';
type BuildHappyCliSubprocessLaunchSpec = typeof import('@/utils/spawnHappyCLI').buildHappyCliSubprocessLaunchSpec;
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');
const { spawnChildProcess } = vi.hoisted(() => ({
  spawnChildProcess: vi.fn(() => ({
    pid: 12345,
    stdout: null,
    stderr: null,
    on: vi.fn(),
  })),
}));

const harness = vi.hoisted(() => {
  let resolveShutdown: ((value: { source: ShutdownSource; errorMessage?: string }) => void) | null = null;
  let requestShutdownRef: ((source: ShutdownSource, errorMessage?: string) => void) | null = null;
  let spawnSessionRef: ((options: any) => Promise<any>) | null = null;
  let stopSessionRef: ((sessionId: string) => Promise<boolean>) | null = null;
  let beforeShutdownRef: (() => Promise<void>) | null = null;
  let machineConnectionStateListener: ((state: any) => void) | null = null;

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
    onConnectionStateChange: vi.fn((listener: (state: any) => void) => {
      machineConnectionStateListener = listener;
      return () => {
        if (machineConnectionStateListener === listener) {
          machineConnectionStateListener = null;
        }
      };
    }),
    connect: vi.fn((params?: { onConnect?: () => void | Promise<void> }) => {
      void params?.onConnect?.();
    }),
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

vi.mock('@/api/machine/ensureMachineRegistered', () => ({
  ensureMachineRegistered: vi.fn(async ({ machineId }: { machineId: string }) => ({
    machineId,
    didRotateMachineId: false,
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
    activeServerDir: '/tmp/happy-home/servers/active',
    currentCliVersion: '0.0.0-test',
    publicReleaseRing: 'publicdev',
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

const spawnHappyCLI = vi.hoisted(() => vi.fn((argv: string[], _opts?: unknown, _launchOptions?: unknown) => ({
  pid: 12345,
  stdout: null,
  stderr: null,
  on: vi.fn(),
})));

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

const onChildExitedCapture = vi.hoisted(() => {
  const onChildExited = vi.fn();
  return {
    onChildExited,
    createOnChildExited: vi.fn(() => onChildExited),
  };
});

const stopSessionCapture = vi.hoisted(() => ({
  createStopSession: vi.fn(({ pidToTrackedSession }: { pidToTrackedSession: Map<number, any> }) =>
    vi.fn(async (sessionId: string) => {
      for (const trackedSession of pidToTrackedSession.values()) {
        if (trackedSession.happySessionId === sessionId) {
          trackedSession.stopRequestedAtMs = Date.now();
        }
      }
      return true;
    }),
  ),
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

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnChildProcess,
  };
});

vi.mock('./platform/linux/buildCgroupSelfMigratingHappyCliLaunchSpec', () => ({
  buildCgroupSelfMigratingHappyCliLaunchSpec,
}));

vi.mock('./platform/linux/migrateTrackedSessionsOutOfDaemonServiceCgroup', () => ({
  migrateTrackedSessionProcessesOutOfDaemonServiceCgroup: cgroupMigrationCapture.migrateTrackedSessionProcessesOutOfDaemonServiceCgroup,
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

vi.mock('@/backends/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backends/catalog')>();
  return {
    ...actual,
    AGENTS: {
      ...actual.AGENTS,
      codex: {
        ...actual.AGENTS.codex,
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
    getManagedServerShutdownCleanup: vi.fn(async () => null),
    resolveAgentCliSubcommand: vi.fn(() => 'codex'),
    resolveCatalogAgentId: vi.fn(() => 'codex'),
  };
});

vi.mock('@/persistence', () => ({
  writeDaemonState: vi.fn(),
  acquireDaemonLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
  releaseDaemonLock: vi.fn(async () => {}),
  readCredentials: vi.fn(async () => null),
  readSettings: vi.fn(async () => ({ machineId: 'machine-1' })),
}));

vi.mock('./controlClient', () => ({
  cleanupDaemonState: vi.fn(async () => {}),
  isDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(async () => false),
  stopDaemon: vi.fn(async () => {}),
  // The daemon's SSH-tunnel system-task wiring (unrelated to spawn/resume) binds these
  // control-client functions when the live system-tasks runner is constructed during daemon
  // startup. Provide no-ops so the suite loads; this test exercises session spawn/resume only
  // and never drives SSH tunnels, so SSH behavior is intentionally left untouched.
  ensureDaemonSshTunnel: vi.fn(async () => ({ error: 'ssh_tunnel_unavailable_in_test' })),
  listDaemonSshTunnels: vi.fn(async () => ({ error: 'ssh_tunnel_unavailable_in_test' })),
  releaseDaemonSshTunnel: vi.fn(async () => ({ error: 'ssh_tunnel_unavailable_in_test' })),
  stopDaemonSshTunnel: vi.fn(async () => ({ error: 'ssh_tunnel_unavailable_in_test' })),
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
  reattachTrackedSessionsFromMarkers: vi.fn(async () => ({
    orphanedDeadDaemonSessions: [],
  })),
}));

vi.mock('./sessions/onHappySessionWebhook', () => ({
  createOnHappySessionWebhook: vi.fn(() => vi.fn()),
}));

vi.mock('./sessions/isSessionRunnerActive', () => ({
  isSessionRunnerActive: vi.fn(async () => false),
}));

vi.mock('./sessions/onChildExited', () => ({
  createOnChildExited: onChildExitedCapture.createOnChildExited,
}));

vi.mock('./sessions/visibleConsoleSpawnWaiter', () => ({
  waitForVisibleConsoleSessionWebhook: vi.fn(async () => ({ type: 'success', sessionId: 'sess_visible_console' })),
}));

vi.mock('./sessions/stopSession', () => ({
  createStopSession: stopSessionCapture.createStopSession,
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

vi.mock('@/daemon/ownership/evaluateCurrentDaemonOwner', () => ({
  evaluateCurrentDaemonOwner: vi.fn(async () => ({ kind: 'none' })),
}));

vi.mock('@/daemon/ownership/resolveDaemonTakeoverDecision', () => ({
  buildDaemonTakeoverNotice: vi.fn(() => ({ title: 'takeover', lines: [] })),
  resolveDaemonTakeoverDecision: vi.fn(() => ({ kind: 'ok' })),
}));

vi.mock('@/daemon/ownership/daemonServiceInventory', () => ({
  evaluateDaemonStartupServiceConflict: vi.fn(async () => ({ kind: 'ok' })),
  renderDaemonInstalledServiceConflict: vi.fn(() => ({ title: 'service-conflict', lines: [] })),
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
  const canonicalBuiltInBackendTarget = {
    kind: 'backend',
    backendId: 'codex',
    sourceKind: 'built_in',
  } as const;
  const canonicalClaudeBackendTarget = {
    kind: 'backend',
    backendId: 'claude',
    sourceKind: 'built_in',
  } as const;
  const canonicalConfiguredBackendTarget = {
    kind: 'backend',
    backendId: 'review-bot',
    configuredBackendId: 'review-bot',
    sourceKind: 'configured',
  } as const;

  afterEach(() => {
    vi.restoreAllMocks();
    harness.resetControlRefs();
    onChildExitedCapture.onChildExited.mockClear();
    onChildExitedCapture.createOnChildExited.mockClear();
    stopSessionCapture.createStopSession.mockClear();
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
    delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
    delete process.env.HAPPIER_DAEMON_DIAGNOSTIC_DISABLE_MACHINE_SYNC;
    delete process.env.HAPPIER_DAEMON_DIAGNOSTIC_DISABLE_AUTOMATION_WORKER;
    delete process.env.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED;
    delete process.env.HAPPIER_DAEMON_STOP_SESSION_WAIT_FOR_EXIT_MS;
    delete process.env.HAPPIER_DAEMON_STOP_SESSION_WAIT_FOR_EXIT_POLL_INTERVAL_MS;
    sessionRespawnManagerCapture.createSessionRunnerRespawnManager.mockClear();
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

      const waitForExitModule = await import('./sessions/waitForExistingSessionExitIfStopRequested');
      const waitForExitSpy = vi.spyOn(waitForExitModule, 'waitForExistingSessionExitIfStopRequested')
        .mockImplementation(async (params: any) => {
          params.onExitObserved?.(6480, { reason: 'process-missing', code: null, signal: null });
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
      expect(onChildExitedCapture.onChildExited).toHaveBeenCalledWith(6480, {
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

  it('derives vendor resume id from existing session metadata and passes --resume to the spawned runner', async () => {
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
        backendTarget: canonicalBuiltInBackendTarget,
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
      expect(firstCall[2]).toEqual({ preferWindowsPackagedBinary: true });

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
        backendTarget: canonicalBuiltInBackendTarget,
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
        backendTarget: canonicalBuiltInBackendTarget,
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

  it('does not report attach success before webhook or child-exit proof when an existing session id is preknown', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    const { waitForSessionWebhook: actualWaitForSessionWebhook } = await vi.importActual<typeof import('./spawn/waitForSessionWebhook')>(
      './spawn/waitForSessionWebhook',
    );

    let exitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
    spawnHappyCLI.mockImplementationOnce(() => {
      const childProcess = {
        pid: 12345,
        stdout: null,
        stderr: null,
        on: vi.fn((event: string, handler: unknown) => {
          if (event === 'exit') {
            exitHandler = handler as (code: number | null, signal: NodeJS.Signals | null) => void;
          }
          return childProcess;
        }),
      };
      return childProcess as ReturnType<typeof spawnHappyCLI>;
    });

    const waitForSessionWebhookMock = vi.mocked(waitForSessionWebhook);
    waitForSessionWebhookMock.mockImplementationOnce(actualWaitForSessionWebhook);

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = harness.getSpawnSession();
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      let settled = false;
      const resultPromise = spawnSession({
        directory: '/tmp',
        backendTarget: canonicalBuiltInBackendTarget,
        existingSessionId: 'sess_plain',
        token: 't',
        codexBackendMode: 'acp',
      }).then((result) => {
        settled = true;
        return result;
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(exitHandler).toBeTypeOf('function');

      if (!exitHandler) {
        throw new Error('Expected child exit handler to be registered');
      }
      const registeredExitHandler: (code: number | null, signal: NodeJS.Signals | null) => void = exitHandler;
      registeredExitHandler(1, null);

      await expect(resultPromise).resolves.toMatchObject({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
      });

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      spawnHappyCLI.mockReset();
      spawnHappyCLI.mockImplementation((argv: string[], _opts?: unknown) => ({
        pid: 12345,
        stdout: null,
        stderr: null,
        on: vi.fn(),
      }));
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

  it('routes configured ACP backend attach spawns through the stored session backend when the request target is stale', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess_plain',
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          flavor: 'acp:review-bot',
          path: '/tmp',
          acpConfiguredBackendV1: {
            v: 1,
            updatedAt: 1,
            backendId: 'review-bot',
            title: 'Review Bot',
          },
        }),
        dataEncryptionKey: null,
      }),
    );

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
        backendTarget: {
          ...canonicalConfiguredBackendTarget,
          backendId: 'custom-kiro',
          configuredBackendId: 'custom-kiro',
        },
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
      expect(argv).toEqual(expect.arrayContaining(['--backend', 'review-bot']));
      expect(argv).not.toEqual(expect.arrayContaining(['--backend', 'custom-kiro']));
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
        backendTarget: canonicalBuiltInBackendTarget,
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

  it('fails closed for unknown built-in backend targets instead of defaulting to custom ACP', async () => {
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

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'not-a-real-agent' },
        token: 't',
      });

      expect(result).toEqual({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unknown backend target',
      });
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

  it('fails closed when customAcp is provided as a built-in backend target', async () => {
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

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'customAcp' },
        token: 't',
      });

      expect(result).toEqual({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unknown backend target',
      });
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

  it('fails closed for fresh spawn requests with no backend target identity', async () => {
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

      const result = await spawnSession({
        directory: '/tmp',
        token: 't',
      });

      expect(result).toEqual({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Backend target is required for fresh session spawn.',
      });
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
        backendTarget: canonicalBuiltInBackendTarget,
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

  it('continues existing-session spawns when the activity probe is unavailable', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    const { isSessionRunnerActive } = await import('./sessions/isSessionRunnerActive');
    vi.mocked(isSessionRunnerActive).mockRejectedValueOnce(new Error('lock reader exploded'));

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
        backendTarget: canonicalBuiltInBackendTarget,
        existingSessionId: 'sess_plain',
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(result).toEqual({ type: 'success', sessionId: 'sess_plain' });
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
          resolveRuntimePrerequisites: async () => ({ ok: true as const }),
          augmentEnv: (): Record<string, string> => {
            const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
            return claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {};
          },
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
        backendTarget: canonicalClaudeBackendTarget,
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

      expect(launchedEnv.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-config');

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

  it('spawns a Claude handoff attach when existingSessionId and resume are both present', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    const claudePathOriginal = process.env.HAPPIER_CLAUDE_PATH;
    const pathOriginal = process.env.PATH;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-claude-spawn-resume-'));
    const claudePath = await writeExecutableShim({
      dir: tempDir,
      fileName: process.platform === 'win32' ? 'claude.cmd' : 'claude',
      contents: process.platform === 'win32'
        ? '@echo off\r\nexit /b 0\r\n'
        : '#!/bin/sh\nexit 0\n',
    });
    process.env.HAPPIER_CLAUDE_PATH = claudePath;
    process.env.PATH = tempDir;

    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess-handoff-source',
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          flavor: 'claude',
          path: '/tmp/source-workspace',
          claudeSessionId: 'vendor-source-1',
        }),
        dataEncryptionKey: null,
      }),
    );

    const waitForSessionWebhookMock = vi.mocked(waitForSessionWebhook);
    waitForSessionWebhookMock.mockResolvedValueOnce({
      type: 'success',
      sessionId: 'sess-handoff-source',
    });

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
        backendTarget: canonicalClaudeBackendTarget,
        existingSessionId: 'sess-handoff-source',
        resume: 'sess-handoff-child',
        token: 't',
      });

      expect(result).toEqual({ type: 'success', sessionId: 'sess-handoff-source' });
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const argv = spawnHappyCLI.mock.calls[0]?.[0] ?? [];
      expect(argv).toEqual(expect.arrayContaining(['--existing-session', 'sess-handoff-source']));
      expect(argv).toEqual(expect.arrayContaining(['--resume', 'sess-handoff-child']));

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      waitForSessionWebhookMock.mockReset();
      waitForSessionWebhookMock.mockImplementation(async () => ({ type: 'success', sessionId: 'sess_plain' }));
      spawnHappyCLI.mockClear();
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      if (claudePathOriginal === undefined) {
        delete process.env.HAPPIER_CLAUDE_PATH;
      } else {
        process.env.HAPPIER_CLAUDE_PATH = claudePathOriginal;
      }
      if (pathOriginal === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = pathOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('uses the local handoff overlay when the source session metadata does not expose a provider id', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    const claudePathOriginal = process.env.HAPPIER_CLAUDE_PATH;
    const pathOriginal = process.env.PATH;
    const configurationMutable = configuration as { activeServerDir: string };
    const activeServerDirOriginal = configurationMutable.activeServerDir;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-claude-spawn-resume-overlay-'));
    const claudePath = await writeExecutableShim({
      dir: tempDir,
      fileName: process.platform === 'win32' ? 'claude.cmd' : 'claude',
      contents: process.platform === 'win32'
        ? '@echo off\r\nexit /b 0\r\n'
        : '#!/bin/sh\nexit 0\n',
    });
    process.env.HAPPIER_CLAUDE_PATH = claudePath;
    process.env.PATH = tempDir;

    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-overlay-'));
    configurationMutable.activeServerDir = activeServerDir;
    await createLocalSessionHandoffMetadataStore({ activeServerDir }).saveByVendorResumeId({
      vendorResumeId: 'sess-handoff-direct',
      exportMetadataOverlay: {
        handoffV1: {
          v: 1,
          sourceMachineId: 'machine_source',
          targetMachineId: 'machine_target',
          providerId: 'claude',
          sessionStorageBefore: 'direct',
          sessionStorageAfter: 'direct',
          transportStrategy: 'direct_peer',
          completedAtMs: 1,
          sourceWorkspaceRootPath: '/repo-source-root',
          targetWorkspaceRootPath: '/repo-target-root',
        },
      },
    });

    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess-handoff-source',
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          path: '/tmp/source-workspace',
        }),
        dataEncryptionKey: null,
      }),
    );

    const waitForSessionWebhookMock = vi.mocked(waitForSessionWebhook);
    waitForSessionWebhookMock.mockResolvedValueOnce({
      type: 'success',
      sessionId: 'sess-handoff-source',
    });

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
        backendTarget: canonicalClaudeBackendTarget,
        existingSessionId: 'sess-handoff-source',
        resume: 'sess-handoff-direct',
        token: 't',
      });

      expect(result).toEqual({ type: 'success', sessionId: 'sess-handoff-source' });
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const argv = spawnHappyCLI.mock.calls[0]?.[0] ?? [];
      expect(argv).toEqual(expect.arrayContaining(['claude', '--happy-starting-mode', 'remote']));
      expect(argv).toEqual(expect.arrayContaining(['--existing-session', 'sess-handoff-source']));
      expect(argv).toEqual(expect.arrayContaining(['--resume', 'sess-handoff-direct']));

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      waitForSessionWebhookMock.mockReset();
      waitForSessionWebhookMock.mockImplementation(async () => ({ type: 'success', sessionId: 'sess_plain' }));
      spawnHappyCLI.mockClear();
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      if (claudePathOriginal === undefined) {
        delete process.env.HAPPIER_CLAUDE_PATH;
      } else {
        process.env.HAPPIER_CLAUDE_PATH = claudePathOriginal;
      }
      if (pathOriginal === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = pathOriginal;
      }
      configurationMutable.activeServerDir = activeServerDirOriginal;
      exitSpy.mockRestore();
    }
  });

  it('fails closed when local handoff overlay resolves built-in providerId to customAcp', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    const configurationMutable = configuration as { activeServerDir: string };
    const activeServerDirOriginal = configurationMutable.activeServerDir;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-overlay-customacp-'));
    configurationMutable.activeServerDir = activeServerDir;
    await createLocalSessionHandoffMetadataStore({ activeServerDir }).saveByVendorResumeId({
      vendorResumeId: 'sess-handoff-direct',
      exportMetadataOverlay: {
        handoffV1: {
          v: 1,
          sourceMachineId: 'machine_source',
          targetMachineId: 'machine_target',
          providerId: 'customAcp',
          sessionStorageBefore: 'direct',
          sessionStorageAfter: 'direct',
          transportStrategy: 'direct_peer',
          completedAtMs: 1,
          sourceWorkspaceRootPath: '/repo-source-root',
          targetWorkspaceRootPath: '/repo-target-root',
        },
      },
    });

    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess-handoff-source',
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          path: '/tmp/source-workspace',
        }),
        dataEncryptionKey: null,
      }),
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
        existingSessionId: 'sess-handoff-source',
        resume: 'sess-handoff-direct',
        token: 't',
      });

      expect(result).toEqual({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unknown backend target',
      });
      expect(spawnHappyCLI).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      spawnHappyCLI.mockClear();
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      configurationMutable.activeServerDir = activeServerDirOriginal;
      exitSpy.mockRestore();
    }
  });

  it('defers shutdown completion until pending machine RPC requests settle', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    let resolvePendingRpc!: () => void;
    harness.apiMachine.awaitPendingRpcRequests.mockImplementationOnce(
      async () => await new Promise<void>((resolve) => {
        resolvePendingRpc = resolve;
      }),
    );

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await vi.waitFor(() => {
        expect(harness.getBeforeShutdown()).toBeTypeOf('function');
        expect(harness.apiMachine.setRPCHandlers).toHaveBeenCalled();
      });

      const beforeShutdown = harness.getBeforeShutdown();
      if (!beforeShutdown) {
        throw new Error('Expected beforeShutdown to be registered');
      }

      let settled = false;
      const waitForBeforeShutdown = beforeShutdown().then(() => {
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
        backendTarget: canonicalBuiltInBackendTarget,
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
        backendTarget: canonicalBuiltInBackendTarget,
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
      expect(spawnOptions?.env?.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP).toBe('1');

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
      if (ORIGINAL_PLATFORM_DESCRIPTOR) {
        Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
      }
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
      delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
      if (ORIGINAL_PLATFORM_DESCRIPTOR) {
        Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
      }
    }
  });

});
