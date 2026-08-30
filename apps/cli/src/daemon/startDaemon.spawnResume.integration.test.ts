import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY } from './platform/linux/daemonSpawnedSessionCgroupSelfMigration';
import { createHttpStatusError } from '@/api/client/httpStatusError';
import {
  listPendingQueueV2LocalIdsFromServer,
  materializeNextPendingQueueV2MessageViaHttp,
} from '@/api/session/pendingQueueV2Transport';
import { resolveConnectedServiceSwitchContinuity } from '@/backends/catalog';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import {
  HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY,
  parseSessionConnectedServicesBindingsJson,
} from '@/agent/runtime/sessionConnectedServicesBindingsEnv';
import { waitForSessionWebhook } from './spawn/waitForSessionWebhook';
import { readPendingFirstInputFromEnv } from './spawn/pendingFirstInput';
import type { ConnectedServicesMaterializationDiagnostic } from './connectedServices/materialize/providerMaterializerTypes';
import { ConnectedServiceAuthGroupQuotaProbeIncompleteError } from './connectedServices/accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { isConnectedServiceUxDiagnosticSpawnErrorDetail } from '@happier-dev/protocol';
import { UsageLimitRecoveryScheduler } from './connectedServices/usageLimitRecovery/UsageLimitRecoveryScheduler';
import { RuntimeAuthRecoveryScheduler } from './connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import { TemporaryThrottleRecoveryScheduler } from './connectedServices/temporaryThrottle/TemporaryThrottleRecoveryScheduler';
import type { StopSessionResult } from './sessions/stopSessionContract';
import type { TerminalHostAdapter } from '@/integrations/terminalHost/_types';
import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import {
  HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY,
  type AttachmentBoundClaudeEndpointState,
} from '@/backends/claude/endpointRecovery/claudeEndpointArtifacts';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';
type BuildHappyCliSubprocessLaunchSpec = typeof import('@/utils/spawnHappyCLI').buildHappyCliSubprocessLaunchSpec;
type HappyCliSubprocessRuntimeDecision = import('@/utils/spawnHappyCLI').HappyCliSubprocessRuntimeDecision;
type CreateStopSessionInput = Parameters<typeof import('./sessions/stopSession').createStopSession>[0];
type CallSessionRpc = typeof callSessionRpc;
type ReadProcessRunState = typeof import('./processRunState').readProcessRunState;
type ReadSessionRunnerLockStatus = typeof import('./sessionRunnerLock').readSessionRunnerLockStatus;

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

async function findAvailableLocalPort(excludedPort?: number): Promise<number> {
  for (;;) {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to allocate a local endpoint port'));
          return;
        }
        resolve(address.port);
      });
    });
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (port !== excludedPort) return port;
  }
}

async function createValidClaudeEndpointFixture(
  attachmentId: AttachmentBoundClaudeEndpointState['attachmentId'],
): Promise<Readonly<{
  state: AttachmentBoundClaudeEndpointState;
  cleanup: () => Promise<void>;
}>> {
  const root = await mkdtemp(join(tmpdir(), 'happier-daemon-claude-endpoint-'));
  const hookPluginDir = join(root, 'plugin');
  const hooksDir = join(hookPluginDir, 'hooks');
  const hookSettingsPath = join(root, 'settings.json');
  const hookServerPort = await findAvailableLocalPort();
  const mcpPort = await findAvailableLocalPort(hookServerPort);
  await mkdir(hooksDir, { recursive: true });
  await Promise.all([
    writeFile(join(hookPluginDir, 'permission-hook-secret'), 'permission-secret'),
    writeFile(hookSettingsPath, '{}'),
    writeFile(hookSettingsPath.replace(/\.json$/, '.statusline-secret'), 'statusline-secret'),
    writeFile(join(hooksDir, 'hooks.json'), JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: '',
          hooks: [{
            type: 'command',
            command: `node session_hook_forwarder.cjs ${hookServerPort}`,
          }],
        }],
      },
    })),
  ]);
  return {
    state: {
      v: 2,
      attachmentId,
      hookServerPort,
      hookPluginDir,
      hookSettingsPath,
      mcpUrl: `http://127.0.0.1:${mcpPort}`,
      mcpPort,
    },
    cleanup: async () => await rm(root, { recursive: true, force: true }),
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
const resolveConnectedServiceAuthForSpawnMock = vi.hoisted(() => vi.fn(async (): Promise<{
  env: Record<string, string>;
  cleanupOnFailure: (() => void) | null;
  cleanupOnExit: (() => void) | null;
  connectedServicesBindings?: {
    v: 1;
    bindingsByServiceId: Record<string, unknown>;
  };
  diagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
}> => ({
  env: { CLAUDE_CONFIG_DIR: '/tmp/claude-connected' },
  cleanupOnFailure: null,
  cleanupOnExit: null,
})));
const updateSessionMetadataWithRetryMock = vi.hoisted(() => vi.fn(async (params: {
  rawSession: { metadataVersion?: number };
  updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
}) => ({
  version: (params.rawSession.metadataVersion ?? 0) + 1,
  metadata: params.updater({}),
})));
const pendingMaterializationRpcMocks = vi.hoisted(() => {
  const ctx = { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' as const };
  return {
    ctx,
    callSessionRpc: vi.fn<CallSessionRpc>(async () => ({
      ok: true,
      didMaterialize: false,
      result: { type: 'no_pending' },
    })),
    resolveSessionTransportContext: vi.fn(async () => ({
      ok: true,
      sessionId: 'sess_plain',
      rawSession: {
        id: 'sess_plain',
        active: true,
        encryptionMode: 'plain',
      },
      mode: 'plain' as const,
      ctx,
    })),
  };
});
const stopSessionMocks = vi.hoisted(() => {
  const stopSession = vi.fn<(_: string) => Promise<StopSessionResult>>(async () => ({ status: 'stopped' }));
  return {
    stopSession,
    createStopSession: vi.fn<(_: CreateStopSessionInput) => typeof stopSession>(() => stopSession),
  };
});
const disconnectedTerminalHostSupervisionMock = vi.hoisted(() => vi.fn(async () => ({
  state: 'recoverable_unservable' as const,
  reason: 'control_descriptor_missing',
})));
const claudeEndpointRecoveryBoundaryMocks = vi.hoisted(() => ({
  readTerminalAttachmentInfo: vi.fn<() => Promise<TerminalAttachmentInfo | null>>(async () => null),
  removeTerminalAttachmentInfo: vi.fn(async () => false),
  readClaudeEndpointDescriptor: vi.fn<() => Promise<AttachmentBoundClaudeEndpointState | null>>(async () => null),
  evaluateLiveness: vi.fn<TerminalHostAdapter['evaluateLiveness']>(async () => ({ paneAlive: true, observedAt: 1 })),
  dispose: vi.fn<TerminalHostAdapter['dispose']>(async () => {}),
}));
const sessionRunnerActivityBoundaryMocks = vi.hoisted(() => ({
  readProcessRunState: vi.fn<ReadProcessRunState>(async () => 'dead'),
  readSessionRunnerLockStatus: vi.fn<ReadSessionRunnerLockStatus>(async () => ({ ok: false, reason: 'not_found' })),
}));
const ensureSessionMachineAccessKeyBindingMock = vi.hoisted(() => vi.fn(async () => {}));
const harness = vi.hoisted(() => {
  let resolveShutdown: ((value: { source: ShutdownSource; errorMessage?: string }) => void) | null = null;
  let requestShutdownRef: ((source: ShutdownSource, errorMessage?: string) => void) | null = null;
  let spawnSessionRef: ((options: any, hooks?: any) => Promise<any>) | null = null;
  let stopSessionRef: ((sessionId: string) => Promise<import('./sessions/stopSessionContract').StopSessionResult>) | null = null;
  let prepareStopSessionRef: ((child: any) => Promise<void> | void) | null = null;
  let beforeShutdownRef: (() => Promise<void>) | null = null;
  let isShuttingDownRef: (() => boolean) | null = null;
  let turnLifecycleHandlerRef: ((input: {
    sessionId: string;
    event: string;
    terminalStatus?: string;
  }) => Promise<unknown>) | null = null;
  let resolveSpawnSessionByNonceRef: ((spawnNonce: string) => Promise<unknown> | unknown) | null = null;
  let pendingSessionActivationHintListenerRef: ((hint: {
    sessionId: string;
    requestId: string;
    pendingVersion: number;
    source: 'changes' | 'live';
  }) => Promise<void> | void) | null = null;

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
    recoverDaemonTerminalSessionMutationJournals: vi.fn(async () => {}),
    enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => {}),
    setRPCHandlers: vi.fn(),
    onUpdate: vi.fn(),
    onAccountSettingsVersionHint: vi.fn(() => () => {}),
    onPendingSessionActivationHint: vi.fn((listener) => {
      pendingSessionActivationHintListenerRef = listener;
      return () => {
        if (pendingSessionActivationHintListenerRef === listener) {
          pendingSessionActivationHintListenerRef = null;
        }
      };
    }),
    onConnectedServicesProjectionChange: vi.fn(() => () => {}),
    onConnectionStateChange: vi.fn(() => () => {}),
    onMachineTransferEnvelope: vi.fn(() => () => {}),
    sendMachineTransferEnvelope: vi.fn(async () => {}),
    connect: vi.fn(),
    updateMachineMetadata: vi.fn(async () => {}),
    updateDaemonState: vi.fn(async () => {}),
    awaitPendingRpcRequests: vi.fn(async () => {}),
    getActiveRpcHandlerExecutions: vi.fn(() => []),
    shutdown: vi.fn(),
  };

  return {
    apiMachine,
    createDaemonShutdownController,
    requestShutdown: (source: ShutdownSource) => requestShutdownRef?.(source),
    setSpawnSession: (fn: (options: any, hooks?: any) => Promise<any>) => {
      spawnSessionRef = fn;
    },
    getSpawnSession: () => spawnSessionRef,
    setResolveSpawnSessionByNonce: (fn: (spawnNonce: string) => Promise<unknown> | unknown) => {
      resolveSpawnSessionByNonceRef = fn;
    },
    getResolveSpawnSessionByNonce: () => resolveSpawnSessionByNonceRef,
    setStopSession: (fn: (sessionId: string) => Promise<import('./sessions/stopSessionContract').StopSessionResult>) => {
      stopSessionRef = fn;
    },
    getStopSession: () => stopSessionRef,
    setPrepareStopSession: (fn: (child: any) => Promise<void> | void) => {
      prepareStopSessionRef = fn;
    },
    getPrepareStopSession: () => prepareStopSessionRef,
    setBeforeShutdown: (fn: () => Promise<void>) => {
      beforeShutdownRef = fn;
    },
    getBeforeShutdown: () => beforeShutdownRef,
    setIsShuttingDown: (fn: () => boolean) => {
      isShuttingDownRef = fn;
    },
    getIsShuttingDown: () => isShuttingDownRef,
    setTurnLifecycleHandler: (fn: (input: {
      sessionId: string;
      event: string;
      terminalStatus?: string;
    }) => Promise<unknown>) => {
      turnLifecycleHandlerRef = fn;
    },
    getTurnLifecycleHandler: () => turnLifecycleHandlerRef,
    emitPendingSessionActivationHint: async (hint: {
      sessionId: string;
      requestId: string;
      pendingVersion: number;
      source: 'changes' | 'live';
    }) => await pendingSessionActivationHintListenerRef?.(hint),
    resetControlRefs: () => {
      spawnSessionRef = null;
      stopSessionRef = null;
      prepareStopSessionRef = null;
      beforeShutdownRef = null;
      isShuttingDownRef = null;
      turnLifecycleHandlerRef = null;
      resolveSpawnSessionByNonceRef = null;
      pendingSessionActivationHintListenerRef = null;
    },
  };
});

async function waitForSpawnSessionRegistration() {
  let spawnSession = harness.getSpawnSession();
  for (let attempt = 0; attempt < 500 && !spawnSession; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    spawnSession = harness.getSpawnSession();
  }
  if (!spawnSession) {
    throw new Error('Expected spawnSession to be registered');
  }
  return spawnSession;
}

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

