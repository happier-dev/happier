import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { configuration } from '@/configuration';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createLocalSessionHandoffMetadataStore } from '@/session/handoff/metadata/localSessionHandoffMetadataStore';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { waitForSessionWebhook } from './spawn/waitForSessionWebhook';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';
type BuildHappyCliSubprocessLaunchSpec = typeof import('@/utils/spawnHappyCLI').buildHappyCliSubprocessLaunchSpec;
type ReattachTrackedSessionsFromMarkers = typeof import('./sessions/reattachFromMarkers').reattachTrackedSessionsFromMarkers;
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');
const loggerDebug = vi.hoisted(() => vi.fn());
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
  let stopSessionRef: ((sessionId: string) => Promise<import('./sessions/stopSessionContract').StopSessionResult>) | null = null;
  let beforeShutdownRef: (() => Promise<void>) | null = null;
  let machineConnectionStateListener: ((state: any) => void) | null = null;
  const credentials = {
    token: 'token-daemon',
    encryption: {
      type: 'dataKey' as const,
      publicKey: new Uint8Array(32).fill(1),
      machineKey: new Uint8Array(32).fill(2),
    },
  };

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
    setRPCHandlers: vi.fn(() => ({
      externalSessionPluginAdmissionOwner: undefined,
    })),
    getPeerMediationMachineRpcHandlerManager: vi.fn(() => ({
      invokeLocal: vi.fn(async () => ({ ok: true })),
    })),
    registerLocalServicesPreviewRoutes: vi.fn(),
    registerLocalServicesRoutes: vi.fn(),
    registerBrowserControlRoutes: vi.fn(),
    registerBrowserContextRoutes: vi.fn(),
    registerBrowserDiagnosticsRoutes: vi.fn(),
    registerBrowserRecordingRoutes: vi.fn(),
    registerSimulatorPreviewRoutes: vi.fn(),
    registerConnectedAccountDaemonRuntime: vi.fn(),
    registerConnectedAccountPurposeBindingRuntime: vi.fn(),
    registerLiveStreamRelayRoutes: vi.fn(),
    onUpdate: vi.fn(() => () => {}),
    onAccountSettingsVersionHint: vi.fn(() => () => {}),
    onPendingSessionActivationHint: vi.fn(() => () => {}),
    onConnectedServicesProjection: vi.fn(() => () => {}),
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
    onMachineTransferEnvelope: vi.fn(() => () => {}),
    sendMachineTransferEnvelope: vi.fn(),
    onTransferRelayV2Envelope: vi.fn(() => () => {}),
    sendTransferRelayV2Envelope: vi.fn(),
    onPeerTcpTunnelRelayEnvelope: vi.fn(() => () => {}),
    sendPeerTcpTunnelRelayEnvelope: vi.fn(),
    onMachineLiveStreamRelayEnvelope: vi.fn(() => () => {}),
    sendMachineLiveStreamRelayEnvelope: vi.fn(),
    emitExternalSessionTranscriptUpdate: vi.fn(),
    executeExternalSessionHistoricalImportCommand: vi.fn(async () => ({ ok: true })),
  };

  return {
    apiMachine,
    credentials,
    createDaemonShutdownController,
    requestShutdown: (source: ShutdownSource) => requestShutdownRef?.(source),
    setSpawnSession: (fn: (options: any) => Promise<any>) => {
      spawnSessionRef = fn;
    },
    getSpawnSession: () => spawnSessionRef,
    setStopSession: (fn: (sessionId: string) => Promise<import('./sessions/stopSessionContract').StopSessionResult>) => {
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
      machineSyncClient: vi.fn(() => harness.apiMachine),
      setServerFeaturesSnapshotProvider: vi.fn(),
      createBrowserRuntimeActionExecutor: vi.fn(() => vi.fn()),
      getAccountEncryptionMode: vi.fn(async () => 'plain'),
      getConnectedServiceAuthGroup: vi.fn(async () => null),
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

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: vi.fn(async () => ({
    status: 'unsupported',
    reason: 'endpoint_missing',
  })),
}));

