import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { encodeBase64, encrypt } from '@/api/encryption';
import * as processInstanceBoundary from '@happier-dev/cli-common/processInstance';
import type { Metadata } from '@/api/types';
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY } from './platform/linux/daemonSpawnedSessionCgroupSelfMigration';
import { createHttpStatusError } from '@/api/client/httpStatusError';
import { ensureMachineRegistered } from '@/api/machine/ensureMachineRegistered';
import {
  materializeNextPendingQueueV2MessageViaHttp,
  readPendingQueueV2ActivationEligibilityFromServer,
} from '@/api/session/pendingQueueV2Transport';
import { resolveConnectedServiceSwitchContinuity } from '@/backends/catalog';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { fetchSessionByIdCompat, fetchSessionsPage } from '@/session/transport/http/sessionsHttp';
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
import { accountSettingsParse, isConnectedServiceUxDiagnosticSpawnErrorDetail } from '@happier-dev/protocol';
import { UsageLimitRecoveryScheduler } from './connectedServices/usageLimitRecovery/UsageLimitRecoveryScheduler';
import { RuntimeAuthRecoveryScheduler } from './connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import { TemporaryThrottleRecoveryScheduler } from './connectedServices/temporaryThrottle/TemporaryThrottleRecoveryScheduler';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { parseAndStripTerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import type { StopSessionResult } from './sessions/stopSessionContract';
import type { TerminalHostAdapter } from '@/integrations/terminalHost/_types';
import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import {
  HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY,
  type AttachmentBoundClaudeEndpointState,
} from '@/backends/claude/endpointRecovery/claudeEndpointArtifacts';
import {
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';
type BuildHappyCliSubprocessLaunchSpec = typeof import('@/utils/spawnHappyCLI').buildHappyCliSubprocessLaunchSpec;
type HappyCliSubprocessRuntimeDecision = import('@/utils/spawnHappyCLI').HappyCliSubprocessRuntimeDecision;
type CreateStopSessionInput = Parameters<typeof import('./sessions/stopSession').createStopSession>[0];
type CallSessionRpc = typeof callSessionRpc;
type ReadProcessRunState = typeof import('./processRunState').readProcessRunState;
type ReadSessionRunnerLockStatus = typeof import('./sessionRunnerLock').readSessionRunnerLockStatus;

function completeReportedSession(params: Parameters<typeof waitForSessionWebhook>[0], sessionId = 'sess_plain') {
  const completion = actualSessionWebhookOwner.waitForSessionWebhook(params);
  // Simulate receipt at the report transport boundary, retaining the real
  // waiter's key ownership, timeout, promotion and callback failure behavior.
  queueMicrotask(() => params.pidToAwaiter.get(params.pid)?.({ pid: params.pid, startedBy: 'daemon', happySessionId: sessionId }));
  return completion;
}

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

function setConfiguredAcpCatalogForTest(supportsLoadSession: boolean, enabled = true): void {
  setActiveAccountSettingsSnapshot({
    source: 'network',
    settingsVersion: Date.now(),
    loadedAtMs: Date.now(),
    settingsSecretsReadKeys: [],
    settings: accountSettingsParse({
      acpCatalogSettingsV1: {
        v: 2,
        backends: [{
          id: 'custom-kiro',
          name: 'custom-kiro',
          title: 'Custom Kiro',
          command: 'kiro-cli',
          args: [],
          env: {},
          transportProfile: 'generic',
          capabilities: {
            supportsLoadSession,
            supportsModes: 'unknown',
            supportsModels: 'unknown',
            supportsConfigOptions: 'unknown',
            promptImageSupport: 'unknown',
          },
          createdAt: 1,
          updatedAt: 1,
        }],
      },
      backendEnabledByTargetKey: { 'acpBackend:custom-kiro': enabled },
    }),
  });
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
  readTerminalAttachmentInfo: vi.fn<typeof import('@/terminal/attachment/terminalAttachmentInfo').readTerminalAttachmentInfo>(async () => null),
  removeTerminalAttachmentInfo: vi.fn<typeof import('@/terminal/attachment/terminalAttachmentInfo').removeTerminalAttachmentInfo>(async () => false),
  readClaudeEndpointDescriptor: vi.fn<() => Promise<AttachmentBoundClaudeEndpointState | null>>(async () => null),
  evaluateLiveness: vi.fn<TerminalHostAdapter['evaluateLiveness']>(async () => ({ paneAlive: true, observedAt: 1 })),
  dispose: vi.fn<TerminalHostAdapter['dispose']>(async () => {}),
}));
const sessionRunnerActivityBoundaryMocks = vi.hoisted(() => ({
  readProcessRunState: vi.fn<ReadProcessRunState>(async () => 'dead'),
  readSessionRunnerLockStatus: vi.fn<ReadSessionRunnerLockStatus>(async () => ({ ok: false, reason: 'not_found' })),
}));
const ensureSessionMachineAccessKeyBindingMock = vi.hoisted(() => vi.fn(async () => {}));
const herdrSpawnCapture = vi.hoisted(() => ({
  createPane: vi.fn(async (_input: unknown) => ({ paneId: 'pane_1', terminalId: 'terminal_1', workspaceId: 'workspace_1', tabId: 'tab_1' })),
  processInfo: vi.fn(async (_paneId: string) => ({ shellPid: 12345, foregroundProcesses: [] })),
  findPane: vi.fn(async (_terminalId: string) => ({ paneId: 'pane_1', terminalId: 'terminal_1', workspaceId: 'workspace_1', tabId: 'tab_1' })),
  closePane: vi.fn(async (_paneId: string) => undefined),
}));
const zellijSpawnCapture = vi.hoisted(() => ({
  createOrAttachHost: vi.fn(async () => ({
    kind: 'zellij' as const,
    sessionName: 'happier-codex',
    paneId: 'terminal_42',
    socketDir: '/tmp/zellij-test',
    attachMetadata: {
      attachStrategy: 'terminal_host' as const,
      topology: 'shared' as const,
      locality: 'same_machine' as const,
      maxClients: null,
      requiresLocalAttachmentInfo: true,
      liveProbe: 'required' as const,
    },
  })),
  evaluateLiveness: vi.fn(async () => ({ paneAlive: true, panePid: 12346, observedAt: 1 })),
  dispose: vi.fn(async () => undefined),
}));
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
  let sessionRunnerStatusHandlerRef: ((input: { sessionId: string }) => Promise<any>) | null = null;
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
    setSessionRunnerStatusHandler: (fn: (input: { sessionId: string }) => Promise<any>) => {
      sessionRunnerStatusHandlerRef = fn;
    },
    getSessionRunnerStatusHandler: () => sessionRunnerStatusHandlerRef,
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
      sessionRunnerStatusHandlerRef = null;
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
    claudeUnifiedTerminalHostActionTimeoutMs: 15_000,
  },
}));

vi.mock('@/integrations/herdr/runtimeBinary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/integrations/herdr/runtimeBinary')>();
  return { ...actual, resolveHerdrRuntimeBinary: vi.fn(actual.resolveHerdrRuntimeBinary) };
});

vi.mock('@/integrations/herdr/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/integrations/herdr/client')>();
  return { ...actual, createHerdrClient: vi.fn(actual.createHerdrClient) };
});

vi.mock('@/integrations/caffeinate', () => ({
  startCaffeinate: vi.fn(() => false),
  stopCaffeinate: vi.fn(async () => {}),
}));

vi.mock('@/ui/doctor', () => ({
  getEnvironmentInfo: vi.fn(() => ({})),
}));

function spawnHappyCliBoundary(argv: string[], _opts?: unknown) {
  const child = {
    pid: 12345,
    stdout: null,
    stderr: null,
    on: vi.fn(),
    unref: vi.fn(),
  };
  spawnHappyCliCapture.children.push(child);
  return child;
}
const spawnHappyCLI = vi.fn(spawnHappyCliBoundary);
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
  writeSessionMarker: vi.fn<typeof import('./sessionRegistry').writeSessionMarker>(async () => {}),
}));
const acceptedMarkerBoundary = vi.hoisted(() => ({
  beforeCommit: null as ((target: unknown) => Promise<void>) | null,
  afterCommit: null as ((target: unknown) => Promise<void>) | null,
}));
// Gate only the atomic filesystem commit; marker serialization and webhook owners stay real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    await acceptedMarkerBoundary.beforeCommit?.(args[1]);
    const result = await actual.rename(...args);
    await acceptedMarkerBoundary.afterCommit?.(args[1]);
    return result;
  } };
});
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
    handleSessionRunnerStatusGet,
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
    handleSessionRunnerStatusGet?: (input: { sessionId: string }) => Promise<any>;
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
    if (handleSessionRunnerStatusGet) {
      harness.setSessionRunnerStatusHandler(handleSessionRunnerStatusGet);
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
    writeTerminalAttachmentInfo: vi.fn(async () => undefined),
  };
});

vi.mock('@/backends/claude/endpointRecovery/claudeEndpointArtifacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backends/claude/endpointRecovery/claudeEndpointArtifacts')>();
  return {
    ...actual,
    readClaudeEndpointDescriptor: claudeEndpointRecoveryBoundaryMocks.readClaudeEndpointDescriptor,
  };
});

vi.mock('@/integrations/terminalHost/defaultRegistry', async importOriginal => ({
  ...await importOriginal<typeof import('@/integrations/terminalHost/defaultRegistry')>(),
  createDefaultTerminalHostRegistry: vi.fn(async () => ({
    zellij: {
      kind: 'zellij' as const,
      createOrAttachHost: zellijSpawnCapture.createOrAttachHost,
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: zellijSpawnCapture.evaluateLiveness,
      dispose: zellijSpawnCapture.dispose,
    },
    herdr: {
      kind: 'herdr' as const,
      createOrAttachHost: vi.fn(async (opts: Readonly<{
        sessionName: string;
        workingDirectory: string;
        spawnArgv: readonly string[];
        spawnEnv: Readonly<Record<string, string>>;
      }>) => {
        const pane = await herdrSpawnCapture.createPane({
          label: opts.sessionName,
          cwd: opts.workingDirectory,
          argv: opts.spawnArgv,
          env: opts.spawnEnv,
        });
        return {
          kind: 'herdr' as const,
          sessionName: opts.sessionName,
          socketPath: '/tmp/herdr-test.sock',
          terminalId: pane.terminalId,
          paneId: pane.paneId,
          attachMetadata: {
            attachStrategy: 'terminal_host' as const,
            topology: 'shared' as const,
            locality: 'same_machine' as const,
            maxClients: null,
            requiresLocalAttachmentInfo: true,
            liveProbe: 'required' as const,
          },
        };
      }),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async (handle: { paneId?: string }) => ({
        paneAlive: true,
        panePid: (await herdrSpawnCapture.processInfo(handle.paneId ?? '')).shellPid,
        observedAt: 1,
      })),
      dispose: vi.fn(async (handle: { terminalId?: string }) => {
        const pane = await herdrSpawnCapture.findPane(handle.terminalId ?? '');
        if (pane) await herdrSpawnCapture.closePane(pane.paneId);
      }),
    },
  })),
}));

vi.mock('./sessions/onHappySessionWebhook', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessions/onHappySessionWebhook')>();
  return { ...actual, createOnHappySessionWebhook: vi.fn(actual.createOnHappySessionWebhook) };
});

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
  readPendingQueueV2ActivationEligibilityFromServer: vi.fn(async () => 'missing'),
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

vi.mock('./sessions/visibleConsoleSpawnWaiter', async () => {
  const actual = await vi.importActual<typeof import('./spawn/waitForSessionWebhook')>('./spawn/waitForSessionWebhook');
  return { waitForVisibleConsoleSessionWebhook: vi.fn((params: Parameters<typeof import('./sessions/visibleConsoleSpawnWaiter').waitForVisibleConsoleSessionWebhook>[0]) => {
    const completion = actual.waitForSessionWebhook({ ...params, timeoutErrorMessage: 'Fixture session report timeout' });
    queueMicrotask(() => params.pidToAwaiter.get(params.pid)?.({ pid: params.pid, startedBy: 'daemon', happySessionId: 'sess_visible_console' }));
    return completion;
  }) };
});

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

vi.mock('@/integrations/tmux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/integrations/tmux')>();
  return { ...actual, selectPreferredTmuxSessionName: vi.fn(actual.selectPreferredTmuxSessionName),
    isTmuxAvailable: vi.fn(async () => false) };
});

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

vi.mock('./spawn/waitForSessionWebhook', async () => {
  const actual = await vi.importActual<typeof import('./spawn/waitForSessionWebhook')>('./spawn/waitForSessionWebhook');
  return { waitForSessionWebhook: vi.fn((params: Parameters<typeof actual.waitForSessionWebhook>[0]) => {
    // A canonical report delivered at the transport boundary, not a seeded-ID
    // success shortcut; timeout, cleanup and promotion use the real waiter owner.
    const completion = actual.waitForSessionWebhook(params);
    queueMicrotask(() => params.pidToAwaiter.get(params.pid)?.({ pid: params.pid, startedBy: 'daemon', happySessionId: 'sess_plain' }));
    return completion;
  }) };
});

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
  fetchSessionsPage: vi.fn(async () => ({ sessions: [], nextCursor: null, hasNext: false })),
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

// Load the real startup corridor during collection, not inside a timed lifecycle case.
const [actualReattachmentOwner, actualChildExitOwner, actualMetadataUpdateOwner, daemonStartupOwner, actualSessionWebhookOwner] = await Promise.all([
  vi.importActual<typeof import('./sessions/reattachFromMarkers')>('./sessions/reattachFromMarkers'),
  vi.importActual<typeof import('./sessions/onChildExited')>('./sessions/onChildExited'),
  vi.importActual<typeof import('@/session/metadata/updateSessionMetadataWithRetry')>('@/session/metadata/updateSessionMetadataWithRetry'),
  import('./startDaemon'),
  vi.importActual<typeof import('./spawn/waitForSessionWebhook')>('./spawn/waitForSessionWebhook'),
]);