vi.mock('@/api/session/ensureSessionMachineAccessKeyBinding', () => ({
  ensureSessionMachineAccessKeyBinding: ensureSessionMachineAccessKeyBindingMock,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    info: vi.fn(),
    infoFile: vi.fn(),
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
    activeServerId: 'test-server',
    apiServerUrl: 'http://localhost:9999',
    currentCliVersion: '0.0.0-test',
    installationIdentityFile: '/tmp/happy-home/installation-identity.json',
    publicReleaseRing: 'stable',
    serverUrl: 'http://localhost:9999',
    webappUrl: 'http://localhost:9999',
    daemonSpawnExistingSessionWaitForExitMs: 5_000,
    daemonSpawnExistingSessionWaitForExitPollIntervalMs: 50,
    daemonReattachCatchUpConcurrency: 4,
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
const resolveHappyCliSubprocessRuntimeDecision = vi.hoisted(() =>
  vi.fn<() => HappyCliSubprocessRuntimeDecision | null>(() => null),
);

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

const sessionRespawnManagerCapture = vi.hoisted(() => {
  const capture = {
    instances: [] as Array<{
      markStopRequested: ReturnType<typeof vi.fn>;
      clearStopRequested: ReturnType<typeof vi.fn>;
      handleUnexpectedExit: ReturnType<typeof vi.fn>;
      __params: {
        enabled: boolean;
        spawnSession: (options: import('@/rpc/handlers/registerSessionHandlers').SpawnSessionOptions) => Promise<unknown>;
        resolveRespawnOptions?: import('./processSupervision/sessionRunnerRespawn').SessionRunnerRespawnOptionsResolver;
        onRespawnSuccess?: (input: { sessionId: string; previousPid: number; result: unknown }) => void;
        onRespawnTerminal?: (input: {
          sessionId: string;
          previousPid: number;
          reason: string;
          detail?: string;
        }) => void;
      };
    }>,
    createSessionRunnerRespawnManager: vi.fn((params: {
      enabled: boolean;
      spawnSession: (options: import('@/rpc/handlers/registerSessionHandlers').SpawnSessionOptions) => Promise<unknown>;
      resolveRespawnOptions?: import('./processSupervision/sessionRunnerRespawn').SessionRunnerRespawnOptionsResolver;
      onRespawnSuccess?: (input: { sessionId: string; previousPid: number; result: unknown }) => void;
      onRespawnTerminal?: (input: {
        sessionId: string;
        previousPid: number;
        reason: string;
        detail?: string;
      }) => void;
    }) => {
      const manager = {
        markStopRequested: vi.fn(),
        clearStopRequested: vi.fn(),
        handleUnexpectedExit: vi.fn(),
        __params: params,
      };
      capture.instances.push(manager);
      return manager;
    }),
  };
  return capture;
});
const sessionRegistryCapture = vi.hoisted(() => ({
  clearSessionMarkerConnectedServiceRestartIntent: vi.fn(async (_pid: number) => {}),
  refreshSessionMarkerRespawn: vi.fn(async () => {}),
  removeSessionMarker: vi.fn(async (_pid: number) => {}),
  writeSessionMarker: vi.fn(async (_marker: { respawn?: Record<string, unknown> }) => {}),
}));
const orphanedStartupSessionEndsCapture = vi.hoisted(() => ({
  publishOrphanedStartupSessionEnds: vi.fn((_params: {
    orphanedDeadDaemonSessions: ReadonlyArray<{ sessionId: string; pid: number }>;
  }) => {}),
}));
const providerActivityRecorderCapture = vi.hoisted(() => ({
  record: vi.fn(async () => {}),
  createConnectedServiceProviderActivityProofRecorder: vi.fn(() => providerActivityRecorderCapture.record),
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

const applySpawnedChildOomScoreAdjustmentMock = vi.hoisted(() => vi.fn(async () => false));

vi.mock('@/utils/spawnHappyCLI', () => ({
  buildHappyCliSubprocessLaunchSpec: vi.fn<BuildHappyCliSubprocessLaunchSpec>(),
  pruneHappyCliRunnerSnapshots: vi.fn(),
  resolveHappyCliSubprocessRuntimeDecision,
  spawnHappyCLI,
}));

vi.mock('./platform/linux/applySpawnedChildOomScoreAdjustment', () => ({
  applySpawnedChildOomScoreAdjustment: applySpawnedChildOomScoreAdjustmentMock,
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

vi.mock('./sessionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessionRegistry')>();
  return {
    ...actual,
    clearSessionMarkerConnectedServiceRestartIntent:
      sessionRegistryCapture.clearSessionMarkerConnectedServiceRestartIntent,
    refreshSessionMarkerRespawn: sessionRegistryCapture.refreshSessionMarkerRespawn,
    removeSessionMarker: sessionRegistryCapture.removeSessionMarker,
    writeSessionMarker: sessionRegistryCapture.writeSessionMarker,
  };
});

vi.mock('./sessions/publishOrphanedStartupSessionEnds', () => ({
  publishOrphanedStartupSessionEnds: orphanedStartupSessionEndsCapture.publishOrphanedStartupSessionEnds,
}));

vi.mock('./connectedServices/recovery/providerActivityProofRecorder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./connectedServices/recovery/providerActivityProofRecorder')>();
  return {
    ...actual,
    createConnectedServiceProviderActivityProofRecorder:
      providerActivityRecorderCapture.createConnectedServiceProviderActivityProofRecorder,
  };
});

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
      claude: {
        ...actual.AGENTS.claude,
        id: 'claude',
        cliSubcommand: 'claude',
        vendorResumeSupport: 'supported',
      },
    },
    requireCatalogEntry: vi.fn((agentId: string = 'codex') => ({
      id: agentId === 'claude' ? 'claude' : 'codex',
      cliSubcommand: agentId === 'claude' ? 'claude' : 'codex',
      vendorResumeSupport: 'supported',
    })),
    getVendorResumeSupport: vi.fn(async () => () => true),
    resolveConnectedServiceSwitchContinuity: vi.fn(async (_agentId: string, { serviceId }: { serviceId: string }) => (
      serviceId === 'anthropic' || serviceId === 'claude-subscription'
        ? { mode: 'restart_same_home' }
        : { mode: 'unsupported', reason: 'unsupported_service' }
    )),
    resolveAgentCliSubcommand: vi.fn((agentId: string = 'codex') => (agentId === 'claude' ? 'claude' : 'codex')),
    resolveCatalogAgentId: vi.fn((agentId: string = 'codex') => (agentId === 'claude' ? 'claude' : 'codex')),
    resolveCatalogAgentIdForCliSubcommand: vi.fn((subcommand: string) => {
      const normalized = subcommand.trim();
      return normalized === 'opencode' ? 'opencode' : normalized === 'claude' ? 'claude' : 'codex';
    }),
  };
});

vi.mock('@/persistence', () => ({
  writeDaemonState: vi.fn(),
  writeDaemonStateIfLockOwned: vi.fn(() => true),
  writeConnectedServiceBrokerState: vi.fn(),
  acquireDaemonLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
  releaseDaemonLock: vi.fn(async () => {}),
  readCredentials: vi.fn(async () => null),
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: updateSessionMetadataWithRetryMock,
}));

vi.mock('./connectedServices/resolveConnectedServiceAuthForSpawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./connectedServices/resolveConnectedServiceAuthForSpawn')>();
  return {
    ...actual,
    resolveConnectedServiceAuthForSpawn: resolveConnectedServiceAuthForSpawnMock,
  };
});

vi.mock('./controlClient', () => ({
  cleanupDaemonState: vi.fn(async () => {}),
  forceStopKnownDaemonPid: vi.fn(async () => {}),
  isDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(async () => false),
  resolveDaemonSpawnSessionByNonce: vi.fn(async () => ({ status: 'not_found' as const })),
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
    prepareStopSession,
    beforeShutdown,
    isShuttingDown,
    handleConnectedServiceTurnLifecycle,
    resolveSpawnSessionByNonce,
  }: {
    spawnSession: (options: any) => Promise<any>;
    stopSession: (sessionId: string) => Promise<import('./sessions/stopSessionContract').StopSessionResult>;
    prepareStopSession?: (child: any) => Promise<void> | void;
    beforeShutdown?: () => Promise<void>;
    isShuttingDown?: () => boolean;
    handleConnectedServiceTurnLifecycle?: (input: {
      sessionId: string;
      event: string;
      terminalStatus?: string;
    }) => Promise<unknown>;
    resolveSpawnSessionByNonce?: (spawnNonce: string) => Promise<unknown> | unknown;
  }) => {
    harness.setSpawnSession(spawnSession);
    harness.setStopSession(stopSession);
    if (prepareStopSession) {
      harness.setPrepareStopSession(prepareStopSession);
    }
    if (beforeShutdown) {
      harness.setBeforeShutdown(beforeShutdown);
    }
    if (isShuttingDown) {
      harness.setIsShuttingDown(isShuttingDown);
    }
    if (handleConnectedServiceTurnLifecycle) {
      harness.setTurnLifecycleHandler(handleConnectedServiceTurnLifecycle);
    }
    if (resolveSpawnSessionByNonce) {
      harness.setResolveSpawnSessionByNonce(resolveSpawnSessionByNonce);
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
    connectedServiceRestartIntents: [],
  })),
}));

vi.mock('./sessions/disconnectedTerminalHostSupervision', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessions/disconnectedTerminalHostSupervision')>();
  return {
    ...actual,
    superviseDisconnectedTerminalHostCandidate: disconnectedTerminalHostSupervisionMock,
  };
});

vi.mock('@/terminal/attachment/terminalAttachmentInfo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/terminal/attachment/terminalAttachmentInfo')>();
  return {
    ...actual,
    readTerminalAttachmentInfo: claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo,
    removeTerminalAttachmentInfo: claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo,
  };
});

vi.mock('@/backends/claude/endpointRecovery/claudeEndpointArtifacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backends/claude/endpointRecovery/claudeEndpointArtifacts')>();
  return {
    ...actual,
    readClaudeEndpointDescriptor: claudeEndpointRecoveryBoundaryMocks.readClaudeEndpointDescriptor,
  };
});

vi.mock('@/integrations/terminalHost/defaultRegistry', () => ({
  createDefaultTerminalHostRegistry: vi.fn(async () => ({
    zellij: {
      kind: 'zellij' as const,
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: claudeEndpointRecoveryBoundaryMocks.evaluateLiveness,
      dispose: claudeEndpointRecoveryBoundaryMocks.dispose,
    },
  })),
}));

vi.mock('./sessions/onHappySessionWebhook', () => ({
  createOnHappySessionWebhook: vi.fn(() => vi.fn()),
}));

vi.mock('./processRunState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./processRunState')>();
  return {
    ...actual,
    readProcessRunState: sessionRunnerActivityBoundaryMocks.readProcessRunState,
  };
});

vi.mock('./sessionRunnerLock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessionRunnerLock')>();
  return {
    ...actual,
    readSessionRunnerLockStatus: sessionRunnerActivityBoundaryMocks.readSessionRunnerLockStatus,
  };
});

vi.mock('@/api/session/pendingQueueV2Transport', () => ({
  listPendingQueueV2LocalIdsFromServer: vi.fn(async () => []),
  materializeNextPendingQueueV2MessageViaHttp: vi.fn(async () => ({
    didMaterialize: false,
    localId: null,
    didWrite: false,
  })),
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc: pendingMaterializationRpcMocks.callSessionRpc,
}));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext: pendingMaterializationRpcMocks.resolveSessionTransportContext,
}));

vi.mock('./sessions/onChildExited', () => ({
  createOnChildExited: vi.fn(() => vi.fn()),
}));

vi.mock('./sessions/visibleConsoleSpawnWaiter', () => ({
  waitForVisibleConsoleSessionWebhook: vi.fn(async () => ({ type: 'success', sessionId: 'sess_visible_console' })),
}));