vi.mock('@happier-dev/cli-common/tailscale', async (importOriginal) => ({
  ...await importOriginal<typeof import('@happier-dev/cli-common/tailscale')>(),
  runTailscaleStatusJson: vi.fn(async () => {
    throw new Error('tailscale unavailable in daemon test');
  }),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: loggerDebug,
    debugLargeJson: vi.fn(),
    info: vi.fn(),
    infoFile: vi.fn(),
    warn: vi.fn(),
    flushSync: vi.fn(),
    logFilePath: '/tmp/happier-daemon.log',
  },
}));

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: vi.fn(async () => ({
    credentials: harness.credentials,
    machineId: 'machine-1',
  })),
}));

vi.mock('@/settings/accountSettings/updateAccountSettingsV2WithRetry', () => {
  let settings: Record<string, unknown> = {};
  let version = 0;
  const updateSettings = vi.fn(async (input: Readonly<{
    mutate?: (current: Readonly<Record<string, unknown>>) => Record<string, unknown>;
    mutation?: Readonly<{ operations: readonly Readonly<
      | { op: 'set'; key: string; value: unknown }
      | { op: 'reset'; key: string }
    >[] }>;
  }>) => {
    if (input.mutation) {
      const next = { ...settings };
      for (const operation of input.mutation.operations) {
        if (operation.op === 'set') next[operation.key] = operation.value;
        else delete next[operation.key];
      }
      settings = next;
    } else if (input.mutate) {
      settings = input.mutate(settings);
    } else {
      throw new Error('Expected Account Settings mutation');
    }
    version += 1;
    return { status: 'applied' as const, settings, version };
  });
  return {
    updateAccountSettingsV2WithRetry: updateSettings,
    updateAccountSettingsV2Once: updateSettings,
    requireAccountSettingsMutationSuccess: (result: Readonly<{ status?: unknown }>) => {
      if (result.status === 'applied' || result.status === 'satisfied' || result.status === 'unchanged') return result;
      throw new Error(`Account Settings mutation did not settle: ${String(result.status)}`);
    },
  };
});

vi.mock('@/configuration', () => ({
  configuration: {
    privateKeyFile: '/tmp/key',
    happyHomeDir: '/tmp/happy-home',
    activeServerDir: '/tmp/happy-home/servers/active',
    activeServerId: 'default',
    currentCliVersion: '0.0.0-test',
    publicReleaseRing: 'publicdev',
    serverUrl: 'http://localhost:9999',
    apiServerUrl: 'http://localhost:9999',
    webappUrl: 'http://localhost:3000',
    deviceLocalSecretKeyFile: '/tmp/happy-home/device-local-secret.key',
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
  createSessionRunnerRespawnManager: vi.fn((params: { enabled: boolean }) => {
    const freshResumeCommits: Array<ReturnType<typeof vi.fn>> = [];
    const manager = {
      markStopRequested: vi.fn(),
      prepareFreshExplicitResumeAdmission: vi.fn(() => {
        const commit = vi.fn();
        freshResumeCommits.push(commit);
        return commit;
      }),
      handleUnexpectedExit: vi.fn(),
      freshResumeCommits,
      __params: params,
    };
    sessionRespawnManagerCapture.managers.push(manager);
    return manager;
  }),
  managers: [] as Array<{
    markStopRequested: ReturnType<typeof vi.fn>;
    prepareFreshExplicitResumeAdmission: ReturnType<typeof vi.fn>;
    handleUnexpectedExit: ReturnType<typeof vi.fn>;
    freshResumeCommits: Array<ReturnType<typeof vi.fn>>;
    __params: { enabled: boolean };
  }>,
}));

const onChildExitedCapture = vi.hoisted(() => {
  const onChildExited = vi.fn();
  return {
    onChildExited,
    createOnChildExited: vi.fn(({ pidToTrackedSession }: { pidToTrackedSession: Map<number, any> }) =>
      vi.fn(async (pid: number, exit: { reason: string; code: number | null; signal: string | null }) => {
        onChildExited(pid, exit);
        pidToTrackedSession.delete(pid);
      })),
  };
});

const stopSessionCapture = vi.hoisted(() => ({
  implementation: null as null | ((
    sessionId: string,
    pidToTrackedSession: Map<number, any>,
  ) => Promise<import('./sessions/stopSessionContract').StopSessionResult>),
  createStopSession: vi.fn<typeof import('./sessions/stopSession').createStopSession>(),
}));

const reattachTrackedSessionsFromMarkersMock = vi.hoisted(() => vi.fn<ReattachTrackedSessionsFromMarkers>(async () => ({
  orphanedDeadDaemonSessions: [],
  connectedServiceRestartIntents: [],
})));
const ensureSessionMachineAccessKeyBindingMock = vi.hoisted(() => vi.fn(async () => {}));
const fetchAccountEncryptionCurrentnessMock = vi.hoisted(() => vi.fn(async () => ({
  mode: 'plain' as const,
  version: 1,
  signingKeyFingerprint: null,
  contentKeyFingerprint: null,
  updatedAt: 1,
})));

const buildHappyCliSubprocessLaunchSpecMock = vi.hoisted(
  () => vi.fn<BuildHappyCliSubprocessLaunchSpec>(),
);

const resolveWindowsRemoteSessionConsoleModeMock = vi.hoisted(() => vi.fn(() => 'hidden' as const));

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

const dispatchDaemonSpawnHookEventMock = vi.hoisted(() => vi.fn(async ({ event }: { event: { eventId: string } }) => ({
  eventId: event.eventId,
  matchedHandlerCount: 0,
  outcomes: [],
  aggregate: event.eventId === 'agent.spawnEnv.augment'
    ? { executionKind: 'augment', result: {} }
    : { executionKind: 'decide', result: { allowed: true } },
})));

vi.mock('@/utils/spawnHappyCLI', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/spawnHappyCLI')>()),
  buildHappyCliSubprocessLaunchSpec: buildHappyCliSubprocessLaunchSpecMock,
  buildHappyCliSubprocessInvocation: vi.fn((args: string[]) => ({
    runtime: 'node',
    argv: ['/tmp/happier-runtime', ...args],
  })),
  resolveHappyCliSubprocessRuntimeDecision: vi.fn(() => ({
    runtime: 'node',
    argvPrefix: ['/tmp/happier-runtime'],
  })),
  pruneHappyCliRunnerSnapshots: vi.fn(),
  spawnHappyCLI,
}));

