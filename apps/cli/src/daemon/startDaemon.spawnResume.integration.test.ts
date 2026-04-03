import { afterEach, describe, expect, it, vi } from 'vitest';

import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { waitForSessionWebhook } from './spawn/waitForSessionWebhook';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';
type BuildHappyCliSubprocessLaunchSpec = typeof import('@/utils/spawnHappyCLI').buildHappyCliSubprocessLaunchSpec;

const harness = vi.hoisted(() => {
  let resolveShutdown: ((value: { source: ShutdownSource; errorMessage?: string }) => void) | null = null;
  let requestShutdownRef: ((source: ShutdownSource, errorMessage?: string) => void) | null = null;
  let spawnSessionRef: ((options: any) => Promise<any>) | null = null;
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
    setBeforeShutdown: (fn: () => Promise<void>) => {
      beforeShutdownRef = fn;
    },
    getBeforeShutdown: () => beforeShutdownRef,
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
  },
}));

vi.mock('@/integrations/caffeinate', () => ({
  startCaffeinate: vi.fn(() => false),
  stopCaffeinate: vi.fn(async () => {}),
}));

vi.mock('@/ui/doctor', () => ({
  getEnvironmentInfo: vi.fn(() => ({})),
}));

const spawnHappyCLI = vi.fn((argv: string[], _opts?: unknown) => ({
  pid: 12345,
  stdout: null,
  stderr: null,
  on: vi.fn(),
}));

vi.mock('@/utils/spawnHappyCLI', () => ({
  buildHappyCliSubprocessLaunchSpec: vi.fn<BuildHappyCliSubprocessLaunchSpec>(),
  spawnHappyCLI,
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

vi.mock('./controlServer', () => ({
  startDaemonControlServer: vi.fn(async ({
    spawnSession,
    beforeShutdown,
  }: {
    spawnSession: (options: any) => Promise<any>;
    beforeShutdown?: () => Promise<void>;
  }) => {
    harness.setSpawnSession(spawnSession);
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
  reattachTrackedSessionsFromMarkers: vi.fn(async () => {}),
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