vi.mock('./sessions/stopSession', () => ({
  createStopSession: stopSessionMocks.createStopSession,
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

vi.mock('@/runtime/assets/resolveCliRuntimeAssetPath', () => ({
  resolveCliRuntimeAssetPath: vi.fn((...segments: string[]) => join(process.cwd(), ...segments)),
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
    harness.apiMachine.recoverDaemonTerminalSessionMutationJournals.mockClear();
    spawnHappyCLI.mockClear();
    resolveHappyCliSubprocessRuntimeDecision.mockReset();
    resolveHappyCliSubprocessRuntimeDecision.mockReturnValue(null);
    spawnHappyCliCapture.children.length = 0;
    spawnChildProcess.mockClear();
    buildCgroupSelfMigratingHappyCliLaunchSpec.mockClear();
    applySpawnedChildOomScoreAdjustmentMock.mockClear();
    cgroupMigrationCapture.migrateTrackedSessionProcessesOutOfDaemonServiceCgroup.mockClear();
    cgroupMigrationCapture.lastParams = null;
    sessionRespawnManagerCapture.createSessionRunnerRespawnManager.mockClear();
    sessionRespawnManagerCapture.instances.length = 0;
    sessionRegistryCapture.clearSessionMarkerConnectedServiceRestartIntent.mockClear();
    sessionRegistryCapture.refreshSessionMarkerRespawn.mockClear();
    sessionRegistryCapture.removeSessionMarker.mockClear();
    sessionRegistryCapture.writeSessionMarker.mockClear();
    orphanedStartupSessionEndsCapture.publishOrphanedStartupSessionEnds.mockClear();
    providerActivityRecorderCapture.createConnectedServiceProviderActivityProofRecorder.mockClear();
    providerActivityRecorderCapture.record.mockClear();
    vi.mocked(materializeNextPendingQueueV2MessageViaHttp).mockClear();
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockReset();
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockResolvedValue([]);
    vi.mocked(callSessionRpc).mockClear();
    vi.mocked(resolveSessionTransportContext).mockClear();
    stopSessionMocks.createStopSession.mockClear();
    stopSessionMocks.stopSession.mockClear();
    stopSessionMocks.stopSession.mockResolvedValue({ status: 'stopped' });
    sessionRunnerActivityBoundaryMocks.readProcessRunState.mockReset();
    sessionRunnerActivityBoundaryMocks.readProcessRunState.mockResolvedValue('dead');
    sessionRunnerActivityBoundaryMocks.readSessionRunnerLockStatus.mockReset();
    sessionRunnerActivityBoundaryMocks.readSessionRunnerLockStatus.mockResolvedValue({ ok: false, reason: 'not_found' });
    ensureSessionMachineAccessKeyBindingMock.mockReset();
    ensureSessionMachineAccessKeyBindingMock.mockResolvedValue(undefined);
    pendingMaterializationRpcMocks.callSessionRpc.mockImplementation(async (params) =>
      params.method.endsWith('wakeCapability.v1.get')
        ? { ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' }
        : { ok: true, result: 'wake_published' });
    pendingMaterializationRpcMocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess_plain',
      rawSession: {
        id: 'sess_plain',
        active: true,
        encryptionMode: 'plain',
      },
      mode: 'plain',
      ctx: pendingMaterializationRpcMocks.ctx,
    });
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

  it('binds startup-reattached live sessions to the daemon final machine identity', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async ({ pidToTrackedSession }) => {
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
        serverUrl: expect.any(String),
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
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      }));
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('activates one exact inactive Pending row after the UI disappears, coalesces a duplicate, and does not restart an active neighbor', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    const rawSession = createSessionRecordFixture({
      id: 'sess_plain',
      seq: 12,
      active: false,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-1',
        flavor: 'codex',
        codexSessionId: 'vendor-plain-1',
        path: '/tmp',
      }),
      dataEncryptionKey: null,
      pendingCount: 1,
      pendingVersion: 9,
    });
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(rawSession);
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockResolvedValue(['pending-after-ui-death']);
    let run: Promise<void> | null = null;

    try {
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await waitForSpawnSessionRegistration();

      await harness.emitPendingSessionActivationHint({
        sessionId: 'sess_plain',
        requestId: 'pending-after-ui-death',
        pendingVersion: 9,
        source: 'changes',
      });

      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      expect(listPendingQueueV2LocalIdsFromServer).toHaveBeenCalledWith({
        token: 'token-daemon',
        sessionId: 'sess_plain',
      });

      await harness.emitPendingSessionActivationHint({
        sessionId: 'sess_plain',
        requestId: 'pending-after-ui-death',
        pendingVersion: 9,
        source: 'live',
      });
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);

      vi.mocked(fetchSessionByIdCompat).mockResolvedValue({ ...rawSession, active: true });
      await harness.emitPendingSessionActivationHint({
        sessionId: 'sess_plain',
        requestId: 'pending-after-ui-death',
        pendingVersion: 9,
        source: 'live',
      });
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
      if (run) {
        harness.requestShutdown('happier-cli');
        await run.catch(() => {});
      }
    }
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

      for (let attempt = 0; attempt < 100; attempt += 1) {
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

  it('enables daemon session runner respawn when explicitly requested', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED = 'true';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (sessionRespawnManagerCapture.createSessionRunnerRespawnManager.mock.calls.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

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
      delete process.env.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED;
      exitSpy.mockRestore();
    }
  });

  it('settles an accepted nonce when the child exits before its webhook', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    const waitForSessionWebhookMock = vi.mocked(waitForSessionWebhook);
    const webhookControl: {
      resolve: ((value:
        | { type: 'success'; sessionId: string }
        | { type: 'error'; errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK'; errorMessage: string }
      ) => void) | null;
    } = { resolve: null };
    const webhookPromise = new Promise<
      | { type: 'success'; sessionId: string }
      | { type: 'error'; errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK'; errorMessage: string }
    >((resolve) => {
      webhookControl.resolve = resolve;
    });
    waitForSessionWebhookMock.mockImplementationOnce(async () => await webhookPromise);
    let run: Promise<void> | null = null;
    const featureDecisionModule = await import('@/features/featureDecisionService');
    const featureDecisionSpy = vi.spyOn(featureDecisionModule, 'resolveCliFeatureDecisionForServer')
      .mockImplementation(async ({ featureId, env }) => {
        const serverSnapshot = { status: 'unsupported' as const, reason: 'endpoint_missing' as const };
        return { decision: featureDecisionModule.resolveCliFeatureDecision({ featureId, env, serverSnapshot }), serverSnapshot };
      });

    try {
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 200 && !spawnSession; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const spawnOptions = {
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        token: 'token-daemon',
        codexBackendMode: 'acp',
        spawnNonce: 'spawn-nonce-fast-ack',
        pendingFirstInput: {
          text: 'Promote this first prompt once.',
          localId: 'spawn-first:fast-ack',
        },
      };
      const claimRunner = vi.fn(async () => {
        expect(spawnHappyCLI).not.toHaveBeenCalled();
      });
      const resultPromise = spawnSession(spawnOptions, { onBeforeRunnerLaunchAccepted: claimRunner });
      const result = await Promise.race([
        resultPromise,
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 25)),
      ]);

      expect(result).not.toBe('timed-out');
      if (result === 'timed-out') {
        throw new Error('spawnSession waited for the session webhook');
      }
      expect(result).toEqual({
        type: 'success',
        runnerAcceptance: 'newly_accepted',
        spawnNonce: 'spawn-nonce-fast-ack',
        sessionIdStatus: 'pending',
      });
      expect(claimRunner).toHaveBeenCalledTimes(1);
      expect(sessionRegistryCapture.writeSessionMarker).toHaveBeenCalledTimes(1);
      expect(sessionRegistryCapture.writeSessionMarker).toHaveBeenCalledWith(expect.objectContaining({
        pid: 12345,
        happySessionId: 'PID-12345',
        startedBy: 'daemon',
        cwd: '/tmp',
        respawn: expect.objectContaining({
          version: 1,
          directory: '/tmp',
          spawnNonce: 'spawn-nonce-fast-ack',
        }),
      }));
      expect(sessionRegistryCapture.writeSessionMarker.mock.calls[0]?.[0]?.respawn)
        .not.toHaveProperty('pendingFirstInput');

      const duplicateResult = await spawnSession(spawnOptions);
      expect(duplicateResult).toEqual({
        ...result,
        runnerAcceptance: 'same_request_runner',
      });
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      expect(waitForSessionWebhookMock).toHaveBeenCalledTimes(1);
      expect(sessionRegistryCapture.writeSessionMarker).toHaveBeenCalledTimes(1);
      const launchedChildEnv = (spawnHappyCLI.mock.calls[0]?.[1] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
      expect(readPendingFirstInputFromEnv(launchedChildEnv)).toEqual(spawnOptions.pendingFirstInput);

      const childExitError = {
        type: 'error' as const,
        errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK' as const,
        errorMessage: 'Child process exited before session webhook (pid=12345, code=1, signal=null)',
      };
      webhookControl.resolve?.(childExitError);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const resolveSpawnSessionByNonce = harness.getResolveSpawnSessionByNonce();
      expect(resolveSpawnSessionByNonce).not.toBeNull();
      await expect(resolveSpawnSessionByNonce?.('spawn-nonce-fast-ack')).resolves.toEqual({
        status: 'error',
        errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK',
        errorMessage: childExitError.errorMessage,
      });
      await expect(spawnSession(spawnOptions)).resolves.toEqual(childExitError);
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      webhookControl.resolve?.({ type: 'success', sessionId: 'sess_late_webhook' });
      waitForSessionWebhookMock.mockReset();
      waitForSessionWebhookMock.mockImplementation(async () => ({ type: 'success', sessionId: 'sess_plain' }));
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
      featureDecisionSpy.mockRestore();
    }
  }, 120_000);

  it('rejoins an accepted existing-session launch while its exact live child is still awaiting the webhook', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    sessionRunnerActivityBoundaryMocks.readProcessRunState.mockResolvedValue('servable');
    pendingMaterializationRpcMocks.callSessionRpc.mockResolvedValue({
      ok: false,
      errorCode: 'rpc_method_unavailable',
    });
    const explicitRecoveryCheckSpy = vi.spyOn(UsageLimitRecoveryScheduler.prototype, 'checkNow');
    const featureDecisionModule = await import('@/features/featureDecisionService');
    const featureDecisionSpy = vi.spyOn(featureDecisionModule, 'resolveCliFeatureDecisionForServer')
      .mockImplementation(async ({ featureId, env }) => {
        const serverSnapshot = { status: 'unsupported' as const, reason: 'endpoint_missing' as const };
        return {
          decision: featureDecisionModule.resolveCliFeatureDecision({ featureId, env, serverSnapshot }),
          serverSnapshot,
        };
      });
    const waitForSessionWebhookMock = vi.mocked(waitForSessionWebhook);
    const actualWebhookModule = await vi.importActual<typeof import('./spawn/waitForSessionWebhook')>(
      './spawn/waitForSessionWebhook',
    );
    const webhookControl: {
      resolve: ((session: import('./types').TrackedSession) => void) | null;
    } = { resolve: null };
    waitForSessionWebhookMock.mockImplementationOnce((params) => {
      const completion = actualWebhookModule.waitForSessionWebhook(params);
      webhookControl.resolve = params.pidToAwaiter.get(params.pid) ?? null;
      return completion;
    });
    const sessionId = 'sess_existing_startup_pending';
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSessionRecordFixture({
      id: sessionId,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        flavor: 'codex',
        codexSessionId: 'vendor-existing-startup-pending',
        path: '/tmp',
      }),
      dataEncryptionKey: null,
    }));
    pendingMaterializationRpcMocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId,
      rawSession: {
        id: sessionId,
        active: true,
        encryptionMode: 'plain',
      },
      mode: 'plain',
      ctx: pendingMaterializationRpcMocks.ctx,
    });
    let run: Promise<void> | null = null;

    try {
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      const spawnSession = await waitForSpawnSessionRegistration();
      const baseOptions = {
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent' as const, agentId: 'codex' as const },
        existingSessionId: sessionId,
        token: 'token-daemon',
        initialTranscriptAfterSeq: 17,
      };

      await expect(spawnSession({
        ...baseOptions,
        executionAuthorization: { provenance: 'user_request', requestId: 'pending-local-first' },
      })).resolves.toEqual({
        type: 'success',
        sessionId,
        runnerAcceptance: 'newly_accepted',
      });
      expect(webhookControl.resolve).not.toBeNull();

      await expect(spawnSession({
        ...baseOptions,
        executionAuthorization: { provenance: 'user_request', requestId: 'pending-local-retry' },
      })).resolves.toEqual({
        type: 'success',
        sessionId,
        runnerAcceptance: 'preexisting_or_adopted',
      });

      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      expect(waitForSessionWebhookMock).toHaveBeenCalledTimes(1);
      expect(pendingMaterializationRpcMocks.callSessionRpc).not.toHaveBeenCalled();
      expect(explicitRecoveryCheckSpy).not.toHaveBeenCalled();
      expect(materializeNextPendingQueueV2MessageViaHttp).not.toHaveBeenCalled();

      webhookControl.resolve?.({
        pid: 12345,
        startedBy: 'daemon',
        happySessionId: sessionId,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      webhookControl.resolve?.({
        pid: 12345,
        startedBy: 'daemon',
        happySessionId: sessionId,
      });
      waitForSessionWebhookMock.mockReset();
      waitForSessionWebhookMock.mockImplementation(async () => ({ type: 'success', sessionId: 'sess_plain' }));
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      exitSpy.mockRestore();
      featureDecisionSpy.mockRestore();
    }
  });

  it('does not launch a runner when the handoff acceptance claim fails', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;
    const featureDecisionModule = await import('@/features/featureDecisionService');
    const featureDecisionSpy = vi.spyOn(featureDecisionModule, 'resolveCliFeatureDecisionForServer')
      .mockImplementation(async ({ featureId, env }) => {
        const serverSnapshot = { status: 'unsupported' as const, reason: 'endpoint_missing' as const };
        return { decision: featureDecisionModule.resolveCliFeatureDecision({ featureId, env, serverSnapshot }), serverSnapshot };
      });

    try {
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 200 && !spawnSession; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) throw new Error('Expected spawnSession to be registered');

      const claimError = new Error('durable handoff claim failed');
      const claimAttemptIdentity = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const spawnOptions = {
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        token: 'token-daemon',
        codexBackendMode: 'acp',
        spawnNonce: `handoff-claim-failure-${claimAttemptIdentity}`,
        pendingFirstInput: {
          text: 'Keep this Pending input with the caller when acceptance fails.',
          localId: `spawn-first:${claimAttemptIdentity}`,
        },
        executionAuthorization: {
          provenance: 'user_request' as const,
          requestId: `handoff-claim-failure-local-id-${claimAttemptIdentity}`,
        },
      };
      await expect(spawnSession(spawnOptions, {
        onBeforeRunnerLaunchAccepted: async () => { throw claimError; },
      })).resolves.toMatchObject({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage: expect.stringContaining(claimError.message),
      });
      expect(spawnHappyCLI).not.toHaveBeenCalled();
      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      exitSpy.mockRestore();
      featureDecisionSpy.mockRestore();
      if (run) {
        harness.requestShutdown('happier-cli');
        await run.catch(() => undefined);
      }
    }
  });

  it('does not treat webhook metadata bindings and task start as provider activity recovery proof', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
    const trackedSessionCapture: {
      current: Map<number, {
        pid: number;
        startedBy: string;
        happySessionId?: string;
        happySessionMetadataFromLocalWebhook?: Record<string, unknown>;
        spawnOptions?: Record<string, unknown>;
      }> | null;
    } = { current: null };
    vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ pidToTrackedSession }) => {
      trackedSessionCapture.current = pidToTrackedSession as typeof trackedSessionCapture.current;
      return vi.fn();
    });

    try {
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (harness.getTurnLifecycleHandler() && trackedSessionCapture.current) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const turnLifecycleHandler = harness.getTurnLifecycleHandler();
      if (!turnLifecycleHandler) {
        throw new Error('Expected connected-service turn lifecycle handler to be registered');
      }
      const trackedSessions = trackedSessionCapture.current;
      if (!trackedSessions) {
        throw new Error('Expected tracked session map from webhook wiring');
      }

      trackedSessions.set(7301, {
        pid: 7301,
        startedBy: 'daemon',
        happySessionId: 'sess_metadata_bindings',
        spawnOptions: {
          directory: '/tmp/workspace',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        },
        happySessionMetadataFromLocalWebhook: {
          id: 'sess_metadata_bindings',
          flavor: 'claude',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'claude-subscription': {
                source: 'connected',
                selection: 'group',
                groupId: 'claude',
                profileId: 'leeroy_bat',
              },
            },
          },
        },
      });

      await expect(turnLifecycleHandler({
        sessionId: 'sess_metadata_bindings',
        event: 'task_started',
      })).resolves.toEqual({
        status: 'continue',
        turnCustody: {
          status: 'ignored_missing_exact_turn',
          activeTurnId: null,
        },
      });

      expect(providerActivityRecorderCapture.record).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(() => vi.fn());
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('ignores dead connected-service restart intents during startup without respawning', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [
          {
            kind: 'dead',
            sessionId: 'sess-durable-restart',
            pid: 7301,
            requestedAtMs: 1_000,
            spawnOptions: {
              directory: '/tmp/workspace-durable',
              backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
              resume: 'claude-durable-thread',
              approvedNewDirectoryCreation: true,
            },
            vendorResumeId: 'claude-durable-thread',
          },
        ] as any,
      }));

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      await new Promise((resolve) => setTimeout(resolve, 0));

      const manager = sessionRespawnManagerCapture.instances[0];
      expect(manager?.handleUnexpectedExit).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      }));
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('ignores dead connected-service restart intents during startup when only the happy session id is resumable', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [
          {
            kind: 'dead',
            sessionId: 'sess-existing-session-restart',
            pid: 7303,
            requestedAtMs: 1_250,
            spawnOptions: {
              directory: '/tmp/workspace-existing-session',
              backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
              existingSessionId: 'sess-existing-session-restart',
              approvedNewDirectoryCreation: true,
            },
            vendorResumeId: null,
          },
        ] as any,
      }));

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      await new Promise((resolve) => setTimeout(resolve, 0));

      const manager = sessionRespawnManagerCapture.instances[0];
      expect(manager?.handleUnexpectedExit).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      }));
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('does not force-respawn orphaned dead OpenCode startup markers', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [
          {
            sessionId: 'sess-opencode-startup-restart',
            pid: 7302,
          },
        ],
        connectedServiceRestartIntents: [],
      }));

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      await new Promise((resolve) => setTimeout(resolve, 0));

      const manager = sessionRespawnManagerCapture.instances[0];
      expect(manager?.handleUnexpectedExit).not.toHaveBeenCalled();
      expect(sessionRegistryCapture.removeSessionMarker).not.toHaveBeenCalledWith(7302);

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      }));
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('does not route dead startup terminal markers through the respawn manager', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [{ sessionId: 'sess-terminal-startup-restart', pid: 7304 }],
        connectedServiceRestartIntents: [],
      }));

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (sessionRespawnManagerCapture.createSessionRunnerRespawnManager.mock.calls.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const manager = sessionRespawnManagerCapture.instances[0];
      expect(manager?.handleUnexpectedExit).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      }));
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('publishes passive orphan state without attempting terminal recovery', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      harness.apiMachine.connect.mockClear();
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [{ sessionId: 'sess-terminal-already-running', pid: 7305 }],
        connectedServiceRestartIntents: [],
      }));

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (orphanedStartupSessionEndsCapture.publishOrphanedStartupSessionEnds.mock.calls.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const manager = sessionRespawnManagerCapture.instances[0];
      expect(manager).toBeDefined();
      expect(manager?.handleUnexpectedExit).not.toHaveBeenCalled();
      expect(orphanedStartupSessionEndsCapture.publishOrphanedStartupSessionEnds).toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      }));
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
      for (let attempt = 0; !spawnSession && attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
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

  it('propagates canonicalized connected-service group bindings into the launched child env and tracked spawn options', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      const trackedSessionCapture: {
        current: Map<number, {
          pid: number;
          spawnOptions?: {
            connectedServices?: unknown;
          };
        }> | null;
      } = { current: null };

      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ pidToTrackedSession }) => {
        trackedSessionCapture.current = pidToTrackedSession as typeof trackedSessionCapture.current;
        return vi.fn();
      });

      resolveConnectedServiceAuthForSpawnMock.mockResolvedValueOnce({
        env: { CODEX_HOME: '/tmp/codex-connected' },
        cleanupOnFailure: null,
        cleanupOnExit: null,
        connectedServicesBindings: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
              profileId: 'codex4',
            },
          },
        },
      });

      const { startDaemon } = await import('./startDaemon');
      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; !spawnSession && attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const spawnResult = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
              profileId: 'we-are',
            },
          },
        },
        token: 't',
      });

      expect(spawnResult.type).toBe('success');

      const directLaunchCall = spawnHappyCLI.mock.calls.at(-1);
      const wrappedLaunchCall = spawnChildProcess.mock.calls.at(-1) as unknown;
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

      expect(parseSessionConnectedServicesBindingsJson(
        launchedEnv[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY] ?? null,
      )).toEqual({
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'happier',
            profileId: 'codex4',
          },
        },
      });

      const trackedSessions = trackedSessionCapture.current;
      if (!trackedSessions) {
        throw new Error('Expected tracked session map from webhook wiring');
      }
      expect(trackedSessions.get(12345)?.spawnOptions?.connectedServices).toEqual({
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'happier',
            profileId: 'codex4',
          },
        },
      });

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(() => vi.fn());
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('fails closed with a stable validation result when hard-limit quota evidence is incomplete', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<unknown> | null = null;
    let shutdownRequested = false;
    try {
      resolveConnectedServiceAuthForSpawnMock.mockRejectedValueOnce(
        new ConnectedServiceAuthGroupQuotaProbeIncompleteError('deadline_exceeded'),
      );
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const spawnSession = await waitForSpawnSessionRegistration();

      await expect(spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
              profileId: 'primary',
            },
          },
        },
        token: 't',
      })).resolves.toEqual({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'Connected service account availability could not be verified before launch. Please retry.',
      });
      expect(spawnHappyCLI).not.toHaveBeenCalled();

      shutdownRequested = true;
      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (!shutdownRequested) {
        harness.requestShutdown('happier-cli');
        await run?.catch(() => {});
      }
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      exitSpy.mockRestore();
    }
  });

  it('tracks connected-service materialization diagnostics on spawn options for downstream switch surfaces', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    const diagnostics = [{
      code: 'state_sharing_degraded',
      providerId: 'claude',
      serviceId: 'anthropic',
      requestedStateMode: 'shared',
      effectiveStateMode: 'isolated',
      reason: 'provider_state_unavailable',
    }] as const;

    let run: Promise<void> | null = null;
    try {
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      const trackedSessionCapture: {
        current: Map<number, {
          pid: number;
          spawnOptions?: {
            materializationDiagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
          };
        }> | null;
      } = { current: null };

      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ pidToTrackedSession }) => {
        trackedSessionCapture.current = pidToTrackedSession as typeof trackedSessionCapture.current;
        return vi.fn();
      });

      resolveConnectedServiceAuthForSpawnMock.mockResolvedValueOnce({
        env: { CLAUDE_CONFIG_DIR: '/tmp/claude-connected' },
        cleanupOnFailure: null,
        cleanupOnExit: null,
        diagnostics,
      });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
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
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'profile',
              profileId: 'profile-1',
            },
          },
        },
        token: 't',
      });

      expect(spawnResult.type).toBe('success');
      const trackedSessions = trackedSessionCapture.current;
      if (!trackedSessions) {
        throw new Error('Expected tracked session map from webhook wiring');
      }
      expect(trackedSessions.get(12345)?.spawnOptions?.materializationDiagnostics).toEqual(diagnostics);

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(() => vi.fn());
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

  it('launches daemon-managed session runners as detached ignored-stdio children and unreferences them', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    const runtimeDecision: HappyCliSubprocessRuntimeDecision = {
      runtime: 'node',
      argvPrefix: [
        '--no-warnings',
        '--no-deprecation',
        '/runtime/.runner-snapshots/0123456789abcdef/index.mjs',
      ],
      env: { HAPPIER_TEST_ADMITTED_CLOSURE: '0123456789abcdef' },
    };
    resolveHappyCliSubprocessRuntimeDecision.mockReturnValue(runtimeDecision);

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
      expect(launchOptions[2]).toEqual(expect.objectContaining({
        preferWindowsPackagedBinary: true,
        runtimeDecision,
      }));
      expect((launchOptions[2] as { runtimeDecision?: unknown }).runtimeDecision).toBe(runtimeDecision);
      expect(resolveHappyCliSubprocessRuntimeDecision).toHaveBeenCalledTimes(1);

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

  it('resolves persisted runtime state before spawning an existing session with stale incoming controls', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess_yolo_restore',
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          flavor: 'claude',
          claudeSessionId: 'vendor-claude-restore',
          path: '/tmp',
          permissionMode: 'yolo',
          permissionModeUpdatedAt: 200,
        }),
        dataEncryptionKey: null,
      }),
    );
    vi.mocked(waitForSessionWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'sess_claude_repair',
    });

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
        existingSessionId: 'sess_yolo_restore',
        permissionMode: 'default',
        permissionModeUpdatedAt: 100,
        token: 't',
      });

      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const firstCall = spawnHappyCLI.mock.calls[0];
      if (!firstCall) {
        throw new Error('Expected spawnHappyCLI to be called');
      }
      const argv = firstCall[0];
      expect(argv).toEqual(expect.arrayContaining(['--existing-session', 'sess_yolo_restore']));
      expect(argv).toEqual(expect.arrayContaining(['--resume', 'vendor-claude-restore']));
      expect(argv).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']));
      expect(argv).toEqual(expect.arrayContaining(['--permission-mode-updated-at', '200']));

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
      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 20 && !spawnSession; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
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

  it.each(['background-service', 'self-restart'] as const)('spawns regular linux %s runners through a pre-exec cgroup self-migration wrapper before provider children start', async (startupSource) => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
    process.env.HAPPIER_DAEMON_STARTUP_SOURCE = startupSource;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    let run: Promise<void> | null = null;
    try {
      const { startDaemon } = await import('./startDaemon');

      run = startDaemon();

      const spawnSession = await waitForSpawnSessionRegistration();

      await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(spawnHappyCLI).not.toHaveBeenCalled();
      expect(buildCgroupSelfMigratingHappyCliLaunchSpec).toHaveBeenCalledTimes(1);
      expect(buildCgroupSelfMigratingHappyCliLaunchSpec).toHaveBeenCalledWith(expect.objectContaining({
        environment: expect.objectContaining({
          HAPPIER_SESSION_REQUESTED_DIRECTORY: '/tmp',
        }),
      }));
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
      expect(applySpawnedChildOomScoreAdjustmentMock).toHaveBeenCalledWith(expect.objectContaining({
        pid: 12345,
      }));

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
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

  it('applies linux spawned-child OOM score adjustment for manual daemon session spawns', async () => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
    process.env.HAPPIER_DAEMON_STARTUP_SOURCE = 'manual';

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = await waitForSpawnSessionRegistration();

      await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      expect(applySpawnedChildOomScoreAdjustmentMock).toHaveBeenCalledWith(expect.objectContaining({
        pid: 12345,
        startupSource: 'manual',
      }));

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

  it.each(['background-service', 'self-restart'] as const)('migrates reattached linux %s session runners out of the daemon service cgroup during startup', async (startupSource) => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
    process.env.HAPPIER_DAEMON_STARTUP_SOURCE = startupSource;

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
        return { orphanedDeadDaemonSessions: [], connectedServiceRestartIntents: [] };
      });

      const stopSessionModule = await import('./sessions/stopSession');
      const stopSessionSpy = vi.fn(async () => ({ status: 'stopped' as const }));
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

  it('ignores live connected-service restart intents during startup without signalling the runner', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        throw Object.assign(new Error(`process ${pid} is not alive`), { code: 'ESRCH' });
      }
      return true;
    }) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async ({ pidToTrackedSession }) => {
        pidToTrackedSession.set(6480, {
          pid: 6480,
          startedBy: 'daemon',
          happySessionId: 'sess-live-restart-intent',
          childProcess: { pid: process.pid } as any,
          reattachedFromDiskMarker: true,
          spawnOptions: {
            directory: '/tmp/workspace-live-restart',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            resume: 'claude-live-thread',
            approvedNewDirectoryCreation: true,
          },
          vendorResumeId: 'claude-live-thread',
        } as any);
        return {
          orphanedDeadDaemonSessions: [],
          connectedServiceRestartIntents: [
            {
              kind: 'live',
              sessionId: 'sess-live-restart-intent',
              pid: 6480,
              requestedAtMs: 1_000,
            },
          ] as any,
        };
      });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(killSpy.mock.calls).not.toContainEqual([-6480, 'SIGTERM']);
      const manager = sessionRespawnManagerCapture.instances[0];
      expect(manager?.handleUnexpectedExit).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      }));
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      killSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('passively reattaches a live runner without signalling it', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) {
        return true;
      }
      return true;
    }) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async ({ pidToTrackedSession }) => {
        pidToTrackedSession.set(6481, {
          pid: 6481,
          startedBy: 'daemon',
          happySessionId: 'sess-live-terminal-restart',
          childProcess: { pid: process.pid } as any,
          reattachedFromDiskMarker: true,
          spawnOptions: {
            directory: '/tmp/workspace-live-terminal',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            resume: 'claude-live-terminal-thread',
            approvedNewDirectoryCreation: true,
          },
          vendorResumeId: 'claude-live-terminal-thread',
        } as any);
        return {
          orphanedDeadDaemonSessions: [],
          connectedServiceRestartIntents: [],
        };
      });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(killSpy.mock.calls).not.toContainEqual([-6481, 'SIGTERM']);
      const manager = sessionRespawnManagerCapture.instances[0];
      expect(manager?.handleUnexpectedExit).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      }));
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      killSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('waits for a stop-requested tracked runner to be observed exited before stop returns', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;
    let loadTerminalHostAdapters: (() => Promise<unknown>) | undefined;

    try {
      harness.resetControlRefs();
      const terminalHostRegistryModule = await import('@/integrations/terminalHost/defaultRegistry');
      vi.mocked(terminalHostRegistryModule.createDefaultTerminalHostRegistry).mockClear();
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async ({ pidToTrackedSession }) => {
        pidToTrackedSession.set(6480, {
          pid: 6480,
          startedBy: 'daemon',
          happySessionId: 'sess-stop-6480',
          reattachedFromDiskMarker: true,
          stopRequestedAtMs: 123,
        } as any);
        return { orphanedDeadDaemonSessions: [], connectedServiceRestartIntents: [] };
      });

      const onChildExitedModule = await import('./sessions/onChildExited');
      const onChildExitedSpy = vi.fn();
      vi.mocked(onChildExitedModule.createOnChildExited).mockReturnValue(onChildExitedSpy);

      const waitForExitModule = await import('./sessions/waitForExistingSessionExitIfStopRequested');
      const waitForExitSpy = vi.spyOn(waitForExitModule, 'waitForExistingSessionExitIfStopRequested')
        .mockImplementation(async (params: any) => {
          params.onExitObserved?.(6480, { reason: 'process-missing', code: null, signal: null });
          params.pidToTrackedSession.delete(6480);
        });

      const stopSessionModule = await import('./sessions/stopSession');
      vi.mocked(stopSessionModule.createStopSession).mockImplementation(({
        pidToTrackedSession,
        waitForTrackedRunnersExit,
        loadTerminalHostAdapters: injectedLoadTerminalHostAdapters,
      }) => {
        loadTerminalHostAdapters = injectedLoadTerminalHostAdapters;
        return vi.fn(async (sessionId: string) => {
          const trackedPids: number[] = [];
          for (const trackedSession of pidToTrackedSession.values()) {
            if (trackedSession.happySessionId === sessionId) {
              trackedSession.stopRequestedAtMs = Date.now();
              trackedPids.push(trackedSession.pid);
            }
          }
          const exited = await waitForTrackedRunnersExit?.({ sessionId, trackedPids });
          return exited
            ? { status: 'stopped' as const }
            : { status: 'incomplete' as const, reason: 'runner_exit_timeout' as const };
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

      await expect(stopSession('sess-stop-6480')).resolves.toEqual({ status: 'stopped' });

      expect(waitForExitSpy).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess-stop-6480',
      }));
      expect(onChildExitedSpy).toHaveBeenCalledWith(6480, {
        reason: 'process-missing',
        code: null,
        signal: null,
      });
      expect(loadTerminalHostAdapters).toEqual(expect.any(Function));
      const firstRegistry = await loadTerminalHostAdapters!();
      const secondRegistry = await loadTerminalHostAdapters!();
      expect(secondRegistry).toBe(firstRegistry);
      expect(terminalHostRegistryModule.createDefaultTerminalHostRegistry).toHaveBeenCalledTimes(1);
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

  it('preserves an exact terminal-host exit marker and routes later Stop through disconnected-host retirement', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      harness.resetControlRefs();

      const onChildExitedModule = await import('./sessions/onChildExited');
      const captured = {
        shouldPreserveSessionMarkerOnExit: null as null | ((input: Readonly<{
          pid: number;
          trackedSession: unknown;
          exit: { reason: string; code: number | null; signal: string | null };
        }>) => boolean),
        onFinalTrackedSessionExitStaged: null as null | ((input: Readonly<{
          pid: number;
          trackedSession: any;
          exit: { reason: string; code: number | null; signal: string | null };
          observedAt: number;
        }>) => Promise<void>),
      };
      vi.mocked(onChildExitedModule.createOnChildExited).mockImplementation((params: any) => {
        captured.shouldPreserveSessionMarkerOnExit = params.shouldPreserveSessionMarkerOnExit ?? null;
        captured.onFinalTrackedSessionExitStaged = params.onFinalTrackedSessionExitStaged ?? null;
        return vi.fn();
      });

      const attachmentId = 'attachment-terminal-owned' as NonNullable<
        import('@/integrations/terminalHost/_types').TerminalHostHandle['attachmentId']
      >;
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockResolvedValue({
        version: 2,
        attachmentId,
        sessionId: 'sess-terminal-owned',
        handle: {
          attachmentId,
          kind: 'zellij',
          sessionName: 'terminal-owned',
          paneId: 'terminal_1',
          socketDir: '/tmp/terminal-owned',
          attachMetadata: {
            attachStrategy: 'terminal_host',
            topology: 'shared',
            locality: 'same_machine',
            liveProbe: 'required',
          },
        },
        terminal: {
          mode: 'zellij',
          zellij: {
            sessionName: 'terminal-owned',
            paneId: 'terminal_1',
            socketDirV1: '/tmp/terminal-owned',
          },
        },
        updatedAt: 1,
      });
      stopSessionMocks.stopSession
        .mockResolvedValueOnce({ status: 'incomplete', reason: 'tracked_runner_absent' })
        .mockResolvedValueOnce({ status: 'stopped' });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (
          harness.getPrepareStopSession()
          && captured.shouldPreserveSessionMarkerOnExit
          && captured.onFinalTrackedSessionExitStaged
        ) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const prepareStopSession = harness.getPrepareStopSession();
      const stopSession = harness.getStopSession();
      const shouldPreserveSessionMarkerOnExit = captured.shouldPreserveSessionMarkerOnExit;
      const onFinalTrackedSessionExitStaged = captured.onFinalTrackedSessionExitStaged;
      if (!prepareStopSession || !stopSession || !shouldPreserveSessionMarkerOnExit || !onFinalTrackedSessionExitStaged) {
        throw new Error('Expected daemon stop preparation and child-exit handler to be registered');
      }

      const eligible = {
        startedBy: 'daemon',
        pid: 7511,
        happySessionId: 'sess-claude-resume',
        vendorResumeId: 'claude-resume-7511',
        spawnOptions: {
          directory: '/tmp/workspace-claude',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          resume: 'claude-resume-7511',
        },
      } as const;
      const terminalOwned = {
        ...eligible,
        startedBy: 'terminal',
        pid: 7512,
        happySessionId: 'sess-terminal-owned',
        happySessionMetadataFromLocalWebhook: {
          path: '/tmp/workspace-claude',
          terminal: {
            mode: 'zellij',
            zellij: {
              sessionName: 'terminal-owned',
              paneId: 'terminal_1',
              socketDirV1: '/tmp/terminal-owned',
            },
          },
        },
        publishedTerminalControlServiceabilityAttachmentId: attachmentId,
      } as const;
      const missingResume = {
        ...eligible,
        pid: 7513,
        happySessionId: 'sess-no-resume',
        vendorResumeId: null,
        spawnOptions: {
          directory: '/tmp/workspace-claude',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        },
      } as const;

      await prepareStopSession(eligible);
      await prepareStopSession(terminalOwned);
      await prepareStopSession(missingResume);

      const exit = { reason: 'signal', code: null, signal: 'SIGTERM' };
      expect(shouldPreserveSessionMarkerOnExit({
        pid: eligible.pid,
        trackedSession: eligible as any,
        exit,
      })).toBe(false);
      expect(shouldPreserveSessionMarkerOnExit({
        pid: terminalOwned.pid,
        trackedSession: terminalOwned as any,
        exit,
      })).toBe(true);
      expect(shouldPreserveSessionMarkerOnExit({
        pid: missingResume.pid,
        trackedSession: missingResume as any,
        exit,
      })).toBe(false);

      await onFinalTrackedSessionExitStaged({
        pid: terminalOwned.pid,
        trackedSession: terminalOwned,
        exit,
        observedAt: 2,
      });
      await expect(stopSession(terminalOwned.happySessionId)).resolves.toEqual({ status: 'stopped' });

      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockResolvedValueOnce(null);
      await expect(onFinalTrackedSessionExitStaged({
        pid: terminalOwned.pid + 1,
        trackedSession: {
          ...terminalOwned,
          pid: terminalOwned.pid + 1,
          happySessionId: 'sess-terminal-descriptor-missing',
        },
        exit,
        observedAt: 3,
      })).rejects.toThrow('terminal_attachment_unavailable_after_runner_exit');

      expect(stopSessionMocks.stopSession).toHaveBeenCalledTimes(2);
      expect(stopSessionMocks.createStopSession).toHaveBeenCalledTimes(2);
      const reconstructedStopInput = stopSessionMocks.createStopSession.mock.calls[1]?.[0];
      expect(Array.from(reconstructedStopInput?.pidToTrackedSession.keys() ?? [])).toEqual([terminalOwned.pid]);
      expect(reconstructedStopInput?.expectedTerminalAttachmentId).toBe(attachmentId);
      expect(reconstructedStopInput?.requireTerminalTopologyProof).toBe(true);
      expect(sessionRegistryCapture.removeSessionMarker).toHaveBeenCalledWith(terminalOwned.pid);
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockReset();
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockResolvedValue(null);
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('waits for exact terminal-host retirement before a concurrent resume can spawn', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;
    let releaseHostRetirement!: () => void;
    const hostRetirementPending = new Promise<void>((resolve) => {
      releaseHostRetirement = resolve;
    });
    let reportRunnerRemoved!: () => void;
    const runnerRemoved = new Promise<void>((resolve) => {
      reportRunnerRemoved = resolve;
    });

    try {
      harness.resetControlRefs();
      sessionRunnerActivityBoundaryMocks.readProcessRunState.mockResolvedValue('servable');
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockImplementation(async ({ pidToTrackedSession }) => {
        pidToTrackedSession.set(7001, {
          pid: 7001,
          startedBy: 'daemon',
          happySessionId: 'sess-stop-resume-serialized',
          reattachedFromDiskMarker: true,
        } as any);
        return { orphanedDeadDaemonSessions: [], connectedServiceRestartIntents: [] };
      });

      const stopSessionModule = await import('./sessions/stopSession');
      vi.mocked(stopSessionModule.createStopSession).mockImplementation(({ pidToTrackedSession }) => {
        return vi.fn(async () => {
          pidToTrackedSession.delete(7001);
          reportRunnerRemoved();
          await hostRetirementPending;
          return { status: 'stopped' as const };
        }) as any;
      });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (harness.getStopSession() && harness.getSpawnSession()) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const stopSession = harness.getStopSession();
      const spawnSession = harness.getSpawnSession();
      if (!stopSession || !spawnSession) {
        throw new Error('Expected daemon session lifecycle handlers to be registered');
      }

      const stopPromise = stopSession('sess-stop-resume-serialized');
      await runnerRemoved;
      let resumeSettled = false;
      const resumePromise = spawnSession({
        directory: '/tmp/workspace-stop-resume-serialized',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        existingSessionId: 'sess-stop-resume-serialized',
        existingSessionAttachPayload: { v: 2, encryptionMode: 'plain' } as any,
      }).finally(() => {
        resumeSettled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resumeSettled).toBe(false);
      expect(spawnHappyCLI).not.toHaveBeenCalled();

      releaseHostRetirement();
      await expect(stopPromise).resolves.toEqual({ status: 'stopped' });
      await expect(resumePromise).resolves.toEqual({
        type: 'success',
        sessionId: 'sess-stop-resume-serialized',
        runnerAcceptance: 'newly_accepted',
      });
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
    } finally {
      releaseHostRetirement();
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      stopSessionMocks.createStopSession.mockImplementation(() => stopSessionMocks.stopSession);
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

    let run: Promise<void> | null = null;
    let shutdownRequested = false;
    try {
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = await waitForSpawnSessionRegistration();

      await expect(
        spawnSession({
          directory: '/tmp/workspace-pre-resolved',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          existingSessionId: 'sess-pre-resolved-1',
          existingSessionAttachPayload: { v: 2, encryptionMode: 'plain' } as any,
        }),
      ).resolves.toEqual({
        type: 'success',
        sessionId: 'sess-pre-resolved-1',
        runnerAcceptance: 'newly_accepted',
      });

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

  it('applies persisted runtime state when a resume request targets an already running session', async () => {
    const explicitRecoveryCheckSpy = vi.spyOn(UsageLimitRecoveryScheduler.prototype, 'checkNow')
      .mockRejectedValueOnce(new Error('recovery check temporarily unavailable'));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    sessionRunnerActivityBoundaryMocks.readProcessRunState.mockResolvedValue('servable');
    pendingMaterializationRpcMocks.callSessionRpc.mockImplementation(async (params) =>
      params.method.endsWith('wakeCapability.v1.get')
        ? { ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' }
        : { ok: true, result: 'wake_published' });
    pendingMaterializationRpcMocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess_already_running',
      rawSession: {
        id: 'sess_already_running',
        active: true,
        encryptionMode: 'plain',
      },
      mode: 'plain',
      ctx: pendingMaterializationRpcMocks.ctx,
    });
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(
      createSessionRecordFixture({
        id: 'sess_already_running',
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          flavor: 'codex',
          codexSessionId: 'vendor-codex-fresh',
          path: '/tmp',
          permissionMode: 'yolo',
          permissionModeUpdatedAt: 200,
          agentModeId: 'plan',
          agentModeUpdatedAt: 201,
          modelId: 'gpt-5.1',
          modelUpdatedAt: 202,
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                profileId: 'fresh-profile',
                groupId: 'main',
                activeProfileId: 'fresh-profile',
              },
            },
          },
          connectedServicesUpdatedAt: 203,
        }),
        dataEncryptionKey: null,
      }),
    );

    let run: Promise<void> | null = null;
    try {
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      const trackedSessionCapture: {
        current: Map<number, {
          happySessionId?: string;
          spawnOptions?: Record<string, unknown>;
          vendorResumeId?: string;
        }> | null;
      } = { current: null };
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ pidToTrackedSession }) => {
        trackedSessionCapture.current = pidToTrackedSession as typeof trackedSessionCapture.current;
        return vi.fn();
      });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 20 && !spawnSession; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }
      if (!trackedSessionCapture.current) {
        throw new Error('Expected tracked session map from webhook wiring');
      }
      trackedSessionCapture.current.set(12345, {
        happySessionId: 'sess_already_running',
        spawnOptions: {
          directory: '/tmp',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          existingSessionId: 'sess_already_running',
          resume: 'vendor-codex-stale',
          permissionMode: 'default',
          permissionModeUpdatedAt: 100,
          agentModeId: 'chat',
          agentModeUpdatedAt: 101,
          modelId: 'gpt-4.1',
          modelUpdatedAt: 102,
          connectedServices: { v: 1, bindingsByServiceId: {} },
          connectedServicesUpdatedAt: 103,
        },
        vendorResumeId: 'vendor-codex-stale',
      });

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_already_running',
        token: 'token-from-spawn-options',
        codexBackendMode: 'appServer',
        permissionMode: 'default',
        permissionModeUpdatedAt: 100,
        agentModeId: 'chat',
        agentModeUpdatedAt: 101,
        modelId: 'gpt-4.1',
        modelUpdatedAt: 102,
        connectedServices: { v: 1, bindingsByServiceId: {} },
        connectedServicesUpdatedAt: 103,
        initialTranscriptAfterSeq: 41,
        executionAuthorization: { provenance: 'user_request', requestId: 'message-42' },
      }, { onBeforeRunnerLaunchAccepted: vi.fn(async () => { throw new Error('must not claim adopted runner'); }) });

      expect(result).toEqual({
        type: 'success',
        sessionId: 'sess_already_running',
        runnerAcceptance: 'preexisting_or_adopted',
      });
      expect(fetchSessionByIdCompat).toHaveBeenCalledWith(expect.objectContaining({
        token: 'token-daemon',
        sessionId: 'sess_already_running',
        reason: 'manual-recovery',
      }));
      expect(trackedSessionCapture.current.get(12345)?.spawnOptions).toMatchObject({
        existingSessionId: 'sess_already_running',
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 200,
        agentModeId: 'plan',
        agentModeUpdatedAt: 201,
        modelId: 'gpt-5.1',
        modelUpdatedAt: 202,
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              profileId: 'fresh-profile',
              groupId: 'main',
              activeProfileId: 'fresh-profile',
            },
          },
        },
        connectedServicesUpdatedAt: 203,
      });
      expect(spawnHappyCLI).not.toHaveBeenCalled();
      expect(explicitRecoveryCheckSpy).toHaveBeenCalledExactlyOnceWith({ sessionId: 'sess_already_running' });
      expect(callSessionRpc).toHaveBeenNthCalledWith(1, {
        token: 'token-daemon',
        sessionId: 'sess_already_running',
        mode: 'plain',
        ctx: pendingMaterializationRpcMocks.ctx,
        method: 'sess_already_running:session.pendingQueue.wakeCapability.v1.get',
        request: {},
      });
      expect(callSessionRpc).toHaveBeenNthCalledWith(2, {
        token: 'token-daemon',
        sessionId: 'sess_already_running',
        mode: 'plain',
        ctx: pendingMaterializationRpcMocks.ctx,
        method: 'sess_already_running:session.pendingQueue.wakeCapability.v1.get',
        request: {},
      });
      expect(callSessionRpc).toHaveBeenCalledTimes(4);
      expect(callSessionRpc).toHaveBeenNthCalledWith(4, expect.objectContaining({
        method: 'sess_already_running:session.pendingQueue.wake.v1',
        request: { protocolVersion: 1 },
      }));
      expect(materializeNextPendingQueueV2MessageViaHttp).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run.catch(() => undefined);
      }
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(() => vi.fn());
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
      explicitRecoveryCheckSpy.mockRestore();
    }
  });

  it('launches markerless explicit Claude Resume with the exact live attachment descriptor in the child environment', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    const sessionId = 'sess_markerless_exact_recovery';
    const attachmentId = 'attachment-markerless-exact' as NonNullable<
      import('@/integrations/terminalHost/_types').TerminalHostHandle['attachmentId']
    >;
    const endpointFixture = await createValidClaudeEndpointFixture(attachmentId);
    const endpointState = endpointFixture.state;
    let run: Promise<void> | null = null;

    try {
      vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(createSessionRecordFixture({
        id: sessionId,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ flavor: 'claude', claudeSessionId: 'vendor-markerless-exact', path: '/tmp' }),
        dataEncryptionKey: null,
      }));
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockResolvedValue({
        version: 2,
        attachmentId,
        sessionId,
        handle: {
          attachmentId,
          kind: 'zellij',
          sessionName: 'markerless-exact-zellij',
          paneId: 'terminal_1',
          socketDir: '/tmp/markerless-exact-zellij',
          attachMetadata: {
            attachStrategy: 'terminal_host',
            topology: 'shared',
            locality: 'same_machine',
            liveProbe: 'required',
          },
        },
        terminal: {
          mode: 'zellij',
          zellij: {
            sessionName: 'markerless-exact-zellij',
            paneId: 'terminal_1',
            socketDirV1: '/tmp/markerless-exact-zellij',
          },
        },
        updatedAt: 1,
      });
      claudeEndpointRecoveryBoundaryMocks.readClaudeEndpointDescriptor.mockResolvedValue(endpointState);
      claudeEndpointRecoveryBoundaryMocks.evaluateLiveness.mockResolvedValue({ paneAlive: true, observedAt: 1 });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 20 && !spawnSession; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) throw new Error('Expected spawnSession to be registered');

      await expect(spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        existingSessionId: sessionId,
        token: 'token-from-spawn-options',
      })).resolves.toMatchObject({ type: 'success' });

      const launch = spawnHappyCLI.mock.calls.at(-1);
      expect((launch?.[1] as { env?: Record<string, string> } | undefined)?.env?.[
        HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY
      ]).toBe(JSON.stringify(endpointState));
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      await endpointFixture.cleanup();
      exitSpy.mockRestore();
    }
  });

  it('destroys an exact unusable preserved Claude host and launches fresh in the same Resume attempt', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    const sessionId = 'sess_exact_unusable_recovery';
    const attachmentId = 'attachment-exact-unusable' as NonNullable<
      import('@/integrations/terminalHost/_types').TerminalHostHandle['attachmentId']
    >;
    const handle = {
      attachmentId,
      kind: 'zellij' as const,
      sessionName: 'exact-unusable-zellij',
      paneId: 'terminal_1',
      socketDir: '/tmp/exact-unusable-zellij',
      attachMetadata: {
        attachStrategy: 'terminal_host' as const,
        topology: 'shared' as const,
        locality: 'same_machine' as const,
        liveProbe: 'required' as const,
      },
    };
    const attachmentInfo: TerminalAttachmentInfo = {
      version: 2,
      attachmentId,
      sessionId,
      handle,
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: handle.sessionName,
          paneId: handle.paneId,
          socketDirV1: handle.socketDir,
        },
      },
      updatedAt: 1,
    };
    const endpointState: AttachmentBoundClaudeEndpointState = {
      v: 2,
      attachmentId,
      hookServerPort: 45123,
      hookPluginDir: `/tmp/happier-missing-endpoint-artifacts-${attachmentId}`,
      hookSettingsPath: `/tmp/happier-missing-endpoint-artifacts-${attachmentId}.json`,
      mcpUrl: 'http://127.0.0.1:45124',
      mcpPort: 45124,
    };
    let attachmentPresent = true;
    let run: Promise<void> | null = null;

    try {
      vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(createSessionRecordFixture({
        id: sessionId,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ flavor: 'claude', claudeSessionId: 'vendor-exact-unusable', path: '/tmp' }),
        dataEncryptionKey: null,
      }));
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockReset();
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockImplementation(async () => (
        attachmentPresent ? attachmentInfo : null
      ));
      claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockReset();
      claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockImplementation(async () => {
        attachmentPresent = false;
        return true;
      });
      claudeEndpointRecoveryBoundaryMocks.readClaudeEndpointDescriptor.mockReset();
      claudeEndpointRecoveryBoundaryMocks.readClaudeEndpointDescriptor.mockResolvedValue(endpointState);
      claudeEndpointRecoveryBoundaryMocks.evaluateLiveness.mockReset();
      claudeEndpointRecoveryBoundaryMocks.evaluateLiveness.mockResolvedValue({ paneAlive: true, observedAt: 1 });
      claudeEndpointRecoveryBoundaryMocks.dispose.mockClear();

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 20 && !spawnSession; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) throw new Error('Expected spawnSession to be registered');

      await expect(spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        existingSessionId: sessionId,
        token: 'token-from-spawn-options',
        environmentVariables: {
          [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: JSON.stringify({ stale: true }),
        },
      })).resolves.toMatchObject({ type: 'success' });

      expect(claudeEndpointRecoveryBoundaryMocks.dispose).toHaveBeenCalledWith(handle);
      expect(claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo).toHaveBeenCalledWith({
        happyHomeDir: expect.any(String),
        sessionId,
        expectedAttachmentId: attachmentId,
        expectedTerminal: attachmentInfo.terminal,
      });
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const launch = spawnHappyCLI.mock.calls[0];
      expect((launch?.[1] as { env?: Record<string, string> } | undefined)?.env).not.toHaveProperty(
        HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY,
      );
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockReset();
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockResolvedValue(null);
      claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockReset();
      claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockResolvedValue(false);
      claudeEndpointRecoveryBoundaryMocks.readClaudeEndpointDescriptor.mockReset();
      claudeEndpointRecoveryBoundaryMocks.readClaudeEndpointDescriptor.mockResolvedValue(null);
      claudeEndpointRecoveryBoundaryMocks.evaluateLiveness.mockReset();
      claudeEndpointRecoveryBoundaryMocks.evaluateLiveness.mockResolvedValue({ paneAlive: true, observedAt: 1 });
      claudeEndpointRecoveryBoundaryMocks.dispose.mockClear();
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      exitSpy.mockRestore();
    }
  });

  it('clears inherited Claude endpoint recovery proof before a fresh launch after exact positive death', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    const endpointStateEnvOriginal = process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY];
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY] = JSON.stringify({ daemonStale: true });
    const sessionId = 'sess_positive_dead_stale_recovery';
    const attachmentId = 'attachment-positive-dead' as NonNullable<
      import('@/integrations/terminalHost/_types').TerminalHostHandle['attachmentId']
    >;
    let run: Promise<void> | null = null;

    try {
      vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(createSessionRecordFixture({
        id: sessionId,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ flavor: 'claude', claudeSessionId: 'vendor-positive-dead', path: '/tmp' }),
        dataEncryptionKey: null,
      }));
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockResolvedValue({
        version: 2,
        attachmentId,
        sessionId,
        handle: {
          attachmentId,
          kind: 'zellij',
          sessionName: 'positive-dead-zellij',
          paneId: 'terminal_2',
          socketDir: '/tmp/positive-dead-zellij',
          attachMetadata: {
            attachStrategy: 'terminal_host',
            topology: 'shared',
            locality: 'same_machine',
            liveProbe: 'required',
          },
        },
        terminal: {
          mode: 'zellij',
          zellij: {
            sessionName: 'positive-dead-zellij',
            paneId: 'terminal_2',
            socketDirV1: '/tmp/positive-dead-zellij',
          },
        },
        updatedAt: 1,
      });
      claudeEndpointRecoveryBoundaryMocks.evaluateLiveness.mockResolvedValue({
        paneAlive: false,
        paneDead: true,
        observedAt: 1,
      });
      claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockResolvedValue(true);

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 20 && !spawnSession; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) throw new Error('Expected spawnSession to be registered');

      await expect(spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        existingSessionId: sessionId,
        token: 'token-from-spawn-options',
        environmentVariables: {
          [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: JSON.stringify({ stale: true }),
        },
      })).resolves.toMatchObject({ type: 'success' });

      expect(claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          expectedAttachmentId: attachmentId,
        }),
      );
      expect(spawnHappyCLI).toHaveBeenCalled();
      const launch = spawnHappyCLI.mock.calls.at(-1);
      expect((launch?.[1] as { env?: Record<string, string> } | undefined)?.env).not.toHaveProperty(
        HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY,
      );
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      if (endpointStateEnvOriginal === undefined) delete process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY];
      else process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY] = endpointStateEnvOriginal;
      exitSpy.mockRestore();
    }
  });

  it('delegates marker-derived Claude runner absence to exact endpoint recovery', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    const sessionId = 'sess_marker_exact_recovery';
    const attachmentId = 'attachment-marker-exact' as NonNullable<
      import('@/integrations/terminalHost/_types').TerminalHostHandle['attachmentId']
    >;
    const handle = {
      attachmentId,
      kind: 'zellij' as const,
      sessionName: 'marker-exact-zellij',
      paneId: 'terminal_1',
      socketDir: '/tmp/marker-exact-zellij',
      attachMetadata: {
        attachStrategy: 'terminal_host' as const,
        topology: 'shared' as const,
        locality: 'same_machine' as const,
        liveProbe: 'required' as const,
      },
    };
    const attachmentInfo: TerminalAttachmentInfo = {
      version: 2,
      attachmentId,
      sessionId,
      handle,
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: handle.sessionName,
          paneId: handle.paneId,
          socketDirV1: handle.socketDir,
        },
      },
      updatedAt: 1,
    };
    const endpointFixture = await createValidClaudeEndpointFixture(attachmentId);
    const endpointState = endpointFixture.state;
    let run: Promise<void> | null = null;

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockResolvedValue({
        orphanedDeadDaemonSessions: [],
        disconnectedTerminalHostCandidates: [{
          sessionId,
          pid: 7722,
          happyHomeDir: '/tmp/happy-home',
          attachmentId,
          handle,
          controlDescriptorAvailable: true,
        }],
        connectedServiceRestartIntents: [],
      });
      disconnectedTerminalHostSupervisionMock.mockResolvedValue({
        state: 'recoverable_unservable',
        reason: 'runner_absent',
      });
      vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(createSessionRecordFixture({
        id: sessionId,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ flavor: 'claude', claudeSessionId: 'vendor-marker-exact', path: '/tmp' }),
        dataEncryptionKey: null,
      }));
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockReset();
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockResolvedValue(attachmentInfo);
      claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockReset();
      claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockResolvedValue(false);
      claudeEndpointRecoveryBoundaryMocks.readClaudeEndpointDescriptor.mockReset();
      claudeEndpointRecoveryBoundaryMocks.readClaudeEndpointDescriptor.mockResolvedValue(endpointState);
      claudeEndpointRecoveryBoundaryMocks.evaluateLiveness.mockReset();
      claudeEndpointRecoveryBoundaryMocks.evaluateLiveness.mockResolvedValue({ paneAlive: true, observedAt: 1 });
      claudeEndpointRecoveryBoundaryMocks.dispose.mockClear();

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 20 && !spawnSession; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) throw new Error('Expected spawnSession to be registered');

      await expect(spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        existingSessionId: sessionId,
        token: 'token-from-spawn-options',
      })).resolves.toMatchObject({ type: 'success' });

      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const launch = spawnHappyCLI.mock.calls[0];
      expect((launch?.[1] as { env?: Record<string, string> } | undefined)?.env?.[
        HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY
      ]).toBe(JSON.stringify(endpointState));
      expect(claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo).not.toHaveBeenCalled();
      expect(claudeEndpointRecoveryBoundaryMocks.dispose).not.toHaveBeenCalled();
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockResolvedValue({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      });
      disconnectedTerminalHostSupervisionMock.mockResolvedValue({
        state: 'recoverable_unservable',
        reason: 'control_descriptor_missing',
      });
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockReset();
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockResolvedValue(null);
      claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockReset();
      claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockResolvedValue(false);
      claudeEndpointRecoveryBoundaryMocks.readClaudeEndpointDescriptor.mockReset();
      claudeEndpointRecoveryBoundaryMocks.readClaudeEndpointDescriptor.mockResolvedValue(null);
      claudeEndpointRecoveryBoundaryMocks.evaluateLiveness.mockReset();
      claudeEndpointRecoveryBoundaryMocks.evaluateLiveness.mockResolvedValue({ paneAlive: true, observedAt: 1 });
      claudeEndpointRecoveryBoundaryMocks.dispose.mockClear();
      await endpointFixture.cleanup();
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      exitSpy.mockRestore();
    }
  });

  it('fences explicit Resume before spawn when an exact preserved host lacks its control descriptor', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      const attachmentId = 'attachment-preserved-without-control' as NonNullable<
        import('@/integrations/terminalHost/_types').TerminalHostHandle['attachmentId']
      >;
      const handle = {
        attachmentId,
        kind: 'zellij' as const,
        sessionName: 'preserved-without-control',
        paneId: 'terminal_1',
        socketDir: '/tmp/preserved-without-control',
        attachMetadata: {
          attachStrategy: 'terminal_host' as const,
          topology: 'shared' as const,
          locality: 'same_machine' as const,
          liveProbe: 'required' as const,
        },
      };
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockResolvedValue({
        orphanedDeadDaemonSessions: [],
        disconnectedTerminalHostCandidates: [{
          sessionId: 'sess_preserved_without_control',
          pid: 7711,
          happyHomeDir: '/tmp/happy',
          attachmentId,
          handle,
          controlDescriptorAvailable: false,
        }],
        connectedServiceRestartIntents: [],
      });
    disconnectedTerminalHostSupervisionMock.mockResolvedValue({
      state: 'recoverable_unservable',
      reason: 'control_descriptor_missing',
    });
    claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockReset();
    claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockResolvedValue(null);
    claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockReset();
    claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockResolvedValue(false);
    claudeEndpointRecoveryBoundaryMocks.readClaudeEndpointDescriptor.mockReset();
    claudeEndpointRecoveryBoundaryMocks.readClaudeEndpointDescriptor.mockResolvedValue(null);
    claudeEndpointRecoveryBoundaryMocks.evaluateLiveness.mockReset();
    claudeEndpointRecoveryBoundaryMocks.evaluateLiveness.mockResolvedValue({ paneAlive: true, observedAt: 1 });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 20 && !spawnSession; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) throw new Error('Expected spawnSession to be registered');

      await expect(spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        existingSessionId: 'sess_preserved_without_control',
        token: 'token-from-spawn-options',
      })).resolves.toEqual({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'This session has a preserved terminal host that cannot be controlled safely. Stop the session, then Resume again to launch a fresh host.',
      });
      expect(spawnHappyCLI).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockResolvedValue({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      });
      disconnectedTerminalHostSupervisionMock.mockResolvedValue({
        state: 'recoverable_unservable',
        reason: 'control_descriptor_missing',
      });
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      exitSpy.mockRestore();
    }
  });

  it('routes explicit Stop to the exact preserved host only after proving all runners absent', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      const attachmentId = 'attachment-preserved-stop' as NonNullable<
        import('@/integrations/terminalHost/_types').TerminalHostHandle['attachmentId']
      >;
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockResolvedValue({
        orphanedDeadDaemonSessions: [],
        disconnectedTerminalHostCandidates: [{
          sessionId: 'sess_preserved_stop',
          pid: 7712,
          happyHomeDir: '/tmp/happy',
          attachmentId,
          handle: {
            attachmentId,
            kind: 'zellij',
            sessionName: 'preserved-stop',
            paneId: 'terminal_2',
            socketDir: '/tmp/preserved-stop',
            attachMetadata: {
              attachStrategy: 'terminal_host',
              topology: 'shared',
              locality: 'same_machine',
              liveProbe: 'required',
            },
          },
          controlDescriptorAvailable: false,
        }],
        connectedServiceRestartIntents: [],
      });
      stopSessionMocks.stopSession
        .mockResolvedValueOnce({ status: 'incomplete', reason: 'tracked_runner_absent' })
        .mockResolvedValueOnce({ status: 'incomplete', reason: 'tracked_runner_absent' })
        .mockResolvedValueOnce({ status: 'stopped' });
      sessionRunnerActivityBoundaryMocks.readSessionRunnerLockStatus
        .mockImplementationOnce(async ({ sessionId }) => ({
          ok: true,
          lock: { sessionId, pid: 7712, acquiredAtMs: 1 },
        }))
        .mockResolvedValue({ ok: false, reason: 'not_found' });
      sessionRunnerActivityBoundaryMocks.readProcessRunState.mockResolvedValue('servable');
      vi.mocked(callSessionRpc).mockResolvedValue({ ok: false, errorCode: 'rpc_method_unavailable' });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      let stopSession = harness.getStopSession();
      for (let attempt = 0; attempt < 20 && !stopSession; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        stopSession = harness.getStopSession();
      }
      if (!stopSession) throw new Error('Expected stopSession to be registered');

      await expect(stopSession('sess_preserved_stop')).resolves.toEqual({
        status: 'incomplete',
        reason: 'tracked_runner_absent',
      });
      expect(stopSessionMocks.stopSession).toHaveBeenCalledTimes(1);
      expect(stopSessionMocks.createStopSession).toHaveBeenCalledTimes(1);

      await expect(stopSession('sess_preserved_stop')).resolves.toEqual({ status: 'stopped' });
      expect(stopSessionMocks.stopSession).toHaveBeenCalledTimes(3);
      expect(stopSessionMocks.createStopSession).toHaveBeenCalledTimes(2);
      const reconstructedStopInput = stopSessionMocks.createStopSession.mock.calls[1]?.[0];
      expect(Array.from(reconstructedStopInput?.pidToTrackedSession.keys() ?? [])).toEqual([7712]);
      expect(reconstructedStopInput?.provenTerminalHostKindsByPid?.get(7712)).toBe('zellij');
      expect(reconstructedStopInput?.requireTerminalTopologyProof).toBe(true);

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockResolvedValue({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      });
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      exitSpy.mockRestore();
    }
  });

  it('makes explicit Stop supersede every automatic recovery owner without letting cleanup failure block retirement', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    const usageLimitCancelSpy = vi.spyOn(UsageLimitRecoveryScheduler.prototype, 'cancel');
    const runtimeAuthCancelSpy = vi.spyOn(RuntimeAuthRecoveryScheduler.prototype, 'cancel');
    const temporaryThrottleCancelSpy = vi.spyOn(TemporaryThrottleRecoveryScheduler.prototype, 'stopRetrying');
    const sessionId = 'sess_explicit_stop_recovery';
    const recovery = {
      v: 1 as const,
      issueFingerprint: 'usage-limit:claude:turn-1:1000:2000',
      status: 'waiting' as const,
      armedAtMs: 1_000,
      resetAtMs: 2_000,
      nextCheckAtMs: 2_000,
      attemptCount: 0,
      maxAttempts: 3,
      lastProbeError: null,
      resumePromptMode: 'standard' as const,
      selectedAuth: { kind: 'native' as const },
    };
    let run: Promise<void> | null = null;

    try {
      vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSessionRecordFixture({
        id: sessionId,
        active: true,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ sessionUsageLimitRecoveryV1: recovery }),
        dataEncryptionKey: null,
      }));
      updateSessionMetadataWithRetryMock.mockImplementationOnce(async (params) => ({
        version: (params.rawSession.metadataVersion ?? 0) + 1,
        metadata: params.updater({ sessionUsageLimitRecoveryV1: recovery }),
      }));

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      let stopSession = harness.getStopSession();
      for (let attempt = 0; attempt < 20 && !stopSession; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        stopSession = harness.getStopSession();
      }
      if (!stopSession) throw new Error('Expected stopSession to be registered');

      await expect(stopSession(sessionId)).resolves.toEqual({ status: 'stopped' });

      expect(usageLimitCancelSpy).toHaveBeenCalledWith({ sessionId });
      expect(runtimeAuthCancelSpy).toHaveBeenCalledWith({ sessionId });
      expect(temporaryThrottleCancelSpy).toHaveBeenCalledWith({ sessionId });
      const metadataUpdate = updateSessionMetadataWithRetryMock.mock.calls.find(
        ([call]) => (call as { sessionId?: string }).sessionId === sessionId,
      )?.[0];
      expect(metadataUpdate?.updater({ sessionUsageLimitRecoveryV1: recovery })).toMatchObject({
        sessionUsageLimitRecoveryV1: {
          issueFingerprint: recovery.issueFingerprint,
          armedAtMs: recovery.armedAtMs,
          status: 'cancelled',
          nextCheckAtMs: null,
        },
      });

      usageLimitCancelSpy.mockRejectedValueOnce(new Error('durable recovery store unavailable'));
      await expect(stopSession(sessionId)).resolves.toEqual({ status: 'stopped' });

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      usageLimitCancelSpy.mockRestore();
      runtimeAuthCancelSpy.mockRestore();
      temporaryThrottleCancelSpy.mockRestore();
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      exitSpy.mockRestore();
    }
  });

  it('keeps a repeated exact Stop successful after the same daemon already completed it', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      stopSessionMocks.stopSession
        .mockResolvedValueOnce({ status: 'stopped' })
        .mockResolvedValue({ status: 'not_found' });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      let stopSession = harness.getStopSession();
      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 20 && (!stopSession || !spawnSession); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        stopSession = harness.getStopSession();
        spawnSession = harness.getSpawnSession();
      }
      if (!stopSession || !spawnSession) throw new Error('Expected session lifecycle handlers to be registered');

      await expect(stopSession('sess_repeated_exact_stop')).resolves.toEqual({ status: 'stopped' });
      await expect(stopSession('sess_repeated_exact_stop')).resolves.toEqual({ status: 'stopped' });
      expect(stopSessionMocks.stopSession).toHaveBeenCalledTimes(2);

      await expect(spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        existingSessionId: 'sess_repeated_exact_stop',
        existingSessionAttachPayload: { v: 2, encryptionMode: 'plain' },
      })).resolves.toMatchObject({ type: 'success' });
      await expect(stopSession('sess_repeated_exact_stop')).resolves.toEqual({ status: 'not_found' });
      expect(stopSessionMocks.stopSession).toHaveBeenCalledTimes(3);

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
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

  it('allows immediate exact Resume after an exact successful Stop retires the cached preserved host on the same daemon', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      const sessionId = 'sess_preserved_stop_then_resume';
      const attachmentId = 'attachment-preserved-stop-then-resume' as NonNullable<
        import('@/integrations/terminalHost/_types').TerminalHostHandle['attachmentId']
      >;
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockResolvedValue({
        orphanedDeadDaemonSessions: [],
        disconnectedTerminalHostCandidates: [{
          sessionId,
          pid: 7713,
          happyHomeDir: '/tmp/happy',
          attachmentId,
          handle: {
            attachmentId,
            kind: 'zellij',
            sessionName: 'preserved-stop-then-resume',
            paneId: 'terminal_3',
            socketDir: '/tmp/preserved-stop-then-resume',
            attachMetadata: {
              attachStrategy: 'terminal_host',
              topology: 'shared',
              locality: 'same_machine',
              liveProbe: 'required',
            },
          },
          controlDescriptorAvailable: false,
        }],
        connectedServiceRestartIntents: [],
      });
      let releaseStop!: () => void;
      const stopPending = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      stopSessionMocks.createStopSession.mockImplementationOnce((input) => vi.fn(async (stoppedSessionId) => {
        await input.onExactTerminalAttachmentRetired?.({
          happyHomeDir: '/tmp/happy',
          sessionId,
          attachmentInfo: {
            version: 2,
            attachmentId,
            sessionId,
            handle: {
              attachmentId,
              kind: 'zellij',
              sessionName: 'preserved-stop-then-resume',
              paneId: 'terminal_3',
              socketDir: '/tmp/preserved-stop-then-resume',
              attachMetadata: {
                attachStrategy: 'terminal_host',
                topology: 'shared',
                locality: 'same_machine',
                liveProbe: 'required',
              },
            },
            terminal: {
              mode: 'zellij',
              zellij: {
                sessionName: 'preserved-stop-then-resume',
                paneId: 'terminal_3',
                socketDirV1: '/tmp/preserved-stop-then-resume',
              },
            },
            updatedAt: 1,
          },
        });
        await stopPending;
        await input.retireExactTerminalControlServiceability?.({
          happyHomeDir: '/tmp/happy',
          sessionId,
          attachmentInfo: {
            version: 2,
            attachmentId,
            sessionId,
            handle: {
              attachmentId,
              kind: 'zellij',
              sessionName: 'preserved-stop-then-resume',
              paneId: 'terminal_3',
              socketDir: '/tmp/preserved-stop-then-resume',
              attachMetadata: {
                attachStrategy: 'terminal_host',
                topology: 'shared',
                locality: 'same_machine',
                liveProbe: 'required',
              },
            },
            terminal: {
              mode: 'zellij',
              zellij: {
                sessionName: 'preserved-stop-then-resume',
                paneId: 'terminal_3',
                socketDirV1: '/tmp/preserved-stop-then-resume',
              },
            },
            updatedAt: 1,
          },
        });
        return await stopSessionMocks.stopSession(stoppedSessionId);
      }));
      disconnectedTerminalHostSupervisionMock.mockResolvedValue({
        state: 'recoverable_unservable',
        reason: 'attachment_changed',
      });
      vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(createSessionRecordFixture({
        id: sessionId,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ flavor: 'claude', claudeSessionId: 'vendor-stop-then-resume', path: '/tmp' }),
        dataEncryptionKey: null,
      }));

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      let stopSession = harness.getStopSession();
      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 20 && (!stopSession || !spawnSession); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        stopSession = harness.getStopSession();
        spawnSession = harness.getSpawnSession();
      }
      if (!stopSession || !spawnSession) throw new Error('Expected stopSession and spawnSession to be registered');

      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (disconnectedTerminalHostSupervisionMock.mock.calls.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(disconnectedTerminalHostSupervisionMock).toHaveBeenCalledTimes(1);
      disconnectedTerminalHostSupervisionMock.mockClear();

      const stopResult = stopSession(sessionId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const resumeResult = spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        existingSessionId: sessionId,
        token: 'token-from-spawn-options',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(disconnectedTerminalHostSupervisionMock).not.toHaveBeenCalled();
      releaseStop();
      await expect(stopResult).resolves.toEqual({ status: 'stopped' });
      await expect(resumeResult).resolves.toMatchObject({ type: 'success' });

      expect(stopSessionMocks.stopSession).toHaveBeenCalledTimes(1);
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      expect(disconnectedTerminalHostSupervisionMock).not.toHaveBeenCalled();
      expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledWith(expect.objectContaining({
        sessionId,
      }));
      const recoverableServiceability = {
        terminal: {
          mode: 'zellij',
          controlServiceabilityV1: {
            v: 1,
            attachmentId,
            state: 'recoverable_unservable',
            observedAt: 100,
            reason: 'control_descriptor_missing',
          },
        },
      };
      const retirementUpdate = updateSessionMetadataWithRetryMock.mock.calls
        .map(([call]) => call)
        .find((call) => {
          if (!call || typeof call !== 'object' || !('sessionId' in call) || call.sessionId !== sessionId) return false;
          const updated = call.updater(recoverableServiceability);
          const terminal = updated.terminal;
          if (!terminal || typeof terminal !== 'object' || !('controlServiceabilityV1' in terminal)) return false;
          const serviceability = terminal.controlServiceabilityV1;
          return Boolean(serviceability && typeof serviceability === 'object' && 'retired' in serviceability && serviceability.retired === true);
        });
      expect(retirementUpdate?.updater(recoverableServiceability)).toMatchObject({
        terminal: {
          mode: 'zellij',
          controlServiceabilityV1: {
            attachmentId,
            state: 'unknown',
            reason: 'attachment_retired',
            retired: true,
          },
        },
      });

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockResolvedValue({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      });
      disconnectedTerminalHostSupervisionMock.mockResolvedValue({
        state: 'recoverable_unservable',
        reason: 'control_descriptor_missing',
      });
      stopSessionMocks.createStopSession.mockImplementation(() => stopSessionMocks.stopSession);
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      exitSpy.mockRestore();
    }
  });

  it('repairs dead legacy terminal topology through the canonical Stop owner before Resume', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockResolvedValue({
        orphanedDeadDaemonSessions: [],
        unresolvedTerminalHostSessionIds: ['sess_unresolved_terminal_topology'],
        connectedServiceRestartIntents: [],
      });
      stopSessionMocks.stopSession.mockResolvedValueOnce({ status: 'stopped' });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 20 && !spawnSession; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) throw new Error('Expected spawnSession to be registered');

      await expect(spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        existingSessionId: 'sess_unresolved_terminal_topology',
        existingSessionAttachPayload: { v: 2, encryptionMode: 'plain' },
      })).resolves.toMatchObject({ type: 'success' });
      expect(stopSessionMocks.stopSession).toHaveBeenCalledWith('sess_unresolved_terminal_topology');
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      const respawnManager = sessionRespawnManagerCapture.instances[0];
      expect(respawnManager?.markStopRequested).toHaveBeenCalledWith(
        'sess_unresolved_terminal_topology',
        expect.objectContaining({ reason: 'daemon_stop_session' }),
      );
      expect(respawnManager?.clearStopRequested).toHaveBeenCalledWith('sess_unresolved_terminal_topology');

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockResolvedValue({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      });
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      exitSpy.mockRestore();
    }
  });

  it('keeps explicit Resume fenced when canonical Stop cannot verify legacy retirement', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockResolvedValue({
        orphanedDeadDaemonSessions: [],
        unresolvedTerminalHostSessionIds: ['sess_unresolved_terminal_topology'],
        connectedServiceRestartIntents: [],
      });
      stopSessionMocks.stopSession.mockResolvedValueOnce({
        status: 'incomplete',
        reason: 'legacy_attachment',
      });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 20 && !spawnSession; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) throw new Error('Expected spawnSession to be registered');

      await expect(spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        existingSessionId: 'sess_unresolved_terminal_topology',
        existingSessionAttachPayload: { v: 2, encryptionMode: 'plain' },
      })).resolves.toEqual({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'This session has preserved terminal topology that is unreadable or legacy. Repair or migrate that topology before trying Resume again.',
      });
      expect(spawnHappyCLI).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockResolvedValue({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
      });
      stopSessionMocks.stopSession.mockResolvedValue({ status: 'stopped' });
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      exitSpy.mockRestore();
    }
  });

  it('fences duplicate resume when process liveness is known but exact-session serviceability is unknown', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    sessionRunnerActivityBoundaryMocks.readProcessRunState
      .mockResolvedValueOnce('servable')
      .mockResolvedValue('dead');
    vi.mocked(callSessionRpc).mockRejectedValueOnce(new Error('runner control RPC unavailable'));
    pendingMaterializationRpcMocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess_stale_runner',
      rawSession: {
        id: 'sess_stale_runner',
        active: true,
        encryptionMode: 'plain',
      },
      mode: 'plain',
      ctx: pendingMaterializationRpcMocks.ctx,
    });

    try {
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      const trackedSessionCapture: {
        current: Map<number, {
          happySessionId?: string;
          startedBy?: string;
          spawnOptions?: Record<string, unknown>;
          vendorResumeId?: string;
          stopRequestedAtMs?: number;
        }> | null;
      } = { current: null };
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ pidToTrackedSession }) => {
        trackedSessionCapture.current = pidToTrackedSession as typeof trackedSessionCapture.current;
        return vi.fn();
      });

      const { startDaemon } = await import('./startDaemon');
      const run = startDaemon();
      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 20 && !spawnSession; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) {
        const { logger } = await import('@/ui/logger');
        throw new Error(`Expected spawnSession to be registered; daemon debug=${JSON.stringify(vi.mocked(logger.debug).mock.calls.slice(-3))}`);
      }
      if (!trackedSessionCapture.current) {
        throw new Error('Expected tracked session map from webhook wiring');
      }
      trackedSessionCapture.current.set(12345, {
        happySessionId: 'sess_stale_runner',
        startedBy: 'daemon',
        spawnOptions: {
          directory: '/tmp',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          existingSessionId: 'sess_stale_runner',
        },
      });

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_stale_runner',
        token: 'token-from-spawn-options',
        codexBackendMode: 'appServer',
      });

      expect(result).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED });
      expect(callSessionRpc).toHaveBeenCalledOnce();
      expect(vi.mocked(callSessionRpc).mock.calls[0]?.[0]).toEqual(expect.objectContaining({
        method: 'sess_stale_runner:session.pendingQueue.wakeCapability.v1.get',
      }));
      // Unknown is fail-safe: neither adoption nor replacement is claimed.
      expect(stopSessionMocks.stopSession).not.toHaveBeenCalled();
      expect(spawnHappyCLI).not.toHaveBeenCalled();
      expect(materializeNextPendingQueueV2MessageViaHttp).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(() => vi.fn());
      vi.mocked(callSessionRpc).mockReset();
      vi.mocked(callSessionRpc).mockResolvedValue({
        ok: true,
        didMaterialize: false,
        result: { type: 'no_pending' },
      });
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('waits for a terminating predecessor to exit before spawning the explicit resume successor', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let predecessorTerminationObserved = false;
    sessionRunnerActivityBoundaryMocks.readProcessRunState.mockImplementation(async () => (
      predecessorTerminationObserved ? 'dead' : 'servable'
    ));
    vi.mocked(callSessionRpc).mockImplementationOnce(async () => {
      predecessorTerminationObserved = true;
      return {
        ok: false,
        error: 'pending_materialization_wake_unavailable',
        errorCode: 'runtime_terminating',
      };
    });
    pendingMaterializationRpcMocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess_terminating_predecessor',
      rawSession: {
        id: 'sess_terminating_predecessor',
        active: true,
        encryptionMode: 'plain',
      },
      mode: 'plain',
      ctx: pendingMaterializationRpcMocks.ctx,
    });
    vi.mocked(waitForSessionWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'sess_terminating_predecessor',
    });

    let run: Promise<void> | null = null;
    try {
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      const trackedSessionCapture: { current: Map<number, any> | null } = { current: null };
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ pidToTrackedSession }) => {
        trackedSessionCapture.current = pidToTrackedSession;
        return vi.fn();
      });
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 20 && (!spawnSession || !trackedSessionCapture.current); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) throw new Error('Expected spawnSession to be registered');
      if (!trackedSessionCapture.current) throw new Error('Expected tracked session map to be registered');
      trackedSessionCapture.current.set(8123, {
        pid: 8123,
        startedBy: 'daemon',
        happySessionId: 'sess_terminating_predecessor',
      });

      const resumeResult = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_terminating_predecessor',
        token: 'token-from-spawn-options',
        codexBackendMode: 'appServer',
      });
      expect(predecessorTerminationObserved).toBe(true);
      expect(callSessionRpc).toHaveBeenNthCalledWith(1, expect.objectContaining({
        method: 'sess_terminating_predecessor:session.pendingQueue.wakeCapability.v1.get',
      }));
      expect(resumeResult).toEqual({
        type: 'success',
        sessionId: 'sess_terminating_predecessor',
        runnerAcceptance: 'newly_accepted',
      });
      await vi.waitFor(() => expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
        method: 'sess_terminating_predecessor:session.pendingQueue.wake.v1',
        request: { protocolVersion: 1 },
      })));
      expect(callSessionRpc).toHaveBeenCalledTimes(3);

      expect(sessionRunnerActivityBoundaryMocks.readSessionRunnerLockStatus).toHaveBeenCalledOnce();
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
      vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(() => vi.fn());
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('repairs a missing materialization identity before resuming an existing Claude connected-service session', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    vi.mocked(resolveConnectedServiceSwitchContinuity).mockResolvedValueOnce({
      mode: 'unsupported',
      reason: 'provider_session_state_unavailable_for_resume',
    });

    const storedSession = createSessionRecordFixture({
      id: 'sess_claude_repair',
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        flavor: 'claude',
        claudeSessionId: 'vendor-claude-repair',
        path: '/tmp',
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: {
              source: 'connected',
              selection: 'profile',
              profileId: 'profile-claude-repair',
            },
          },
        },
        connectedServicesUpdatedAt: 300,
      }),
      dataEncryptionKey: null,
    });
    vi.mocked(fetchSessionByIdCompat).mockImplementation(async ({ sessionId }) => (
      sessionId === 'sess_claude_repair'
        ? storedSession
        : createSessionRecordFixture({
            id: 'sess_plain',
            encryptionMode: 'plain',
            metadata: JSON.stringify({ flavor: 'codex', codexSessionId: 'vendor-plain-1', path: '/tmp' }),
            dataEncryptionKey: null,
          })
    ));
    vi.mocked(waitForSessionWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'sess_claude_repair',
    });

    let run: Promise<unknown> | null = null;
    let shutdownRequested = false;
    try {
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = await waitForSpawnSessionRegistration();

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        existingSessionId: 'sess_claude_repair',
        token: 'token-from-spawn-options',
      });

      expect(resolveConnectedServiceSwitchContinuity).not.toHaveBeenCalled();
      expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_claude_repair',
      }));
      expect(resolveConnectedServiceAuthForSpawnMock).toHaveBeenCalled();
      expect(result).toEqual({
        type: 'success',
        sessionId: 'sess_claude_repair',
        runnerAcceptance: 'newly_accepted',
      });
      expect(resolveConnectedServiceAuthForSpawnMock).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_claude_repair',
        connectedServiceMaterializationIdentityV1: expect.objectContaining({ v: 1 }),
      }));
      const authCall = (resolveConnectedServiceAuthForSpawnMock.mock.calls as unknown as ReadonlyArray<readonly [unknown]>).at(0);
      const authInput = authCall?.[0] as {
        materializationKey?: unknown;
        connectedServiceMaterializationIdentityV1?: { id?: string };
      } | undefined;
      expect(authInput?.materializationKey).toBe(authInput?.connectedServiceMaterializationIdentityV1?.id);
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);

      shutdownRequested = true;
      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (!shutdownRequested) {
        harness.requestShutdown('happier-cli');
        await run?.catch(() => {});
      }
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('fails closed when resuming an existing connected-service session without identity or provider resume state', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess_missing_identity_no_resume',
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          flavor: 'codex',
          path: '/tmp',
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': {
                source: 'connected',
                selection: 'group',
                groupId: 'happier',
                profileId: 'codex1',
              },
            },
          },
          connectedServicesUpdatedAt: 300,
        }),
        dataEncryptionKey: null,
      }),
    );

    let run: Promise<unknown> | null = null;
    let shutdownRequested = false;
    try {
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 10 && !spawnSession; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_missing_identity_no_resume',
        token: 'token-from-spawn-options',
      });

      expect(result).toMatchObject({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'connected_service_materialization_identity_missing',
      });
      expect(isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)).toBe(true);
      if (!isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)) {
        throw new Error('expected connected-service diagnostic spawn detail');
      }
      expect(result.errorDetail.uxDiagnostic.code).toBe('connected_service_materialization_identity_missing');
      expect(result.errorDetail.uxDiagnostic.failurePhase).toBe('materialization');
      expect(resolveConnectedServiceSwitchContinuity).not.toHaveBeenCalled();
      expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_missing_identity_no_resume',
      }));
      expect(resolveConnectedServiceAuthForSpawnMock).not.toHaveBeenCalled();
      expect(spawnHappyCLI).not.toHaveBeenCalled();

      shutdownRequested = true;
      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (!shutdownRequested) {
        harness.requestShutdown('happier-cli');
        await run?.catch(() => {});
      }
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('publishes one idempotent pending queue wake through the guarded live session RPC after fresh attach', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    const guardedRpcMock = vi.mocked(callSessionRpc);
    guardedRpcMock
      .mockResolvedValueOnce({ ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' })
      .mockResolvedValueOnce({ ok: true, result: 'wake_published' });

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 20 && !spawnSession; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_plain',
        token: 'token-from-spawn-options',
        codexBackendMode: 'appServer',
      });

      expect(result).toMatchObject({ type: 'success', sessionId: 'sess_plain' });
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);

      expect(guardedRpcMock).toHaveBeenCalledTimes(2);
      expect(guardedRpcMock.mock.calls[0]?.[0]).toEqual({
        token: 'token-daemon',
        sessionId: 'sess_plain',
        mode: 'plain',
        ctx: pendingMaterializationRpcMocks.ctx,
        method: 'sess_plain:session.pendingQueue.wakeCapability.v1.get',
        request: {},
      });
      expect(guardedRpcMock.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        method: 'sess_plain:session.pendingQueue.wake.v1',
        request: { protocolVersion: 1 },
      }));
      expect(materializeNextPendingQueueV2MessageViaHttp).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      guardedRpcMock.mockReset();
      guardedRpcMock.mockResolvedValue({
        ok: true,
        didMaterialize: false,
        result: { type: 'no_pending' },
      });
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      exitSpy.mockRestore();
    }
  });

  it('does not arm a daemon materialization retry timer after the one-shot attach wake', async () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    vi.mocked(callSessionRpc).mockImplementation(async (raw?: unknown) =>
      (raw as { method?: string } | undefined)?.method?.endsWith('wakeCapability.v1.get') === true
        ? { ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' }
        : { ok: true, result: 'wake_published' });

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; attempt < 20 && !spawnSession; attempt += 1) {
        await vi.advanceTimersByTimeAsync(0);
        spawnSession = harness.getSpawnSession();
      }
      if (!spawnSession) {
        throw new Error('Expected spawnSession to be registered');
      }

      const resultPromise = spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_plain',
        token: 'token-from-spawn-options',
        codexBackendMode: 'appServer',
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(resultPromise).resolves.toMatchObject({ type: 'success', sessionId: 'sess_plain' });

      await vi.waitFor(() => expect(callSessionRpc).toHaveBeenCalledTimes(2));
      const timerCountAfterWake = vi.getTimerCount();

      harness.requestShutdown('happier-cli');
      await vi.advanceTimersByTimeAsync(0);
      await run;

      await vi.advanceTimersByTimeAsync(60_000);
      expect(callSessionRpc).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(timerCountAfterWake);
    } finally {
      vi.useRealTimers();
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

      const spawnSession = await waitForSpawnSessionRegistration();

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

      const spawnSession = await waitForSpawnSessionRegistration();

      const result = await spawnSession({
        directory: '~/Documents/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(result).toEqual({
        type: 'success',
        runnerAcceptance: 'newly_accepted',
        spawnNonce: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        sessionIdStatus: 'pending',
      });
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

      const spawnSession = await waitForSpawnSessionRegistration();

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'sess_plain',
        token: 't',
        codexBackendMode: 'acp',
      });

      expect(result).toEqual({
        type: 'success',
        sessionId: 'sess_plain',
        runnerAcceptance: 'newly_accepted',
      });
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

  it('routes configured ACP backend attach spawns through the acp-catalog command with preset args', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = await waitForSpawnSessionRegistration();

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

      const spawnSession = await waitForSpawnSessionRegistration();

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

      const spawnSession = await waitForSpawnSessionRegistration();

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

      const spawnSession = await waitForSpawnSessionRegistration();

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

  it('marks control routes as shutting down once beforeShutdown quiesces quota producers', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
    delete process.env.HAPPIER_DAEMON_WAIT_FOR_AUTH;

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

      for (let attempt = 0; !harness.getBeforeShutdown() && attempt < 200; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const beforeShutdown = harness.getBeforeShutdown();
      const isShuttingDown = harness.getIsShuttingDown();
      if (!beforeShutdown || !isShuttingDown) {
        throw new Error('Expected control server shutdown hooks to be registered');
      }

      expect(isShuttingDown()).toBe(false);
      await beforeShutdown();
      expect(isShuttingDown()).toBe(true);

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

      expect(harness.apiMachine.recoverDaemonTerminalSessionMutationJournals).toHaveBeenCalledTimes(1);

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

  it('flushes daemon server work again after pending machine RPC requests settle', async () => {
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

    const serverWorkScheduler = {
      enqueue: vi.fn(async () => ({ status: 'written' as const })),
      flushAll: vi.fn(async () => ({ timedOut: false })),
      recordEvent: vi.fn(),
      getSnapshot: vi.fn(() => ({
        pendingKeyCount: 0,
        pendingPayloadBytes: 0,
        purposes: {},
        keys: {},
      })),
    };

    try {
      vi.resetModules();
      vi.doMock('./serverWork', async (importOriginal) => {
        const actual = await importOriginal<typeof import('./serverWork')>();
        return {
          ...actual,
          createDaemonServerWorkScheduler: vi.fn(() => serverWorkScheduler),
        };
      });
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
        expect(serverWorkScheduler.flushAll).toHaveBeenCalledTimes(1);
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
      expect(serverWorkScheduler.flushAll).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      resolvePendingRpc();
      await waitForBeforeShutdown;

      expect(settled).toBe(true);
      expect(serverWorkScheduler.flushAll).toHaveBeenCalledTimes(2);

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      vi.doUnmock('./serverWork');
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
    const immutableEntrypoint = '/runtime/.runner-snapshots/0123456789abcdef/index.mjs';
    const runtimeDecision: HappyCliSubprocessRuntimeDecision = {
      runtime: 'node',
      argvPrefix: ['--no-warnings', '--no-deprecation', immutableEntrypoint],
      env: { HAPPIER_TEST_ADMITTED_CLOSURE: '0123456789abcdef' },
    };
    resolveHappyCliSubprocessRuntimeDecision.mockReturnValue(runtimeDecision);

    try {
      const { buildHappyCliSubprocessLaunchSpec } = await import('@/utils/spawnHappyCLI');
      const { resolveWindowsRemoteSessionConsoleMode } = await import('./platform/windows/windowsSessionConsoleMode');
      const { startHappySessionInVisibleWindowsConsole } = await import('./platform/windows/spawnHappyCliVisibleConsole');
      const { startDaemon } = await import('./startDaemon');

      vi.mocked(buildHappyCliSubprocessLaunchSpec).mockImplementation((args, options) => ({
        runtime: 'node',
        filePath: 'node',
        args: [...(options?.runtimeDecision?.argvPrefix ?? ['/mutable/source/index.ts']), ...args],
        env: options?.runtimeDecision?.env ? { ...options.runtimeDecision.env } : undefined,
      }));
      vi.mocked(startHappySessionInVisibleWindowsConsole).mockClear();
      vi.mocked(resolveWindowsRemoteSessionConsoleMode).mockReturnValue('console');

      run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; !spawnSession && attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
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
        windowsRemoteSessionConsole: 'visible',
      });

      expect(startHappySessionInVisibleWindowsConsole).toHaveBeenCalledWith(expect.objectContaining({
        filePath: 'node',
        args: expect.arrayContaining([immutableEntrypoint, 'codex', '--happy-starting-mode', 'remote']),
        workingDirectory: '/tmp',
        env: expect.objectContaining({ HAPPIER_TEST_ADMITTED_CLOSURE: '0123456789abcdef' }),
      }));
      const launchOptions = vi.mocked(buildHappyCliSubprocessLaunchSpec).mock.calls.at(-1)?.[1];
      expect(launchOptions).toEqual(expect.objectContaining({
        preferWindowsPackagedBinary: true,
        runtimeDecision,
      }));
      expect(launchOptions?.runtimeDecision).toBe(runtimeDecision);
      expect(resolveHappyCliSubprocessRuntimeDecision).toHaveBeenCalledTimes(1);
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

  it('uses the same admitted immutable runner decision for the Windows Terminal adapter', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;
    const immutableEntrypoint = '/runtime/.runner-snapshots/fedcba9876543210/index.mjs';
    const runtimeDecision: HappyCliSubprocessRuntimeDecision = {
      runtime: 'node',
      argvPrefix: ['--no-warnings', '--no-deprecation', immutableEntrypoint],
      env: { HAPPIER_TEST_ADMITTED_CLOSURE: 'fedcba9876543210' },
    };
    resolveHappyCliSubprocessRuntimeDecision.mockReturnValue(runtimeDecision);

    try {
      const { buildHappyCliSubprocessLaunchSpec } = await import('@/utils/spawnHappyCLI');
      const { resolveWindowsRemoteSessionConsoleMode } = await import('./platform/windows/windowsSessionConsoleMode');
      const { startHappySessionInWindowsTerminal } = await import('./platform/windows/spawnHappyCliWindowsTerminal');
      const { startDaemon } = await import('./startDaemon');

      vi.mocked(buildHappyCliSubprocessLaunchSpec).mockImplementation((args, options) => ({
        runtime: 'node',
        filePath: 'node',
        args: [...(options?.runtimeDecision?.argvPrefix ?? ['/mutable/source/index.ts']), ...args],
        env: options?.runtimeDecision?.env ? { ...options.runtimeDecision.env } : undefined,
      }));
      vi.mocked(startHappySessionInWindowsTerminal).mockClear();
      vi.mocked(resolveWindowsRemoteSessionConsoleMode).mockReturnValue('windows_terminal');

      run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      let spawnSession = harness.getSpawnSession();
      for (let attempt = 0; !spawnSession && attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
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
        windowsRemoteSessionLaunchMode: 'windows_terminal',
      });

      expect(startHappySessionInWindowsTerminal).toHaveBeenCalledWith(expect.objectContaining({
        filePath: 'node',
        args: expect.arrayContaining([immutableEntrypoint, 'codex', '--happy-starting-mode', 'remote']),
        workingDirectory: '/tmp',
        env: expect.objectContaining({ HAPPIER_TEST_ADMITTED_CLOSURE: 'fedcba9876543210' }),
      }));
      const launchOptions = vi.mocked(buildHappyCliSubprocessLaunchSpec).mock.calls.at(-1)?.[1];
      expect(launchOptions).toEqual(expect.objectContaining({
        preferWindowsPackagedBinary: true,
        runtimeDecision,
      }));
      expect(launchOptions?.runtimeDecision).toBe(runtimeDecision);
      expect(resolveHappyCliSubprocessRuntimeDecision).toHaveBeenCalledTimes(1);
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