vi.mock('@/plugins/runtime/hooks/execution/dispatchDaemonSpawnHookEvent', () => ({
  dispatchDaemonSpawnHookEvent: dispatchDaemonSpawnHookEventMock,
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
  resolveWindowsRemoteSessionConsoleMode: resolveWindowsRemoteSessionConsoleModeMock,
}));

vi.mock('./platform/windows/spawnHappyCliVisibleConsole', () => ({
  startHappySessionInVisibleWindowsConsole: vi.fn(async () => ({ ok: true, pid: 7777 })),
}));

vi.mock('./platform/windows/spawnHappyCliWindowsTerminal', () => ({
  startHappySessionInWindowsTerminal: vi.fn(async () => ({ ok: true, pid: 8888 })),
}));

vi.mock('@/session/runtime/catalogHooks', () => ({
  getVendorResumeSupport: vi.fn(async () => () => true),
}));

vi.mock('@/persistence', () => ({
  writeDaemonState: vi.fn(),
  writeDaemonStateForLockOwner: vi.fn(() => true),
  clearDaemonStateForLockOwner: vi.fn(() => true),
  clearDaemonStateForTestTeardown: vi.fn(async () => {}),
  acquireDaemonLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
  releaseDaemonLock: vi.fn(async () => {}),
  readCredentials: vi.fn(async () => harness.credentials),
  readStoredCredentials: vi.fn(async () => harness.credentials),
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
    stopSession: (sessionId: string) => Promise<import('./sessions/stopSessionContract').StopSessionResult>;
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
  reattachTrackedSessionsFromMarkers: reattachTrackedSessionsFromMarkersMock,
}));

vi.mock('@/api/session/ensureSessionMachineAccessKeyBinding', () => ({
  ensureSessionMachineAccessKeyBinding: ensureSessionMachineAccessKeyBindingMock,
}));

vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
  fetchAccountEncryptionCurrentness: fetchAccountEncryptionCurrentnessMock,
}));