describe('startDaemon spawn resume wiring (integration)', () => {
  let closeHerdrFixture: (() => void) | undefined;
  let herdrFixtureRun: Promise<void> | undefined;
  let previousHerdrFixtureBinary: string | undefined;
  let deliverShutdownWatchdog: (() => unknown) | undefined;
  let firedShutdownTimerWork: Promise<unknown>[] = [];

  async function restoreDaemonExitBoundary(exitSpy: MockInstance) {
    // clearTimeout cannot retire an async watchdog callback that already fired.
    // Real process.exit ends it; the in-process OS fixture must await it instead.
    await Promise.all(firedShutdownTimerWork);
    exitSpy.mockRestore();
  }

  beforeEach(async () => {
    deliverShutdownWatchdog = undefined;
    firedShutdownTimerWork = [];
    const { getDaemonShutdownWatchdogTimeoutMs } = await import('./shutdownPolicy');
    const scheduleTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((...timerArgs: Parameters<typeof setTimeout>) => {
      const [callback, delay, ...callbackArgs] = timerArgs;
      if (delay !== getDaemonShutdownWatchdogTimeoutMs()) return scheduleTimeout(...timerArgs);
      const watchdogCallback = () => {
        const result: unknown = callback(...callbackArgs);
        if (result instanceof Promise) firedShutdownTimerWork.push(result);
        return result;
      };
      deliverShutdownWatchdog = watchdogCallback;
      return scheduleTimeout(watchdogCallback, delay);
    }) as typeof setTimeout);
    previousHerdrFixtureBinary = process.env.HERDR_BIN_PATH;
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      // Most cases exercise platform-independent daemon lifecycle behavior. Keep their
      // launch adapter deterministic; dedicated cases below opt into Linux/macOS behavior.
      Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
    }
    let fixtureReady!: () => void;
    const ready = new Promise<void>(resolve => { fixtureReady = resolve; });
    const closed = new Promise<void>(resolve => { closeHerdrFixture = resolve; });
    herdrFixtureRun = withHerdrApi(async api => {
      process.env.HERDR_BIN_PATH = api.binary;
      const clients = await import('@/integrations/herdr/client');
      const actualClients = await vi.importActual<typeof import('@/integrations/herdr/client')>('@/integrations/herdr/client');
      // Keep endpoint admission and version parsing real, substituting only the native socket.
      vi.mocked(clients.createHerdrClient).mockImplementation(params => actualClients.createHerdrClient({ ...params, socketPath: api.socketPath }));
      fixtureReady();
      await closed;
    });
    await Promise.race([ready, herdrFixtureRun]);
  });

  afterEach(async () => {
    await Promise.all(firedShutdownTimerWork);
    closeHerdrFixture?.();
    await herdrFixtureRun;
    if (previousHerdrFixtureBinary === undefined) delete process.env.HERDR_BIN_PATH;
    else process.env.HERDR_BIN_PATH = previousHerdrFixtureBinary;
    resetActiveAccountSettingsSnapshotForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    harness.resetControlRefs();
    harness.apiMachine.recoverDaemonTerminalSessionMutationJournals.mockClear();
    spawnHappyCLI.mockReset();
    spawnHappyCLI.mockImplementation(spawnHappyCliBoundary);
    herdrSpawnCapture.createPane.mockClear();
    herdrSpawnCapture.processInfo.mockClear();
    herdrSpawnCapture.findPane.mockClear();
    herdrSpawnCapture.closePane.mockClear();
    zellijSpawnCapture.createOrAttachHost.mockClear();
    zellijSpawnCapture.evaluateLiveness.mockClear();
    zellijSpawnCapture.dispose.mockClear();
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
    updateSessionMetadataWithRetryMock.mockReset();
    updateSessionMetadataWithRetryMock.mockImplementation(async (params) => ({
      version: (params.rawSession.metadataVersion ?? 0) + 1,
      metadata: params.updater({}),
    }));
    vi.mocked(materializeNextPendingQueueV2MessageViaHttp).mockClear();
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockReset();
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('missing');
    vi.mocked(fetchSessionsPage).mockReset();
    vi.mocked(fetchSessionsPage).mockResolvedValue({ sessions: [], nextCursor: null, hasNext: false });
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
    delete process.env.HAPPIER_DAEMON_SELF_RESTART_CORRELATION_ID;
    delete process.env.HAPPIER_DAEMON_SELF_RESTART_DEADLINE_MS;
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

      let resolveBound!: () => void;
      const bound = new Promise<void>((resolve) => { resolveBound = resolve; });
      ensureSessionMachineAccessKeyBindingMock.mockImplementationOnce(async () => { resolveBound(); });
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      await bound;
      expect(ensureSessionMachineAccessKeyBindingMock).toHaveBeenCalledWith({
        serverUrl: expect.any(String),
        token: 'token-daemon',
        sessionId: 'session-reattached-control',
        machineId: 'machine-1',
      });

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
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it('activates one exact Pending row after the UI disappears and delegates stale active state to runner serviceability', async () => {
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
      pendingActivationAuthorization: {
        requestId: 'pending-after-ui-death',
        requestedAt: 10,
        status: 'waiting',
      },
    });
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(rawSession);
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    let run: Promise<void> | null = null;

    try {
      const activationModule = await import('./sessions/activatePendingInactiveSession');
      const activationSpy = vi.spyOn(activationModule, 'activatePendingSessionRuntime');
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await waitForSpawnSessionRegistration();
      await vi.waitFor(
        () => expect(harness.apiMachine.onPendingSessionActivationHint).toHaveBeenCalledTimes(1),
        { timeout: 10_000 },
      );
      expect(ensureMachineRegistered).toHaveBeenCalledWith(expect.objectContaining({
        daemonState: expect.objectContaining({ daemonPendingSessionActivationSupported: true }),
      }));

      await harness.emitPendingSessionActivationHint({
        sessionId: 'sess_plain',
        requestId: 'pending-after-ui-death',
        pendingVersion: 9,
        source: 'changes',
      });

      expect(fetchSessionByIdCompat).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess_plain',
        reason: 'manual-recovery',
      }));
      expect(readPendingQueueV2ActivationEligibilityFromServer).toHaveBeenCalled();
      expect(activationSpy).toHaveBeenCalledTimes(1);
      await expect(activationSpy.mock.results[0]?.value).resolves.toMatchObject({ status: 'activated' });
      expect(readPendingQueueV2ActivationEligibilityFromServer).toHaveBeenCalledWith({
        token: 'token-daemon',
        sessionId: 'sess_plain',
        requestId: 'pending-after-ui-death',
      });

      await harness.emitPendingSessionActivationHint({
        sessionId: 'sess_plain',
        requestId: 'pending-after-ui-death',
        pendingVersion: 9,
        source: 'live',
      });
      expect(activationSpy).toHaveBeenCalledTimes(2);
      await expect(activationSpy.mock.results[1]?.value).resolves.toMatchObject({ status: 'activated' });

      vi.mocked(fetchSessionByIdCompat).mockResolvedValue({ ...rawSession, active: true });
      await harness.emitPendingSessionActivationHint({
        sessionId: 'sess_plain',
        requestId: 'pending-after-ui-death',
        pendingVersion: 9,
        source: 'live',
      });
      expect(activationSpy).toHaveBeenCalledTimes(3);
      await expect(activationSpy.mock.results[2]?.value).resolves.toMatchObject({ status: 'activated' });

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      if (run) {
        harness.requestShutdown('happier-cli');
        await run.catch(() => {});
      }
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it('recovers a waiting exact-machine activation from one reconnect scan without a live hint', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    const rawSession = createSessionRecordFixture({
      id: 'sess_reconnect_activation',
      seq: 12,
      active: false,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-1',
        flavor: 'codex',
        codexSessionId: 'vendor-reconnect-1',
        path: '/tmp',
      }),
      dataEncryptionKey: null,
      machineId: 'machine-1',
      path: '/tmp',
      pendingCount: 1,
      pendingVersion: 9,
      pendingActivationAuthorization: {
        requestId: 'pending-reconnect',
        requestedAt: 10,
        status: 'waiting',
      },
    });
    vi.mocked(fetchSessionsPage).mockResolvedValue({
      sessions: [rawSession],
      nextCursor: null,
      hasNext: false,
    });
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(rawSession);
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    harness.apiMachine.connect.mockImplementationOnce((params?: { onConnect?: () => void | Promise<void> }) => {
      void params?.onConnect?.();
    });
    let run: Promise<void> | null = null;

    try {
      const activationModule = await import('./sessions/activatePendingInactiveSession');
      const activationSpy = vi.spyOn(activationModule, 'activatePendingSessionRuntime');
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await vi.waitFor(() => expect(fetchSessionsPage).toHaveBeenCalled(), { timeout: 10_000 });
      await vi.waitFor(() => expect(readPendingQueueV2ActivationEligibilityFromServer).toHaveBeenCalled(), { timeout: 10_000 });
      await vi.waitFor(() => expect(activationSpy).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      await expect(activationSpy.mock.results[0]?.value).resolves.toMatchObject({ status: 'activated' });

      expect(fetchSessionsPage).toHaveBeenCalledWith({ token: 'token-daemon', limit: 200 });
      expect(readPendingQueueV2ActivationEligibilityFromServer).toHaveBeenCalledWith({
        token: 'token-daemon',
        sessionId: 'sess_reconnect_activation',
        requestId: 'pending-reconnect',
      });

      harness.requestShutdown('happier-cli');
      await run;
      run = null;
    } finally {
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      if (run) {
        harness.requestShutdown('happier-cli');
        await run.catch(() => {});
      }
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
    waitForSessionWebhookMock.mockImplementationOnce((params) => {
      const completion = actualSessionWebhookOwner.waitForSessionWebhook(params);
      webhookControl.resolve = params.pidToSpawnResultResolver.get(params.pid) ?? null;
      return completion;
    });
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
      waitForSessionWebhookMock.mockImplementation(completeReportedSession);
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      await restoreDaemonExitBoundary(exitSpy);
      featureDecisionSpy.mockRestore();
    }
  }, 120_000);

  it.each(['existing', 'fresh', 'encrypted', 'stale_pid', 'legacy', 'other_machine', 'unknown_process', 'lookup_failed', 'webhook_during_lookup', 'exit_during_lookup', 'locked_runner', 'wrapper'] as const)('handles an accepted %s launch before its session webhook', async (startup) => {
    const isFresh = startup !== 'existing';
    const spawnBoundary = spawnHappyCliBoundary;
    spawnHappyCLI.mockImplementationOnce(spawnBoundary).mockImplementationOnce((argv, options) => {
      const child = spawnBoundary(argv, options);
      child.pid = 12346;
      return child;
    });
    const readFingerprint = processInstanceBoundary.readProcessInstanceFingerprintSync;
    const fingerprintSpy = vi.spyOn(processInstanceBoundary, 'readProcessInstanceFingerprintSync')
      .mockImplementation(pid => pid === 23456 ? 'fixture-current-generation'
        : pid === 12345 ? (startup === 'wrapper' ? 'fixture-wrapper-generation' : 'fixture-current-generation')
          : readFingerprint(pid));
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
    const metadata: Metadata = {
      flavor: 'codex', codexSessionId: 'vendor-existing-startup-pending', path: '/tmp',
      machineId: startup === 'other_machine' ? 'machine-other' : 'machine-1',
      hostPid: startup === 'wrapper' ? 23456 : 12345, startedBy: 'daemon', happyHomeDir: '/tmp/happy-home',
      host: 'fixture-host', homeDir: '/tmp', happyLibDir: '/tmp/lib', happyToolsDir: '/tmp/tools',
      ...(startup === 'legacy' ? {} : { hostProcessInstanceFingerprint:
        startup === 'stale_pid' ? 'fixture-previous-generation' : 'fixture-current-generation' }),
    };
    const rawSession = createSessionRecordFixture({
      id: sessionId,
      encryptionMode: startup === 'encrypted' ? 'e2ee' : 'plain',
      metadata: startup === 'encrypted'
        ? encodeBase64(encrypt(new Uint8Array(32).fill(2), 'dataKey', metadata), 'base64')
        : JSON.stringify(metadata),
      dataEncryptionKey: null,
    });
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(rawSession);
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
        ...(isFresh ? { existingSessionId: undefined, spawnNonce: 'fresh-startup-nonce' } : {}),
        executionAuthorization: { provenance: 'user_request', requestId: 'pending-local-first' },
      })).resolves.toEqual(isFresh ? {
        type: 'success',
        sessionIdStatus: 'pending',
        spawnNonce: 'fresh-startup-nonce',
        runnerAcceptance: 'newly_accepted',
      } : {
        type: 'success',
        sessionId,
        runnerAcceptance: 'newly_accepted',
      });
      expect(webhookControl.resolve).not.toBeNull();

      const webhookModule = await import('./sessions/onHappySessionWebhook');
      const reportFactory = vi.mocked(webhookModule.createOnHappySessionWebhook);
      const reportParams = reportFactory.mock.calls.at(-1)?.[0];
      const report = reportFactory.mock.results.at(-1)?.value;
      if (!reportParams || typeof report !== 'function') throw new Error('Expected real report owner');
      const trackedChild = reportParams.pidToTrackedSession.get(12345);
      if (!trackedChild) throw new Error('Expected accepted child');
      if (startup === 'wrapper') {
        trackedChild.sessionRunnerPid = 23456;
      }
      if (startup === 'locked_runner') {
        sessionRunnerActivityBoundaryMocks.readSessionRunnerLockStatus.mockResolvedValue({
          ok: true, lock: { sessionId, pid: 54321, acquiredAtMs: 1 },
        });
        pendingMaterializationRpcMocks.callSessionRpc.mockImplementation(async params =>
          params.method.endsWith('wakeCapability.v1.get')
            ? { ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' }
            : { ok: true, result: 'wake_published' });
      }
      if (startup === 'unknown_process') {
        sessionRunnerActivityBoundaryMocks.readProcessRunState.mockRejectedValue(new Error('OS state unavailable'));
      }
      if (startup === 'lookup_failed') {
        vi.mocked(fetchSessionByIdCompat).mockRejectedValueOnce(new Error('Server unavailable'));
      }
      if (startup === 'webhook_during_lookup') {
        pendingMaterializationRpcMocks.callSessionRpc.mockImplementation(async params =>
          params.method.endsWith('wakeCapability.v1.get')
            ? { ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' }
            : { ok: true, result: 'wake_published' });
        vi.mocked(fetchSessionByIdCompat).mockImplementationOnce(async () => {
          await report(sessionId, metadata);
          return rawSession;
        });
      }
      if (startup === 'exit_during_lookup') {
        vi.mocked(fetchSessionByIdCompat).mockImplementationOnce(async () => {
          reportParams.pidToTrackedSession.delete(12345);
          reportParams.pidToAwaiter.delete(12345);
          return rawSession;
        });
      }
      const resumeResult = await spawnSession({
        ...baseOptions,
        executionAuthorization: { provenance: 'user_request', requestId: 'pending-local-retry' },
      });
      const shouldFence = startup === 'legacy' || startup === 'unknown_process' || startup === 'lookup_failed';
      const shouldSpawn = startup === 'stale_pid' || startup === 'other_machine' || startup === 'exit_during_lookup';
      if (shouldFence) {
        expect(resumeResult).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED });
      } else {
        expect(resumeResult).toEqual({
          type: 'success', sessionId,
          runnerAcceptance: shouldSpawn ? 'newly_accepted' : 'preexisting_or_adopted',
        });
      }
      expect(spawnHappyCLI).toHaveBeenCalledTimes(shouldSpawn ? 2 : 1);
      expect(waitForSessionWebhookMock).toHaveBeenCalledTimes(shouldSpawn ? 2 : 1);
      if (startup !== 'webhook_during_lookup' && startup !== 'locked_runner') {
        expect(pendingMaterializationRpcMocks.callSessionRpc).not.toHaveBeenCalled();
        expect(explicitRecoveryCheckSpy).not.toHaveBeenCalled();
        expect(materializeNextPendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
      }
      if (startup === 'stale_pid' || startup === 'legacy' || startup === 'lookup_failed' || startup === 'other_machine' || startup === 'locked_runner') {
        expect(trackedChild.happySessionId).toBeUndefined();
        // A later genuine webhook must still be able to bind the actual new Session.
        if (startup === 'stale_pid') {
          await report('sess_actual_fresh_child', { ...metadata, hostProcessInstanceFingerprint: 'fixture-current-generation' });
          expect(trackedChild.happySessionId).toBe('sess_actual_fresh_child');
        }
      }
      if (startup === 'fresh' || startup === 'encrypted' || startup === 'unknown_process' || startup === 'wrapper') {
        expect(trackedChild.happySessionId).toBe(sessionId);
        expect(reportParams.pidToAwaiter.has(12345)).toBe(true);
      }

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
      waitForSessionWebhookMock.mockImplementation(completeReportedSession);
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      await restoreDaemonExitBoundary(exitSpy);
      featureDecisionSpy.mockRestore();
      fingerprintSpy.mockRestore();
      spawnHappyCLI.mockReset();
      spawnHappyCLI.mockImplementation(spawnBoundary);
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
      featureDecisionSpy.mockRestore();
      if (run) {
        harness.requestShutdown('happier-cli');
        await run.catch(() => undefined);
      }
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it('does not treat webhook metadata bindings and task start as provider activity recovery proof', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const shutdownExitCalls = exitSpy.mock.calls;
    let watchdogCompletion: unknown;
    let firingWatchdog = false;
    let releaseWatchdogGrace!: () => void;
    let observeWatchdogGrace!: () => void;
    const watchdogGraceElapsed = new Promise<void>(resolve => { observeWatchdogGrace = resolve; });
    const scheduleTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...timerArgs: Parameters<typeof setTimeout>) => {
      if (firingWatchdog && timerArgs[1] === 100) {
        const [callback, delay, ...callbackArgs] = timerArgs;
        // The watchdog's existing grace timer elapses normally; its OS delivery
        // is held until ordinary cleanup has returned, reproducing the CI overlap.
        releaseWatchdogGrace = () => callback(...callbackArgs);
        return scheduleTimeout(observeWatchdogGrace, delay);
      }
      return scheduleTimeout(...timerArgs);
    }) as typeof setTimeout);
    let enterCleanup!: () => void;
    let releaseCleanup!: () => void;
    const cleanupEntered = new Promise<void>(resolve => { enterCleanup = resolve; });
    const cleanupReleased = new Promise<void>(resolve => { releaseCleanup = resolve; });
    const { stopCaffeinate } = await import('@/integrations/caffeinate');
    vi.mocked(stopCaffeinate).mockImplementationOnce(async () => {
      enterCleanup();
      await cleanupReleased;
    });
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
      // Capture the timer armed at shutdown admission before later drain budgets
      // install their own timers with the same duration.
      await Promise.resolve();
      const fireWatchdog = deliverShutdownWatchdog;
      await cleanupEntered;
      // Deliver the existing watchdog at the OS timer boundary while cleanup is
      // pending. Its real 100ms grace period then overlaps normal completion.
      if (!fireWatchdog) throw new Error('Expected the shutdown watchdog to be armed');
      firingWatchdog = true;
      watchdogCompletion = fireWatchdog();
      firingWatchdog = false;
      expect(releaseWatchdogGrace).toBeTypeOf('function');
      await watchdogGraceElapsed;
      releaseCleanup();
      await run;
      run = null;
    } finally {
      releaseCleanup();
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
      if (watchdogCompletion) {
        releaseWatchdogGrace();
      }
      await restoreDaemonExitBoundary(exitSpy);
      if (watchdogCompletion) {
        await expect(watchdogCompletion).resolves.toBeUndefined();
        expect([...new Set(shutdownExitCalls.map(([code]) => code))]).toEqual([0]);
      }
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it.each([
    'wake', 'wake_rpc_failed', 'resume_after_stop', 'respawn_with_nonce', 'early_webhook', 'marker_write_failed', 'early_webhook_marker_failed',
    'tmux_creation_unconfirmed', 'tmux_creation_not_started',
    'herdr_creation_unconfirmed', 'herdr_creation_stopped',
    'binding_write_failed', 'windows_binding_write_failed', 'binding_exit_overlap', 'committed_binding_exit_overlap', 'heartbeat_binding_exit_overlap', 'tmux_binding_exit_overlap',
    'early_regular_exit', 'early_regular_report_exit', 'exit_before_first_report', 'wrapper_promotion',
    'ready_nonce_replay', 'unready_nonce_replay', 'unbound_nonce_replay', 'restored_plain_nonce_replay',
    'wrong_binding_nonce_replay', 'sameid_wrong_mode_nonce_replay', 'late_binding_nonce_replay', 'late_geometry_nonce_replay',
    'wrong_marker_session_nonce_replay', 'wrong_marker_pid_nonce_replay', 'wrong_marker_identity_nonce_replay',
    'late_retiring_nonce_replay', 'late_owner_nonce_replay', 'missing_id_nonce_replay', 'legacy_windows_nonce_replay', 'wrong_windows_nonce_replay',
    'console_nonce_replay', 'tmux_nonce_replay', 'zellij_nonce_replay', 'pty_console_missing_id_nonce_replay',
  ] as const)('completes an accepted runner through real owners (%s)', async (contract) => {
    const runContract = async (api?: Parameters<Parameters<typeof withHerdrApi>[0]>[0]) => {
    const { configuration } = await import('@/configuration');
    const originalHome = configuration.happyHomeDir;
    const fixtureHome = await mkdtemp(join(tmpdir(), 'happier-hosted-completion-'));
    const previousRefresh = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    const previousNonceTtl = process.env.HAPPIER_DAEMON_SPAWN_ACCEPTED_NONCE_TTL_MS;
    const previousExitPoll = process.env.HAPPIER_DAEMON_VISIBLE_CONSOLE_EXIT_POLL_MS;
    const previousHeartbeatInterval = process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL;
    const previousTmuxInlineLimit = process.env.HAPPIER_CLI_TMUX_INLINE_SPAWN_MAX_CHARS;
    const previousHerdrBinary = process.env.HERDR_BIN_PATH;
    const previousClaudeBinary = process.env.HAPPIER_CLAUDE_PATH;
    const isTmuxCreation = contract === 'tmux_creation_unconfirmed' || contract === 'tmux_creation_not_started';
    const isHerdrCreation = contract === 'herdr_creation_unconfirmed' || contract === 'herdr_creation_stopped';
    const isTmux = contract === 'tmux_binding_exit_overlap' || isTmuxCreation;
    const isWindows = contract === 'windows_binding_write_failed';
    const isHeartbeatExit = contract === 'heartbeat_binding_exit_overlap' || contract === 'tmux_binding_exit_overlap';
    const isCommittedBindingExit = contract === 'committed_binding_exit_overlap';
    const isBindingExit = contract === 'binding_exit_overlap' || isCommittedBindingExit || isHeartbeatExit;
    const isRestoredPlain = contract === 'restored_plain_nonce_replay';
    const isWrapperPromotion = contract === 'wrapper_promotion';
    const isExitBeforeFirstReport = contract === 'exit_before_first_report';
    const isEarlyRegularExit = contract === 'early_regular_exit' || contract === 'early_regular_report_exit' || isWrapperPromotion || isExitBeforeFirstReport;
    const fixtureAgent = isEarlyRegularExit || isRestoredPlain || isWindows ? 'codex' : 'claude';
    const childProcessBoundary = await import('node:child_process');
    const actualChildProcessBoundary = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    // Synthetic runner PIDs must have matching OS census evidence. Returning an
    // actual process row keeps classification and report-marker custody real,
    // without falling through to the shared machine's unrelated process census.
    vi.spyOn(childProcessBoundary, 'execFileSync').mockImplementation(((file, args, options) => {
      if (file === 'ps' && Array.isArray(args) && args.includes('-p')
        && (args.includes('12345') || args.includes('23456'))) {
        const command = `/test/apps/cli/dist/index.mjs ${fixtureAgent} --started-by daemon`;
        if (args.includes('stat=,ucomm=,command=')) return `S node ${command}\n`;
        if (args.includes('command=')) return `${command}\n`;
      }
      return actualChildProcessBoundary.execFileSync(file, args, options);
    }) as typeof childProcessBoundary.execFileSync);
    const isNonceReplay = contract.endsWith('_nonce_replay');
    const recoveredReady = contract === 'ready_nonce_replay' || isRestoredPlain || contract === 'missing_id_nonce_replay' || contract === 'legacy_windows_nonce_replay'
      || contract === 'console_nonce_replay' || contract === 'tmux_nonce_replay' || contract === 'zellij_nonce_replay';
    let replayClockOffset = 0;
    const realNow = Date.now.bind(Date);
    const replayClock = isNonceReplay ? vi.spyOn(Date, 'now').mockImplementation(() => realNow() + replayClockOffset) : undefined;
    if (isNonceReplay) {
      process.env.HAPPIER_DAEMON_SPAWN_ACCEPTED_NONCE_TTL_MS = '3000';
    }
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED = isEarlyRegularExit || isBindingExit ? 'false' : 'true';
    if (contract === 'binding_exit_overlap' || isCommittedBindingExit) process.env.HAPPIER_DAEMON_VISIBLE_CONSOLE_EXIT_POLL_MS = '10';
    if (isHeartbeatExit) {
      process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = '10';
      process.env.HAPPIER_DAEMON_VISIBLE_CONSOLE_EXIT_POLL_MS = '60000';
    }
    process.env.HAPPIER_DAEMON_SESSION_RESPAWN_BASE_DELAY_MS = '50';
    process.env.HAPPIER_DAEMON_SESSION_RESPAWN_JITTER_MS = '0';
    Object.defineProperty(configuration, 'happyHomeDir', { value: fixtureHome });
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    // OS presence is the boundary; the webhook wait, binding, presentation and restart policy stay real.
    const originalKill = process.kill.bind(process);
    let fixtureRunnerAlive = true;
    let fixtureExitObserved = false;
    vi.spyOn(process, 'kill').mockImplementation(((pid, signal) => {
      if (isWrapperPromotion && pid === 23456 && signal === 0) return true;
      if (pid === 12345 && signal === 0) {
        if (!fixtureRunnerAlive) {
          fixtureExitObserved = true;
          throw Object.assign(new Error('Fixture runner exited'), { code: 'ESRCH' });
        }
        return true;
      }
      return originalKill(pid, signal);
    }) as typeof process.kill);
    const [catalog, actualCatalog, waiter, actualWaiter, visible, actualVisible, resolver, actualResolver,
      webhook, actualWebhook, respawn, actualRespawn, attachments, actualAttachments, runtime] = await Promise.all([
      import('@/backends/catalog'), vi.importActual<typeof import('@/backends/catalog')>('@/backends/catalog'),
      import('./spawn/waitForSessionWebhook'), vi.importActual<typeof import('./spawn/waitForSessionWebhook')>('./spawn/waitForSessionWebhook'),
      import('./sessions/visibleConsoleSpawnWaiter'), vi.importActual<typeof import('./sessions/visibleConsoleSpawnWaiter')>('./sessions/visibleConsoleSpawnWaiter'),
      import('./sessions/resolveSpawnWebhookResult'), vi.importActual<typeof import('./sessions/resolveSpawnWebhookResult')>('./sessions/resolveSpawnWebhookResult'),
      import('./sessions/onHappySessionWebhook'), vi.importActual<typeof import('./sessions/onHappySessionWebhook')>('./sessions/onHappySessionWebhook'),
      import('./processSupervision/sessionRunnerRespawn'), vi.importActual<typeof import('./processSupervision/sessionRunnerRespawn')>('./processSupervision/sessionRunnerRespawn'),
      import('@/terminal/attachment/terminalAttachmentInfo'), vi.importActual<typeof import('@/terminal/attachment/terminalAttachmentInfo')>('@/terminal/attachment/terminalAttachmentInfo'),
      import('@/utils/spawnHappyCLI'),
    ]);
    const restoreDelegates: Array<() => void> = [];
    const delegateToActual = <T extends (...args: never[]) => unknown>(
      target: MockInstance<T>,
      actual: Parameters<MockInstance<T>['mockImplementation']>[0],
    ) => {
      const previous = target.getMockImplementation();
      target.mockImplementation(actual);
      restoreDelegates.push(() => {
        target.mockReset();
        if (previous) target.mockImplementation(previous);
      });
    };
    if (fixtureAgent === 'claude') {
      process.env.HAPPIER_CLAUDE_PATH = await writeExecutableShim({
        dir: fixtureHome, fileName: 'claude', contents: `#!${process.execPath}\nprocess.exit(0);\n`,
      });
      setActiveAccountSettingsSnapshot({
        source: 'network', settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
        settings: accountSettingsParse({ claudeUnifiedTerminalEnabled: false }),
      });
      delegateToActual(vi.mocked(fetchSessionByIdCompat), async () => createSessionRecordFixture({
        id: 'sess_plain', encryptionMode: 'plain', dataEncryptionKey: null,
        metadata: JSON.stringify({ flavor: 'claude', claudeSessionId: 'vendor-claude-1', path: '/tmp' }),
      }));
    }
    if (isHerdrCreation && api) {
      // The shim substitutes only the external native executable; registry, version
      // admission, socket protocol, and creation/cleanup decisions remain real.
      process.env.HERDR_BIN_PATH = api.binary;
      const binaries = await import('@/integrations/herdr/runtimeBinary');
      const actualBinaries = await vi.importActual<typeof import('@/integrations/herdr/runtimeBinary')>('@/integrations/herdr/runtimeBinary');
      delegateToActual(vi.mocked(binaries.resolveHerdrRuntimeBinary), actualBinaries.resolveHerdrRuntimeBinary);
      api.faults.set('pane.get', 'error');
      if (contract === 'herdr_creation_unconfirmed') api.faults.set('pane.close', 'error');
      const clients = await import('@/integrations/herdr/client');
      const actualClients = await vi.importActual<typeof import('@/integrations/herdr/client')>('@/integrations/herdr/client');
      // Only the external socket address changes; inventory parsing and creation/cleanup stay real.
      delegateToActual(vi.mocked(clients.createHerdrClient), (params) => actualClients.createHerdrClient({ ...params, socketPath: api.socketPath }));
      const hosts = await import('@/integrations/terminalHost/defaultRegistry');
      const actualHosts = await vi.importActual<typeof import('@/integrations/terminalHost/defaultRegistry')>('@/integrations/terminalHost/defaultRegistry');
      delegateToActual(vi.mocked(hosts.createDefaultTerminalHostRegistry), () => actualHosts.createDefaultTerminalHostRegistry({ zellijBinary: null }));
    }
    delegateToActual(vi.mocked(catalog.requireCatalogEntry), actualCatalog.requireCatalogEntry);
    delegateToActual(vi.mocked(catalog.resolveCatalogAgentId), actualCatalog.resolveCatalogAgentId);
    delegateToActual(vi.mocked(catalog.resolveAgentCliSubcommand), actualCatalog.resolveAgentCliSubcommand);
    if (isWindows) {
      Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'win32' });
      const modes = await import('./platform/windows/windowsSessionConsoleMode');
      const actualModes = await vi.importActual<typeof import('./platform/windows/windowsSessionConsoleMode')>('./platform/windows/windowsSessionConsoleMode');
      delegateToActual(vi.mocked(modes.resolveWindowsRemoteSessionConsoleMode), actualModes.resolveWindowsRemoteSessionConsoleMode);
      const consoleTransport = await import('./platform/windows/spawnHappyCliVisibleConsole');
      delegateToActual(vi.mocked(consoleTransport.startHappySessionInVisibleWindowsConsole), async () => ({ ok: true as const, pid: 12345 }));
    }
    if (isHeartbeatExit) {
      const heartbeat = await import('./lifecycle/heartbeat');
      const actualHeartbeat = await vi.importActual<typeof import('./lifecycle/heartbeat')>('./lifecycle/heartbeat');
      delegateToActual(vi.mocked(heartbeat.startDaemonHeartbeatLoop), actualHeartbeat.startDaemonHeartbeatLoop);
    }
    delegateToActual(vi.mocked(catalog.getVendorResumeSupport), actualCatalog.getVendorResumeSupport);
    if (isNonceReplay || isCommittedBindingExit) {
      const actualProcessState = await vi.importActual<typeof import('./processRunState')>('./processRunState');
      delegateToActual(sessionRunnerActivityBoundaryMocks.readProcessRunState, actualProcessState.readProcessRunState);
    }
    let webhookTimeouts: Parameters<typeof actualWaiter.waitForSessionWebhook>[0]['pidToSpawnWebhookTimeout'] | undefined;
    let webhookResolvers: Parameters<typeof actualWaiter.waitForSessionWebhook>[0]['pidToSpawnResultResolver'] | undefined;
    delegateToActual(vi.mocked(waiter.waitForSessionWebhook), (params) => {
      webhookTimeouts = params.pidToSpawnWebhookTimeout;
      webhookResolvers = params.pidToSpawnResultResolver;
      return actualWaiter.waitForSessionWebhook(params);
    });
    const exitPolls: ReturnType<typeof setInterval>[] = [];
    const originalSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((...args: Parameters<typeof setInterval>) => {
      const timer = originalSetInterval(...args);
      exitPolls.push(timer);
      return timer;
    }) as typeof setInterval);
    const availabilityTimers: ReturnType<typeof setTimeout>[] = [];
    let tmuxLaunchHandoffPath: string | undefined;
    if (isTmux) {
      if (isTmuxCreation) process.env.HAPPIER_CLI_TMUX_INLINE_SPAWN_MAX_CHARS = '1';
      const originalSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
        const timer = originalSetTimeout(...args);
        if (args[1] === 60_000) availabilityTimers.push(timer);
        return timer;
      }) as typeof setTimeout);
      const tmux = await import('@/integrations/tmux');
      const actualTmux = await vi.importActual<typeof import('@/integrations/tmux')>('@/integrations/tmux');
      delegateToActual(vi.mocked(tmux.isTmuxAvailable), actualTmux.isTmuxAvailable);
      const childProcess = await import('node:child_process');
      // Only the OS tmux client transport is replaced; parsing, argv construction,
      // launch ownership and attachment binding remain the actual implementation.
      delegateToActual(vi.mocked(childProcess.spawn), ((command: string, args: readonly string[]) => {
        if (command !== 'tmux') throw new Error('Unexpected fixture process');
        const child = new EventEmitter();
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        Object.assign(child, { stdout, stderr });
        queueMicrotask(() => {
          if (args.includes('new-window') && isTmuxCreation) {
            tmuxLaunchHandoffPath = /'([^']*happier-tmux-spawn-[^']*\/spawn\.sh)'/.exec(args[args.length - 1] ?? '')?.[1];
            if (contract === 'tmux_creation_not_started') {
              stderr.emit('data', 'create window failed: index 1 in use.');
              child.emit('close', 1);
            } else {
              // The tmux server has accepted creation; the client reply cannot
              // prove the immutable window identity. It is not a failed spawn.
              stdout.emit('data', '12345\tmalformed-window-id\n');
              child.emit('close', 0);
            }
          } else {
            stdout.emit('data', args.includes('new-window') ? '12345\t@1\n' : 'happier-fixture\n');
            child.emit('close', 0);
          }
        });
        return child;
      }) as unknown as typeof childProcess.spawn);
    }
    delegateToActual(vi.mocked(visible.waitForVisibleConsoleSessionWebhook), actualVisible.waitForVisibleConsoleSessionWebhook);
    delegateToActual(vi.mocked(resolver.resolveSpawnWebhookResult), actualResolver.resolveSpawnWebhookResult);
    delegateToActual(vi.mocked(attachments.writeTerminalAttachmentInfo), actualAttachments.writeTerminalAttachmentInfo);
    delegateToActual(vi.mocked(runtime.buildHappyCliSubprocessLaunchSpec), (args) => ({
      runtime: 'node' as const, filePath: '/test/admitted-happier', args: [...args],
    }));
    let manager: import('./processSupervision/sessionRunnerRespawn').SessionRunnerRespawnManager | undefined;
    delegateToActual(vi.mocked(respawn.createSessionRunnerRespawnManager), (params) => {
      manager = actualRespawn.createSessionRunnerRespawnManager(params);
      return manager;
    });
    let report: ReturnType<typeof actualWebhook.createOnHappySessionWebhook> | undefined;
    let reportedPublication: Promise<void> | undefined;
    let releaseReportCensus!: () => void;
    const reportCensusReleased = new Promise<void>((resolve) => { releaseReportCensus = resolve; });
    let firstReportOwner: import('./types').TrackedSession | undefined;
    let tracked: Map<number, import('./types').TrackedSession> | undefined;
    let awaiters: Map<number, (session: import('./types').TrackedSession) => void> | undefined;
    delegateToActual(vi.mocked(webhook.createOnHappySessionWebhook), (params) => {
      tracked = params.pidToTrackedSession;
      awaiters = params.pidToAwaiter;
      report = actualWebhook.createOnHappySessionWebhook({
        ...params,
        ...(contract === 'pty_console_missing_id_nonce_replay' ? {
          onTrackedSessionReported: (session: import('./types').TrackedSession) => {
            reportedPublication = Promise.resolve(params.onTrackedSessionReported?.(session));
            return reportedPublication;
          },
        } : {}),
        ...(isWrapperPromotion ? { getParentPidFn: () => 12345 } : {}),
        ...(isExitBeforeFirstReport ? { findHappyProcessByPidFn: async () => { await reportCensusReleased; return null; } } : {}),
      });
      return report;
    });
    let enteredMarker!: () => void;
    let releaseMarker!: () => void;
    const markerEntered = new Promise<void>((resolve) => { enteredMarker = resolve; });
    const markerReleased = new Promise<void>((resolve) => { releaseMarker = resolve; });
    let enteredBinding!: () => void;
    let releaseBinding!: () => void;
    const bindingEntered = new Promise<void>((resolve) => { enteredBinding = resolve; });
    const bindingReleased = new Promise<void>((resolve) => { releaseBinding = resolve; });
    const regularChildEvents = new EventEmitter();
    let regularAttachFilePath: string | undefined;
    if (isEarlyRegularExit || isHerdrCreation) {
      const exits = await import('./sessions/onChildExited');
      delegateToActual(vi.mocked(exits.createOnChildExited), actualChildExitOwner.createOnChildExited);
      const attachFiles = await import('./sessionAttachFile');
      const actualAttachFiles = await vi.importActual<typeof import('./sessionAttachFile')>('./sessionAttachFile');
      delegateToActual(vi.mocked(attachFiles.createSessionAttachFile), async (params) => {
        const attachment = await actualAttachFiles.createSessionAttachFile(params);
        regularAttachFilePath = attachment.filePath;
        return attachment;
      });
      if (isEarlyRegularExit) spawnHappyCLI.mockImplementationOnce(() => ({
        pid: 12345, stdout: null, stderr: null, unref: vi.fn(),
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => regularChildEvents.on(event, listener)),
      }));
    }
    if (isBindingExit) {
      const exits = await import('./sessions/onChildExited');
      delegateToActual(vi.mocked(exits.createOnChildExited), actualChildExitOwner.createOnChildExited);
    }
    if (isNonceReplay || isCommittedBindingExit || contract === 'early_webhook' || contract === 'marker_write_failed' || contract === 'early_webhook_marker_failed' || isEarlyRegularExit) {
      const actualMarkers = await vi.importActual<typeof import('./sessionRegistry')>('./sessionRegistry');
      delegateToActual(sessionRegistryCapture.writeSessionMarker, actualMarkers.writeSessionMarker);
      if (isEarlyRegularExit) {
        delegateToActual(sessionRegistryCapture.removeSessionMarker, actualMarkers.removeSessionMarker);
      }
      if (!isNonceReplay && !isCommittedBindingExit) acceptedMarkerBoundary.beforeCommit = async (target) => {
        if (String(target).startsWith(fixtureHome) && String(target).endsWith('pid-12345.json')) {
          acceptedMarkerBoundary.beforeCommit = null;
          if (contract === 'marker_write_failed') throw Object.assign(new Error('Fixture OS commit denied'), { code: 'EACCES' });
          enteredMarker();
          await markerReleased;
          if (contract === 'early_webhook_marker_failed') throw Object.assign(new Error('Fixture OS commit denied'), { code: 'EACCES' });
        }
      };
    }
    if (contract === 'binding_write_failed' || isWindows) {
      acceptedMarkerBoundary.beforeCommit = async (target) => {
        if (String(target) === join(fixtureHome, 'terminal', 'sessions', 'sess_plain.json')) {
          throw Object.assign(new Error('Fixture attachment commit denied'), { code: 'EACCES' });
        }
      };
    }
    if (isBindingExit) {
      const holdBinding = async (target: unknown) => {
        if (String(target) === join(fixtureHome, 'terminal', 'sessions', 'sess_plain.json')) {
          enteredBinding();
          await bindingReleased;
        }
      };
      if (isCommittedBindingExit) acceptedMarkerBoundary.afterCommit = holdBinding;
      else acceptedMarkerBoundary.beforeCommit = holdBinding;
    }
    const guardedRpc = vi.mocked(callSessionRpc);
    let replayingNonce = false;
    let replayTransitionApplied = false;
    let replayOriginalTerminal: import('./types').TrackedSession['hostedTerminal'];
    const { logger } = await import('@/ui/logger');
    vi.mocked(logger.warn).mockClear();
    guardedRpc.mockImplementation(async ({ method }) => {
      if (replayingNonce && !replayTransitionApplied) {
        replayTransitionApplied = true;
        const acceptedRunner = tracked!.get(12345)!;
        if (contract === 'late_binding_nonce_replay') {
          const bound = await actualAttachments.readTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId: 'sess_plain' });
          if (!bound || bound.version === 1) throw new Error('Missing fixture exact host');
          await actualAttachments.writeTerminalAttachmentInfo({
            happyHomeDir: fixtureHome, sessionId: 'sess_plain', attachmentId: 'replacement-attachment',
            handle: { ...bound.handle, attachmentId: 'replacement-attachment' as typeof bound.attachmentId }, terminal: bound.terminal,
          });
        }
        if (contract === 'late_geometry_nonce_replay') {
          const bound = await actualAttachments.readTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId: 'sess_plain' });
          if (!bound || bound.version === 1) throw new Error('Missing fixture exact host');
          replayOriginalTerminal = acceptedRunner.hostedTerminal;
          acceptedRunner.hostedTerminal = { ...bound.terminal, herdr: { ...bound.terminal.herdr!, terminalId: 'different-terminal' } };
          await actualAttachments.writeTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId: 'sess_plain', attachmentId: bound.attachmentId,
            handle: { ...bound.handle, terminalId: 'different-terminal' }, terminal: acceptedRunner.hostedTerminal });
        }
        if (contract === 'late_retiring_nonce_replay') {
          acceptedRunner.reportMarkerCustody ??= { pending: Promise.resolve(), retiring: false };
          acceptedRunner.reportMarkerCustody.retiring = true;
        }
        if (contract === 'late_owner_nonce_replay') {
          tracked!.set(12345, { ...acceptedRunner, happySessionId: 'sess_changed' });
        }
      }
      if (replayingNonce && contract === 'unready_nonce_replay') {
        return { ok: false, errorCode: 'rpc_method_unavailable' };
      }
      if (method.endsWith('wakeCapability.v1.get')) {
        return { ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1' };
      }
      if (contract === 'wake_rpc_failed') throw new Error('fixture_rpc_transport_failure');
      return { ok: true, result: 'wake_published' };
    });
    let run: Promise<void> | null = null;
    try {
      run = daemonStartupOwner.startDaemon();
      const spawnSession = await waitForSpawnSessionRegistration();
      if (contract === 'resume_after_stop') {
        await harness.getStopSession()!('sess_plain');
      }
      guardedRpc.mockClear();
      const accepting = spawnSession({
        directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: fixtureAgent },
        existingSessionId: 'sess_plain', ...(fixtureAgent === 'codex' ? { codexBackendMode: 'appServer' as const } : {}),
        terminal: isTmux ? { mode: 'tmux', tmux: { sessionName: 'happier-fixture' } } : isEarlyRegularExit || isRestoredPlain || isWindows ? { mode: 'plain' } : { mode: 'herdr', herdr: { sessionName: 'default' } },
        ...(isWindows ? { windowsRemoteSessionLaunchMode: 'console' as const } : {}),
        token: 'token-daemon', ...(contract !== 'resume_after_stop' ? { spawnNonce: `hosted-completion-${contract}` } : {}),
      });
      const metadata = {
        path: '/tmp', host: 'test-host', homeDir: '/tmp/home', happyHomeDir: fixtureHome,
        happyLibDir: '/tmp/lib', happyToolsDir: '/tmp/tools', hostPid: 12345,
        startedBy: 'daemon' as const, flavor: fixtureAgent,
        ...(fixtureAgent === 'claude' ? { claudeSessionId: 'vendor-claude-1' } : { codexSessionId: 'vendor-plain-1' }),
      };
      if (contract === 'early_webhook' || contract === 'early_webhook_marker_failed') {
        await markerEntered;
        await report!('sess_plain', metadata);
        expect(guardedRpc).not.toHaveBeenCalled();
        expect(await harness.getResolveSpawnSessionByNonce()!(`hosted-completion-${contract}`))
          .not.toMatchObject({ status: 'success' });
        if (contract === 'early_webhook') {
          acceptedMarkerBoundary.beforeCommit = async (target) => {
            if (String(target) === join(fixtureHome, 'terminal', 'sessions', 'sess_plain.json')) {
              enteredBinding();
              await bindingReleased;
            }
          };
        }
        releaseMarker();
      }
      if (isEarlyRegularExit) {
        await markerEntered;
        if (isWrapperPromotion) await report!('PID-23456', { ...metadata, hostPid: 23456 });
        else if (contract === 'early_regular_report_exit') await report!('sess_plain', metadata);
        // ChildProcess exit delivery is the OS boundary; the real waiter and
        // accepted-marker owner remain in the daemon startup corridor.
        if (isExitBeforeFirstReport) firstReportOwner = tracked?.get(12345);
        regularChildEvents.emit('exit', 1, null);
        expect(awaiters?.has(12345)).toBe(false);
        if (isExitBeforeFirstReport) await report!('sess_plain', metadata);
        if (isWrapperPromotion) {
          expect(tracked?.has(23456)).toBe(true);
          expect(awaiters?.has(23456)).toBe(true);
        }
        releaseMarker();
      }
      const accepted = await accepting;
      if (isHerdrCreation) {
        expect(api?.requests.map((request) => request.method)).toContain('layout.apply');
        expect(accepted).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED });
        expect(spawnHappyCLI).not.toHaveBeenCalled();
        expect(regularAttachFilePath).toBeDefined();
        if (contract === 'herdr_creation_unconfirmed') {
          await expect(access(regularAttachFilePath!)).resolves.toBeUndefined();
          expect(api?.panes.has('managed')).toBe(true);
          // Inspect the real private handoff to the actual runner parser. This
          // proves daemon admission preserves the chosen endpoint across child setup.
          const layout = api?.requests.find(request => request.method === 'layout.apply');
          const root = layout?.params.root;
          if (!root || typeof root !== 'object' || !('command' in root)
            || !Array.isArray(root.command) || typeof root.command[2] !== 'string') {
            throw new Error('Missing real hosted runner handoff');
          }
          const spec: unknown = JSON.parse(await readFile(root.command[2], 'utf8'));
          if (!spec || typeof spec !== 'object' || !('args' in spec)
            || !Array.isArray(spec.args) || !spec.args.every(arg => typeof arg === 'string')) {
            throw new Error('Invalid real hosted runner handoff');
          }
          expect(parseAndStripTerminalRuntimeFlags(spec.args).terminal).toMatchObject({
            mode: 'herdr', requested: 'herdr', herdrSessionName: 'default', herdrSocketPath: api?.socketPath,
          });
        } else {
          await expect(access(regularAttachFilePath!)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(api?.panes.has('managed')).toBe(false);
        }
        return;
      }
      if (isTmuxCreation) {
        if (contract === 'tmux_creation_unconfirmed') {
          expect(accepted).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED });
          expect(spawnHappyCLI).not.toHaveBeenCalled();
          expect(tracked?.has(12345)).toBe(false);
          expect(awaiters?.size).toBe(0);
          expect(tmuxLaunchHandoffPath).toBeDefined();
          await expect(access(tmuxLaunchHandoffPath!)).resolves.toBeUndefined();
        } else {
          expect(accepted).toMatchObject({ type: 'success', sessionId: 'sess_plain' });
          expect(spawnHappyCLI).toHaveBeenCalledTimes(1);
          await report!('sess_plain', metadata);
          expect(tmuxLaunchHandoffPath).toBeDefined();
          await expect(access(tmuxLaunchHandoffPath!)).rejects.toMatchObject({ code: 'ENOENT' });
        }
        expect(await actualAttachments.readTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId: 'sess_plain' })).toBeNull();
        return;
      }
      if (isWrapperPromotion) {
        expect(accepted).toMatchObject({ type: 'success', sessionId: 'sess_plain' });
        await report!('sess_plain', { ...metadata, hostPid: 23456 });
        await vi.waitFor(async () => {
          expect(await harness.getResolveSpawnSessionByNonce()!(`hosted-completion-${contract}`))
            .toMatchObject({ status: 'success', sessionId: 'sess_plain' });
        });
        const actualMarkers = await vi.importActual<typeof import('./sessionRegistry')>('./sessionRegistry');
        await vi.waitFor(async () => expect(await actualMarkers.readSessionMarkerForPid(12345)).toBeNull());
        await vi.waitFor(async () => expect(await actualMarkers.readSessionMarkerForPid(23456)).toMatchObject({ happySessionId: 'sess_plain' }));
        expect(tracked?.has(23456)).toBe(true);
        expect(webhookTimeouts?.size).toBe(0);
        expect(webhookResolvers?.size).toBe(0);
        return;
      }
      if (isEarlyRegularExit) {
        await vi.waitFor(async () => {
          expect(await harness.getResolveSpawnSessionByNonce()!(`hosted-completion-${contract}`))
            .toMatchObject({ status: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK' });
        });
        expect(awaiters?.has(12345)).toBe(false);
        expect(webhookTimeouts?.has(12345)).toBe(false);
        await vi.waitFor(() => expect(tracked?.has(12345)).toBe(false));
        expect(regularAttachFilePath).toBeTruthy();
        await expect(access(regularAttachFilePath!)).rejects.toMatchObject({ code: 'ENOENT' });
        const actualMarkers = await vi.importActual<typeof import('./sessionRegistry')>('./sessionRegistry');
        if (isExitBeforeFirstReport) {
          releaseReportCensus();
          await firstReportOwner?.reportMarkerCustody?.pending;
        }
        expect(await actualMarkers.readSessionMarkerForPid(12345)).toBeNull();
        expect(guardedRpc).not.toHaveBeenCalled();
        return;
      }
      if (contract === 'marker_write_failed' || contract === 'early_webhook_marker_failed') {
        expect(accepted).toMatchObject({ type: 'error', errorCode: 'SPAWN_FAILED' });
        expect(awaiters?.has(12345)).toBe(false);
        expect(webhookTimeouts?.has(12345)).toBe(false);
        expect(webhookResolvers?.has(12345)).toBe(false);
        expect(guardedRpc).not.toHaveBeenCalled();
        expect(await actualAttachments.readTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId: 'sess_plain' })).toBeNull();
        return;
      }
      expect(accepted).toMatchObject({ type: 'success', sessionId: 'sess_plain' });
      if (isWindows) {
        await report!('sess_plain', metadata);
        await vi.waitFor(async () => {
          expect(await harness.getResolveSpawnSessionByNonce()!(`hosted-completion-${contract}`))
            .toMatchObject({ status: 'error', errorCode: 'SPAWN_FAILED' });
        });
        expect(await actualAttachments.readTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId: 'sess_plain' })).toBeNull();
        expect(tracked?.has(12345)).toBe(true);
        expect(guardedRpc).not.toHaveBeenCalled();
        return;
      }
      if (contract === 'early_webhook') {
        await bindingEntered;
        expect(await harness.getResolveSpawnSessionByNonce()!(`hosted-completion-${contract}`))
          .toEqual({ status: 'pending' });
        releaseBinding();
      }
      if (contract !== 'early_webhook') expect(guardedRpc).not.toHaveBeenCalled();
      expect(herdrSpawnCapture.createPane).toHaveBeenCalledTimes(isRestoredPlain || isTmux ? 0 : 1);
      expect(tracked?.get(12345)?.spawnOptions?.terminal?.mode).toBe(isTmux ? 'tmux' : isRestoredPlain ? 'plain' : 'herdr');
      if (contract !== 'early_webhook') await report!('sess_plain', metadata);
      if (isBindingExit) {
        await bindingEntered;
        if (isCommittedBindingExit) {
          expect(tracked?.get(12345)?.startupCustody).toBeTruthy();
          await tracked?.get(12345)?.reportMarkerCustody?.pending;
          expect(await actualAttachments.readTerminalAttachmentState({ happyHomeDir: fixtureHome, sessionId: 'sess_plain' }))
            .toMatchObject({ status: 'present' });
          expect(await harness.getResolveSpawnSessionByNonce()!(`hosted-completion-${contract}`))
            .toEqual({ status: 'pending' });
        }
        fixtureRunnerAlive = false;
        await vi.waitFor(() => expect(fixtureExitObserved).toBe(true));
        expect(await harness.getResolveSpawnSessionByNonce()!(`hosted-completion-${contract}`))
          .toMatchObject({ status: 'pending' });
        expect(tracked?.has(12345)).toBe(true);
        releaseBinding();
        await vi.waitFor(async () => {
          expect(await harness.getResolveSpawnSessionByNonce()!(`hosted-completion-${contract}`))
            .toMatchObject({ status: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK' });
          expect(tracked?.has(12345)).toBe(false);
        });
        expect(guardedRpc).not.toHaveBeenCalled();
        return;
      }
      if (contract === 'binding_write_failed') {
        await vi.waitFor(() => expect(herdrSpawnCapture.closePane).toHaveBeenCalledTimes(1));
        await vi.waitFor(async () => {
          expect(await harness.getResolveSpawnSessionByNonce()!(`hosted-completion-${contract}`))
            .toMatchObject({ status: 'error', errorCode: 'SPAWN_FAILED' });
        });
        expect(await actualAttachments.readTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId: 'sess_plain' })).toBeNull();
        expect(herdrSpawnCapture.closePane).toHaveBeenCalledTimes(1);
        expect(guardedRpc).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalled();
        return;
      }
      if (isNonceReplay) {
        // Replay mutates an already-published runner, not an in-flight report.
        const acceptedRunner = tracked!.get(12345)!;
        await acceptedRunner.startupCustody?.finalization;
        await acceptedRunner.reportMarkerCustody?.pending;
      }
      if (contract !== 'resume_after_stop') await vi.waitFor(async () => {
        expect(await harness.getResolveSpawnSessionByNonce()!(`hosted-completion-${contract}`))
          .toMatchObject({ status: 'success', sessionId: 'sess_plain' });
      });
      if (!isRestoredPlain) await vi.waitFor(async () => {
        expect(await actualAttachments.readTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId: 'sess_plain' }))
          .toMatchObject({ version: 2, handle: { kind: 'herdr', terminalId: 'terminal_1' } });
      });
      if (isNonceReplay) {
        if (isRestoredPlain) {
          const acceptedRunner = tracked!.get(12345)!;
          const { buildTrackedSpawnOptions } = await import('./spawnHooks');
          const { buildSessionRunnerRespawnDescriptorV1FromSpawnOptions, buildSpawnSessionOptionsFromRespawnDescriptorV1 } =
            await import('./processSupervision/sessionRunnerRespawnDescriptor');
          // The canonical accepted topology overrides the requested host; the
          // descriptor round trip is the actual restart persistence boundary.
          const descriptor = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(buildTrackedSpawnOptions({
            options: { ...acceptedRunner.spawnOptions!, terminal: { mode: 'herdr' } },
            terminalPresentation: { kind: 'none' },
          }));
          if (!descriptor) throw new Error('Fixture accepted descriptor missing');
          const restored = buildSpawnSessionOptionsFromRespawnDescriptorV1(descriptor);
          expect(restored.terminal).toEqual({ mode: 'plain' });
          acceptedRunner.spawnOptions = restored;
          delete acceptedRunner.childProcess;
          delete acceptedRunner.hostedTerminal;
          delete acceptedRunner.happySessionMetadataFromLocalWebhook;
          expect(await actualAttachments.readTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId: 'sess_plain' })).toBeNull();
        }
        if (contract === 'unbound_nonce_replay') {
          await unlink(join(fixtureHome, 'terminal', 'sessions', 'sess_plain.json'));
        }
        const acceptedRunner = tracked!.get(12345)!;
        if (contract === 'wrong_binding_nonce_replay' || contract === 'sameid_wrong_mode_nonce_replay' || contract === 'missing_id_nonce_replay') {
          const bound = await actualAttachments.readTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId: 'sess_plain' });
          if (!bound || bound.version === 1) throw new Error('Missing fixture exact host');
          if (contract === 'wrong_binding_nonce_replay') {
            await actualAttachments.writeTerminalAttachmentInfo({
              happyHomeDir: fixtureHome, sessionId: 'sess_plain', attachmentId: bound.attachmentId,
              handle: { ...bound.handle, terminalId: 'different-terminal' },
              terminal: { ...bound.terminal, herdr: { ...bound.terminal.herdr!, terminalId: 'different-terminal' } },
            });
          } else if (contract === 'sameid_wrong_mode_nonce_replay') {
            await actualAttachments.writeTerminalAttachmentInfo({
              happyHomeDir: fixtureHome, sessionId: 'sess_plain', attachmentId: bound.attachmentId,
              handle: { ...bound.handle, kind: 'zellij', sessionName: 'different-host', paneId: 'different-pane', socketDir: '/fixture/zellij' },
              terminal: { mode: 'zellij', zellij: { sessionName: 'different-host', paneId: 'different-pane', socketDirV1: '/fixture/zellij' } },
            });
          } else {
            // Same exact host metadata remains sufficient when no attachment ID was published.
            if (acceptedRunner.hostedTerminal?.controlServiceabilityV1) delete acceptedRunner.hostedTerminal.controlServiceabilityV1.attachmentId;
            delete acceptedRunner.publishedTerminalControlServiceabilityAttachmentId;
          }
        }
        if (contract === 'wrong_marker_session_nonce_replay') {
          const markers = await vi.importActual<typeof import('./sessionRegistry')>('./sessionRegistry');
          const marker = await markers.readSessionMarkerForPid(12345);
          if (!marker) throw new Error('Missing fixture accepted marker');
          await markers.writeSessionMarker({ ...marker, happySessionId: 'different-session' });
        }
        if (contract === 'wrong_marker_pid_nonce_replay') {
          const markerPath = join(fixtureHome, 'tmp', 'daemon-sessions', 'pid-12345.json');
          const rawMarker = JSON.parse(await readFile(markerPath, 'utf8'));
          await writeFile(markerPath, JSON.stringify({ ...rawMarker, pid: 23456 }));
          const markers = await vi.importActual<typeof import('./sessionRegistry')>('./sessionRegistry');
          expect(await markers.readSessionMarkerForPid(12345)).toMatchObject({ pid: 23456 });
        }
        if (contract === 'wrong_marker_identity_nonce_replay') {
          const markers = await vi.importActual<typeof import('./sessionRegistry')>('./sessionRegistry');
          const marker = await markers.readSessionMarkerForPid(12345);
          if (!marker) throw new Error('Missing fixture accepted marker');
          acceptedRunner.processInstanceFingerprint = 'accepted-runner-instance';
          await markers.writeSessionMarker({ ...marker, processInstanceFingerprint: 'different-runner-instance' });
        }
        if (contract === 'pty_console_missing_id_nonce_replay') {
          const bound = await actualAttachments.readTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId: 'sess_plain' });
          if (!bound || bound.version === 1) throw new Error('Missing fixture exact host');
          acceptedRunner.hostedTerminal = { mode: 'windows_console', windows: { host: 'console', pid: 12345 } };
          await actualAttachments.writeTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId: 'sess_plain', attachmentId: bound.attachmentId,
            handle: { ...bound.handle, kind: 'windows_console', sessionName: 'pty-console', paneId: 'pty-console' },
            terminal: { mode: 'windows_console', windows: { host: 'console' } } });
          delete acceptedRunner.publishedTerminalControlServiceabilityAttachmentId;
        }
        if (contract === 'tmux_nonce_replay' || contract === 'zellij_nonce_replay') {
          const bound = await actualAttachments.readTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId: 'sess_plain' });
          if (!bound || bound.version === 1) throw new Error('Missing fixture exact host');
          const mode = contract === 'tmux_nonce_replay' ? 'tmux' : 'zellij';
          acceptedRunner.hostedTerminal = mode === 'tmux'
            ? { mode, tmux: { target: 'exact-session:exact-pane', tmpDir: '/fixture/socket' } }
            : { mode, zellij: { sessionName: 'exact-session', paneId: 'exact-pane', socketDirV1: '/fixture/socket' } };
          await actualAttachments.writeTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId: 'sess_plain',
            attachmentId: bound.attachmentId, handle: { ...bound.handle, kind: mode, sessionName: 'exact-session', paneId: 'exact-pane', socketDir: '/fixture/socket' },
            terminal: acceptedRunner.hostedTerminal });
        }
        if (contract === 'legacy_windows_nonce_replay' || contract === 'wrong_windows_nonce_replay' || contract === 'console_nonce_replay') {
          const windows = await vi.importActual<typeof import('./platform/windows/windowsHostedSessionRuntime')>('./platform/windows/windowsHostedSessionRuntime');
          acceptedRunner.hostedTerminal = windows.buildWindowsHostedTerminalAttachment({ pid: 12345,
            actualMode: contract === 'console_nonce_replay' ? 'windows_console' : 'windows_terminal', requestedMode: 'windows_terminal',
            windowId: 'exact-window', title: 'exact-tab' });
          await unlink(join(fixtureHome, 'terminal', 'sessions', 'sess_plain.json'));
          await actualAttachments.writeTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId: 'sess_plain', terminal: contract === 'wrong_windows_nonce_replay'
            ? { ...acceptedRunner.hostedTerminal, windows: { ...acceptedRunner.hostedTerminal.windows!, windowId: 'different-window' } }
            : acceptedRunner.hostedTerminal });
          delete acceptedRunner.publishedTerminalControlServiceabilityAttachmentId;
        }
        replayingNonce = true;
        guardedRpc.mockClear();
        replayClockOffset = 3001;
        expect(await harness.getResolveSpawnSessionByNonce()!(`hosted-completion-${contract}`))
          .toEqual(recoveredReady ? { status: 'success', sessionId: 'sess_plain' } : { status: 'pending' });
        if (contract === 'late_geometry_nonce_replay') acceptedRunner.hostedTerminal = replayOriginalTerminal;
        expect(await spawnSession({
          directory: '/tmp', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          existingSessionId: 'sess_plain', codexBackendMode: 'appServer',
          terminal: { mode: 'herdr', herdr: { sessionName: 'default' } },
          token: 'token-daemon', spawnNonce: `hosted-completion-${contract}`,
        })).toMatchObject({ type: 'success', sessionId: 'sess_plain', runnerAcceptance: 'same_request_runner' });
        // The held observation must not settle. A subsequent lookup can prove
        // the now-stable same physical host when no attachment ID was advertised.
        expect(await harness.getResolveSpawnSessionByNonce()!(`hosted-completion-${contract}`))
          .toEqual(recoveredReady || contract === 'late_binding_nonce_replay'
            ? { status: 'success', sessionId: 'sess_plain' } : { status: 'pending' });
        expect(herdrSpawnCapture.createPane).toHaveBeenCalledTimes(isRestoredPlain ? 0 : 1);
        if (contract === 'pty_console_missing_id_nonce_replay') {
          delegateToActual(vi.mocked(attachments.readTerminalAttachmentInfo), actualAttachments.readTerminalAttachmentInfo);
          const updates = await import('@/session/metadata/updateSessionMetadataWithRetry');
          delegateToActual(vi.mocked(updates.updateSessionMetadataWithRetry), actualMetadataUpdateOwner.updateSessionMetadataWithRetry);
          let serverMetadata: Record<string, unknown> = { ...metadata, terminal: { mode: 'windows_console', windows: { host: 'console' } } };
          let serverVersion = 1;
          vi.mocked(fetchSessionByIdCompat).mockImplementation(async () => createSessionRecordFixture({ id: 'sess_plain',
            encryptionMode: 'plain', metadata: JSON.stringify(serverMetadata), metadataVersion: serverVersion, dataEncryptionKey: null }));
          const sockets = await import('@/api/session/sockets');
          // Socket.io is the external server boundary; the publication CAS and
          // serviceability projection remain the actual canonical implementation.
          vi.spyOn(sockets, 'createSessionScopedSocket').mockImplementation(() => {
            const events = new EventEmitter();
            return { connected: true, on: events.on.bind(events), off: events.off.bind(events),
              connect: () => events.emit('connect'), disconnect: () => {}, close: () => {},
              emit: (_event: string, payload: { expectedVersion: number; metadata: string }, ack: (answer: unknown) => void) => {
                expect(payload.expectedVersion).toBe(serverVersion);
                serverMetadata = JSON.parse(payload.metadata) as Record<string, unknown>;
                serverVersion += 1;
                ack({ result: 'success', version: serverVersion, metadata: payload.metadata });
              },
            } as unknown as ReturnType<typeof sockets.createSessionScopedSocket>;
          });
          await report!('sess_plain', { ...metadata, terminal: { mode: 'windows_console', windows: { host: 'console' } } });
          await reportedPublication;
          await acceptedRunner.reportMarkerCustody?.pending;
          expect(acceptedRunner.publishedTerminalControlServiceabilityAttachmentId).toBeTruthy();
          expect(serverMetadata.terminal).toMatchObject({ controlServiceabilityV1: {
            attachmentId: acceptedRunner.publishedTerminalControlServiceabilityAttachmentId, state: 'servable' } });
          expect(await harness.getResolveSpawnSessionByNonce()!(`hosted-completion-${contract}`))
            .toEqual({ status: 'success', sessionId: 'sess_plain' });
        }
        return;
      }
      if (contract === 'wake' || contract === 'wake_rpc_failed' || contract === 'early_webhook') {
        await vi.waitFor(() => expect(guardedRpc.mock.calls.map(([params]) => params.method))
          .toContain('sess_plain:session.pendingQueue.wake.v1'));
        expect(guardedRpc.mock.calls.filter(([params]) => params.method.endsWith('session.pendingQueue.wake.v1')))
          .toHaveLength(1);
        if (contract === 'wake_rpc_failed') {
          await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
            event: 'pending_queue_wake', sessionId: 'sess_plain', trigger: 'attach',
            outcome: 'unavailable', reason: 'rpc_failed',
          }));
          expect(await harness.getResolveSpawnSessionByNonce()!('hosted-completion-wake_rpc_failed'))
            .toMatchObject({ status: 'success', sessionId: 'sess_plain' });
        }
      } else {
        const crashed = tracked!.get(12345)!;
        tracked!.delete(12345);
        manager!.handleUnexpectedExit(crashed, { reason: 'process-exited', code: 1, signal: null });
        await vi.waitFor(() => expect(herdrSpawnCapture.createPane).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(awaiters!.has(12345)).toBe(true));
        // Finish the replacement's real waiter rather than leaving a five-minute test timer behind.
        await report!('sess_plain', {
          path: '/tmp', host: 'test-host', homeDir: '/tmp/home', happyHomeDir: fixtureHome,
          happyLibDir: '/tmp/lib', happyToolsDir: '/tmp/tools', hostPid: 12345,
          startedBy: 'daemon', flavor: fixtureAgent,
          ...(fixtureAgent === 'claude' ? { claudeSessionId: 'vendor-claude-1' } : { codexSessionId: 'vendor-plain-1' }),
        });
        if (contract === 'respawn_with_nonce') {
          // The original caller keeps its idempotent receipt; recovery is a different launch attempt.
          expect(await harness.getResolveSpawnSessionByNonce()!('hosted-completion-respawn_with_nonce'))
            .toMatchObject({ status: 'success', sessionId: 'sess_plain' });
        }
      }
    } finally {
      if (previousHerdrBinary === undefined) delete process.env.HERDR_BIN_PATH;
      else process.env.HERDR_BIN_PATH = previousHerdrBinary;
      if (previousClaudeBinary === undefined) delete process.env.HAPPIER_CLAUDE_PATH;
      else process.env.HAPPIER_CLAUDE_PATH = previousClaudeBinary;
      replayClock?.mockRestore();
      releaseMarker();
      releaseBinding();
      releaseReportCensus();
      acceptedMarkerBoundary.beforeCommit = null;
      acceptedMarkerBoundary.afterCommit = null;
      if (isEarlyRegularExit) {
        for (const timeout of webhookTimeouts?.values() ?? []) clearTimeout(timeout);
        webhookTimeouts?.clear();
        awaiters?.clear();
        for (const resolve of webhookResolvers?.values() ?? []) resolve({ type: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK', errorMessage: 'Fixture cleanup' });
        webhookResolvers?.clear();
      }
      const unfinished = tracked?.get(12345);
      if (contract === 'early_webhook' && unfinished) await awaiters?.get(12345)?.(unfinished);
      // The replacement report can ACK before the existing common binding
      // finalizer. Drain actual owned work before removing its filesystem fixture.
      for (const timeout of webhookTimeouts?.values() ?? []) clearTimeout(timeout);
      for (const resolve of webhookResolvers?.values() ?? []) resolve({ type: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK', errorMessage: 'Fixture cleanup' });
      await Promise.all(Array.from(tracked?.values() ?? [], (session) => session.startupCustody?.finalization));
      await Promise.all(Array.from(tracked?.values() ?? [], (session) => session.reportMarkerCustody?.pending));
      await firstReportOwner?.reportMarkerCustody?.pending;
      if (run) { harness.requestShutdown('happier-cli'); await run; }
      for (const timer of exitPolls) clearInterval(timer);
      for (const timer of availabilityTimers) clearTimeout(timer);
      if (tmuxLaunchHandoffPath) await rm(dirname(tmuxLaunchHandoffPath), { recursive: true, force: true });
      if (previousTmuxInlineLimit === undefined) delete process.env.HAPPIER_CLI_TMUX_INLINE_SPAWN_MAX_CHARS;
      else process.env.HAPPIER_CLI_TMUX_INLINE_SPAWN_MAX_CHARS = previousTmuxInlineLimit;
      for (const restore of restoreDelegates) restore();
      Object.defineProperty(configuration, 'happyHomeDir', { value: originalHome });
      if (previousRefresh === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = previousRefresh;
      if (previousNonceTtl === undefined) delete process.env.HAPPIER_DAEMON_SPAWN_ACCEPTED_NONCE_TTL_MS;
      else process.env.HAPPIER_DAEMON_SPAWN_ACCEPTED_NONCE_TTL_MS = previousNonceTtl;
      if (previousExitPoll === undefined) delete process.env.HAPPIER_DAEMON_VISIBLE_CONSOLE_EXIT_POLL_MS;
      else process.env.HAPPIER_DAEMON_VISIBLE_CONSOLE_EXIT_POLL_MS = previousExitPoll;
      if (previousHeartbeatInterval === undefined) delete process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL;
      else process.env.HAPPIER_DAEMON_HEARTBEAT_INTERVAL = previousHeartbeatInterval;
      delete process.env.HAPPIER_DAEMON_SESSION_RESPAWN_BASE_DELAY_MS;
      delete process.env.HAPPIER_DAEMON_SESSION_RESPAWN_JITTER_MS;
      await rm(fixtureHome, { recursive: true, force: true });
    }
    };
    // Native executable shebang substitution is POSIX-only; socket-owner coverage
    // remains platform-independent in the existing Herdr client tests.
    if ((contract === 'herdr_creation_unconfirmed' || contract === 'herdr_creation_stopped') && process.platform === 'win32') return;
    if (contract === 'herdr_creation_unconfirmed' || contract === 'herdr_creation_stopped') await withHerdrApi(runContract);
    else await runContract();
  });

  it('returns typed host setup recovery when the actual Herdr executable is absent', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const previousRefresh = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    const previousHerdr = process.env.HERDR_BIN_PATH;
    const fixtureHome = await mkdtemp(join(tmpdir(), 'happier-host-unavailable-'));
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    process.env.HERDR_BIN_PATH = join(fixtureHome, 'absent-herdr');
    let run: Promise<void> | null = null;
    const hosts = await import('@/integrations/terminalHost/defaultRegistry');
    const previousInventory = vi.mocked(hosts.createDefaultTerminalHostRegistry).getMockImplementation();
    const runtime = await import('@/integrations/herdr/runtimeBinary');
    const previousRuntime = vi.mocked(runtime.resolveHerdrRuntimeBinary).getMockImplementation();
    try {
      // Keep registry/version admission real; the missing executable is the OS boundary.
      const actualRuntime = await vi.importActual<typeof import('@/integrations/herdr/runtimeBinary')>('@/integrations/herdr/runtimeBinary');
      vi.mocked(runtime.resolveHerdrRuntimeBinary).mockImplementation(actualRuntime.resolveHerdrRuntimeBinary);
      const actual = await vi.importActual<typeof import('@/integrations/terminalHost/defaultRegistry')>('@/integrations/terminalHost/defaultRegistry');
      vi.mocked(hosts.createDefaultTerminalHostRegistry).mockImplementation(() => actual.createDefaultTerminalHostRegistry({ zellijBinary: null }));
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      const spawnSession = await waitForSpawnSessionRegistration();
      const result = await spawnSession({
        directory: fixtureHome, backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        terminal: { mode: 'herdr', herdr: { sessionName: 'default' } }, token: 't',
      });
      expect(result).toMatchObject({ errorMessage: expect.stringContaining('hosting requires a supported') });
      expect(result).toMatchObject({
        type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorDetail: { kind: 'terminal_host_unavailable', host: 'herdr', reason: 'installation_unavailable' },
      });
      expect(herdrSpawnCapture.createPane).not.toHaveBeenCalled();
    } finally {
      if (run) { harness.requestShutdown('happier-cli'); await run; }
      if (previousInventory) vi.mocked(hosts.createDefaultTerminalHostRegistry).mockImplementation(previousInventory);
      if (previousRuntime) vi.mocked(runtime.resolveHerdrRuntimeBinary).mockImplementation(previousRuntime);
      if (previousRefresh === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = previousRefresh;
      if (previousHerdr === undefined) delete process.env.HERDR_BIN_PATH;
      else process.env.HERDR_BIN_PATH = previousHerdr;
      await restoreDaemonExitBoundary(exitSpy);
      await rm(fixtureHome, { recursive: true, force: true });
    }
  });

  it('launches an app-created Codex App Server controller with an optional local Herdr client', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const previousRefresh = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;
    try {
      const catalog = await import('@/backends/catalog');
      const { codexDaemonSpawnHooks } = await import('@/backends/codex/daemon/spawnHooks');
      const { buildHappyCliSubprocessLaunchSpec } = await import('@/utils/spawnHappyCLI');
      vi.mocked(catalog.requireCatalogEntry).mockImplementation(() => ({
        id: 'codex',
        cliSubcommand: 'codex',
        vendorResumeSupport: 'supported',
        getDaemonSpawnHooks: async () => ({
          ...codexDaemonSpawnHooks,
          validateSpawn: async () => ({ ok: true as const }),
        }),
      }));
      vi.mocked(buildHappyCliSubprocessLaunchSpec).mockImplementation((args) => ({
        runtime: 'node',
        filePath: '/test/admitted-happier',
        args: [...args],
      }));
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      const spawnSession = await waitForSpawnSessionRegistration();
      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        codexBackendMode: 'appServer',
        terminal: { mode: 'herdr', herdr: { sessionName: 'default' } },
        token: 't',
      });

      if (result.type !== 'success') throw new Error(JSON.stringify(result));
      expect(result).toMatchObject({ type: 'success' });
      const [argv, options] = spawnHappyCLI.mock.calls[0];
      expect(argv).toEqual(expect.arrayContaining([
          'codex',
          '--happy-starting-mode', 'local',
          '--happy-terminal-mode', 'plain',
          '--happy-terminal-requested', 'herdr',
          '--happy-herdr-session-name', 'default',
          '--happy-herdr-socket-path', expect.any(String),
        ]));
      expect(options).toMatchObject({ env: { HAPPIER_CODEX_BACKEND_MODE: 'appServer' } });
      expect(herdrSpawnCapture.createPane).not.toHaveBeenCalled();
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const catalog = await import('@/backends/catalog');
      vi.mocked(catalog.requireCatalogEntry).mockImplementation(() => ({
        id: 'codex', cliSubcommand: 'codex', vendorResumeSupport: 'supported',
      }));
      const { buildHappyCliSubprocessLaunchSpec } = await import('@/utils/spawnHappyCLI');
      vi.mocked(buildHappyCliSubprocessLaunchSpec).mockReset();
      if (previousRefresh === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = previousRefresh;
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it('launches an app-created Codex App Server controller with an optional local Zellij client', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const previousRefresh = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;
    try {
      const catalog = await import('@/backends/catalog');
      const { codexDaemonSpawnHooks } = await import('@/backends/codex/daemon/spawnHooks');
      const { buildHappyCliSubprocessLaunchSpec } = await import('@/utils/spawnHappyCLI');
      vi.mocked(catalog.requireCatalogEntry).mockImplementation(() => ({
        id: 'codex',
        cliSubcommand: 'codex',
        vendorResumeSupport: 'supported',
        getDaemonSpawnHooks: async () => ({
          ...codexDaemonSpawnHooks,
          validateSpawn: async () => ({ ok: true as const }),
        }),
      }));
      vi.mocked(buildHappyCliSubprocessLaunchSpec).mockImplementation((args) => ({
        runtime: 'node',
        filePath: '/test/admitted-happier',
        args: [...args],
      }));
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      const spawnSession = await waitForSpawnSessionRegistration();
      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        codexBackendMode: 'appServer',
        terminal: { mode: 'zellij' },
        token: 't',
      });

      if (result.type !== 'success') throw new Error(JSON.stringify(result));
      const [argv, options] = spawnHappyCLI.mock.calls[0];
      expect(argv).toEqual(expect.arrayContaining([
        'codex', '--happy-starting-mode', 'local',
        '--happy-terminal-mode', 'plain', '--happy-terminal-requested', 'zellij',
      ]));
      expect(options).toMatchObject({ env: { HAPPIER_CODEX_BACKEND_MODE: 'appServer' } });
      expect(zellijSpawnCapture.createOrAttachHost).not.toHaveBeenCalled();
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const catalog = await import('@/backends/catalog');
      vi.mocked(catalog.requireCatalogEntry).mockImplementation(() => ({
        id: 'codex', cliSubcommand: 'codex', vendorResumeSupport: 'supported',
      }));
      const { buildHappyCliSubprocessLaunchSpec } = await import('@/utils/spawnHappyCLI');
      vi.mocked(buildHappyCliSubprocessLaunchSpec).mockReset();
      if (previousRefresh === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = previousRefresh;
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it('launches app-created unified Claude in one daemon-owned Herdr pane', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const previousRefresh = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;
    try {
      const catalog = await import('@/backends/catalog');
      const { claudeDaemonSpawnHooks } = await import('@/backends/claude/daemon/spawnHooks');
      const { buildHappyCliSubprocessLaunchSpec } = await import('@/utils/spawnHappyCLI');
      vi.mocked(buildHappyCliSubprocessLaunchSpec).mockImplementation((args) => ({
        runtime: 'node',
        filePath: '/test/admitted-happier',
        args: [...args],
      }));
      vi.mocked(catalog.requireCatalogEntry).mockImplementation(() => ({
        id: 'claude',
        cliSubcommand: 'claude',
        vendorResumeSupport: 'supported',
        getDaemonSpawnHooks: async () => ({
          ...claudeDaemonSpawnHooks,
          validateSpawn: async () => ({ ok: true as const }),
        }),
      }));
      vi.mocked(catalog.resolveCatalogAgentId).mockReturnValue('claude');
      vi.mocked(catalog.resolveAgentCliSubcommand).mockReturnValue('claude');
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      const spawnSession = await waitForSpawnSessionRegistration();
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settingsVersion: 1,
        loadedAtMs: Date.now(),
        settingsSecretsReadKeys: [],
        settings: accountSettingsParse({ claudeUnifiedTerminalEnabled: true }),
      });
      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        terminal: { mode: 'herdr', herdr: { sessionName: 'default' } },
        token: 't',
      });

      if (result.type !== 'success') throw new Error(JSON.stringify(result));
      expect(result).toMatchObject({ type: 'success' });
      expect(herdrSpawnCapture.createPane).toHaveBeenCalledWith(expect.objectContaining({
        argv: expect.arrayContaining([
          'claude',
          '--happy-starting-mode', 'local',
          '--happy-terminal-mode', 'herdr',
          '--happy-terminal-requested', 'herdr',
          '--happy-herdr-session-name', 'default',
          '--happy-terminal-attachment-id',
        ]),
        env: expect.objectContaining({ HAPPIER_CLAUDE_UNIFIED_TERMINAL_PIN: '1' }),
      }));
      expect(spawnHappyCLI).not.toHaveBeenCalled();
    } finally {
      if (run) {
        harness.requestShutdown('happier-cli');
        await run;
      }
      const catalog = await import('@/backends/catalog');
      vi.mocked(catalog.requireCatalogEntry).mockImplementation(() => ({
        id: 'codex', cliSubcommand: 'codex', vendorResumeSupport: 'supported',
      }));
      vi.mocked(catalog.resolveCatalogAgentId).mockReturnValue('codex');
      vi.mocked(catalog.resolveAgentCliSubcommand).mockReturnValue('codex');
      const { buildHappyCliSubprocessLaunchSpec } = await import('@/utils/spawnHappyCLI');
      vi.mocked(buildHappyCliSubprocessLaunchSpec).mockReset();
      if (previousRefresh === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = previousRefresh;
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
    vi.mocked(waitForSessionWebhook).mockImplementationOnce((params) => completeReportedSession(params, 'sess_claude_repair'));

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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it.each(['background-service', 'self-restart'] as const)('spawns regular linux %s runners through a pre-exec cgroup self-migration wrapper before provider children start', async (startupSource) => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
    process.env.HAPPIER_DAEMON_STARTUP_SOURCE = startupSource;
    if (startupSource === 'self-restart') {
      process.env.HAPPIER_DAEMON_SELF_RESTART_CORRELATION_ID = 'spawn-resume-cgroup-wrapper';
      process.env.HAPPIER_DAEMON_SELF_RESTART_DEADLINE_MS = String(Date.now() + 60_000);
    }

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
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it('wraps manual Linux daemon session spawns for cgroup self-migration and adjusts their OOM score', async () => {
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

      expect(spawnHappyCLI).not.toHaveBeenCalled();
      expect(buildCgroupSelfMigratingHappyCliLaunchSpec).toHaveBeenCalledTimes(1);
      expect(spawnChildProcess).toHaveBeenCalledTimes(1);
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
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it.each(['background-service', 'self-restart'] as const)('migrates reattached linux %s session runners out of the daemon service cgroup during startup', async (startupSource) => {
    if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
    process.env.HAPPIER_DAEMON_STARTUP_SOURCE = startupSource;
    if (startupSource === 'self-restart') {
      process.env.HAPPIER_DAEMON_SELF_RESTART_CORRELATION_ID = 'spawn-resume-cgroup-reattach';
      process.env.HAPPIER_DAEMON_SELF_RESTART_DEADLINE_MS = String(Date.now() + 60_000);
    }

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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it('observes an already-missing tracked runner before stop attempts signaling', async () => {
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
      const actualStopSessionModule = await vi.importActual<typeof import('./sessions/stopSession')>('./sessions/stopSession');
      vi.mocked(stopSessionModule.createStopSession).mockImplementation((params) => {
        loadTerminalHostAdapters = params.loadTerminalHostAdapters;
        return actualStopSessionModule.createStopSession({
          ...params,
          readAttachmentState: async () => ({ status: 'absent' }),
        });
      });
      const killSpy = vi.spyOn(process, 'kill');

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

      expect(waitForExitSpy).not.toHaveBeenCalled();
      expect(onChildExitedSpy).toHaveBeenCalledWith(6480, {
        reason: 'process-missing',
        code: null,
        signal: null,
      });
      expect(killSpy).not.toHaveBeenCalledWith(6480, 'SIGTERM');
      expect(killSpy).not.toHaveBeenCalledWith(-6480, 'SIGTERM');
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
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it.each(['released', 'replaced', 'owned_dead', 'owned_alive', 'owned_replaced', 'owned_concurrent'] as const)('projects exact startup-reattached terminal custody after its descriptor is %s', async (descriptorCase) => {
    const owned = descriptorCase.startsWith('owned_');
    const { configuration } = await import('@/configuration');
    const originalHome = configuration.happyHomeDir;
    const fixtureHome = await mkdtemp(join(tmpdir(), 'happier-reattached-borrowed-'));
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    Object.defineProperty(configuration, 'happyHomeDir', { value: fixtureHome });
    const pid = 2_147_482_911;
    const sessionId = 'sess-reattached-borrowed';
    const attachmentId = 'attachment-reattached-borrowed';
    const terminal = {
      mode: 'herdr' as const,
      herdr: { sessionName: 'default', socketPath: '/tmp/herdr.sock', terminalId: 'user-terminal' },
      controlServiceabilityV1: { v: 1 as const, attachmentId, state: 'servable' as const, observedAt: 1 },
    };
    const metadata = {
      path: '/tmp/project', host: 'test-host', homeDir: '/tmp/home', happyHomeDir: fixtureHome,
      happyLibDir: '/tmp/lib', happyToolsDir: '/tmp/tools', terminal,
    };
    let serverMetadata: Record<string, unknown> = metadata;
    let metadataVersion = 1;
    const secondSessionId = `${sessionId}-second`;
    const secondAttachmentId = `${attachmentId}-second`;
    const secondTerminal = { ...terminal,
      herdr: { ...terminal.herdr, terminalId: 'second-terminal' },
      controlServiceabilityV1: { ...terminal.controlServiceabilityV1, attachmentId: secondAttachmentId } };
    const secondServer = { metadata: { ...metadata, terminal: secondTerminal } as Record<string, unknown>, version: 1 };
    const markers = await vi.importActual<typeof import('./sessionRegistry')>('./sessionRegistry');
    const attachments = await vi.importActual<typeof import('@/terminal/attachment/terminalAttachmentInfo')>('@/terminal/attachment/terminalAttachmentInfo');
    const { buildTerminalHostHandleFromAttachmentMetadata } = await import('@/agent/runtime/terminal/attachmentMetadata');
    const reattach = await import('./sessions/reattachFromMarkers');
    const exits = await import('./sessions/onChildExited');
    const updates = await import('@/session/metadata/updateSessionMetadataWithRetry');
    const doctor = await import('./doctor');
    const sockets = await import('@/api/session/sockets');
    const supervision = await import('./sessions/disconnectedTerminalHostSupervision');
    const actualSupervision = await vi.importActual<typeof supervision>('./sessions/disconnectedTerminalHostSupervision');
    const hosts = await import('@/integrations/terminalHost/defaultRegistry');
    const terminalHostRegistry = await hosts.createDefaultTerminalHostRegistry();
    const hostAdapter = terminalHostRegistry.herdr!;
    vi.spyOn(hosts, 'createDefaultTerminalHostRegistry').mockResolvedValue(terminalHostRegistry);
    // This adapter is the terminal-host OS boundary; liveness/retirement policy stays real.
    let resolveProbeStarted!: () => void;
    let releaseProbe!: () => void;
    const probeStarted = new Promise<void>((resolve) => { resolveProbeStarted = resolve; });
    const probeReleased = new Promise<void>((resolve) => { releaseProbe = resolve; });
    let secondExitStarted = false;
    let resolveSecondExitRead!: () => void;
    const secondExitRead = new Promise<void>((resolve) => { resolveSecondExitRead = resolve; });
    vi.spyOn(hostAdapter, 'evaluateLiveness').mockImplementation(async (handle) => {
      if (descriptorCase === 'owned_concurrent' && handle.terminalId === terminal.herdr.terminalId) {
        resolveProbeStarted();
        await probeReleased;
      }
      return { paneAlive: descriptorCase === 'owned_alive', observedAt: 2 };
    });
    vi.mocked(supervision.superviseDisconnectedTerminalHostCandidate).mockImplementation(actualSupervision.superviseDisconnectedTerminalHostCandidate);
    let exitHandler: ReturnType<typeof exits.createOnChildExited> | undefined;
    let resolveExitReady!: () => void;
    const exitReady = new Promise<void>((resolve) => { resolveExitReady = resolve; });
    let trackedSessions: Map<number, import('./types').TrackedSession> | undefined;
    let run: Promise<void> | null = null;
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const originalKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation(((targetPid, signal) => {
      if ((targetPid === pid || targetPid === pid + 1) && signal === 0) return true;
      return originalKill(targetPid, signal);
    }) as typeof process.kill);
    vi.spyOn(doctor, 'findAllHappyProcesses').mockResolvedValue([
      { pid, command: 'happier claude', type: 'user-session' },
      ...(descriptorCase === 'owned_concurrent' ? [{ pid: pid + 1, command: 'happier claude', type: 'user-session' }] : []),
    ]);
    vi.mocked(reattach.reattachTrackedSessionsFromMarkers).mockImplementation(actualReattachmentOwner.reattachTrackedSessionsFromMarkers);
    vi.mocked(exits.createOnChildExited).mockImplementation((params) => {
      trackedSessions = params.pidToTrackedSession;
      exitHandler = actualChildExitOwner.createOnChildExited(params);
      resolveExitReady();
      return exitHandler;
    });
    sessionRegistryCapture.removeSessionMarker.mockImplementation(markers.removeSessionMarker);
    claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockImplementation(async (params) => {
      const attachment = await attachments.readTerminalAttachmentInfo({ ...params, happyHomeDir: fixtureHome });
      if (secondExitStarted && params.sessionId === secondSessionId) resolveSecondExitRead();
      return attachment;
    });
    claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockImplementation(async (params) =>
      await attachments.removeTerminalAttachmentInfo({ ...params, happyHomeDir: fixtureHome }));
    vi.mocked(updates.updateSessionMetadataWithRetry).mockImplementation(actualMetadataUpdateOwner.updateSessionMetadataWithRetry);
    vi.mocked(fetchSessionByIdCompat).mockImplementation(async (params) => createSessionRecordFixture({
      id: params.sessionId, encryptionMode: 'plain',
      metadata: JSON.stringify(params.sessionId === secondSessionId ? secondServer.metadata : serverMetadata),
      metadataVersion: params.sessionId === secondSessionId ? secondServer.version : metadataVersion, dataEncryptionKey: null,
    }));
    // Socket.io is the server boundary; metadata decoding, update CAS, and retirement stay real.
    vi.spyOn(sockets, 'createSessionScopedSocket').mockImplementation((params) => {
      const events = new EventEmitter();
      return {
        connected: true,
        on: events.on.bind(events), off: events.off.bind(events),
        connect: () => events.emit('connect'), disconnect: () => {}, close: () => {},
        emit: (_event: string, payload: { expectedVersion: number; metadata: string }, ack: (answer: unknown) => void) => {
          if (params.sessionId === secondSessionId) {
            expect(payload.expectedVersion).toBe(secondServer.version);
            secondServer.metadata = JSON.parse(payload.metadata) as Record<string, unknown>;
            secondServer.version += 1;
          } else {
            expect(payload.expectedVersion).toBe(metadataVersion);
            serverMetadata = JSON.parse(payload.metadata) as Record<string, unknown>;
            metadataVersion += 1;
          }
          ack({ result: 'success', version: params.sessionId === secondSessionId ? secondServer.version : metadataVersion, metadata: payload.metadata });
        },
      } as unknown as ReturnType<typeof sockets.createSessionScopedSocket>;
    });
    try {
      await markers.writeSessionMarker({ pid, happySessionId: sessionId, startedBy: 'terminal',
        processCommandHash: markers.hashProcessCommand('happier claude'), metadata });
      await attachments.writeTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId, attachmentId,
        lifecycle: owned ? 'owned' : 'borrowed', terminal, handle: buildTerminalHostHandleFromAttachmentMetadata(terminal)! });
      if (descriptorCase === 'owned_concurrent') {
        await markers.writeSessionMarker({ pid: pid + 1, happySessionId: secondSessionId, startedBy: 'terminal',
          processCommandHash: markers.hashProcessCommand('happier claude'), metadata: secondServer.metadata });
        await attachments.writeTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId: secondSessionId,
          attachmentId: secondAttachmentId, lifecycle: 'owned', terminal: secondTerminal,
          handle: buildTerminalHostHandleFromAttachmentMetadata(secondTerminal)! });
      }
      run = daemonStartupOwner.startDaemon();
      await exitReady;
      expect(trackedSessions?.get(pid)?.reattachedFromDiskMarker).toBe(true);
      if (!owned) await attachments.removeTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId, expectedAttachmentId: attachmentId });
      const replacementTerminal = { ...terminal,
        controlServiceabilityV1: { ...terminal.controlServiceabilityV1, attachmentId: 'attachment-replacement', observedAt: 2 } };
      if (descriptorCase === 'replaced' || descriptorCase === 'owned_replaced') {
        await attachments.writeTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId, attachmentId: 'attachment-replacement',
          lifecycle: descriptorCase === 'owned_replaced' ? 'owned' : 'borrowed', terminal: replacementTerminal,
          handle: buildTerminalHostHandleFromAttachmentMetadata(replacementTerminal)! });
        serverMetadata = { ...metadata, terminal: replacementTerminal };
      }
      const replacement = await attachments.readTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId });
      const firstExit = exitHandler!(pid, { reason: 'process-exited', code: 0, signal: null });
      if (descriptorCase === 'owned_concurrent') {
        await probeStarted;
        secondExitStarted = true;
        const secondExit = exitHandler!(pid + 1, { reason: 'process-exited', code: 0, signal: null });
        await secondExitRead;
        // Let the descriptor-read continuation register its candidate while the first OS probe is held.
        await new Promise<void>((resolve) => setImmediate(resolve));
        releaseProbe();
        await Promise.all([firstExit, secondExit]);
        expect(secondServer.metadata).toMatchObject({ terminal: { controlServiceabilityV1: {
          attachmentId: secondAttachmentId, retired: true, state: 'unknown', reason: 'attachment_retired',
        } } });
      }
      await firstExit;
      if (descriptorCase === 'released' || descriptorCase === 'owned_dead' || descriptorCase === 'owned_concurrent') {
        expect(serverMetadata).toMatchObject({ terminal: { controlServiceabilityV1: {
          attachmentId, retired: true, state: 'unknown', reason: 'attachment_retired',
        } } });
      } else if (descriptorCase === 'owned_alive') {
        expect(serverMetadata).toMatchObject({ terminal: { controlServiceabilityV1: {
          attachmentId, state: 'recoverable_unservable',
        } } });
      } else {
        expect(serverMetadata).toEqual({ ...metadata, terminal: replacementTerminal });
      }
      if (!owned || descriptorCase === 'owned_dead' || descriptorCase === 'owned_concurrent') expect(await markers.listSessionMarkers()).toEqual([]);
      expect(await attachments.readTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId }))
        .toEqual(descriptorCase === 'owned_dead' || descriptorCase === 'owned_concurrent' ? null : replacement);
      expect(trackedSessions?.has(pid)).toBe(false);
      expect(herdrSpawnCapture.closePane).not.toHaveBeenCalled();
      expect(claudeEndpointRecoveryBoundaryMocks.dispose).not.toHaveBeenCalled();
    } finally {
      releaseProbe();
      if (run) { harness.requestShutdown('happier-cli'); await run; }
      Object.defineProperty(configuration, 'happyHomeDir', { value: originalHome });
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      vi.mocked(reattach.reattachTrackedSessionsFromMarkers).mockReset();
      vi.mocked(reattach.reattachTrackedSessionsFromMarkers).mockResolvedValue({ orphanedDeadDaemonSessions: [], connectedServiceRestartIntents: [] });
      vi.mocked(exits.createOnChildExited).mockReset();
      vi.mocked(exits.createOnChildExited).mockImplementation(() => vi.fn());
      sessionRegistryCapture.removeSessionMarker.mockReset();
      sessionRegistryCapture.removeSessionMarker.mockResolvedValue(undefined);
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockReset();
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockResolvedValue(null);
      claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockReset();
      claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockResolvedValue(false);
      vi.mocked(supervision.superviseDisconnectedTerminalHostCandidate).mockReset();
      vi.mocked(supervision.superviseDisconnectedTerminalHostCandidate).mockResolvedValue({ state: 'recoverable_unservable', reason: 'control_descriptor_missing' });
      await rm(fixtureHome, { recursive: true, force: true });
    }
  });

  it('preserves an exact terminal-host exit marker and routes later Stop through disconnected-host retirement', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    let run: Promise<void> | null = null;
    const catalog = await import('@/backends/catalog');
    const actualCatalog = await vi.importActual<typeof import('@/backends/catalog')>('@/backends/catalog');
    const previousCatalog = vi.mocked(catalog.requireCatalogEntry).getMockImplementation();
    vi.mocked(catalog.requireCatalogEntry).mockImplementation(actualCatalog.requireCatalogEntry);

    try {
      harness.resetControlRefs();

      const onChildExitedModule = await import('./sessions/onChildExited');
      const captured = {
        shouldPreserveSessionMarkerOnExit: null as null | ((input: Readonly<{
          pid: number;
          trackedSession: unknown;
          exit: { reason: string; code: number | null; signal: string | null };
        }>) => boolean | Promise<boolean>),
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
      expect(await shouldPreserveSessionMarkerOnExit({
        pid: eligible.pid,
        trackedSession: eligible as any,
        exit,
      })).toBe(false);
      expect(await shouldPreserveSessionMarkerOnExit({
        pid: terminalOwned.pid,
        trackedSession: terminalOwned as any,
        exit,
      })).toBe(true);
      expect(await shouldPreserveSessionMarkerOnExit({
        pid: missingResume.pid,
        trackedSession: missingResume as any,
        exit,
      })).toBe(false);

      // The native client was detached earlier; its historical webhook is not
      // current custody and must not preserve a normally exited controller.
      const optionalPresentation = {
        ...terminalOwned,
        pid: 7515,
        happySessionId: 'sess-detached-opencode',
        spawnOptions: {
          directory: '/tmp/workspace-opencode',
          backendTarget: { kind: 'builtInAgent' as const, agentId: 'opencode' as const },
          terminal: { mode: 'zellij' as const },
        },
      };
      expect(await shouldPreserveSessionMarkerOnExit({
        pid: optionalPresentation.pid,
        trackedSession: optionalPresentation,
        exit: { reason: 'process-exited', code: 0, signal: null },
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

      const borrowedAttachmentId = 'attachment-terminal-borrowed';
      const terminalBorrowed = {
        ...terminalOwned,
        pid: 7514,
        happySessionId: 'sess-terminal-borrowed',
        happySessionMetadataFromLocalWebhook: {
          path: '/tmp/workspace-claude',
          terminal: {
            mode: 'herdr' as const,
            herdr: {
              sessionName: 'default',
              socketPath: '/tmp/herdr.sock',
              terminalId: 'terminal_borrowed',
            },
          },
        },
        publishedTerminalControlServiceabilityAttachmentId: borrowedAttachmentId,
        publishedTerminalControlServiceabilityAttachmentLifecycle: 'borrowed' as const,
      };
      expect(await shouldPreserveSessionMarkerOnExit({
        pid: terminalBorrowed.pid,
        trackedSession: terminalBorrowed,
        exit,
      })).toBe(false);
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockResolvedValueOnce(null);
      updateSessionMetadataWithRetryMock.mockClear();
      await expect(onFinalTrackedSessionExitStaged({
        pid: terminalBorrowed.pid,
        trackedSession: terminalBorrowed,
        exit,
        observedAt: 4,
      })).resolves.toBeUndefined();
      expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledOnce();

      const replacementHome = await mkdtemp(join(tmpdir(), 'happier-borrowed-replacement-'));
      const attachments = await vi.importActual<typeof import('@/terminal/attachment/terminalAttachmentInfo')>(
        '@/terminal/attachment/terminalAttachmentInfo',
      );
      const { buildTerminalHostHandleFromAttachmentMetadata } = await import('@/agent/runtime/terminal/attachmentMetadata');
      try {
        const replacementTerminal = {
          mode: 'herdr' as const,
          herdr: {
            sessionName: 'default',
            socketPath: '/tmp/herdr.sock',
            terminalId: 'terminal_replacement',
            paneId: 'replacement-pane',
          },
        };
        await attachments.writeTerminalAttachmentInfo({
          happyHomeDir: replacementHome,
          sessionId: terminalBorrowed.happySessionId,
          attachmentId: 'attachment-terminal-borrowed-replacement',
          lifecycle: 'borrowed',
          handle: buildTerminalHostHandleFromAttachmentMetadata(replacementTerminal)!,
          terminal: replacementTerminal,
        });
        const replacement = await attachments.readTerminalAttachmentInfo({
          happyHomeDir: replacementHome,
          sessionId: terminalBorrowed.happySessionId,
        });
        expect(replacement?.version).toBe(3);
        // Redirect only the filesystem boundary to this isolated fixture; retain
        // the real attachment parser, identity checks, and retirement operation.
        claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockImplementation(async () =>
          await attachments.readTerminalAttachmentInfo({
            happyHomeDir: replacementHome,
            sessionId: terminalBorrowed.happySessionId,
          }));
        claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockImplementation(async (params) =>
          await attachments.removeTerminalAttachmentInfo({ ...params, happyHomeDir: replacementHome }));
        await onFinalTrackedSessionExitStaged({
          pid: terminalBorrowed.pid,
          trackedSession: terminalBorrowed,
          exit,
          observedAt: 5,
        });
        expect(await attachments.readTerminalAttachmentInfo({
          happyHomeDir: replacementHome,
          sessionId: terminalBorrowed.happySessionId,
        })).toEqual(replacement);
      } finally {
        await rm(replacementHome, { recursive: true, force: true });
        claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockReset();
        claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockResolvedValue(false);
      }

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
      await restoreDaemonExitBoundary(exitSpy);
      vi.mocked(catalog.requireCatalogEntry).mockReset();
      if (previousCatalog) vi.mocked(catalog.requireCatalogEntry).mockImplementation(previousCatalog);
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
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it('spawns an existing session without re-fetching it when a pre-resolved attach payload is supplied', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    vi.mocked(waitForSessionWebhook).mockImplementationOnce((params) => completeReportedSession(params, 'sess-pre-resolved-1'));
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
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it('refreshes persisted runtime state before status reads and already-running resume requests', async () => {
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
        current: Map<number, import('./types').TrackedSession> | null;
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
        pid: 12345,
        startedBy: 'daemon',
        happySessionId: 'sess_already_running',
        processCommandHash: 'hash-stale-runner',
        processCommand:
          'node /tmp/happier/versions/0.2.10/package-dist/index.mjs codex --happy-starting-mode remote --started-by daemon',
        spawnOptions: {
          directory: '/tmp',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          permissionMode: 'default',
          permissionModeUpdatedAt: 100,
          agentModeId: 'chat',
          agentModeUpdatedAt: 101,
          modelId: 'gpt-4.1',
          modelUpdatedAt: 102,
          connectedServices: { v: 1, bindingsByServiceId: {} },
          connectedServicesUpdatedAt: 103,
        },
      });

      const sessionRunnerStatusHandler = harness.getSessionRunnerStatusHandler();
      if (!sessionRunnerStatusHandler) {
        throw new Error('Expected session runner status handler to be registered');
      }
      const runtimeStatus = await sessionRunnerStatusHandler({
        sessionId: 'sess_already_running',
      });
      expect(runtimeStatus.plannedRestart.disabledReason).not.toBe('missing_resume_identity');
      expect(trackedSessionCapture.current.get(12345)?.vendorResumeId).toBe('vendor-codex-fresh');

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
        spawnNonce: 'adopt-ready-existing-runner',
        executionAuthorization: { provenance: 'user_request', requestId: 'message-42' },
      }, { onBeforeRunnerLaunchAccepted: vi.fn(async () => { throw new Error('must not claim adopted runner'); }) });

      expect(result).toEqual({
        type: 'success',
        sessionId: 'sess_already_running',
        runnerAcceptance: 'preexisting_or_adopted',
      });
      expect(await harness.getResolveSpawnSessionByNonce()!('adopt-ready-existing-runner'))
        .toEqual({ status: 'success', sessionId: 'sess_already_running' });
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it('destroys an exact unusable preserved Claude host and launches fresh in the same Resume attempt', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    const { configuration } = await import('@/configuration');
    const originalHome = configuration.happyHomeDir;
    const fixtureHome = await mkdtemp(join(tmpdir(), 'happier-endpoint-retirement-'));
    Object.defineProperty(configuration, 'happyHomeDir', { value: fixtureHome });
    const attachments = await vi.importActual<typeof import('@/terminal/attachment/terminalAttachmentInfo')>('@/terminal/attachment/terminalAttachmentInfo');
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
    let run: Promise<void> | null = null;

    try {
      vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(createSessionRecordFixture({
        id: sessionId,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ flavor: 'claude', claudeSessionId: 'vendor-exact-unusable', path: '/tmp' }),
        dataEncryptionKey: null,
      }));
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockReset();
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockImplementation(attachments.readTerminalAttachmentInfo);
      claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockReset();
      claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockImplementation(attachments.removeTerminalAttachmentInfo);
      await attachments.writeTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId, attachmentId,
        handle, terminal: attachmentInfo.terminal });
      claudeEndpointRecoveryBoundaryMocks.readClaudeEndpointDescriptor.mockReset();
      claudeEndpointRecoveryBoundaryMocks.readClaudeEndpointDescriptor.mockResolvedValue(endpointState);
      claudeEndpointRecoveryBoundaryMocks.evaluateLiveness.mockReset();
      claudeEndpointRecoveryBoundaryMocks.evaluateLiveness.mockResolvedValue({ paneAlive: true, observedAt: 1 });
      claudeEndpointRecoveryBoundaryMocks.dispose.mockClear();

      const hosts = await import('@/integrations/terminalHost/defaultRegistry');
      const adapters = await hosts.createDefaultTerminalHostRegistry();
      // Configure the consumed OS adapter, not an unconsumed fixture-side liveness projection.
      vi.spyOn(adapters.zellij!, 'evaluateLiveness').mockImplementation(claudeEndpointRecoveryBoundaryMocks.evaluateLiveness);
      vi.spyOn(adapters.zellij!, 'dispose').mockImplementation(claudeEndpointRecoveryBoundaryMocks.dispose);
      vi.spyOn(hosts, 'createDefaultTerminalHostRegistry').mockResolvedValue(adapters);

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
      Object.defineProperty(configuration, 'happyHomeDir', { value: originalHome });
      await rm(fixtureHome, { recursive: true, force: true });
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it('clears inherited Claude endpoint recovery proof before a fresh launch after exact positive death', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    const endpointStateEnvOriginal = process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY];
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    const { configuration } = await import('@/configuration');
    const originalHome = configuration.happyHomeDir;
    const fixtureHome = await mkdtemp(join(tmpdir(), 'happier-dead-endpoint-retirement-'));
    Object.defineProperty(configuration, 'happyHomeDir', { value: fixtureHome });
    const attachments = await vi.importActual<typeof import('@/terminal/attachment/terminalAttachmentInfo')>('@/terminal/attachment/terminalAttachmentInfo');
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
      const attachmentInfo: TerminalAttachmentInfo = {
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
      };
      await attachments.writeTerminalAttachmentInfo({ happyHomeDir: fixtureHome, sessionId, attachmentId,
        handle: attachmentInfo.handle, terminal: attachmentInfo.terminal });
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockImplementation(attachments.readTerminalAttachmentInfo);
      claudeEndpointRecoveryBoundaryMocks.evaluateLiveness.mockResolvedValue({
        paneAlive: false,
        paneDead: true,
        observedAt: 1,
      });
      claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockImplementation(attachments.removeTerminalAttachmentInfo);

      const hosts = await import('@/integrations/terminalHost/defaultRegistry');
      const adapters = await hosts.createDefaultTerminalHostRegistry();
      // Exact death/disposal is observed through the host OS boundary used by recovery.
      vi.spyOn(adapters.zellij!, 'evaluateLiveness').mockImplementation(claudeEndpointRecoveryBoundaryMocks.evaluateLiveness);
      vi.spyOn(adapters.zellij!, 'dispose').mockImplementation(claudeEndpointRecoveryBoundaryMocks.dispose);
      vi.spyOn(hosts, 'createDefaultTerminalHostRegistry').mockResolvedValue(adapters);

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
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockReset();
      claudeEndpointRecoveryBoundaryMocks.readTerminalAttachmentInfo.mockResolvedValue(null);
      claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockReset();
      claudeEndpointRecoveryBoundaryMocks.removeTerminalAttachmentInfo.mockResolvedValue(false);
      claudeEndpointRecoveryBoundaryMocks.evaluateLiveness.mockReset();
      claudeEndpointRecoveryBoundaryMocks.evaluateLiveness.mockResolvedValue({ paneAlive: true, observedAt: 1 });
      Object.defineProperty(configuration, 'happyHomeDir', { value: originalHome });
      await rm(fixtureHome, { recursive: true, force: true });
      await restoreDaemonExitBoundary(exitSpy);
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
          controlDescriptorStatus: 'available',
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
      await restoreDaemonExitBoundary(exitSpy);
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
          controlDescriptorStatus: 'missing',
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
        errorMessage: expect.any(String),
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
      await restoreDaemonExitBoundary(exitSpy);
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
          controlDescriptorStatus: 'missing',
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
      await restoreDaemonExitBoundary(exitSpy);
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
      updateSessionMetadataWithRetryMock.mockImplementation(async (params) => ({
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
      const persistedMetadataCandidates = updateSessionMetadataWithRetryMock.mock.calls
        .filter(([call]) => (call as { sessionId?: string }).sessionId === sessionId)
        .map(([call]) => call.updater({ sessionUsageLimitRecoveryV1: recovery }));
      expect(persistedMetadataCandidates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sessionUsageLimitRecoveryV1: expect.objectContaining({
            issueFingerprint: recovery.issueFingerprint,
            armedAtMs: recovery.armedAtMs,
            status: 'cancelled',
            nextCheckAtMs: null,
          }),
        }),
      ]));

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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
          controlDescriptorStatus: 'missing',
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it('waits for an unresponsive predecessor to exit before spawning the explicit resume successor', async () => {
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
          pid: number;
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
        pid: 12345,
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

      expect(result).toMatchObject({ type: 'success' });
      expect(vi.mocked(callSessionRpc).mock.calls[0]?.[0]).toEqual(expect.objectContaining({
        method: 'sess_stale_runner:session.pendingQueue.wakeCapability.v1.get',
      }));
      // The daemon never overlaps runners: it only replaces the predecessor after process
      // inspection proves that the unresponsive runner exited.
      expect(stopSessionMocks.stopSession).not.toHaveBeenCalled();
      expect(spawnHappyCLI).toHaveBeenCalledOnce();
      expect(sessionRunnerActivityBoundaryMocks.readProcessRunState.mock.calls
        .filter(([pid]) => pid === 12345)).toHaveLength(2);

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
      await restoreDaemonExitBoundary(exitSpy);
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
    vi.mocked(waitForSessionWebhook).mockImplementationOnce((params) => completeReportedSession(params, 'sess_terminating_predecessor'));

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
      await restoreDaemonExitBoundary(exitSpy);
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
    vi.mocked(waitForSessionWebhook).mockImplementationOnce((params) => completeReportedSession(params, 'sess_claude_repair'));

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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await vi.waitFor(() => expect(harness.getSpawnSession()).not.toBeNull());
      const spawnSession = harness.getSpawnSession();
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it('waits for webhook proof instead of passing an existing session id shortcut for attach spawns', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    const waitForSessionWebhookMock = vi.mocked(waitForSessionWebhook);
    waitForSessionWebhookMock.mockImplementationOnce(completeReportedSession);

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
      waitForSessionWebhookMock.mockImplementation(completeReportedSession);
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it('derives the exact configured ACP resume identity while attaching an existing session', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(createSessionRecordFixture({
      id: 'sess_plain',
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        flavor: 'acp:custom-kiro',
        acpConfiguredBackendV1: { v: 1, updatedAt: 1, backendId: 'custom-kiro', title: 'Custom Kiro' },
        customAcpSessionId: 'provider-session-1',
        path: '/tmp',
      }),
      dataEncryptionKey: null,
    }));

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const spawnSession = await waitForSpawnSessionRegistration();
      setConfiguredAcpCatalogForTest(true);

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
      expect(argv).toEqual(expect.arrayContaining(['--resume', 'provider-session-1']));

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      spawnHappyCLI.mockClear();
      if (refreshEnvOriginal === undefined) {
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      } else {
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      }
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it('routes an explicit load-capable configured ACP resume through the acp-catalog command', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';

    try {
      const { startDaemon } = await import('./startDaemon');
      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const spawnSession = await waitForSpawnSessionRegistration();
      setConfiguredAcpCatalogForTest(true);

      await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
        resume: 'configured-session-1',
        token: 't',
      });

      const argv = spawnHappyCLI.mock.calls[0]?.[0];
      expect(argv).toEqual(expect.arrayContaining([
        'acp-catalog',
        '--backend', 'custom-kiro',
        '--resume', 'configured-session-1',
      ]));

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      spawnHappyCLI.mockClear();
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it('rejects configured ACP resume when the current catalog declares static load unsupported', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    try {
      const { startDaemon } = await import('./startDaemon');
      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const spawnSession = await waitForSpawnSessionRegistration();
      setConfiguredAcpCatalogForTest(false);

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
        resume: 'configured-session-1',
        token: 't',
      });

      expect(result).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED });
      expect(spawnHappyCLI).not.toHaveBeenCalled();
      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

  it('rejects configured ACP resume when the exact configured target is disabled', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const refreshEnvOriginal = process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
    process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
    try {
      const { startDaemon } = await import('./startDaemon');
      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const spawnSession = await waitForSpawnSessionRegistration();
      setConfiguredAcpCatalogForTest(true, false);

      const result = await spawnSession({
        directory: '/tmp',
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
        resume: 'configured-session-1',
        token: 't',
      });

      expect(result).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED });
      expect(spawnHappyCLI).not.toHaveBeenCalled();
      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (refreshEnvOriginal === undefined) delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
      else process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = refreshEnvOriginal;
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
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
      await restoreDaemonExitBoundary(exitSpy);
    }
  });

});