vi.mock('./sessions/onHappySessionWebhook', async (importOriginal) => ({
  ...await importOriginal<typeof import('./sessions/onHappySessionWebhook')>(),
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

vi.mock('./sessions/stopSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessions/stopSession')>();
  stopSessionCapture.createStopSession.mockImplementation((params) => {
    const realStopSession = actual.createStopSession({
      ...params,
      readHostAttachmentState: async () => ({ status: 'absent' }),
    });
    return async (sessionId) => {
      if (stopSessionCapture.implementation) {
        return await stopSessionCapture.implementation(sessionId, params.pidToTrackedSession);
      }
      return await realStopSession(sessionId);
    };
  });
  return {
    ...actual,
    createStopSession: stopSessionCapture.createStopSession,
  };
});

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

vi.mock('./voiceInference/voiceInferenceWorker', () => ({
  startVoiceInferenceWorker: vi.fn(async () => null),
}));

vi.mock('./shutdownPolicy', () => ({
  getDaemonShutdownExitCode: vi.fn(() => 0),
  getDaemonShutdownWatchdogTimeoutMs: vi.fn(() => 10_000),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionsPage: vi.fn(async () => ({
    sessions: [],
    nextCursor: null,
    hasNext: false,
  })),
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

async function waitForSpawnSession(): Promise<NonNullable<ReturnType<typeof harness.getSpawnSession>>> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const spawnSession = harness.getSpawnSession();
    if (spawnSession) return spawnSession;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected spawnSession to be registered');
}

async function waitForStopSession(): Promise<NonNullable<ReturnType<typeof harness.getStopSession>>> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const stopSession = harness.getStopSession();
    if (stopSession) return stopSession;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected stopSession to be registered');
}

async function waitForRespawnManagerCreation(): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (sessionRespawnManagerCapture.createSessionRunnerRespawnManager.mock.calls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const fatalLog = loggerDebug.mock.calls.find(([message]) =>
    typeof message === 'string' && message.includes('[FATAL]'));
  throw new Error(
    fatalLog
      ? `Expected session respawn manager to be created; daemon startup failed: ${JSON.stringify(fatalLog[1])}`
      : 'Expected session respawn manager to be created',
  );
}

describe('startDaemon spawn resume wiring (integration)', () => {
  const canonicalBuiltInBackendTarget = {
    kind: 'backend',
    backendId: 'codex',
    sourceKind: 'built_in',
  } as const;
  const canonicalCodexAcpRuntimeDescriptor = {
    v: 1 as const,
    agentId: 'codex',
    agent: { backendMode: 'acp' },
  };
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
    vi.clearAllMocks();
    vi.resetModules();
    harness.resetControlRefs();
    harness.apiMachine.setRPCHandlers.mockClear();
    harness.apiMachine.awaitPendingRpcRequests.mockClear();
    harness.apiMachine.awaitPendingRpcRequests.mockImplementation(async () => {});
    spawnHappyCLI.mockClear();
    spawnChildProcess.mockClear();
    onChildExitedCapture.onChildExited.mockClear();
    onChildExitedCapture.createOnChildExited.mockClear();
    stopSessionCapture.createStopSession.mockClear();
    stopSessionCapture.implementation = null;
    reattachTrackedSessionsFromMarkersMock.mockReset();
    reattachTrackedSessionsFromMarkersMock.mockImplementation(async () => ({
      orphanedDeadDaemonSessions: [],
      connectedServiceRestartIntents: [],
    }));
    ensureSessionMachineAccessKeyBindingMock.mockReset();
    ensureSessionMachineAccessKeyBindingMock.mockResolvedValue(undefined);
    fetchAccountEncryptionCurrentnessMock.mockReset();
    fetchAccountEncryptionCurrentnessMock.mockResolvedValue({
      mode: 'plain',
      version: 1,
      signingKeyFingerprint: null,
      contentKeyFingerprint: null,
      updatedAt: 1,
    });
    buildHappyCliSubprocessLaunchSpecMock.mockReset();
    resolveWindowsRemoteSessionConsoleModeMock.mockReset();
    resolveWindowsRemoteSessionConsoleModeMock.mockReturnValue('hidden');
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
    sessionRespawnManagerCapture.managers.length = 0;
    loggerDebug.mockClear();
  });

  it('binds startup-reattached live sessions to the daemon final machine identity', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      reattachTrackedSessionsFromMarkersMock.mockImplementation(async ({ pidToTrackedSession }) => {
        pidToTrackedSession.set(7788, {
          pid: 7788,
          startedBy: 'daemon',
          happySessionId: 'session-reattached-control',
          reattachedFromDiskMarker: true,
        });
        return {
          orphanedDeadDaemonSessions: [],
          recoveredLiveSessionIds: ['session-reattached-control'],
          connectedServiceRestartIntents: [],
        };
      });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      await vi.waitFor(() => expect(ensureSessionMachineAccessKeyBindingMock).toHaveBeenCalledWith({
        serverUrl: 'http://localhost:9999',
        token: 'token-daemon',
        sessionId: 'session-reattached-control',
        machineId: 'machine-1',
      }));

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run.catch(() => {});
      }
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('enables daemon session runner respawn by default (runner death is non-fatal, adopt-first)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    delete process.env.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED;

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      await waitForRespawnManagerCreation();

      expect(sessionRespawnManagerCapture.createSessionRunnerRespawnManager).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
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

  it('disables daemon session runner respawn when the opt-out env is set to false', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED = 'false';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      await waitForRespawnManagerCreation();

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
      delete process.env.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED;
      exitSpy.mockRestore();
    }
  });

  it('waits for a stop-requested tracked runner to be observed exited before stop returns', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
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
          childProcess: {
            pid: 6480,
            exitCode: null,
            signalCode: null,
            kill: vi.fn(() => true),
          },
        } as any);
        return { orphanedDeadDaemonSessions: [], connectedServiceRestartIntents: [] };
      });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      const stopSession = await waitForStopSession();

      await expect(stopSession('sess-stop-6480')).resolves.toEqual({ status: 'stopped' });

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
      killSpy.mockRestore();
    }
  });

  it('does not let a concurrent resume pass the existing-session gate until the full stop aggregate settles', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let releaseStop!: () => void;
    const stopDisposition = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let run: Promise<void> | null = null;

    try {
      vi.resetModules();
      harness.resetControlRefs();
      stopSessionCapture.implementation = async (_sessionId, pidToTrackedSession) => {
        pidToTrackedSession.delete(6481);
        await stopDisposition;
        return { status: 'stopped' };
      };
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async ({ pidToTrackedSession }) => {
        pidToTrackedSession.set(6481, {
          pid: 6481,
          startedBy: 'daemon',
          happySessionId: 'sess-stop-resume-barrier',
          reattachedFromDiskMarker: true,
        } as any);
        return { orphanedDeadDaemonSessions: [], connectedServiceRestartIntents: [] };
      });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      const spawnSession = await waitForSpawnSession();
      const stopSession = harness.getStopSession();
      if (!stopSession) throw new Error('Expected stopSession to be registered');

      const stopPromise = stopSession('sess-stop-resume-barrier');
      let resumeSettled = false;
      const resumePromise = spawnSession({
        directory: '/tmp',
        backendTarget: canonicalBuiltInBackendTarget,
        existingSessionId: 'sess-stop-resume-barrier',
        token: 't',
        runtimeDescriptorV1: canonicalCodexAcpRuntimeDescriptor,
      }).finally(() => {
        resumeSettled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(resumeSettled).toBe(false);

      releaseStop();
      await expect(stopPromise).resolves.toEqual({ status: 'stopped' });
      await expect(resumePromise).resolves.toEqual(expect.objectContaining({ type: 'success' }));
    } finally {
      releaseStop?.();
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      exitSpy.mockRestore();
    }
  });

  it('restores crash respawn only after a stopped existing session is explicitly resumed successfully', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      vi.resetModules();
      harness.resetControlRefs();
      stopSessionCapture.implementation = async (_sessionId, pidToTrackedSession) => {
        pidToTrackedSession.delete(6482);
        return { status: 'stopped' };
      };
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async ({ pidToTrackedSession }) => {
        pidToTrackedSession.set(6482, {
          pid: 6482,
          startedBy: 'daemon',
          happySessionId: 'sess-stop-resume-respawn',
          reattachedFromDiskMarker: true,
          spawnOptions: {
            directory: '/tmp',
            backendTarget: canonicalBuiltInBackendTarget,
          },
        } as any);
        return { orphanedDeadDaemonSessions: [], connectedServiceRestartIntents: [] };
      });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      const spawnSession = await waitForSpawnSession();
      const stopSession = harness.getStopSession();
      if (!stopSession) throw new Error('Expected stopSession to be registered');

      await expect(stopSession('sess-stop-resume-respawn')).resolves.toEqual({ status: 'stopped' });
      await expect(spawnSession({
        directory: '/tmp',
        backendTarget: canonicalBuiltInBackendTarget,
        existingSessionId: 'sess-stop-resume-respawn',
        token: 't',
        runtimeDescriptorV1: canonicalCodexAcpRuntimeDescriptor,
      })).resolves.toEqual(expect.objectContaining({ type: 'success' }));

      const manager = sessionRespawnManagerCapture.managers.at(-1);
      if (!manager) throw new Error('Expected session respawn manager');
      expect(manager.prepareFreshExplicitResumeAdmission).toHaveBeenCalledWith('sess-stop-resume-respawn');
      expect(manager.freshResumeCommits).toHaveLength(1);
      expect(manager.freshResumeCommits[0]).toHaveBeenCalledTimes(1);

      const childExitOwnerCalls = onChildExitedCapture.createOnChildExited.mock.calls as unknown as Array<[{
        onUnexpectedExit?: (tracked: unknown, exit: unknown) => void;
      }]>;
      const childExitOwnerParams = childExitOwnerCalls.at(-1)?.[0];
      childExitOwnerParams?.onUnexpectedExit?.({
        pid: 6483,
        startedBy: 'daemon',
        happySessionId: 'sess-stop-resume-respawn',
        spawnOptions: {
          directory: '/tmp',
          backendTarget: canonicalBuiltInBackendTarget,
        },
      }, {
        reason: 'process-exited',
        code: 1,
        signal: null,
      });
      expect(manager.handleUnexpectedExit).toHaveBeenCalledWith(
        expect.objectContaining({ happySessionId: 'sess-stop-resume-respawn', pid: 6483 }),
        { reason: 'process-exited', code: 1, signal: null },
        expect.any(Object),
      );
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
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

      const spawnSession = await waitForSpawnSession();

      await spawnSession({
        directory: '/tmp',
        backendTarget: canonicalBuiltInBackendTarget,
        existingSessionId: 'sess_plain',
        token: 't',
        runtimeDescriptorV1: canonicalCodexAcpRuntimeDescriptor,
      });

      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const firstCall = spawnHappyCLI.mock.calls[0];
      if (!firstCall) {
        throw new Error('Expected spawnHappyCLI to be called');
      }
      const argv = firstCall[0];
      expect(argv).toEqual(expect.arrayContaining(['--existing-session', 'sess_plain']));
      expect(argv).toEqual(expect.arrayContaining(['--resume', 'vendor-plain-1']));
      expect(firstCall[2]).toEqual(expect.objectContaining({ preferWindowsPackagedBinary: true }));

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

      const spawnSession = await waitForSpawnSession();

      await spawnSession({
        directory: '/tmp',
        backendTarget: canonicalBuiltInBackendTarget,
        token: 't',
        runtimeDescriptorV1: canonicalCodexAcpRuntimeDescriptor,
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

  it('waits for webhook proof instead of passing an existing session id shortcut for attach spawns', async () => {
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

      const spawnSession = await waitForSpawnSession();

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: canonicalBuiltInBackendTarget,
        existingSessionId: 'sess_plain',
        token: 't',
        runtimeDescriptorV1: canonicalCodexAcpRuntimeDescriptor,
      });

      expect(result).toEqual({ type: 'success', sessionId: 'sess_plain' });
      expect(waitForSessionWebhookMock).toHaveBeenCalledTimes(1);
      const firstCall = waitForSessionWebhookMock.mock.calls[0]?.[0];
      expect(firstCall).not.toHaveProperty('resolveExistingSessionId');

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

    const waitForSessionWebhookMock = vi.mocked(waitForSessionWebhook);
    let resolveWebhook: ((result: SpawnSessionResult) => void) | null = null;
    const readResolveWebhook = (): ((result: SpawnSessionResult) => void) => {
      const resolver = resolveWebhook;
      if (!resolver) {
        throw new Error('Expected session webhook waiter to be registered');
      }
      return resolver;
    };
    waitForSessionWebhookMock.mockImplementationOnce(async () => await new Promise<SpawnSessionResult>((resolve) => {
      resolveWebhook = resolve;
    }));

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = await waitForSpawnSession();

      let settled = false;
      const resultPromise = spawnSession({
        directory: '/tmp',
        backendTarget: canonicalBuiltInBackendTarget,
        existingSessionId: 'sess_plain',
        token: 't',
        runtimeDescriptorV1: canonicalCodexAcpRuntimeDescriptor,
      }).then((result) => {
        settled = true;
        return result;
      });

      await vi.waitFor(() => {
        expect(resolveWebhook).toBeTypeOf('function');
      });
      expect(settled).toBe(false);

      readResolveWebhook()({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
        errorMessage: 'Child process exited before session webhook (pid=12345, code=1, signal=null)',
      });

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

      const spawnSession = await waitForSpawnSession();

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

      const spawnSession = await waitForSpawnSession();

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: canonicalBuiltInBackendTarget,
        existingSessionId: 'sess_missing',
        token: 't',
        runtimeDescriptorV1: canonicalCodexAcpRuntimeDescriptor,
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

      const spawnSession = await waitForSpawnSession();

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

      const spawnSession = await waitForSpawnSession();

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

      const spawnSession = await waitForSpawnSession();

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

      const spawnSession = await waitForSpawnSession();

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: canonicalBuiltInBackendTarget,
        existingSessionId: 'sess_fetch_error',
        token: 't',
        runtimeDescriptorV1: canonicalCodexAcpRuntimeDescriptor,
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

      const spawnSession = await waitForSpawnSession();

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: canonicalBuiltInBackendTarget,
        existingSessionId: 'sess_plain',
        token: 't',
        runtimeDescriptorV1: canonicalCodexAcpRuntimeDescriptor,
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
    const catalogRegistry = await import('@/agent/catalog/registry');
    const realRequireCatalogEntry = catalogRegistry.requireCatalogEntry;
    const requireCatalogEntrySpy = vi.spyOn(catalogRegistry, 'requireCatalogEntry')
      .mockImplementation((agentId) => {
        const entry = realRequireCatalogEntry(agentId);
        if (agentId !== 'claude') return entry;
        return {
          ...entry,
          getDaemonSpawnHooks: async () => ({
            resolveRuntimePrerequisites: async () => ({ ok: true as const }),
            augmentEnv: (): Record<string, string> => {
              const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
              return claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {};
            },
          }),
        };
      });
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-config';
    delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;

    try {
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');

      const trackedSessionCapture: {
        current: Map<number, {
          pid: number;
          spawnOptions?: {
            environmentVariables?: Record<string, string>;
          };
        }> | null;
      } = { current: null };

      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ pidToTrackedSession }) => {
        trackedSessionCapture.current = pidToTrackedSession as typeof trackedSessionCapture.current;
        return vi.fn();
      });

      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = await waitForSpawnSession();

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
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      requireCatalogEntrySpy.mockRestore();
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

      const spawnSession = await waitForSpawnSession();

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

      const spawnSession = await waitForSpawnSession();

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

      const spawnSession = await waitForSpawnSession();

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

  it('registers a beforeShutdown drain with the control server', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await vi.waitFor(() => {
        expect(harness.getBeforeShutdown()).toBeTypeOf('function');
      }, { timeout: 5_000 });

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

      const spawnSession = await waitForSpawnSession();

      await spawnSession({
        directory: '/tmp',
        backendTarget: canonicalBuiltInBackendTarget,
        existingSessionId: 'sess_plain',
        token: 't',
        runtimeDescriptorV1: canonicalCodexAcpRuntimeDescriptor,
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

      const spawnSession = await waitForSpawnSession();

      await spawnSession({
        directory: '/tmp',
        backendTarget: canonicalBuiltInBackendTarget,
        token: 't',
        runtimeDescriptorV1: canonicalCodexAcpRuntimeDescriptor,
      });

      expect(spawnHappyCLI).not.toHaveBeenCalled();
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
        return { orphanedDeadDaemonSessions: [], connectedServiceRestartIntents: [] };
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
