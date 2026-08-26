import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import type {
  ConnectedServiceAuthGroupApi,
  ConnectedServiceCredentialApi,
} from '@/api/connectedServices/connectedServiceCredentialApi';
import type { ConnectedServiceCredentialLifecycleDescriptor } from './connectedServices/credentials/lifecycleTypes';
import type { ConnectedServiceRuntimeRegistry as ConnectedServiceRuntimeRegistryType } from './connectedServices/runtimeRegistry/registry';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from './connectedServices/connectedServiceChildEnvironment';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from './connectedServices/accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import type { TrackedSession } from './types';
import { PI_BROKER_SELECTION_IDENTITY_ENV } from '@/backends/pi/brokerExtension';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';
type BuildHappyCliSubprocessLaunchSpec = typeof import('@/utils/spawnHappyCLI').buildHappyCliSubprocessLaunchSpec;
type VerifyClaudeSharedGroupGenerationApplication = NonNullable<
  ConnectedServiceCredentialLifecycleDescriptor['verifyGenerationApplication']
>;
type ApplyClaudeSharedGroupGenerationApplication = NonNullable<
  ConnectedServiceCredentialLifecycleDescriptor['applySharedGenerationApplication']
>;

const automationCredentials = {
  token: 'token-automation',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
};

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

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  attempts: number = 400,
  intervalMs: number = 5,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(message);
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function restoreProcessEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function resetAutomationDaemonTestDefaults(): Promise<void> {
  harness.setMachineSyncClientOverride(null);
  harness.axiosGet.mockReset().mockRejectedValue(new Error('Unexpected HTTP request in daemon automation test'));
  harness.readAccountChangesCursor.mockReset().mockResolvedValue(0);
  harness.writeAccountChangesCursor.mockReset().mockResolvedValue(undefined);
  harness.verifyClaudeSharedGroupGenerationApplication.mockReset().mockResolvedValue({ status: 'unavailable' });
  harness.applyClaudeSharedGroupGenerationApplication.mockReset().mockResolvedValue({ status: 'unavailable' });
  harness.listConnectedServiceAuthGroups.mockReset().mockResolvedValue([]);
  harness.getConnectedServiceAuthGroup.mockReset().mockResolvedValue(null);
  harness.getAccountEncryptionMode.mockReset().mockResolvedValue('plain');
  harness.getConnectedServiceCredentialPlain.mockReset().mockResolvedValue(null);
  harness.getConnectedServiceCredentialSealed.mockReset().mockResolvedValue(null);
  const { ensureMachineRegistered } = await import('@/api/machine/ensureMachineRegistered');
  vi.mocked(ensureMachineRegistered).mockReset();
  vi.mocked(ensureMachineRegistered).mockImplementation(async ({ machineId }: { machineId: string }) => ({
    machineId,
    didRotateMachineId: false,
    machine: createRegisteredMachine(machineId),
  }));

  const { isDaemonRunningCurrentlyInstalledHappyVersion } = await import('./controlClient');
  vi.mocked(isDaemonRunningCurrentlyInstalledHappyVersion).mockReset();
  vi.mocked(isDaemonRunningCurrentlyInstalledHappyVersion).mockResolvedValue(false);

  const { fetchAccountProfile } = await import('@/api/accountProfile');
  vi.mocked(fetchAccountProfile).mockReset();
  // The HTTP boundary fixture only needs the two projection fields consumed by this composition.
  vi.mocked(fetchAccountProfile).mockResolvedValue({
    connectedServicesV2: [],
    connectedServiceCredentialRevisionsV1: [],
  } as unknown as Awaited<ReturnType<typeof fetchAccountProfile>>);

  const { fetchSessionById } = await import('@/session/transport/http/sessionsHttp');
  vi.mocked(fetchSessionById).mockReset().mockResolvedValue(null);
}

const harness = vi.hoisted(() => {
  let resolveShutdown: ((value: { source: ShutdownSource; errorMessage?: string }) => void) | null = null;
  let requestShutdownRef: ((source: ShutdownSource, errorMessage?: string) => void) | null = null;
  let machineConnectionStateListener: ((state: any) => void) | null = null;
  let autoShutdownAfterAutomationStart = true;
  let activeAccountSettingsSnapshot: Record<string, unknown> | null = null;
  let daemonControlServerParams: unknown = null;
  let machineSyncClientOverride: unknown = null;
  const machineUpdateListeners: Array<(update: any) => boolean | void> = [];
  const accountSettingsVersionHintListeners: Array<(hint: { settingsVersion: number | null; source: string }) => void> = [];
  const connectedServicesProjectionChangeListeners: Array<(hint: {
    source: string;
    executionAuthority: 'passive_projection' | 'fresh_user_action' | 'runtime_recovery';
    signal: AbortSignal;
    connectedServicesV2: unknown;
    connectedServiceCredentialRevisionsV1: unknown;
  }) => Promise<void> | void> = [];
  const axiosGet = vi.fn();
  const readAccountChangesCursor = vi.fn(async () => 0);
  const writeAccountChangesCursor = vi.fn(async () => {});
  const verifyClaudeSharedGroupGenerationApplication = vi.fn<VerifyClaudeSharedGroupGenerationApplication>(
    async () => ({ status: 'unavailable' as const }),
  );
  const applyClaudeSharedGroupGenerationApplication = vi.fn<ApplyClaudeSharedGroupGenerationApplication>(
    async () => ({ status: 'unavailable' as const }),
  );

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

  const listConnectedServiceAuthGroups = vi.fn<ConnectedServiceAuthGroupApi['listConnectedServiceAuthGroups']>(async () => []);
  const getConnectedServiceAuthGroup = vi.fn<ConnectedServiceAuthGroupApi['getConnectedServiceAuthGroup']>(async () => null);
  const getAccountEncryptionMode = vi.fn<NonNullable<ConnectedServiceCredentialApi['getAccountEncryptionMode']>>(
    async () => 'plain',
  );
  const getConnectedServiceCredentialPlain = vi.fn<NonNullable<ConnectedServiceCredentialApi['getConnectedServiceCredentialPlain']>>(
    async () => null,
  );
  const getConnectedServiceCredentialSealed = vi.fn<ConnectedServiceCredentialApi['getConnectedServiceCredentialSealed']>(
    async () => null,
  );

  const apiMachine = {
    getActiveRpcHandlerExecutions: vi.fn(() => []),
    recoverDaemonTerminalSessionMutationJournals: vi.fn(async () => {}),
    enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => {}),
    setRPCHandlers: vi.fn(),
    onUpdate: vi.fn((listener: (update: any) => boolean | void) => {
      machineUpdateListeners.push(listener);
      return () => {
        const index = machineUpdateListeners.indexOf(listener);
        if (index >= 0) {
          machineUpdateListeners.splice(index, 1);
        }
      };
    }),
    onAccountSettingsVersionHint: vi.fn((listener: (hint: { settingsVersion: number | null; source: string }) => void) => {
      accountSettingsVersionHintListeners.push(listener);
      return () => {
        const index = accountSettingsVersionHintListeners.indexOf(listener);
        if (index >= 0) {
          accountSettingsVersionHintListeners.splice(index, 1);
        }
      };
    }),
    onPendingSessionActivationHint: vi.fn(() => () => {}),
    onConnectedServicesProjectionChange: vi.fn((listener: typeof connectedServicesProjectionChangeListeners[number]) => {
      connectedServicesProjectionChangeListeners.push(listener);
      return () => {
        const index = connectedServicesProjectionChangeListeners.indexOf(listener);
        if (index >= 0) connectedServicesProjectionChangeListeners.splice(index, 1);
      };
    }),
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
  const machineSyncClient = vi.fn(() => machineSyncClientOverride ?? apiMachine);

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
    machineSyncClient,
    setMachineSyncClientOverride: (client: unknown) => {
      machineSyncClientOverride = client;
    },
    axiosGet,
    readAccountChangesCursor,
    writeAccountChangesCursor,
    verifyClaudeSharedGroupGenerationApplication,
    applyClaudeSharedGroupGenerationApplication,
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
    setActiveAccountSettingsSnapshot: (snapshot: Record<string, unknown> | null) => {
      activeAccountSettingsSnapshot = snapshot;
    },
    getActiveAccountSettingsSnapshot: () => activeAccountSettingsSnapshot,
    setDaemonControlServerParams: (params: unknown) => {
      daemonControlServerParams = params;
    },
    getDaemonControlServerParams: () => daemonControlServerParams,
    machineUpdateListeners,
    accountSettingsVersionHintListeners,
    connectedServicesProjectionChangeListeners,
    listConnectedServiceAuthGroups,
    getConnectedServiceAuthGroup,
    getAccountEncryptionMode,
    getConnectedServiceCredentialPlain,
    getConnectedServiceCredentialSealed,
    resetDaemonListeners: () => {
      machineConnectionStateListener = null;
      machineUpdateListeners.splice(0, machineUpdateListeners.length);
      accountSettingsVersionHintListeners.splice(0, accountSettingsVersionHintListeners.length);
      connectedServicesProjectionChangeListeners.splice(0, connectedServicesProjectionChangeListeners.length);
      daemonControlServerParams = null;
    },
    requestShutdown: (source: ShutdownSource) => requestShutdownRef?.(source),
    bootstrapAccountSettingsContext: vi.fn(async (_params?: unknown) => ({
      source: 'network',
      settings: { schemaVersion: 2 },
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      settingsSecretsReadKeys: [],
    })),
  };
});

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: vi.fn(async () => ({
      machineSyncClient: harness.machineSyncClient,
      listConnectedServiceAuthGroups: harness.listConnectedServiceAuthGroups,
      getConnectedServiceAuthGroup: harness.getConnectedServiceAuthGroup,
      getAccountEncryptionMode: harness.getAccountEncryptionMode,
      getConnectedServiceCredentialPlain: harness.getConnectedServiceCredentialPlain,
      getConnectedServiceCredentialSealed: harness.getConnectedServiceCredentialSealed,
    })),
  },
  isMachineContentPublicKeyMismatchError: vi.fn(() => false),
}));

vi.mock('axios', () => ({
  default: {
    get: harness.axiosGet,
    isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: unknown } | null)?.isAxiosError),
  },
}));

vi.mock('@/api/accountProfile', () => ({
  fetchAccountProfile: vi.fn(async () => ({
    connectedServicesV2: [],
    connectedServiceCredentialRevisionsV1: [],
  })),
}));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext: vi.fn(async ({ idOrPrefix }: { idOrPrefix: string }) => ({
    ok: true as const,
    sessionId: idOrPrefix,
    rawSession: {},
    ctx: {
      encryptionKey: new Uint8Array(32).fill(7),
      encryptionVariant: 'legacy' as const,
    },
    mode: 'plain' as const,
  })),
}));

vi.mock('@/session/transport/rpc/sessionRpc', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/sessionRpc')>(),
  callSessionRpc: vi.fn(async () => ({ ok: true, appliedVia: 'current_truth_fence' })),
}));

vi.mock('@/api/machine/ensureMachineRegistered', () => ({
  ensureMachineRegistered: vi.fn(async ({ machineId }: { machineId: string }) => ({
    machineId,
    didRotateMachineId: false,
    machine: createRegisteredMachine(machineId),
  })),
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById: vi.fn(async () => null),
  fetchSessionsPage: vi.fn(async () => ({ sessions: [], nextCursor: null, hasNext: false })),
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
    credentials: automationCredentials,
    machineId: 'machine-automation',
  })),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    privateKeyFile: '/tmp/key',
    happyHomeDir: '/tmp/home',
    currentCliVersion: '0.0.0-test',
    publicReleaseRing: 'stable',
    activeServerId: 'default',
    serverUrl: 'https://api.happier.dev',
    apiServerUrl: 'https://api.happier.dev',
    webappUrl: 'https://happier.dev',
    activeServerDir: '/tmp/server',
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
  pruneHappyCliRunnerSnapshots: vi.fn(),
  resolveHappyCliSubprocessRuntimeDecision: vi.fn(() => null),
  spawnHappyCLI: vi.fn(() => ({
    pid: 4242,
    unref: vi.fn(),
    on: vi.fn(),
  })),
}));

vi.mock('@/backends/claude/connectedServices/verifyClaudeSharedGroupGenerationApplication', () => ({
  verifyClaudeSharedGroupGenerationApplication: harness.verifyClaudeSharedGroupGenerationApplication,
}));

vi.mock('@/backends/claude/connectedServices/applyClaudeSharedGroupGenerationApplication', () => ({
  applyClaudeSharedGroupGenerationApplication: harness.applyClaudeSharedGroupGenerationApplication,
}));

vi.mock('@/backends/catalog', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/backends/catalog')>(),
  getConnectedServiceStateSharingDescriptor: vi.fn(async () => ({
    providerId: 'claude',
    providerSupportStatus: 'supported',
    config: {
      supported: true,
      modes: ['linked', 'copied', 'isolated'],
      entries: [],
    },
    state: {
      supported: true,
      modes: ['isolated', 'shared'],
      entries: [],
      symlinkUnavailableDegradePolicy: 'block_continuity',
    },
    authIsolation: {
      mode: 'materialized_home',
      secretEntries: [],
    },
  })),
  getConnectedServiceRuntimeAuthAdapter: vi.fn(() => null),
  getVendorResumeSupport: vi.fn(async () => () => true),
  resolveConnectedServiceSwitchContinuity: vi.fn(async () => ({ mode: 'restart_same_home' })),
  resolveConnectedServiceCandidatePersistedSessionFile: vi.fn(() => null),
  resolveAgentCliSubcommand: vi.fn(),
  resolveCatalogAgentId: vi.fn(() => 'codex'),
  notifyTerminalAttachmentRetiredThroughCatalog: vi.fn(async () => {}),
}));

vi.mock('@/persistence', () => {
  const writeDaemonState = vi.fn();
  const clearDaemonState = vi.fn(async () => true);
  return {
    clearDaemonState,
    writeDaemonState,
    writeDaemonStateIfLockOwned: vi.fn((state: unknown) => {
      writeDaemonState(state);
      return true;
    }),
    writeConnectedServiceBrokerState: vi.fn(),
    acquireDaemonLock: vi.fn(async () => harness.lockHandle),
    releaseDaemonLock: vi.fn(async () => {}),
    readCredentials: vi.fn(async () => null),
    readSettings: vi.fn(async () => ({ experiments: true })),
    readAccountChangesCursor: harness.readAccountChangesCursor,
    writeAccountChangesCursor: harness.writeAccountChangesCursor,
  };
});

vi.mock('@/settings/accountSettings/activeAccountSettingsSnapshot', () => ({
  getActiveAccountSettingsSnapshot: vi.fn(() => harness.getActiveAccountSettingsSnapshot()),
}));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext: harness.bootstrapAccountSettingsContext,
}));

vi.mock('@/settings/accountSettings/refreshAccountSettingsForMinimumVersion', () => ({
  refreshAccountSettingsForMinimumVersion: vi.fn(async (params: { credentials: unknown; minSettingsVersion?: number | null; mode?: string; forceRefresh?: boolean }) => {
    const active = harness.getActiveAccountSettingsSnapshot();
    if (
      !params.forceRefresh
      &&
      typeof params.minSettingsVersion === 'number'
      && active
      && typeof active.settingsVersion === 'number'
      && active.settingsVersion >= params.minSettingsVersion
    ) {
      return {
        source: 'cache',
        settings: { schemaVersion: 2 },
        settingsVersion: active.settingsVersion,
        loadedAtMs: Date.now(),
        settingsSecretsReadKeys: [],
        whenRefreshed: null,
      };
    }
    return await harness.bootstrapAccountSettingsContext({
      credentials: params.credentials,
      mode: params.mode ?? 'blocking',
      refresh: params.forceRefresh ? 'force' : 'auto',
      ...(typeof params.minSettingsVersion === 'number' ? { minSettingsVersion: params.minSettingsVersion } : {}),
    });
  }),
}));

vi.mock('./controlClient', () => ({
  cleanupDaemonState: vi.fn(async () => {}),
  isDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(async () => false),
  resolveDaemonSpawnSessionByNonce: vi.fn(async () => null),
  stopDaemon: vi.fn(async () => {}),
}));

vi.mock('@/daemon/ownership/evaluateCurrentDaemonOwner', () => ({
  evaluateCurrentDaemonOwner: vi.fn(async () => ({ kind: 'none' })),
}));

vi.mock('@/daemon/ownership/daemonServiceInventory', () => ({
  evaluateDaemonStartupServiceConflict: vi.fn(async () => ({ kind: 'none' })),
}));

vi.mock('./controlServer', () => ({
  startDaemonControlServer: vi.fn(async (params: unknown) => {
    harness.setDaemonControlServerParams(params);
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

vi.mock('./sessions/onChildExited', () => ({
  createOnChildExited: vi.fn(() => vi.fn()),
}));

vi.mock('./sessions/visibleConsoleSpawnWaiter', () => ({
  waitForVisibleConsoleSessionWebhook: vi.fn(async () => null),
}));

vi.mock('./sessions/isSessionRunnerActive', () => {
  const isSessionRunnerActive = vi.fn(async () => false);
  return {
    isSessionRunnerActive,
    probeSessionRunnerServiceability: vi.fn(async (...args: Parameters<typeof isSessionRunnerActive>) =>
      await isSessionRunnerActive(...args)
        ? { state: 'runner_present' as const, control: { state: 'servable' as const } }
        : { state: 'runner_absent' as const }),
    resolveSessionRunnerResumeDecision: (probe: { state: string; control?: { state: string; reason?: string } }) =>
      probe.state === 'runner_absent' ? { action: 'spawn' as const }
        : probe.control?.state === 'servable' ? { action: 'adopt' as const }
          : { action: 'fence' as const, reason: probe.control?.reason ?? 'unknown' },
  };
});

vi.mock('./sessions/stopSession', () => ({
  createStopSession: vi.fn(() => vi.fn(async () => ({ status: 'stopped' as const }))),
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
  resolveTerminalRequestFromSpawnOptions: vi.fn(() => ({ requested: null })),
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
    ok: true,
    env: {},
    cleanupOnFailure: null,
    cleanupOnExit: null,
  })),
}));

vi.mock('./automation/automationWorker', () => ({
  startAutomationWorker: harness.startAutomationWorker,
}));

vi.mock('./memory/memoryWorker', () => ({
  startMemoryWorker: vi.fn(async () => null),
}));

vi.mock('./connectedServices/quotas/ConnectedServiceQuotasCoordinator', () => ({
  DEFAULT_CONNECTED_SERVICE_QUOTA_FETCH_TIMEOUT_MS: 15_000,
  ConnectedServiceQuotasCoordinator: vi.fn(() => ({
    flushInBandQuotaPersistence: vi.fn(async () => ({ timedOut: false })),
    notifyQuotaPersistenceConnectivityChanged: vi.fn(),
    dispose: vi.fn(),
    registerSpawnTarget: vi.fn(),
    unregisterPid: vi.fn(),
    transferPid: vi.fn(),
    scheduleCurrentSourceRefresh: vi.fn(),
    probeGroupQuotaSnapshots: vi.fn(async () => {}),
    handleAccountUsageChanged: vi.fn(async () => {}),
    consumeRecoveryCreditForProfile: vi.fn(async () => null),
  })),
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

vi.mock('./connectedServices/resolveConnectedServiceAuthForSpawn', async () => {
  const actual = await vi.importActual<typeof import('./connectedServices/resolveConnectedServiceAuthForSpawn')>(
    './connectedServices/resolveConnectedServiceAuthForSpawn',
  );
  return {
    ...actual,
    resolveConnectedServiceAuthForSpawn: vi.fn(async () => null),
  };
});

vi.mock('./connectedServices/shouldResolveConnectedServiceAuthForSpawn', () => ({
  shouldResolveConnectedServiceAuthForSpawn: vi.fn(() => false),
}));

vi.mock('./sessionEncryption/resolveExistingSessionAttachContext', () => ({
  resolveExistingSessionAttachContext: vi.fn(async () => ({
    ok: true,
    attachPayload: { v: 2, encryptionMode: 'plain', lastObservedMessageSeq: 0 },
    metadata: null,
    deliveredUserMessageSeq: null,
  })),
}));

vi.mock('./connectedServices/accountUsage/currentSourceHydration', () => ({
  hydrateProviderAccountUsageStoreFromConnectedServiceInventory: vi.fn(async () => ({
    sources: [],
    hydration: {
      hydratedRecordIds: [],
      dispositions: [],
      refreshSources: [],
    },
  })),
}));

vi.mock('./shutdownPolicy', () => ({
  getDaemonShutdownExitCode: vi.fn(() => 0),
  getDaemonShutdownWatchdogTimeoutMs: vi.fn(() => 10_000),
}));

vi.mock('@/machines/transfer/directPeerTransport', () => ({
  createDirectPeerTransferRegistry: vi.fn(() => ({
    publishTransfer: vi.fn(() => ({
      endpointCandidates: [],
      expiresAt: 30_000,
    })),
    readPublishedTransfer: vi.fn(() => null),
    resolveOnDemandTransferOnOpen: vi.fn(async () => null),
    clearPublishedTransfer: vi.fn(),
  })),
  requestDirectPeerTransferToFile: vi.fn(async ({ destinationPath }: { destinationPath: string }) => ({
    destinationPath,
    manifestHash: 'sha256:test-manifest',
    sizeBytes: 0,
  })),
  startDirectPeerTransferServer: vi.fn(async () => ({
    port: 46001,
    stop: vi.fn(async () => {}),
  })),
}));

const CLAUDE_CONNECTED_BINDINGS = {
  v: 1,
  bindingsByServiceId: {
    'claude-subscription': {
      source: 'connected',
      selection: 'profile',
      profileId: 'claude-primary',
    },
  },
} as const;

function sharedClaudeAccountSettingsSnapshot(): Record<string, unknown> {
  return {
    settingsVersion: 3,
    settings: {
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: { configMode: 'isolated', stateMode: 'isolated' },
        byAgentId: {
          claude: { configMode: 'copied', stateMode: 'shared' },
        },
      },
    },
    settingsSecretsReadKeys: [],
  };
}

function createDaemonGroupBoundClaudeTrackedSession(pid: number): TrackedSession {
  return {
    pid,
    startedBy: 'daemon',
    spawnOptions: {
      directory: '/tmp/claude-readiness',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: `csm_claude_readiness_${pid}`,
        createdAtMs: 1_000,
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
            profileId: 'claude-primary',
          },
        },
      },
      environmentVariables: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'claude-subscription',
          groupId: 'team',
          activeProfileId: 'claude-primary',
          fallbackProfileId: 'claude-backup',
          generation: 1,
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        }]),
      },
    },
  };
}

function createDaemonClaudeReadinessMetadata(pid: number): Metadata {
  return {
    path: '/tmp/claude-readiness',
    host: 'test-host',
    homeDir: '/tmp',
    happyHomeDir: '/tmp/home',
    happyLibDir: '/tmp/lib',
    happyToolsDir: '/tmp/tools',
    hostPid: pid,
    startedBy: 'daemon',
    machineId: 'machine-automation',
    flavor: 'claude',
  };
}

function createDaemonGroupBoundPiTrackedSession(pid: number, selectionIdentity: string): TrackedSession {
  return {
    pid,
    startedBy: 'daemon',
    spawnOptions: {
      directory: '/tmp/pi-readiness',
      backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: `csm_pi_readiness_${pid}`,
        createdAtMs: 1_000,
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'happier',
            profileId: 'batiplus',
          },
        },
      },
      environmentVariables: {
        [PI_BROKER_SELECTION_IDENTITY_ENV]: selectionIdentity,
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'happier',
          activeProfileId: 'batiplus',
          fallbackProfileId: 'batiplus',
          generation: 1_203,
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        }]),
      },
    },
  };
}

function createDaemonPiReadinessMetadata(pid: number): Metadata {
  return {
    path: '/tmp/pi-readiness',
    host: 'test-host',
    homeDir: '/tmp',
    happyHomeDir: '/tmp/home',
    happyLibDir: '/tmp/lib',
    happyToolsDir: '/tmp/tools',
    hostPid: pid,
    startedBy: 'daemon',
    machineId: 'machine-automation',
    flavor: 'pi',
  };
}

async function installActualDaemonClaudeReadinessWebhook(pid: number): Promise<Readonly<{
  getTrackedSession: () => TrackedSession;
  installTrackedSession: (tracked: TrackedSession) => void;
}>> {
  let trackedSession: TrackedSession | null = null;
  let trackedSessionsByPid: Map<number, TrackedSession> | null = null;
  const catalog = await import('@/backends/catalog');
  const actualClaude = await vi.importActual<typeof import('@/backends/claude/index')>(
    '@/backends/claude/index',
  );
  const lifecycleDescriptor = await actualClaude.agent.getConnectedServiceCredentialLifecycleDescriptor();
  vi.mocked(catalog.resolveCatalogAgentId).mockReturnValue('claude');
  vi.spyOn(catalog, 'resolveConnectedServiceCredentialLifecycleDescriptor').mockResolvedValue(lifecycleDescriptor);
  const webhookModule = await import('./sessions/onHappySessionWebhook');
  const actualWebhookModule = await vi.importActual<typeof import('./sessions/onHappySessionWebhook')>(
    './sessions/onHappySessionWebhook',
  );
  vi.mocked(webhookModule.createOnHappySessionWebhook).mockImplementation((params) => {
    trackedSessionsByPid = params.pidToTrackedSession;
    trackedSession = createDaemonGroupBoundClaudeTrackedSession(pid);
    params.pidToTrackedSession.set(pid, trackedSession);
    return actualWebhookModule.createOnHappySessionWebhook({
      ...params,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      readCredentialsFn: async () => automationCredentials,
    });
  });
  return {
    getTrackedSession: () => {
      if (!trackedSession) throw new Error('Expected daemon Claude tracked-session composition');
      return trackedSession;
    },
    installTrackedSession: (tracked) => {
      if (!trackedSessionsByPid) throw new Error('Expected daemon tracked-session registry composition');
      trackedSessionsByPid.set(tracked.pid, tracked);
      trackedSession = tracked;
    },
  };
}

async function installActualDaemonPiReadinessWebhook(
  tracked: TrackedSession,
): Promise<Readonly<{ installTrackedSession: (next: TrackedSession) => void }>> {
  let trackedSessionsByPid: Map<number, TrackedSession> | null = null;
  const catalog = await import('@/backends/catalog');
  const actualPi = await vi.importActual<typeof import('@/backends/pi/index')>('@/backends/pi/index');
  const lifecycleDescriptor = await actualPi.agent.getConnectedServiceCredentialLifecycleDescriptor();
  vi.mocked(catalog.resolveCatalogAgentId).mockReturnValue('pi');
  vi.spyOn(catalog, 'resolveConnectedServiceCredentialLifecycleDescriptor').mockResolvedValue(lifecycleDescriptor);
  const webhookModule = await import('./sessions/onHappySessionWebhook');
  const actualWebhookModule = await vi.importActual<typeof import('./sessions/onHappySessionWebhook')>(
    './sessions/onHappySessionWebhook',
  );
  vi.mocked(webhookModule.createOnHappySessionWebhook).mockImplementation((params) => {
    trackedSessionsByPid = params.pidToTrackedSession;
    params.pidToTrackedSession.set(tracked.pid, tracked);
    return actualWebhookModule.createOnHappySessionWebhook({
      ...params,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: async () => {},
      readCredentialsFn: async () => automationCredentials,
    });
  });
  return {
    installTrackedSession: (next) => {
      if (!trackedSessionsByPid) throw new Error('Expected daemon Pi tracked-session registry composition');
      trackedSessionsByPid.set(next.pid, next);
    },
  };
}

async function createCapturedDaemonControlApp() {
  const params = harness.getDaemonControlServerParams();
  if (!params) throw new Error('Expected daemon control-server composition');
  const actualControlServer = await vi.importActual<typeof import('./controlServer')>('./controlServer');
  return actualControlServer.createDaemonControlApp(
    params as Parameters<typeof actualControlServer.createDaemonControlApp>[0],
  );
}

function readCapturedDaemonControlToken(): string {
  const params = harness.getDaemonControlServerParams() as { controlToken?: unknown } | null;
  const controlToken = typeof params?.controlToken === 'string' ? params.controlToken : '';
  if (!controlToken) throw new Error('Expected daemon control token');
  return controlToken;
}

describe('startDaemon automation wiring (integration)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    harness.setAutoShutdownAfterAutomationStart(true);
    harness.setActiveAccountSettingsSnapshot(null);
    harness.resetDaemonListeners();
    await resetAutomationDaemonTestDefaults();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    harness.setAutoShutdownAfterAutomationStart(true);
    harness.resetDaemonListeners();
  });

  async function startDaemonAndGetSpawnSessionHandler(): Promise<{
    run: Promise<void>;
    spawnSession: (options: unknown) => Promise<unknown>;
  }> {
    const { startDaemon } = await import('./startDaemon');
    const run = startDaemon();
    await waitForCondition(
      () => harness.apiMachine.setRPCHandlers.mock.calls.length >= 1,
      'Expected daemon RPC handlers to be registered',
    );

    const handlers = harness.apiMachine.setRPCHandlers.mock.calls[0]?.[0] as {
      spawnSession?: (options: unknown) => Promise<unknown>;
    } | undefined;
    if (typeof handlers?.spawnSession !== 'function') {
      throw new Error('Expected spawnSession handler to be registered');
    }
    return { run, spawnSession: handlers.spawnSession };
  }

  it('rejects static-unavailable native selections before daemon spawn effects', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);
    let run: Promise<void> | null = null;

    try {
      const { SPAWN_SESSION_ERROR_CODES } = await import('@happier-dev/protocol');
      const { ensureSessionDirectory } = await import('./startup/ensureSessionDirectory');
      const { resolveSpawnChildEnvironment } = await import('./spawn/resolveSpawnChildEnvironment');
      const { spawnHappyCLI } = await import('@/utils/spawnHappyCLI');
      const { resolveCatalogAgentId } = await import('@/backends/catalog');
      vi.mocked(resolveCatalogAgentId).mockReturnValue('qwen');

      const started = await startDaemonAndGetSpawnSessionHandler();
      run = started.run;
      const result = await started.spawnSession({
        machineId: 'machine-automation',
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'qwen' },
        modelId: 'not-a-qwen-static-model',
      });

      expect(result).toEqual(expect.objectContaining({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      }));
      expect(ensureSessionDirectory).not.toHaveBeenCalled();
      expect(resolveSpawnChildEnvironment).not.toHaveBeenCalled();
      expect(spawnHappyCLI).not.toHaveBeenCalled();
    } finally {
      harness.requestShutdown('happier-cli');
      if (run) await run;
      exitSpy.mockRestore();
    }
  });

  it('fails closed before child launch when connected-service resume reachability is unavailable', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);
    harness.setActiveAccountSettingsSnapshot(sharedClaudeAccountSettingsSnapshot());

    try {
      const {
        ConnectedServiceSpawnResumeUnreachableError,
        resolveConnectedServiceAuthForSpawn,
      } = await import('./connectedServices/resolveConnectedServiceAuthForSpawn');
      const { shouldResolveConnectedServiceAuthForSpawn } = await import('./connectedServices/shouldResolveConnectedServiceAuthForSpawn');
      const { resolveSpawnChildEnvironment } = await import('./spawn/resolveSpawnChildEnvironment');
      const { buildHappySessionControlArgs } = await import('./sessionSpawnArgs');
      const { resolveCatalogAgentId } = await import('@/backends/catalog');
      const {
        SPAWN_SESSION_ERROR_CODES,
        isConnectedServiceResumeUnreachableSpawnErrorDetail,
      } = await import('@happier-dev/protocol');

      vi.mocked(resolveCatalogAgentId).mockReturnValue('claude');
      vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValue(true);
      vi.mocked(resolveConnectedServiceAuthForSpawn).mockRejectedValueOnce(
        new ConnectedServiceSpawnResumeUnreachableError({
          agentId: 'claude',
          vendorResumeId: 'claude-missing-resume',
          cwd: '/tmp/project',
          targetMaterializedRoot: '/tmp/materialized/claude',
          reason: 'no_resumable_session_file',
        }),
      );

      const { run, spawnSession } = await startDaemonAndGetSpawnSessionHandler();
      const result = await spawnSession({
        machineId: 'machine-automation',
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: 'claude-missing-resume',
        connectedServices: CLAUDE_CONNECTED_BINDINGS,
      });

      expect(result).toEqual(expect.objectContaining({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      }));
      expect(isConnectedServiceResumeUnreachableSpawnErrorDetail((result as { errorDetail?: unknown }).errorDetail)).toBe(true);
      expect(resolveConnectedServiceAuthForSpawn).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'claude',
        sessionDirectory: '/tmp/project',
        vendorResumeId: 'claude-missing-resume',
        resumeReachabilityRequired: true,
      }));
      expect(resolveSpawnChildEnvironment).not.toHaveBeenCalled();
      expect(buildHappySessionControlArgs).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('continues to child launch when connected-service resume reachability resolves', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);
    harness.setActiveAccountSettingsSnapshot(sharedClaudeAccountSettingsSnapshot());

    try {
      const { resolveConnectedServiceAuthForSpawn } = await import('./connectedServices/resolveConnectedServiceAuthForSpawn');
      const { shouldResolveConnectedServiceAuthForSpawn } = await import('./connectedServices/shouldResolveConnectedServiceAuthForSpawn');
      const { buildHappySessionControlArgs } = await import('./sessionSpawnArgs');
      const { spawnHappyCLI } = await import('@/utils/spawnHappyCLI');
      const { waitForSessionWebhook } = await import('./spawn/waitForSessionWebhook');
      const { resolveCatalogAgentId } = await import('@/backends/catalog');

      vi.mocked(resolveCatalogAgentId).mockReturnValue('claude');
      vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValue(true);
      vi.mocked(waitForSessionWebhook).mockResolvedValueOnce({
        type: 'success',
        sessionId: 'sess-claude-reachable',
      });
      vi.mocked(resolveConnectedServiceAuthForSpawn).mockResolvedValueOnce({
        env: { CLAUDE_CONFIG_DIR: '/tmp/materialized/claude/claude-config' },
        cleanupOnFailure: null,
        cleanupOnExit: null,
        connectedServicesBindings: CLAUDE_CONNECTED_BINDINGS,
        runtimeAccountIdentitySelections: [],
      });

      const { run, spawnSession } = await startDaemonAndGetSpawnSessionHandler();
      await spawnSession({
        machineId: 'machine-automation',
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: 'claude-reachable-resume',
        connectedServices: CLAUDE_CONNECTED_BINDINGS,
      });

      expect(resolveConnectedServiceAuthForSpawn).toHaveBeenCalledWith(expect.objectContaining({
        vendorResumeId: 'claude-reachable-resume',
        resumeReachabilityRequired: true,
      }));
      expect(buildHappySessionControlArgs).toHaveBeenCalledWith(expect.objectContaining({
        resume: 'claude-reachable-resume',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      }));
      expect(spawnHappyCLI).toHaveBeenCalledTimes(1);

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('gates runtime-snapshot replayed vendor resume ids before child launch', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);
    harness.setActiveAccountSettingsSnapshot(sharedClaudeAccountSettingsSnapshot());

    try {
      const {
        ConnectedServiceSpawnResumeUnreachableError,
        resolveConnectedServiceAuthForSpawn,
      } = await import('./connectedServices/resolveConnectedServiceAuthForSpawn');
      const { shouldResolveConnectedServiceAuthForSpawn } = await import('./connectedServices/shouldResolveConnectedServiceAuthForSpawn');
      const { resolveExistingSessionAttachContext } = await import('./sessionEncryption/resolveExistingSessionAttachContext');
      const { resolveSpawnChildEnvironment } = await import('./spawn/resolveSpawnChildEnvironment');
      const { resolveCatalogAgentId } = await import('@/backends/catalog');

      vi.mocked(resolveCatalogAgentId).mockReturnValue('claude');
      vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValue(true);
      vi.mocked(resolveExistingSessionAttachContext).mockResolvedValueOnce({
        ok: true,
        attachPayload: { v: 2, encryptionMode: 'plain', lastObservedMessageSeq: 0 },
        metadata: {
          connectedServices: CLAUDE_CONNECTED_BINDINGS,
          connectedServiceMaterializationIdentityV1: {
            v: 1,
            id: 'csm_snapshot_replay',
            createdAtMs: 1_000,
          },
          claudeSessionId: 'claude-snapshot-resume',
        },
        vendorResumeId: 'claude-snapshot-resume',
        sessionPath: '/tmp/project',
      });
      vi.mocked(resolveConnectedServiceAuthForSpawn).mockRejectedValueOnce(
        new ConnectedServiceSpawnResumeUnreachableError({
          agentId: 'claude',
          vendorResumeId: 'claude-snapshot-resume',
          cwd: '/tmp/project',
          targetMaterializedRoot: '/tmp/materialized/claude',
          reason: 'no_resumable_session_file',
        }),
      );

      const { run, spawnSession } = await startDaemonAndGetSpawnSessionHandler();
      const result = await spawnSession({
        machineId: 'machine-automation',
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        existingSessionId: 'sess-existing',
        connectedServices: CLAUDE_CONNECTED_BINDINGS,
      });

      expect(resolveConnectedServiceAuthForSpawn).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess-existing',
        vendorResumeId: 'claude-snapshot-resume',
        resumeReachabilityRequired: true,
      }));
      expect(result).toEqual(expect.objectContaining({ type: 'error' }));
      expect(resolveSpawnChildEnvironment).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
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
          machine: createRegisteredMachine(resolvedMachineId),
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

      await waitForCondition(
        () => harness.startAutomationWorker.mock.calls.length >= 1,
        'Expected automation worker to start after machine registration rotation',
      );

      expect(stopDaemon).toHaveBeenCalledTimes(1);
      expect(writeDaemonState).toHaveBeenCalledWith(expect.objectContaining({
        machineId: 'machine-rotated',
      }));
      expect(harness.startAutomationWorker).toHaveBeenCalledTimes(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('backs off machine registration retries after transient failures', async () => {
    vi.useRealTimers();
    harness.setAutoShutdownAfterAutomationStart(false);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const retryBaseDelayOriginal = process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_BASE_DELAY_MS;
    const retryDelayOriginal = process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS;
    const retryMaxDelayOriginal = process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_MAX_DELAY_MS;
    const retryJitterOriginal = process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_JITTER_MS;
    delete process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_BASE_DELAY_MS;
    process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS = '100';
    process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_MAX_DELAY_MS = '1000';
    process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_JITTER_MS = '0';

    let run: Promise<void> | null = null;
    try {
      const { ensureMachineRegistered } = await import('@/api/machine/ensureMachineRegistered');
      const ensureMachineRegisteredMock = vi.mocked(ensureMachineRegistered);
      const firstAttempt = createDeferred<Awaited<ReturnType<typeof ensureMachineRegistered>>>();
      const secondAttempt = createDeferred<Awaited<ReturnType<typeof ensureMachineRegistered>>>();
      ensureMachineRegisteredMock
        .mockImplementationOnce(() => firstAttempt.promise)
        .mockImplementationOnce(() => secondAttempt.promise);

      const { startDaemon } = await import('./startDaemon');

      run = startDaemon();
      await waitForCondition(
        () => ensureMachineRegisteredMock.mock.calls.length >= 1 || exitSpy.mock.calls.length >= 1,
        'Expected machine registration loop to start the first attempt',
        400,
      );
      if (ensureMachineRegisteredMock.mock.calls.length === 0) {
        const { logger } = await import('@/ui/logger');
        const debugCalls = vi.mocked(logger.debug).mock.calls.slice(-3);
        throw new Error(`Expected machine registration loop to start before daemon exit: ${JSON.stringify(debugCalls)}`);
      }

      vi.useFakeTimers();
      firstAttempt.reject(new Error('transient machine registration failure 1'));
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(99);
      expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(2);

      secondAttempt.reject(new Error('transient machine registration failure 2'));
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(199);
      expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);
      expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.startAutomationWorker).toHaveBeenCalledTimes(1);

      harness.requestShutdown('happier-cli');
      await vi.advanceTimersByTimeAsync(0);
      await run;
    } finally {
      harness.requestShutdown('happier-cli');
      if (run) {
        if (vi.isFakeTimers()) {
          await vi.advanceTimersByTimeAsync(0);
        }
        await run;
      }
      if (retryBaseDelayOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_BASE_DELAY_MS;
      } else {
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_BASE_DELAY_MS = retryBaseDelayOriginal;
      }
      if (retryDelayOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS;
      } else {
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS = retryDelayOriginal;
      }
      if (retryMaxDelayOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_MAX_DELAY_MS;
      } else {
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_MAX_DELAY_MS = retryMaxDelayOriginal;
      }
      if (retryJitterOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_JITTER_MS;
      } else {
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_JITTER_MS = retryJitterOriginal;
      }
      vi.useRealTimers();
      exitSpy.mockRestore();
    }
  });

  it('does not publish delayed machine registration after shutdown begins', async () => {
    vi.useRealTimers();
    harness.setAutoShutdownAfterAutomationStart(false);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const registration = createDeferred<Awaited<ReturnType<
      typeof import('@/api/machine/ensureMachineRegistered').ensureMachineRegistered
    >>>();
    const startupSourceOriginal = process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
    const selfRestartCorrelationIdOriginal = process.env.HAPPIER_DAEMON_SELF_RESTART_CORRELATION_ID;
    const selfRestartDeadlineMsOriginal = process.env.HAPPIER_DAEMON_SELF_RESTART_DEADLINE_MS;
    let run: Promise<void> | null = null;

    try {
      process.env.HAPPIER_DAEMON_STARTUP_SOURCE = 'self-restart';
      process.env.HAPPIER_DAEMON_SELF_RESTART_CORRELATION_ID = 'self-restart-delayed-machine-registration';
      process.env.HAPPIER_DAEMON_SELF_RESTART_DEADLINE_MS = String(Date.now() + 60_000);

      const { ensureMachineRegistered } = await import('@/api/machine/ensureMachineRegistered');
      vi.mocked(ensureMachineRegistered).mockImplementationOnce(() => registration.promise);
      const { writeDaemonState } = await import('@/persistence');
      const { startDaemon } = await import('./startDaemon');

      run = startDaemon();
      await waitForCondition(
        () => vi.mocked(ensureMachineRegistered).mock.calls.length >= 1,
        'Expected background machine registration to begin',
      );
      expect(writeDaemonState).toHaveBeenCalledTimes(1);

      harness.requestShutdown('happier-cli');
      await run;
      run = null;

      registration.resolve({
        machineId: 'machine-after-shutdown',
        didRotateMachineId: true,
        machine: createRegisteredMachine('machine-after-shutdown'),
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(writeDaemonState).toHaveBeenCalledTimes(1);
      expect(writeDaemonState).not.toHaveBeenCalledWith(expect.objectContaining({
        machineId: 'machine-after-shutdown',
      }));
    } finally {
      harness.requestShutdown('happier-cli');
      if (run) await run;
      restoreProcessEnvValue('HAPPIER_DAEMON_STARTUP_SOURCE', startupSourceOriginal);
      restoreProcessEnvValue('HAPPIER_DAEMON_SELF_RESTART_CORRELATION_ID', selfRestartCorrelationIdOriginal);
      restoreProcessEnvValue('HAPPIER_DAEMON_SELF_RESTART_DEADLINE_MS', selfRestartDeadlineMsOriginal);
      exitSpy.mockRestore();
    }
  });

  it('owner-clears published daemon and broker state before releasing the lock after a fatal startup error', async () => {
    vi.useRealTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const {
        clearDaemonState,
        releaseDaemonLock,
        writeConnectedServiceBrokerState,
        writeDaemonState,
      } = await import('@/persistence');
      const { startDaemonHeartbeatLoop } = await import('./lifecycle/heartbeat');
      vi.mocked(startDaemonHeartbeatLoop).mockImplementationOnce(() => {
        throw new Error('fatal after daemon publication');
      });
      const { startDaemon } = await import('./startDaemon');

      await startDaemon();

      expect(writeDaemonState).toHaveBeenCalledTimes(1);
      expect(writeConnectedServiceBrokerState).toHaveBeenCalledTimes(1);
      expect(clearDaemonState).toHaveBeenCalledWith({
        expectedOwner: {
          pid: process.pid,
          startedAt: expect.any(Number),
        },
      });
      expect(vi.mocked(clearDaemonState).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(releaseDaemonLock).mock.invocationCallOrder[0]!,
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('still releases the lifecycle lock when fatal owner cleanup fails', async () => {
    vi.useRealTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const { clearDaemonState, releaseDaemonLock } = await import('@/persistence');
      vi.mocked(clearDaemonState).mockRejectedValueOnce(new Error('fatal owner cleanup failed'));
      const { startDaemonHeartbeatLoop } = await import('./lifecycle/heartbeat');
      vi.mocked(startDaemonHeartbeatLoop).mockImplementationOnce(() => {
        throw new Error('fatal after daemon publication');
      });
      const { startDaemon } = await import('./startDaemon');

      await startDaemon();

      expect(clearDaemonState).toHaveBeenCalledTimes(1);
      expect(releaseDaemonLock).toHaveBeenCalledWith(harness.lockHandle);
      expect(vi.mocked(clearDaemonState).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(releaseDaemonLock).mock.invocationCallOrder[0]!,
      );
    } finally {
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
      const writeDaemonStateMock = writeDaemonState as unknown as { mock: { calls: unknown[][] } };
      await waitForCondition(
        () => writeDaemonStateMock.mock.calls.length >= 1,
        'Expected daemon state to be written before machine registration succeeds',
      );

      expect(writeDaemonState).toHaveBeenCalledTimes(1);
      expect(ensureMachineRegistered).toHaveBeenCalledWith(expect.objectContaining({
        daemonState: expect.objectContaining({
          startedWithCliVersion: '0.2.10',
        }),
      }));

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('writes daemon state before current-source provider-account usage hydration completes', async () => {
    vi.useRealTimers();
    harness.setAutoShutdownAfterAutomationStart(false);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const hydration = createDeferred<{
      sources: [];
      hydration: { hydratedRecordIds: []; dispositions: []; refreshSources: [] };
    }>();
    const startupSourceOriginal = process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
    const selfRestartCorrelationIdOriginal = process.env.HAPPIER_DAEMON_SELF_RESTART_CORRELATION_ID;
    const selfRestartDeadlineMsOriginal = process.env.HAPPIER_DAEMON_SELF_RESTART_DEADLINE_MS;
    let run: Promise<void> | null = null;

    try {
      process.env.HAPPIER_DAEMON_STARTUP_SOURCE = 'self-restart';
      process.env.HAPPIER_DAEMON_SELF_RESTART_CORRELATION_ID = 'self-restart-automation-hydration';
      process.env.HAPPIER_DAEMON_SELF_RESTART_DEADLINE_MS = String(Date.now() + 60_000);
      const { hydrateProviderAccountUsageStoreFromConnectedServiceInventory } = await import('./connectedServices/accountUsage/currentSourceHydration');
      vi.mocked(hydrateProviderAccountUsageStoreFromConnectedServiceInventory).mockImplementationOnce(async () => hydration.promise);

      const { writeDaemonState } = await import('@/persistence');
      const { startDaemon } = await import('./startDaemon');

      run = startDaemon();
      const writeDaemonStateMock = writeDaemonState as unknown as { mock: { calls: unknown[][] } };
      await waitForCondition(
        () => writeDaemonStateMock.mock.calls.length >= 1,
        'Expected daemon state to be written before current-source provider-account usage hydration completes',
      );
      await waitForCondition(
        () => vi.mocked(hydrateProviderAccountUsageStoreFromConnectedServiceInventory).mock.calls.length >= 1,
        'Expected current-source provider-account usage hydration to start after daemon state is written',
      );

      expect(writeDaemonState).toHaveBeenCalledTimes(1);
      expect(hydrateProviderAccountUsageStoreFromConnectedServiceInventory).toHaveBeenCalledTimes(1);
    } finally {
      hydration.resolve({
        sources: [],
        hydration: { hydratedRecordIds: [], dispositions: [], refreshSources: [] },
      });
      harness.requestShutdown('happier-cli');
      try {
        if (run) await run;
      } finally {
        restoreProcessEnvValue('HAPPIER_DAEMON_STARTUP_SOURCE', startupSourceOriginal);
        restoreProcessEnvValue('HAPPIER_DAEMON_SELF_RESTART_CORRELATION_ID', selfRestartCorrelationIdOriginal);
        restoreProcessEnvValue('HAPPIER_DAEMON_SELF_RESTART_DEADLINE_MS', selfRestartDeadlineMsOriginal);
        exitSpy.mockRestore();
      }
    }
  });

  it('starts automation worker after machine sync bootstrap and stops it on shutdown', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const { startDaemon } = await import('./startDaemon');
      await startDaemon();

      await waitForCondition(
        () => harness.startAutomationWorker.mock.calls.length >= 1,
        'Expected automation worker to start after machine bootstrap completes',
      );

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
      await waitForCondition(
        () => harness.automationWorkerStop.mock.calls.length >= 1,
        'Expected automation worker to stop during daemon shutdown cleanup',
      );
      expect(harness.automationWorkerStop).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('warns when connected-service quota persistence does not drain during shutdown', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const { logger } = await import('@/ui/logger');
      const { ConnectedServiceQuotasCoordinator } = await import('./connectedServices/quotas/ConnectedServiceQuotasCoordinator');
      const flushInBandQuotaPersistence = vi.fn(async () => ({
        timedOut: true,
        inProcess: { timedOut: true, drained: false },
        serverWork: { timedOut: false },
      }));
      vi.mocked(ConnectedServiceQuotasCoordinator).mockImplementationOnce(() => ({
        flushInBandQuotaPersistence,
        notifyQuotaPersistenceConnectivityChanged: vi.fn(),
        dispose: vi.fn(),
        registerSpawnTarget: vi.fn(),
        unregisterPid: vi.fn(),
        transferPid: vi.fn(),
        scheduleCurrentSourceRefresh: vi.fn(),
      } as unknown as InstanceType<typeof ConnectedServiceQuotasCoordinator>));

      const { startDaemon } = await import('./startDaemon');
      await startDaemon();

      expect(flushInBandQuotaPersistence).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        '[DAEMON RUN] Connected-service quota persistence did not drain before shutdown',
        expect.objectContaining({
          timedOut: true,
          inProcess: { timedOut: true, drained: false },
          serverWork: { timedOut: false },
        }),
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('composes recipient-only apply without a pending metadata writer in the production quota adapter', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const { ConnectedServiceQuotasCoordinator } = await import('./connectedServices/quotas/ConnectedServiceQuotasCoordinator');
      const { startDaemon } = await import('./startDaemon');
      await startDaemon();

      const construction = vi.mocked(ConnectedServiceQuotasCoordinator).mock.calls.at(-1)?.[0];
      const adapter = construction?.authGroupSwitchCoordinator;
      expect(adapter?.applyCommittedGeneration).toBeTypeOf('function');
      expect(construction).not.toHaveProperty('recordPendingAuthGroupGeneration');
      await expect(adapter?.applyCommittedGeneration?.({
        sessionId: 'missing-sibling',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'backup',
        generation: 2,
        reason: 'same_provider_account_exhausted',
        fromProfileId: 'primary',
      })).resolves.toEqual({
        status: 'session_not_found',
        generation: 2,
        errorCode: 'session_not_found',
      });
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('registers durable connected-services reconciliation before the machine transport connects', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const previousReconciliationTimeoutMs = process.env.HAPPIER_PROVIDER_INPUT_GENERATION_RECONCILIATION_TIMEOUT_MS;
    process.env.HAPPIER_PROVIDER_INPUT_GENERATION_RECONCILIATION_TIMEOUT_MS = '100';
    harness.setAutoShutdownAfterAutomationStart(false);
    try {
      const { startDaemon } = await import('./startDaemon');
      const run = startDaemon();
      await Promise.race([
        waitForCondition(
          () => harness.apiMachine.connect.mock.calls.length >= 1,
          'Expected machine transport to connect',
        ),
        run.then(async () => {
          const { logger } = await import('@/ui/logger');
          throw new Error(`Daemon exited before machine transport connected: ${JSON.stringify(vi.mocked(logger.debug).mock.calls.slice(-5))}`);
        }),
      ]);

      expect(harness.apiMachine.recoverDaemonTerminalSessionMutationJournals).toHaveBeenCalledOnce();
      expect(harness.apiMachine.recoverDaemonTerminalSessionMutationJournals.mock.invocationCallOrder[0])
        .toBeLessThan(harness.apiMachine.connect.mock.invocationCallOrder[0]!);
      expect(harness.apiMachine.onConnectedServicesProjectionChange).toHaveBeenCalledOnce();
      expect(harness.apiMachine.onConnectedServicesProjectionChange.mock.invocationCallOrder[0])
        .toBeLessThan(harness.apiMachine.connect.mock.invocationCallOrder[0]!);
      expect(harness.connectedServicesProjectionChangeListeners).toHaveLength(1);
      const { fetchSessionsPage } = await import('@/session/transport/http/sessionsHttp');
      vi.mocked(fetchSessionsPage).mockClear();
      const projectionController = new AbortController();
      await expect(harness.connectedServicesProjectionChangeListeners[0]?.({
        source: 'startup',
        executionAuthority: 'passive_projection',
        signal: projectionController.signal,
        connectedServicesV2: [{
          serviceId: 'openai-codex',
          profiles: [],
          groups: [{
            groupId: 'main',
            activeProfileId: 'primary',
            generation: 1,
            memberProfileIds: ['primary'],
          }],
        }],
        connectedServiceCredentialRevisionsV1: [],
      })).resolves.toBeUndefined();
      expect(fetchSessionsPage).not.toHaveBeenCalled();

      const changedProjection = {
        source: 'changes',
        executionAuthority: 'passive_projection' as const,
        signal: projectionController.signal,
        connectedServicesV2: [{
          serviceId: 'openai-codex',
          profiles: [],
          groups: [{
            groupId: 'main',
            activeProfileId: 'backup',
            generation: 2,
            memberProfileIds: ['backup'],
          }],
        }],
        // Old writers omit the revision projection; the new daemon must parse that as unknown.
        connectedServiceCredentialRevisionsV1: [],
      };
      await expect(harness.connectedServicesProjectionChangeListeners[0]?.(changedProjection)).resolves.toBeUndefined();
      expect(fetchSessionsPage).not.toHaveBeenCalled();
      await expect(harness.connectedServicesProjectionChangeListeners[0]?.(changedProjection)).resolves.toBeUndefined();
      expect(fetchSessionsPage).not.toHaveBeenCalled();
      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      if (previousReconciliationTimeoutMs === undefined) {
        delete process.env.HAPPIER_PROVIDER_INPUT_GENERATION_RECONCILIATION_TIMEOUT_MS;
      } else {
        process.env.HAPPIER_PROVIDER_INPUT_GENERATION_RECONCILIATION_TIMEOUT_MS = previousReconciliationTimeoutMs;
      }
      exitSpy.mockRestore();
    }
  });

  it('records daemon Claude startup but returns a retryable failure when the generation consumer is unavailable', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const quotaReadiness = createDeferred<boolean>();
    const pid = 7420;
    let run: Promise<void> | null = null;
    let app: Awaited<ReturnType<typeof createCapturedDaemonControlApp>> | null = null;
    harness.setAutoShutdownAfterAutomationStart(false);

    try {
      const quotasEnabledModule = await import(
        './connectedServices/quotas/resolveConnectedServicesQuotasDaemonEnabled'
      );
      vi.mocked(quotasEnabledModule.resolveConnectedServicesQuotasDaemonEnabled)
        .mockImplementationOnce(async () => await quotaReadiness.promise);
      const webhook = await installActualDaemonClaudeReadinessWebhook(pid);

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await waitForCondition(
        () => harness.getDaemonControlServerParams() !== null,
        'Expected daemon control server before quota/consumer initialization',
      );
      app = await createCapturedDaemonControlApp();
      const controlToken = readCapturedDaemonControlToken();

      const response = await app.inject({
        method: 'POST',
        url: '/session-started',
        headers: { 'x-happier-daemon-token': controlToken },
        payload: {
          sessionId: 'session-claude-readiness-before-consumer',
          metadata: createDaemonClaudeReadinessMetadata(pid),
        },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: 'error',
        errorCode: 'session_startup_reconciliation_failed',
      });
      await waitForCondition(
        () => webhook.getTrackedSession().happySessionId === 'session-claude-readiness-before-consumer',
        'Expected the daemon to record the reported session before deferred reconciliation settles',
      );
      expect(webhook.getTrackedSession()).toMatchObject({
        pid,
        happySessionId: 'session-claude-readiness-before-consumer',
        happySessionMetadataFromLocalWebhook: expect.objectContaining({
          hostPid: pid,
          flavor: 'claude',
        }),
      });
    } finally {
      quotaReadiness.resolve(true);
      if (app) await app.close();
      harness.requestShutdown('happier-cli');
      if (run) await run;
      exitSpy.mockRestore();
    }
  });

  it('indexes a terminal-started broker runtime from its first durable session report', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const pid = 7429;
    const sessionId = 'session-terminal-opencode-broker';
    const brokerSelectionIdentity =
      'opencode|connected|broker:1|openai-codex:work:account-1|group:team';
    let run: Promise<void> | null = null;
    let app: Awaited<ReturnType<typeof createCapturedDaemonControlApp>> | null = null;
    let runtimeRegistry: ConnectedServiceRuntimeRegistryType | null = null;
    const getRuntimeRegistry = (): ConnectedServiceRuntimeRegistryType | null => runtimeRegistry;
    harness.setAutoShutdownAfterAutomationStart(false);

    try {
      const catalog = await import('@/backends/catalog');
      vi.mocked(catalog.resolveCatalogAgentId).mockReturnValue('opencode');
      const { ConnectedServiceRuntimeRegistry } = await import(
        './connectedServices/runtimeRegistry/registry'
      );
      const originalSubscribe = ConnectedServiceRuntimeRegistry.prototype.onTargetRegistration;
      vi.spyOn(ConnectedServiceRuntimeRegistry.prototype, 'onTargetRegistration').mockImplementation(function (
        this: ConnectedServiceRuntimeRegistryType,
        listener,
      ) {
        runtimeRegistry = this;
        return originalSubscribe.call(this, listener);
      });
      const webhookModule = await import('./sessions/onHappySessionWebhook');
      const actualWebhookModule = await vi.importActual<typeof import('./sessions/onHappySessionWebhook')>(
        './sessions/onHappySessionWebhook',
      );
      vi.mocked(webhookModule.createOnHappySessionWebhook).mockImplementation((params) => {
        params.pidToTrackedSession.set(pid, {
          pid,
          startedBy: 'happy directly - likely by user from terminal',
          happySessionId: `PID-${pid}`,
        });
        return actualWebhookModule.createOnHappySessionWebhook({
          ...params,
          findHappyProcessByPidFn: async () => null,
          writeSessionMarkerFn: async () => {},
          readCredentialsFn: async () => automationCredentials,
        });
      });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await waitForCondition(
        () => harness.getDaemonControlServerParams() !== null && runtimeRegistry !== null,
        'Expected daemon control server and Connected Services runtime registry',
      );
      app = await createCapturedDaemonControlApp();
      const response = await app.inject({
        method: 'POST',
        url: '/session-started',
        headers: { 'x-happier-daemon-token': readCapturedDaemonControlToken() },
        payload: {
          sessionId,
          metadata: {
            path: '/tmp/terminal-opencode',
            host: 'test-host',
            homeDir: '/tmp',
            happyHomeDir: '/tmp/home',
            happyLibDir: '/tmp/lib',
            happyToolsDir: '/tmp/tools',
            hostPid: pid,
            startedBy: 'happy directly - likely by user from terminal',
            machineId: 'machine-automation',
            flavor: 'opencode',
            connectedServices: {
              v: 1,
              bindingsByServiceId: {
                'openai-codex': {
                  source: 'connected',
                  selection: 'group',
                  groupId: 'team',
                  profileId: 'work',
                },
              },
            },
            connectedServiceBrokerSelectionIdentityV1: brokerSelectionIdentity,
          },
        },
      });

      expect(response.statusCode).toBe(200);
      await waitForCondition(
        () => getRuntimeRegistry()?.getByBrokerSelectionIdentity(brokerSelectionIdentity)?.sessionId === sessionId,
        'Expected the terminal-started broker identity to reach the canonical runtime registry',
      );
      expect(getRuntimeRegistry()?.getByBrokerSelectionIdentity(brokerSelectionIdentity)).toMatchObject({
        pid,
        agentId: 'opencode',
        sessionId,
      });
    } finally {
      if (app) await app.close();
      harness.requestShutdown('happier-cli');
      if (run) await run;
      exitSpy.mockRestore();
    }
  });

  it('does not ACK Claude startup until authoritative readiness reconciliation settles', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const pid = 7421;
    let run: Promise<void> | null = null;
    let app: Awaited<ReturnType<typeof createCapturedDaemonControlApp>> | null = null;
    harness.setAutoShutdownAfterAutomationStart(false);

    try {
      await installActualDaemonClaudeReadinessWebhook(pid);
      const { callSessionRpc } = await import('@/session/transport/rpc/sessionRpc');
      const { fetchAccountProfile } = await import('@/api/accountProfile');
      const unavailableApplied = createDeferred<unknown>();
      vi.mocked(callSessionRpc).mockReset();
      vi.mocked(callSessionRpc)
        .mockImplementationOnce(async () => await unavailableApplied.promise)
        .mockResolvedValue({ ok: true, appliedVia: 'current_truth_fence' });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await waitForCondition(
        () => harness.connectedServicesProjectionChangeListeners.length === 1
          && harness.getDaemonControlServerParams() !== null,
        'Expected canonical consumer and projection listener composition',
      );
      app = await createCapturedDaemonControlApp();
      const controlToken = readCapturedDaemonControlToken();

      let responseSettled = false;
      const responsePromise = app.inject({
        method: 'POST',
        url: '/session-started',
        headers: { 'x-happier-daemon-token': controlToken },
        payload: {
          sessionId: 'session-claude-readiness-fetch',
          metadata: createDaemonClaudeReadinessMetadata(pid),
        },
      }).then((response) => {
        responseSettled = true;
        return response;
      });
      const firstBoundary = await Promise.race([
        responsePromise.then(() => 'response' as const),
        waitForCondition(
          () => vi.mocked(callSessionRpc).mock.calls.length === 1,
          'Expected unavailable truth RPC during readiness reconciliation',
        ).then(() => 'unavailable_rpc' as const),
      ]);

      expect(firstBoundary).toBe('unavailable_rpc');
      expect(responseSettled).toBe(false);
      await waitForCondition(
        () => vi.mocked(fetchAccountProfile).mock.calls.length === 1
          && vi.mocked(callSessionRpc).mock.calls.length === 1,
        'Expected authoritative readiness reconciliation before startup ACK',
      );
      expect(fetchAccountProfile).toHaveBeenCalledOnce();
      expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-claude-readiness-fetch',
        request: expect.objectContaining({
          authGeneration: {
            kind: 'current_auth_group_unavailable',
            groupId: 'team',
            unavailableReason: 'group_missing',
          },
        }),
      }));
      unavailableApplied.resolve({ ok: true, appliedVia: 'current_truth_fence' });
      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
      expect(responseSettled).toBe(true);

      await expect(app.inject({
        method: 'POST',
        url: '/session-started',
        headers: { 'x-happier-daemon-token': controlToken },
        payload: {
          sessionId: 'session-claude-readiness-fetch',
          metadata: createDaemonClaudeReadinessMetadata(pid),
        },
      })).resolves.toMatchObject({ statusCode: 200 });
      expect(fetchAccountProfile).toHaveBeenCalledTimes(2);
      expect(callSessionRpc).toHaveBeenCalledOnce();
    } finally {
      if (app) await app.close();
      harness.requestShutdown('happier-cli');
      if (run) await run;
      exitSpy.mockRestore();
    }
  });

  it('ACKs an exact newcomer without waiting for an unrelated blocked aggregate sibling', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const newcomerPid = 7423;
    const revisionA = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const revisionB = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    let run: Promise<void> | null = null;
    let app: Awaited<ReturnType<typeof createCapturedDaemonControlApp>> | null = null;
    harness.setAutoShutdownAfterAutomationStart(false);
    harness.setActiveAccountSettingsSnapshot(sharedClaudeAccountSettingsSnapshot());

    try {
      const webhook = await installActualDaemonClaudeReadinessWebhook(newcomerPid);
      const { fetchAccountProfile } = await import('@/api/accountProfile');
      const { ConnectedServiceRuntimeRegistry } = await import('./connectedServices/runtimeRegistry/registry');
      const { ConnectedServiceRefreshCoordinator } = await import(
        './connectedServices/refresh/ConnectedServiceRefreshCoordinator'
      );
      const originalSubscribe = ConnectedServiceRuntimeRegistry.prototype.onTargetRegistration;
      vi.spyOn(ConnectedServiceRuntimeRegistry.prototype, 'onTargetRegistration').mockImplementation(function (
        this: InstanceType<typeof ConnectedServiceRuntimeRegistry>,
        listener,
      ) {
        const cleanup = originalSubscribe.call(this, listener);
        this.registerTarget({
          pid: 7422,
          agentId: 'codex',
          sessionId: 'session-direct-blocked-sibling',
          connectedServicesBindingsRaw: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': { source: 'connected', selection: 'profile', profileId: 'direct' },
            },
          },
          connectedServiceSelectionsEnv: {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
              kind: 'profile',
              serviceId: 'openai-codex',
              profileId: 'direct',
              credentialRevision: revisionA,
            }]),
          },
        });
        return cleanup;
      });
      const applyDirectCredential = vi.spyOn(
        ConnectedServiceRefreshCoordinator.prototype,
        'handleExternalCredentialUpdate',
      );
      const projection = (directCredentialRevision: string) => ({
        connectedServicesV2: [
          {
            serviceId: 'claude-subscription',
            profiles: [],
            groups: [{
              groupId: 'team',
              activeProfileId: 'claude-primary',
              generation: 1,
              memberProfileIds: ['claude-primary'],
            }],
          },
        ],
        connectedServiceCredentialRevisionsV1: [
          {
            serviceId: 'claude-subscription',
            profileId: 'claude-primary',
            credentialRevision: revisionA,
          },
          {
            serviceId: 'openai-codex',
            profileId: 'direct',
            credentialRevision: directCredentialRevision,
          },
        ],
      });
      vi.mocked(fetchAccountProfile).mockResolvedValue(
        projection(revisionA) as unknown as Awaited<ReturnType<typeof fetchAccountProfile>>,
      );

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await waitForCondition(
        () => harness.connectedServicesProjectionChangeListeners.length === 1
          && harness.getDaemonControlServerParams() !== null,
        'Expected canonical generation and control-server composition',
      );
      app = await createCapturedDaemonControlApp();
      const controlToken = readCapturedDaemonControlToken();
      const projectionController = new AbortController();
      await harness.connectedServicesProjectionChangeListeners[0]?.({
        source: 'changes',
        executionAuthority: 'passive_projection',
        signal: projectionController.signal,
        ...projection(revisionA),
      });

      const blockedSibling = createDeferred<void>();
      applyDirectCredential.mockClear().mockImplementation(async () => {
        await blockedSibling.promise;
      });
      const projectionB = projection(revisionB);
      vi.mocked(fetchAccountProfile).mockResolvedValue(
        projectionB as unknown as Awaited<ReturnType<typeof fetchAccountProfile>>,
      );
      const aggregateReconciliation = Promise.resolve(
        harness.connectedServicesProjectionChangeListeners[0]?.({
          source: 'changes',
          executionAuthority: 'passive_projection',
          signal: projectionController.signal,
          ...projectionB,
        }),
      );
      await waitForCondition(
        () => applyDirectCredential.mock.calls.length === 1,
        'Expected the unrelated direct-credential sibling to block aggregate reconciliation',
      );

      const newcomer = createDaemonGroupBoundClaudeTrackedSession(newcomerPid);
      webhook.installTrackedSession(newcomer);

      const newcomerResponsePromise = app.inject({
        method: 'POST',
        url: '/session-started',
        headers: { 'x-happier-daemon-token': controlToken },
        payload: {
          sessionId: 'session-claude-exact-newcomer',
          metadata: createDaemonClaudeReadinessMetadata(newcomerPid),
        },
      });
      const newcomerOutcome = await Promise.race([
        newcomerResponsePromise.then((response) => ({ kind: 'response' as const, response })),
        new Promise<{ kind: 'blocked' }>((resolve) => {
          setTimeout(() => resolve({ kind: 'blocked' }), 250);
        }),
      ]);
      blockedSibling.resolve();
      expect(newcomerOutcome.kind).toBe('response');
      if (newcomerOutcome.kind !== 'response') return;
      expect(newcomerOutcome.response.statusCode).toBe(200);
      expect(newcomerOutcome.response.json()).toEqual({ status: 'ok' });
      await aggregateReconciliation;
    } finally {
      if (app) await app.close();
      harness.requestShutdown('happier-cli');
      if (run) await run;
      exitSpy.mockRestore();
    }
  });

  it.each([
    [
      'fetches fresh truth for strict Claude startup after failed passive reconciliation',
      {
        passiveProfileId: 'claude-primary',
        passiveGeneration: 1,
        passiveCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      },
    ],
    [
      'fetches fresh truth for strict Claude startup after successful passive legacy reconciliation',
      {
        passiveProfileId: 'lb_bat',
        passiveGeneration: 274,
        passiveCredentialRevision: null,
      },
    ],
  ] as const)('%s', async (_name, {
    passiveProfileId,
    passiveGeneration,
    passiveCredentialRevision,
  }) => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const pid = 7424;
    let run: Promise<void> | null = null;
    let app: Awaited<ReturnType<typeof createCapturedDaemonControlApp>> | null = null;
    harness.setAutoShutdownAfterAutomationStart(false);
    harness.setActiveAccountSettingsSnapshot(sharedClaudeAccountSettingsSnapshot());

    try {
      const webhook = await installActualDaemonClaudeReadinessWebhook(pid);
      const tracked = createDaemonGroupBoundClaudeTrackedSession(pid);
      if (!tracked.spawnOptions) throw new Error('Expected Claude spawn options');
      tracked.spawnOptions = {
        ...tracked.spawnOptions,
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'claude-subscription',
            groupId: 'team',
            activeProfileId: 'lb_bat',
            fallbackProfileId: 'claude-backup',
            generation: 274,
          }]),
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': {
              source: 'connected',
              selection: 'group',
              groupId: 'team',
              profileId: 'lb_bat',
            },
          },
        },
      };
      const { fetchAccountProfile } = await import('@/api/accountProfile');
      vi.mocked(fetchAccountProfile).mockResolvedValue({
        connectedServicesV2: [{
          serviceId: 'claude-subscription',
          profiles: [{
            profileId: 'lb_bat',
            status: 'connected',
          }],
          groups: [{
            groupId: 'team',
            activeProfileId: 'lb_bat',
            generation: 274,
            memberProfileIds: ['lb_bat'],
          }],
        }],
        // Released v0.2.1 credentials predate revision fencing.
        connectedServiceCredentialRevisionsV1: [],
      } as unknown as Awaited<ReturnType<typeof fetchAccountProfile>>);
      const { callSessionRpc } = await import('@/session/transport/rpc/sessionRpc');
      vi.mocked(callSessionRpc).mockReset();

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await waitForCondition(
        () => harness.connectedServicesProjectionChangeListeners.length === 1
          && harness.getDaemonControlServerParams() !== null,
        'Expected canonical generation and control-server composition',
      );
      await harness.connectedServicesProjectionChangeListeners[0]?.({
        source: 'passive-projection-before-strict-startup',
        executionAuthority: 'passive_projection',
        signal: new AbortController().signal,
        connectedServicesV2: [{
          serviceId: 'claude-subscription',
          profiles: [{
            profileId: passiveProfileId,
            status: 'connected',
          }],
          groups: [{
            groupId: 'team',
            activeProfileId: passiveProfileId,
            generation: passiveGeneration,
            memberProfileIds: [passiveProfileId],
          }],
        }],
        connectedServiceCredentialRevisionsV1: passiveCredentialRevision
          ? [{
              serviceId: 'claude-subscription',
              profileId: passiveProfileId,
              credentialRevision: passiveCredentialRevision,
            }]
          : [],
      });
      webhook.installTrackedSession(tracked);
      app = await createCapturedDaemonControlApp();
      const controlToken = readCapturedDaemonControlToken();

      const response = await app.inject({
        method: 'POST',
        url: '/session-started',
        headers: { 'x-happier-daemon-token': controlToken },
        payload: {
          sessionId: 'session-claude-legacy-fresh-registration',
          metadata: createDaemonClaudeReadinessMetadata(pid),
        },
      });

      expect(fetchAccountProfile).toHaveBeenCalled();
      expect(harness.applyClaudeSharedGroupGenerationApplication).not.toHaveBeenCalled();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
      expect(webhook.getTrackedSession()).toMatchObject({
        happySessionId: 'session-claude-legacy-fresh-registration',
        spawnOptions: {
          connectedServiceMaterializationIdentityV1: expect.objectContaining({
            id: `csm_claude_readiness_${pid}`,
          }),
        },
      });
      expect(callSessionRpc).not.toHaveBeenCalled();
    } finally {
      if (app) await app.close();
      harness.requestShutdown('happier-cli');
      if (run) await run;
      exitSpy.mockRestore();
    }
  });

  it('returns retryable Pi startup failures while preserving conflicting request-time broker truth', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const startupPid = 7430;
    const conflictPid = 7431;
    const unavailablePid = 7432;
    const startupIdentity = 'pi|connected|broker:1|openai-codex:batiplus:startup';
    const conflictIdentity = 'pi|connected|broker:1|openai-codex:batiplus:conflict';
    const unavailableIdentity = 'pi|connected|broker:1|openai-codex:batiplus:unavailable';
    const startupTracked = createDaemonGroupBoundPiTrackedSession(startupPid, startupIdentity);
    let run: Promise<void> | null = null;
    let app: Awaited<ReturnType<typeof createCapturedDaemonControlApp>> | null = null;
    harness.setAutoShutdownAfterAutomationStart(false);

    try {
      const webhook = await installActualDaemonPiReadinessWebhook(startupTracked);
      const { fetchAccountProfile } = await import('@/api/accountProfile');
      const brokerSelections = await import(
        './connectedServices/broker/brokerBridgeEffectiveSelectionRegistry'
      );
      brokerSelections.resetBrokerBridgeEffectiveSelectionsForTests();
      vi.mocked(fetchAccountProfile).mockResolvedValue({
        connectedServicesV2: [{
          serviceId: 'openai-codex',
          profiles: [],
          groups: [{
            groupId: 'happier',
            activeProfileId: 'batiplus',
            generation: 1_203,
            memberProfileIds: ['batiplus'],
          }],
        }],
        connectedServiceCredentialRevisionsV1: [{
          serviceId: 'openai-codex',
          profileId: 'batiplus',
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        }],
      } as unknown as Awaited<ReturnType<typeof fetchAccountProfile>>);

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await waitForCondition(
        () => harness.connectedServicesProjectionChangeListeners.length === 1
          && harness.getDaemonControlServerParams() !== null,
        'Expected canonical Pi generation and control-server composition',
      );
      app = await createCapturedDaemonControlApp();
      const controlToken = readCapturedDaemonControlToken();
      const report = async (sessionId: string, pid: number) => await app!.inject({
        method: 'POST',
        url: '/session-started',
        headers: { 'x-happier-daemon-token': controlToken },
        payload: { sessionId, metadata: createDaemonPiReadinessMetadata(pid) },
      });

      await expect(report('session-pi-empty-broker-cache', startupPid)).resolves.toMatchObject({ statusCode: 200 });
      expect(brokerSelections.getBrokerBridgeEffectiveSelection({
        selectionIdentity: startupIdentity,
        serviceId: 'openai-codex',
      })).toBeNull();

      brokerSelections.updateBrokerBridgeEffectiveSelection({
        selectionIdentity: conflictIdentity,
        serviceId: 'openai-codex',
        selection: {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'happier',
          activeProfileId: 'stale',
          fallbackProfileId: 'batiplus',
          generation: 1_202,
          credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
          credentialFingerprint: 'sha256:deadbeef',
        },
      });
      webhook.installTrackedSession(createDaemonGroupBoundPiTrackedSession(conflictPid, conflictIdentity));
      const { logger } = await import('@/ui/logger');
      const conflictWarningBaseline = vi.mocked(logger.warn).mock.calls.length;
      const conflictResponse = await report('session-pi-conflicting-broker-cache', conflictPid);
      expect(conflictResponse.statusCode).toBe(503);
      expect(conflictResponse.json()).toEqual({
        status: 'error',
        errorCode: 'session_startup_reconciliation_failed',
      });
      await waitForCondition(
        () => vi.mocked(logger.warn).mock.calls.length > conflictWarningBaseline,
        'Expected conflicting broker truth to remain retryable after startup failure',
      );
      expect(brokerSelections.getBrokerBridgeEffectiveSelection({
        selectionIdentity: conflictIdentity,
        serviceId: 'openai-codex',
      })).toMatchObject({
        availability: 'available',
        selection: expect.objectContaining({
          groupId: 'happier',
          activeProfileId: 'stale',
          generation: 1_202,
          credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
        }),
      });

      brokerSelections.markBrokerBridgeEffectiveSelectionUnavailable({
        selectionIdentity: unavailableIdentity,
        serviceId: 'openai-codex',
        groupId: 'happier',
        unavailableReason: 'active_profile_missing',
      });
      webhook.installTrackedSession(createDaemonGroupBoundPiTrackedSession(unavailablePid, unavailableIdentity));
      const unavailableWarningBaseline = vi.mocked(logger.warn).mock.calls.length;
      const unavailableResponse = await report('session-pi-unavailable-broker-cache', unavailablePid);
      expect(unavailableResponse.statusCode).toBe(503);
      expect(unavailableResponse.json()).toEqual({
        status: 'error',
        errorCode: 'session_startup_reconciliation_failed',
      });
      await waitForCondition(
        () => vi.mocked(logger.warn).mock.calls.length > unavailableWarningBaseline,
        'Expected unavailable broker truth to remain retryable after startup failure',
      );
      expect(brokerSelections.getBrokerBridgeEffectiveSelection({
        selectionIdentity: unavailableIdentity,
        serviceId: 'openai-codex',
      })).toMatchObject({
        availability: 'unavailable',
        groupId: 'happier',
        unavailableReason: 'active_profile_missing',
      });
    } finally {
      if (app) await app.close();
      harness.requestShutdown('happier-cli');
      if (run) await run;
      exitSpy.mockRestore();
    }
  });

  it('fences a same-session replacement during awaited Claude shared proof and reconciles the exact replacement once', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const pid = 7425;
    const replacementPid = 7426;
    const bindinglessReplacementPid = 7427;
    const sessionId = 'session-claude-exact-registration';
    const oldRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const desiredRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const replacementRevision = 'csr_cccccccccccccccccccccc';
    const sharedHome = '/tmp/server/connected-services/claude-subscription/group/team';
    const proofGate = createDeferred<void>();
    let proofStartedResolved = false;
    let currentGroup = {
      serviceId: 'claude-subscription' as const,
      groupId: 'team',
      activeProfileId: 'claude-primary',
      generation: 267,
    };
    let providerSurface = {
      profileId: 'claude-primary',
      generation: 267,
      credentialRevision: oldRevision,
    };
    let run: Promise<void> | null = null;
    let app: Awaited<ReturnType<typeof createCapturedDaemonControlApp>> | null = null;
    let providerInputWait: Promise<void> | null = null;
    const fenceController = new AbortController();
    harness.setAutoShutdownAfterAutomationStart(false);

    const providerProof = () => ({
      status: 'verified' as const,
      source: 'claude_shared_group_home_provenance',
      sharedAuthSurfaceId: 'team',
      credentialRevision: providerSurface.credentialRevision,
      credentialFingerprint: 'sha256:exact-registration-shared-home',
    });
    const verifyGenerationApplication = vi.fn(async (input: Readonly<{
      profileId: string;
      generation: number;
      credentialRevision: string | null;
      environmentVariables: Readonly<Record<string, string>>;
    }>) => {
      if (input.generation === 268) {
        if (!proofStartedResolved) {
          proofStartedResolved = true;
        }
        await proofGate.promise;
      }
      return input.environmentVariables.CLAUDE_CONFIG_DIR === sharedHome
        && input.profileId === providerSurface.profileId
        && input.generation === providerSurface.generation
        && input.credentialRevision === providerSurface.credentialRevision
        ? providerProof()
        : { status: 'unavailable' as const };
    });

    try {
      const webhook = await installActualDaemonClaudeReadinessWebhook(pid);
      const { ClaudeConnectedServiceAuthGroupRequestFence } = await import(
        '@/backends/claude/connectedServices/claudeConnectedServiceAuthGroupRequestFence'
      );
      const providerInputFence = new ClaudeConnectedServiceAuthGroupRequestFence();
      const catalog = await import('@/backends/catalog');
      vi.spyOn(catalog, 'resolveConnectedServiceGenerationApplicationScope').mockResolvedValue({
        status: 'supported',
        scope: 'shared_group_auth_surface',
        ownerId: 'claude',
      });
      vi.spyOn(catalog, 'resolveConnectedServiceCredentialLifecycleDescriptor').mockResolvedValue({
        verifyGenerationApplication,
        applySharedGenerationApplication: vi.fn(async () => providerProof()),
        buildLiveGenerationCurrentTruthRequest: ({ serviceId, currentTruth }: Readonly<{
          serviceId: string;
          currentTruth: unknown;
        }>) => ({ serviceId, reason: 'exact_registration_test', authGeneration: currentTruth }),
      } as never);
      harness.getConnectedServiceAuthGroup.mockImplementation(async () => ({
        v: 1,
        ...currentGroup,
        displayName: null,
        policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        runtimeStateRevision: 0,
        state: { v: 1 },
        members: ['claude-primary', 'claude-backup'].map((profileId, index) => ({
          v: 1 as const,
          serviceId: 'claude-subscription' as const,
          groupId: 'team',
          profileId,
          enabled: true,
          priority: index + 1,
          state: { v: 1 as const },
          createdAt: index + 1,
          updatedAt: index + 1,
        })),
        createdAt: 1,
        updatedAt: 1,
      }));
      const { fetchAccountProfile } = await import('@/api/accountProfile');
      vi.mocked(fetchAccountProfile).mockResolvedValue({
        connectedServicesV2: [{
          serviceId: 'claude-subscription',
          profiles: [],
          groups: [{
            groupId: 'team',
            activeProfileId: 'claude-primary',
            generation: 267,
            memberProfileIds: ['claude-primary', 'claude-backup'],
          }],
        }],
        connectedServiceCredentialRevisionsV1: [{
          serviceId: 'claude-subscription',
          profileId: 'claude-primary',
          credentialRevision: oldRevision,
        }],
      } as never);
      const { callSessionRpc } = await import('@/session/transport/rpc/sessionRpc');
      const deliveredTruth: unknown[] = [];
      vi.mocked(callSessionRpc).mockReset().mockImplementation(async ({ request }) => {
        const truth = (request as { authGeneration?: unknown }).authGeneration;
        deliveredTruth.push(truth);
        providerInputFence.applyCurrentTruth(truth as Parameters<typeof providerInputFence.applyCurrentTruth>[0]);
        return { ok: true, appliedVia: 'current_truth_fence' };
      });
      const switchModule = await import(
        './connectedServices/sessionAuthSwitch/switchSessionConnectedServiceAuth'
      );
      const staleApplySpy = vi.spyOn(switchModule, 'switchSessionConnectedServiceAuth').mockResolvedValue({
        ok: false,
        errorCode: 'stale_runtime_target_apply_attempt',
      } as never);
      const { ConnectedServiceRuntimeRegistry } = await import('./connectedServices/runtimeRegistry/registry');
      let runtimeRegistry: InstanceType<typeof ConnectedServiceRuntimeRegistry> | null = null;
      const originalRegisterTarget = ConnectedServiceRuntimeRegistry.prototype.registerTarget;
      const registerTargetSpy = vi.spyOn(ConnectedServiceRuntimeRegistry.prototype, 'registerTarget').mockImplementation(function (
        this: InstanceType<typeof ConnectedServiceRuntimeRegistry>,
        input,
      ) {
        runtimeRegistry = this;
        return originalRegisterTarget.call(this, input);
      });

      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await Promise.race([
        waitForCondition(
          () => harness.connectedServicesProjectionChangeListeners.length === 1
            && harness.getDaemonControlServerParams() !== null,
          'Expected canonical generation and control-server composition',
        ),
        run.then(() => {
          throw new Error('Daemon exited before exact-registration test composition');
        }),
      ]);
      app = await createCapturedDaemonControlApp();
      const controlToken = readCapturedDaemonControlToken();
      const tracked = webhook.getTrackedSession();
      tracked.spawnOptions = {
        ...tracked.spawnOptions,
        directory: tracked.spawnOptions?.directory ?? '/tmp/claude-readiness',
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': {
              source: 'connected', selection: 'group', groupId: 'team', profileId: 'claude-primary',
            },
          },
        },
        environmentVariables: {
          CLAUDE_CONFIG_DIR: sharedHome,
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'claude-subscription',
            groupId: 'team',
            activeProfileId: 'claude-primary',
            fallbackProfileId: 'claude-backup',
            generation: 267,
            credentialRevision: oldRevision,
          }]),
        },
      };

      await expect(app.inject({
        method: 'POST',
        url: '/session-started',
        headers: { 'x-happier-daemon-token': controlToken },
        payload: { sessionId, metadata: createDaemonClaudeReadinessMetadata(pid) },
      })).resolves.toMatchObject({ statusCode: 200 });
      const baselineRegisterCallCount = registerTargetSpy.mock.calls.length;
      expect(baselineRegisterCallCount).toBeGreaterThan(0);
      deliveredTruth.splice(0, deliveredTruth.length);
      staleApplySpy.mockClear();

      providerInputFence.applyCurrentTruth({
        kind: 'current_auth_group_unavailable',
        groupId: 'replacement',
        unavailableReason: 'group_missing',
      });
      let providerInputReleased = false;
      providerInputWait = providerInputFence.waitUntilAvailable(fenceController.signal).then(
        () => { providerInputReleased = true; },
        () => undefined,
      );

      currentGroup = { ...currentGroup, activeProfileId: 'claude-backup', generation: 268 };
      providerSurface = {
        profileId: 'claude-backup',
        generation: 268,
        credentialRevision: desiredRevision,
      };
      const projectionPromise = Promise.resolve(harness.connectedServicesProjectionChangeListeners[0]?.({
        source: 'exact-registration-generation-268',
        executionAuthority: 'passive_projection',
        signal: new AbortController().signal,
        connectedServicesV2: [{
          serviceId: 'claude-subscription',
          profiles: [],
          groups: [{
            groupId: 'team',
            activeProfileId: 'claude-backup',
            generation: 268,
            memberProfileIds: ['claude-primary', 'claude-backup'],
          }],
        }],
        connectedServiceCredentialRevisionsV1: [{
          serviceId: 'claude-subscription',
          profileId: 'claude-backup',
          credentialRevision: desiredRevision,
        }],
      }));
      await waitForCondition(
        () => proofStartedResolved,
        'Expected generation 268 shared proof to start',
      );

      const replacementTracked = createDaemonGroupBoundClaudeTrackedSession(replacementPid);
      replacementTracked.spawnOptions = {
        ...replacementTracked.spawnOptions,
        directory: replacementTracked.spawnOptions?.directory ?? '/tmp/claude-readiness',
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': {
              source: 'connected', selection: 'group', groupId: 'replacement', profileId: 'claude-replacement',
            },
          },
        },
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'group',
            serviceId: 'claude-subscription',
            groupId: 'replacement',
            activeProfileId: 'claude-replacement',
            fallbackProfileId: null,
            generation: 1,
            credentialRevision: replacementRevision,
          }]),
        },
      };
      webhook.installTrackedSession(replacementTracked);
      const replacementResponsePromise = app.inject({
        method: 'POST',
        url: '/session-started',
        headers: { 'x-happier-daemon-token': controlToken },
        payload: { sessionId, metadata: createDaemonClaudeReadinessMetadata(replacementPid) },
      });
      await waitForCondition(
        () => registerTargetSpy.mock.calls.length > baselineRegisterCallCount,
        'Expected exact same-session replacement registration during provider proof',
      );
      proofGate.resolve();

      await expect(projectionPromise).resolves.toBeUndefined();
      await expect(replacementResponsePromise).resolves.toMatchObject({ statusCode: 200 });
      await waitForCondition(
        () => deliveredTruth.length === 1,
        'Expected replacement current truth to settle after startup ACK',
      );
      expect(staleApplySpy).not.toHaveBeenCalled();
      expect(deliveredTruth).toEqual([{
        kind: 'current_auth_group_unavailable',
        groupId: 'replacement',
        unavailableReason: 'group_missing',
      }]);
      expect(providerInputReleased).toBe(false);
      expect(registerTargetSpy.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
        pid: replacementPid,
        sessionId,
      }));

      await expect(app.inject({
        method: 'POST',
        url: '/session-started',
        headers: { 'x-happier-daemon-token': controlToken },
        payload: { sessionId, metadata: createDaemonClaudeReadinessMetadata(replacementPid) },
      })).resolves.toMatchObject({ statusCode: 200 });
      expect(deliveredTruth).toHaveLength(1);
      expect(registerTargetSpy.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
        pid: replacementPid,
        sessionId,
      }));

      const bindinglessReplacement = createDaemonGroupBoundClaudeTrackedSession(bindinglessReplacementPid);
      bindinglessReplacement.spawnOptions = {
        ...bindinglessReplacement.spawnOptions,
        directory: bindinglessReplacement.spawnOptions?.directory ?? '/tmp/claude-readiness',
        connectedServices: { v: 1, bindingsByServiceId: {} },
        environmentVariables: {},
      };
      webhook.installTrackedSession(bindinglessReplacement);
      await expect(app.inject({
        method: 'POST',
        url: '/session-started',
        headers: { 'x-happier-daemon-token': controlToken },
        payload: { sessionId, metadata: createDaemonClaudeReadinessMetadata(bindinglessReplacementPid) },
      })).resolves.toMatchObject({ statusCode: 200 });
      expect(deliveredTruth).toHaveLength(1);
      expect(runtimeRegistry!.getBySessionId(sessionId)).toBeNull();
      expect(runtimeRegistry!.listTargets().some((target) => target.sessionId === sessionId)).toBe(false);
    } finally {
      proofGate.resolve();
      fenceController.abort();
      if (providerInputWait) await providerInputWait.catch(() => undefined);
      if (app) await app.close();
      harness.requestShutdown('happier-cli');
      if (run) await run;
      exitSpy.mockRestore();
    }
  });

  it('retries a failed live projection application before advancing its reconciliation baseline', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);
    const credentialRevisionA = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const credentialRevisionB = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    try {
      const { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } = await import(
        './connectedServices/connectedServiceChildEnvironment'
      );
      const { ConnectedServiceRuntimeRegistry } = await import('./connectedServices/runtimeRegistry/registry');
      const { ConnectedServiceRefreshCoordinator } = await import(
        './connectedServices/refresh/ConnectedServiceRefreshCoordinator'
      );
      const originalSubscribe = ConnectedServiceRuntimeRegistry.prototype.onTargetRegistration;
      vi.spyOn(ConnectedServiceRuntimeRegistry.prototype, 'onTargetRegistration').mockImplementation(function (
        this: InstanceType<typeof ConnectedServiceRuntimeRegistry>,
        listener,
      ) {
        const cleanup = originalSubscribe.call(this, listener);
        this.registerTarget({
          pid: 7411,
          agentId: 'codex',
          sessionId: 'initial-runtime-target',
          connectedServicesBindingsRaw: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': { source: 'connected', selection: 'profile', profileId: 'direct' },
            },
          },
          connectedServiceSelectionsEnv: {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
              kind: 'profile',
              serviceId: 'openai-codex',
              profileId: 'direct',
              credentialRevision: credentialRevisionA,
            }]),
          },
        });
        return cleanup;
      });
      const applySpy = vi.spyOn(
        ConnectedServiceRefreshCoordinator.prototype,
        'handleExternalCredentialUpdate',
      );
      const { startDaemon } = await import('./startDaemon');
      const run = startDaemon();
      await waitForCondition(
        () => harness.connectedServicesProjectionChangeListeners.length === 1,
        'Expected connected-services projection composition',
      );
      applySpy.mockClear();
      applySpy.mockRejectedValueOnce(new Error('temporary live credential failure'));
      const { fetchSessionsPage } = await import('@/session/transport/http/sessionsHttp');
      vi.mocked(fetchSessionsPage).mockClear();
      const signal = new AbortController().signal;

      const projection = {
        source: 'startup',
        executionAuthority: 'passive_projection' as const,
        signal,
        connectedServicesV2: [],
        connectedServiceCredentialRevisionsV1: [{
          serviceId: 'openai-codex',
          profileId: 'direct',
          credentialRevision: credentialRevisionB,
        }],
      };

      await expect(harness.connectedServicesProjectionChangeListeners[0]?.(projection))
        .rejects.toThrow('temporary live credential failure');
      await expect(harness.connectedServicesProjectionChangeListeners[0]?.(projection)).resolves.toBeUndefined();
      await expect(harness.connectedServicesProjectionChangeListeners[0]?.(projection)).resolves.toBeUndefined();

      expect(applySpy).toHaveBeenCalledTimes(2);
      expect(applySpy).toHaveBeenLastCalledWith({
        serviceId: 'openai-codex',
        profileId: 'direct',
        credentialBoundary: {
          status: 'present',
          revisionSemantics: 'revisioned',
          credentialRevision: credentialRevisionB,
        },
        executionAuthority: 'passive_projection',
      });
      expect(fetchSessionsPage).not.toHaveBeenCalled();
      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('reconciles generation 268 through the real /v2 cursor owner before acknowledging exact direct and shared proof', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);
    const oldRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const desiredRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const directOldRevision = 'csr_cccccccccccccccccccccc';
    const directDesiredRevision = 'csr_dddddddddddddddddddddd';
    const sharedHome = '/tmp/server/connected-services/claude-subscription/group/team';
    const stableClaudePids = [7422, 7423] as const;
    const directPid = 7421;
    let runtimeRegistry: InstanceType<typeof import('./connectedServices/runtimeRegistry/registry').ConnectedServiceRuntimeRegistry> | null = null;
    let currentGroup = {
      serviceId: 'claude-subscription' as const,
      groupId: 'team',
      activeProfileId: 'claude-primary',
      generation: 267,
    };
    let providerSurface = {
      profileId: 'claude-primary',
      generation: 267,
      credentialRevision: oldRevision,
    };
    let loseFirstApplyResponse = true;
    let lateReplacementRegistered = false;
    let unavailableProofCount = 0;
    let passiveDaemonReplacementCount = 0;
    let daemonRuntimeRegistryCount = 0;
    let daemonTrackedSessionsByPid: Map<number, TrackedSession> | null = null;
    let replacementProviderInputAbortController: AbortController | null = null;
    let replacementProviderInputWait: Promise<void> | null = null;
    let run: Promise<void> | null = null;
    const webhookModule = await import('./sessions/onHappySessionWebhook');
    vi.mocked(webhookModule.createOnHappySessionWebhook).mockImplementation((params) => {
      daemonTrackedSessionsByPid = params.pidToTrackedSession;
      return vi.fn();
    });

    const providerProof = () => ({
      status: 'verified' as const,
      source: 'claude_shared_group_home_provenance',
      sharedAuthSurfaceId: 'team',
      credentialRevision: providerSurface.credentialRevision,
      credentialFingerprint: 'sha256:f092-shared-home',
    });
    const verifyGenerationApplication = vi.fn(async (input: Readonly<{
      profileId: string;
      generation: number;
      credentialRevision: string | null;
      environmentVariables: Readonly<Record<string, string>>;
    }>) => {
      const verified = input.environmentVariables.CLAUDE_CONFIG_DIR === sharedHome
        && input.profileId === providerSurface.profileId
        && input.generation === providerSurface.generation
        && input.credentialRevision === providerSurface.credentialRevision;
      if (!verified) {
        unavailableProofCount += 1;
        return { status: 'unavailable' as const };
      }
      if (input.generation === 268 && runtimeRegistry && !lateReplacementRegistered) {
        lateReplacementRegistered = true;
        const tracked = createDaemonGroupBoundClaudeTrackedSession(7424);
        daemonTrackedSessionsByPid?.set(7424, {
          ...tracked,
          happySessionId: 'f092-claude-late',
          happySessionMetadataFromLocalWebhook: createDaemonClaudeReadinessMetadata(7424),
        });
        runtimeRegistry.registerTarget({
          pid: 7424,
          agentId: 'claude',
          sessionId: 'f092-claude-late',
          connectedServicesBindingsRaw: {
            v: 1,
            bindingsByServiceId: {
              'claude-subscription': {
                source: 'connected', selection: 'group', groupId: 'team', profileId: 'claude-primary',
              },
            },
          },
          connectedServiceSelectionsEnv: {
            CLAUDE_CONFIG_DIR: sharedHome,
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
              kind: 'group',
              serviceId: 'claude-subscription',
              groupId: 'team',
              activeProfileId: 'claude-primary',
              fallbackProfileId: 'claude-backup',
              generation: 267,
              credentialRevision: oldRevision,
            }]),
          },
        });
      }
      return providerProof();
    });
    const applySharedGenerationApplication = vi.fn(async (input: Readonly<{
      profileId: string;
      generation: number;
      credentialRevision: string;
    }>) => {
      providerSurface = {
        profileId: input.profileId,
        generation: input.generation,
        credentialRevision: input.credentialRevision,
      };
      if (loseFirstApplyResponse) {
        loseFirstApplyResponse = false;
        throw new Error('provider effect committed but response was lost');
      }
      return providerProof();
    });

    try {
      const { buildConnectedServiceCredentialRecord } = await import('@happier-dev/protocol');
      const credentialRecord = buildConnectedServiceCredentialRecord({
        now: 1_000,
        serviceId: 'claude-subscription',
        profileId: 'claude-backup',
        kind: 'oauth',
        oauth: {
          accessToken: 'f092-access-token',
          refreshToken: 'f092-refresh-token',
          idToken: null,
          scope: null,
          tokenType: null,
          providerAccountId: null,
          providerEmail: null,
        },
      });
      harness.getConnectedServiceAuthGroup.mockImplementation(async () => ({
        v: 1,
        ...currentGroup,
        displayName: null,
        policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        runtimeStateRevision: 0,
        state: { v: 1 },
        members: ['claude-primary', 'claude-backup'].map((profileId, index) => ({
          v: 1 as const,
          serviceId: 'claude-subscription' as const,
          groupId: 'team',
          profileId,
          enabled: true,
          priority: index + 1,
          state: { v: 1 as const },
          createdAt: index + 1,
          updatedAt: index + 1,
        })),
        createdAt: 1,
        updatedAt: 1,
      }));
      harness.getConnectedServiceCredentialPlain.mockResolvedValue({
        revisionSemantics: 'revisioned',
        credentialRevision: desiredRevision,
        content: { t: 'plain', v: credentialRecord },
      });

      const catalog = await import('@/backends/catalog');
      vi.mocked(catalog.resolveCatalogAgentId).mockReturnValue('claude');
      await expect(catalog.resolveConnectedServiceGenerationApplicationScope(
        'claude-subscription',
        'claude',
      )).resolves.toEqual({
        status: 'supported',
        scope: 'shared_group_auth_surface',
        ownerId: 'claude',
      });
      const claudeLifecycleDescriptor = await catalog.resolveConnectedServiceCredentialLifecycleDescriptor('claude');
      expect(claudeLifecycleDescriptor).toMatchObject({
        providerId: 'claude',
        serviceIds: expect.arrayContaining(['claude-subscription']),
        generationApplicationScope: 'shared_group_auth_surface',
        sharedGenerationApplicationServiceIds: expect.arrayContaining(['claude-subscription']),
      });
      expect(claudeLifecycleDescriptor.verifyGenerationApplication)
        .toBe(harness.verifyClaudeSharedGroupGenerationApplication);
      expect(claudeLifecycleDescriptor.applySharedGenerationApplication)
        .toBe(harness.applyClaudeSharedGroupGenerationApplication);
      harness.verifyClaudeSharedGroupGenerationApplication.mockImplementation(verifyGenerationApplication);
      harness.applyClaudeSharedGroupGenerationApplication.mockImplementation(applySharedGenerationApplication);

      const { ConnectedServiceRuntimeRegistry } = await import('./connectedServices/runtimeRegistry/registry');
      const claudeRuntimeInput = (
        pid: number,
        index: number,
        identity: Readonly<{
          profileId: string;
          generation: number;
          credentialRevision: string;
        }> = {
          profileId: 'claude-primary',
          generation: 267,
          credentialRevision: oldRevision,
        },
      ) => ({
        pid,
        agentId: 'claude' as const,
        sessionId: `f092-claude-${index + 1}`,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
              'claude-subscription': {
                source: 'connected' as const,
                selection: 'group' as const,
                groupId: 'team',
                profileId: identity.profileId,
              },
            },
          },
        connectedServiceSelectionsEnv: {
          CLAUDE_CONFIG_DIR: sharedHome,
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
              kind: 'group',
              serviceId: 'claude-subscription',
              groupId: 'team',
              activeProfileId: identity.profileId,
              fallbackProfileId: 'claude-backup',
              generation: identity.generation,
              credentialRevision: identity.credentialRevision,
            }]),
          },
        });
      const originalSubscribe = ConnectedServiceRuntimeRegistry.prototype.onTargetRegistration;
      vi.spyOn(ConnectedServiceRuntimeRegistry.prototype, 'onTargetRegistration').mockImplementation(function (
        this: InstanceType<typeof ConnectedServiceRuntimeRegistry>,
        listener,
      ) {
        runtimeRegistry = this;
        daemonRuntimeRegistryCount += 1;
        const cleanup = originalSubscribe.call(this, listener);
        if (daemonRuntimeRegistryCount === 1) {
          this.registerTarget({
            pid: directPid,
            agentId: 'codex',
            sessionId: 'f092-codex-direct',
            connectedServicesBindingsRaw: {
              v: 1,
              bindingsByServiceId: {
                'openai-codex': {
                  source: 'connected', selection: 'profile', profileId: 'direct',
                },
              },
            },
            connectedServiceSelectionsEnv: {
              [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                kind: 'profile',
                serviceId: 'openai-codex',
                profileId: 'direct',
                credentialRevision: directOldRevision,
              }]),
            },
          });
          for (const [index, pid] of stableClaudePids.entries()) {
            this.registerTarget(claudeRuntimeInput(pid, index));
          }
        }
        return cleanup;
      });

      const { callSessionRpc } = await import('@/session/transport/rpc/sessionRpc');
      const { fetchSessionById } = await import('@/session/transport/http/sessionsHttp');
      vi.mocked(fetchSessionById).mockImplementation(async ({ sessionId }) => ({
        id: sessionId,
        active: true,
        activeAt: 1,
        metadata: null,
      }) as never);
      const { ClaudeConnectedServiceAuthGroupRequestFence } = await import(
        '@/backends/claude/connectedServices/claudeConnectedServiceAuthGroupRequestFence'
      );
      const providerInputFence = new ClaudeConnectedServiceAuthGroupRequestFence();
      vi.mocked(callSessionRpc).mockImplementation(async ({ request }) => {
        const truth = (request as { authGeneration?: unknown }).authGeneration;
        if (
          typeof truth === 'object'
          && truth !== null
          && (truth as { kind?: unknown }).kind === 'current_auth_group_available'
          && (truth as { groupId?: unknown }).groupId === 'team'
          && (truth as { generation?: unknown }).generation === 268
          && (truth as { credentialRevision?: unknown }).credentialRevision === desiredRevision
        ) {
          providerInputFence.applyCurrentTruth(
            truth as Parameters<typeof providerInputFence.applyCurrentTruth>[0],
          );
        }
        return { ok: true, appliedVia: 'current_truth_fence' };
      });
      const { spawnHappyCLI } = await import('@/utils/spawnHappyCLI');
      const { ConnectedServiceRefreshCoordinator } = await import(
        './connectedServices/refresh/ConnectedServiceRefreshCoordinator'
      );
      const directApplySpy = vi.spyOn(
        ConnectedServiceRefreshCoordinator.prototype,
        'handleExternalCredentialUpdate',
      );
      const { ApiMachineClient } = await import('@/api/apiMachine');
      const realApiMachine = new ApiMachineClient(
        automationCredentials.token,
        createRegisteredMachine('machine-automation'),
      );
      vi.spyOn(realApiMachine, 'connect').mockImplementation(() => {});
      vi.spyOn(realApiMachine, 'recoverDaemonTerminalSessionMutationJournals').mockImplementation(async () => {});
      vi.spyOn(realApiMachine, 'updateMachineMetadata').mockImplementation(async () => {});
      vi.spyOn(realApiMachine, 'updateDaemonState').mockImplementation(async () => {});
      const projectionRegistrationSpy = vi.spyOn(realApiMachine, 'onConnectedServicesProjectionChange');
      harness.setMachineSyncClientOverride(realApiMachine);

      const projectionProfile = (input: Readonly<{
        activeProfileId: string;
        generation: number;
        claudeRevision: string;
        directRevision: string;
      }>) => ({
        connectedServicesV2: [{
          serviceId: 'claude-subscription',
          profiles: [],
          groups: [{
            groupId: 'team',
            activeProfileId: input.activeProfileId,
            generation: input.generation,
            memberProfileIds: ['claude-primary', 'claude-backup'],
          }],
        }],
        connectedServiceCredentialRevisionsV1: [{
          serviceId: 'claude-subscription',
          profileId: input.activeProfileId,
          credentialRevision: input.claudeRevision,
        }, {
          serviceId: 'openai-codex',
          profileId: 'direct',
          credentialRevision: input.directRevision,
        }],
      });
      const baselineProfile = projectionProfile({
        activeProfileId: 'claude-primary',
        generation: 267,
        claudeRevision: oldRevision,
        directRevision: directOldRevision,
      });
      const generation268Profile = projectionProfile({
        activeProfileId: 'claude-backup',
        generation: 268,
        claudeRevision: desiredRevision,
        directRevision: directDesiredRevision,
      });
      let profileReadCount = 0;
      const { fetchAccountProfile } = await import('@/api/accountProfile');
      vi.mocked(fetchAccountProfile).mockImplementation(async () => (
        profileReadCount++ === 0 ? baselineProfile : generation268Profile
      ) as never);
      harness.readAccountChangesCursor.mockResolvedValue(267);
      harness.axiosGet.mockImplementation(async (url: string) => {
        if (url.includes('/v1/account/profile')) {
          return { status: 200, data: { id: 'account-f092' } };
        }
        if (url.includes('/v2/changes')) {
          return {
            status: 200,
            data: {
              changes: [{
                cursor: 268,
                kind: 'account',
                entityId: 'self',
                changedAt: 268,
                hint: { connectedServices: true },
              }],
              nextCursor: 268,
            },
          };
        }
        throw new Error(`Unexpected HTTP request in generation-268 composition: ${url}`);
      });
      const killSpy = vi.spyOn(process, 'kill');
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await waitForCondition(
        () => projectionRegistrationSpy.mock.calls.length === 1 && runtimeRegistry !== null,
        'Expected the real ApiMachine projection registration and live runtime registry',
      );
      const apiMachineProjectionOwner = realApiMachine as unknown as {
        notifyConnectedServicesProjectionChange(input: Readonly<{
          source: 'startup';
          executionAuthority: 'passive_projection';
          signal: AbortSignal;
          connectedServicesV2: unknown;
          connectedServiceCredentialRevisionsV1: unknown;
        }>): Promise<void>;
        syncChangesOnConnect(input: Readonly<{ reason: 'reconnect' }>): Promise<void>;
      };
      await apiMachineProjectionOwner.notifyConnectedServicesProjectionChange({
        source: 'startup',
        executionAuthority: 'passive_projection',
        signal: new AbortController().signal,
        connectedServicesV2: baselineProfile.connectedServicesV2,
        connectedServiceCredentialRevisionsV1: baselineProfile.connectedServiceCredentialRevisionsV1,
      });
      vi.mocked(callSessionRpc).mockClear();
      verifyGenerationApplication.mockClear();
      applySharedGenerationApplication.mockClear();
      directApplySpy.mockClear();
      harness.writeAccountChangesCursor.mockClear();
      vi.mocked(spawnHappyCLI).mockClear();
      killSpy.mockClear();

      currentGroup = {
        ...currentGroup,
        activeProfileId: 'claude-backup',
        generation: 268,
      };
      await expect(apiMachineProjectionOwner.syncChangesOnConnect({ reason: 'reconnect' }))
        .resolves.toBeUndefined();
      expect(runtimeRegistry!.getByPid(stableClaudePids[0])).toMatchObject({
        pid: stableClaudePids[0],
        sessionId: 'f092-claude-1',
      });
      expect(applySharedGenerationApplication).toHaveBeenCalledOnce();
      expect(unavailableProofCount).toBeGreaterThan(0);
      expect(harness.writeAccountChangesCursor).toHaveBeenCalledWith('account-f092', 268);
      expect(directApplySpy).not.toHaveBeenCalled();
      expect(callSessionRpc).not.toHaveBeenCalled();
      expect(vi.mocked(spawnHappyCLI)).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
      expect(runtimeRegistry!.listTargets().map((target) => target.pid)).toEqual([
        directPid,
        ...stableClaudePids,
      ]);

      expect(runtimeRegistry!.unregisterSessionTargetByPid(stableClaudePids[1])?.sessionId)
        .toBe('f092-claude-2');
      runtimeRegistry!.registerTarget(claudeRuntimeInput(stableClaudePids[1], 1));

      await expect(apiMachineProjectionOwner.syncChangesOnConnect({ reason: 'reconnect' })).resolves.toBeUndefined();
      await waitForCondition(
        () => vi.mocked(callSessionRpc).mock.calls.some(([input]) => input.sessionId === 'f092-claude-late'),
        'Expected the registration racing reconciliation to receive current truth',
      );
      expect(applySharedGenerationApplication).toHaveBeenCalledOnce();
      expect(verifyGenerationApplication).toHaveBeenCalledWith(expect.objectContaining({
        serviceId: 'claude-subscription',
        groupId: 'team',
        profileId: 'claude-backup',
        generation: 268,
        credentialRevision: desiredRevision,
        environmentVariables: expect.objectContaining({ CLAUDE_CONFIG_DIR: sharedHome }),
      }));
      expect(directApplySpy).toHaveBeenCalledOnce();
      expect(directApplySpy).toHaveBeenCalledWith({
        serviceId: 'openai-codex',
        profileId: 'direct',
        credentialBoundary: {
          status: 'present',
          revisionSemantics: 'revisioned',
          credentialRevision: directDesiredRevision,
        },
        executionAuthority: 'passive_projection',
      });
      expect(harness.writeAccountChangesCursor).toHaveBeenCalledTimes(2);
      expect(harness.writeAccountChangesCursor).toHaveBeenCalledWith('account-f092', 268);
      expect(vi.mocked(callSessionRpc).mock.calls.map(([input]) => input.sessionId).sort()).toEqual([
        'f092-claude-1',
        'f092-claude-2',
        'f092-claude-late',
      ]);
      expect(vi.mocked(callSessionRpc).mock.calls.map(([input]) => (
        input.request as { authGeneration?: unknown }
      ).authGeneration)).toEqual([
        expect.objectContaining({
          kind: 'current_auth_group_available',
          groupId: 'team',
          generation: 268,
          credentialRevision: desiredRevision,
        }),
        expect.objectContaining({
          kind: 'current_auth_group_available',
          groupId: 'team',
          generation: 268,
          credentialRevision: desiredRevision,
        }),
        expect.objectContaining({
          kind: 'current_auth_group_available',
          groupId: 'team',
          generation: 268,
          credentialRevision: desiredRevision,
        }),
      ]);
      expect(applySharedGenerationApplication).toHaveBeenCalledOnce();
      expect(vi.mocked(callSessionRpc)).toHaveBeenCalledTimes(3);
      expect(vi.mocked(spawnHappyCLI)).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
      expect(providerSurface).toEqual({
        profileId: 'claude-backup',
        generation: 268,
        credentialRevision: desiredRevision,
      });
      expect(runtimeRegistry!.listTargets().map((target) => target.pid)).toEqual([
        directPid,
        ...stableClaudePids,
        7424,
      ]);
      expect(vi.mocked(callSessionRpc).mock.calls.some(([input]) => (
        input.sessionId === 'f092-claude-1'
        && (input.request as { authGeneration?: { generation?: unknown; credentialRevision?: unknown } }).authGeneration?.generation === 268
        && (input.request as { authGeneration?: { generation?: unknown; credentialRevision?: unknown } }).authGeneration?.credentialRevision === desiredRevision
      ))).toBe(true);
      providerInputFence.applyCurrentTruth({
        kind: 'current_auth_group_unavailable',
        groupId: 'team',
        unavailableReason: 'group_missing',
      });
      replacementProviderInputAbortController = new AbortController();
      let replacementProviderInputReleased = false;
      replacementProviderInputWait = providerInputFence.waitUntilAvailable(
        replacementProviderInputAbortController.signal,
      ).then(() => {
        replacementProviderInputReleased = true;
      });
      await Promise.resolve();
      expect(replacementProviderInputReleased).toBe(false);

      const firstDaemonRuntimeRegistry = runtimeRegistry;
      harness.requestShutdown('happier-cli');
      await run;
      run = null;
      applySharedGenerationApplication.mockClear();
      directApplySpy.mockClear();
      vi.mocked(callSessionRpc).mockClear();
      harness.writeAccountChangesCursor.mockClear();
      vi.mocked(spawnHappyCLI).mockClear();
      killSpy.mockClear();

      const replacementApiMachine = new ApiMachineClient(
        automationCredentials.token,
        createRegisteredMachine('machine-automation'),
      );
      vi.spyOn(replacementApiMachine, 'connect').mockImplementation(() => {});
      vi.spyOn(replacementApiMachine, 'recoverDaemonTerminalSessionMutationJournals').mockImplementation(async () => {});
      vi.spyOn(replacementApiMachine, 'updateMachineMetadata').mockImplementation(async () => {});
      vi.spyOn(replacementApiMachine, 'updateDaemonState').mockImplementation(async () => {});
      const replacementProjectionRegistrationSpy = vi.spyOn(
        replacementApiMachine,
        'onConnectedServicesProjectionChange',
      );
      harness.setMachineSyncClientOverride(replacementApiMachine);
      harness.readAccountChangesCursor.mockResolvedValue(268);

      run = startDaemon();
      await waitForCondition(
        () => replacementProjectionRegistrationSpy.mock.calls.length === 1
          && runtimeRegistry !== null
          && runtimeRegistry !== firstDaemonRuntimeRegistry,
        'Expected passive replacement daemon projection and fresh runtime registry',
      );
      passiveDaemonReplacementCount += 1;
      const replacementProjectionOwner = replacementApiMachine as unknown as {
        notifyConnectedServicesProjectionChange(input: Readonly<{
          source: 'startup';
          executionAuthority: 'passive_projection';
          signal: AbortSignal;
          connectedServicesV2: unknown;
          connectedServiceCredentialRevisionsV1: unknown;
        }>): Promise<void>;
      };
      const replacementProjection = {
        source: 'startup' as const,
        executionAuthority: 'passive_projection' as const,
        signal: new AbortController().signal,
        connectedServicesV2: generation268Profile.connectedServicesV2,
        connectedServiceCredentialRevisionsV1: generation268Profile.connectedServiceCredentialRevisionsV1,
      };
      await replacementProjectionOwner.notifyConnectedServicesProjectionChange(replacementProjection);
      expect(replacementProviderInputReleased).toBe(false);
      expect(applySharedGenerationApplication).not.toHaveBeenCalled();
      expect(directApplySpy).not.toHaveBeenCalled();
      expect(callSessionRpc).not.toHaveBeenCalled();
      expect(harness.writeAccountChangesCursor).not.toHaveBeenCalled();
      expect(vi.mocked(spawnHappyCLI)).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
      const survivingTrackedSession = createDaemonGroupBoundClaudeTrackedSession(stableClaudePids[0]);
      const replacementTrackedSessionsByPid = daemonTrackedSessionsByPid as Map<number, TrackedSession> | null;
      if (!replacementTrackedSessionsByPid) {
        throw new Error('Expected replacement daemon tracked-session registry');
      }
      replacementTrackedSessionsByPid.set(stableClaudePids[0], {
        ...survivingTrackedSession,
        happySessionId: 'f092-claude-1',
        happySessionMetadataFromLocalWebhook: createDaemonClaudeReadinessMetadata(stableClaudePids[0]),
      });
      const survivingTarget = runtimeRegistry!.registerTarget({
        ...claudeRuntimeInput(stableClaudePids[0], 0, {
          profileId: 'claude-backup',
          generation: 268,
          credentialRevision: desiredRevision,
        }),
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: `csm_claude_replacement_${stableClaudePids[0]}`,
          createdAtMs: 1_000,
        },
      });
      expect(survivingTarget.connectedServiceMaterializationIdentityV1).toEqual({
        v: 1,
        id: `csm_claude_replacement_${stableClaudePids[0]}`,
        createdAtMs: 1_000,
      });
      expect(survivingTarget.activeBindings).toEqual([
        expect.objectContaining({
          serviceId: 'claude-subscription',
          groupId: 'team',
          profileId: 'claude-backup',
          generation: 268,
          credentialRevision: desiredRevision,
        }),
      ]);
      await waitForCondition(
        () => replacementProviderInputReleased,
        'Expected the surviving runner provider-input fence to reopen from exact current truth',
      );
      await replacementProviderInputWait;

      expect(runtimeRegistry!.listTargets()).toEqual([
        expect.objectContaining({
          pid: stableClaudePids[0],
          sessionId: 'f092-claude-1',
          activeBindings: [expect.objectContaining({
            serviceId: 'claude-subscription',
            groupId: 'team',
            profileId: 'claude-backup',
            generation: 268,
            credentialRevision: desiredRevision,
          })],
        }),
      ]);
      expect(applySharedGenerationApplication).not.toHaveBeenCalled();
      expect(directApplySpy).not.toHaveBeenCalled();
      expect(callSessionRpc).toHaveBeenCalledOnce();
      expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'f092-claude-1',
        method: 'f092-claude-1:session.connectedServiceAuth.applyGeneration',
        request: {
          serviceId: 'claude-subscription',
          reason: 'diagnostic',
          authGeneration: {
            kind: 'current_auth_group_available',
            groupId: 'team',
            generation: 268,
            credentialRevision: desiredRevision,
          },
        },
      }));
      expect(replacementProviderInputReleased).toBe(true);
      runtimeRegistry!.registerTarget(claudeRuntimeInput(stableClaudePids[0], 0, {
        profileId: 'claude-backup',
        generation: 268,
        credentialRevision: desiredRevision,
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(callSessionRpc).toHaveBeenCalledOnce();
      expect(harness.writeAccountChangesCursor).not.toHaveBeenCalled();
      expect(vi.mocked(spawnHappyCLI)).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
      expect(passiveDaemonReplacementCount).toBe(1);
    } finally {
      replacementProviderInputAbortController?.abort();
      if (replacementProviderInputWait) await replacementProviderInputWait.catch(() => undefined);
      harness.requestShutdown('happier-cli');
      if (run) await run;
      exitSpy.mockRestore();
    }
  });

  it('passively reconciles one late direct-profile registration and dedupes an unchanged re-registration', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);
    const credentialRevisionA = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const credentialRevisionB = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    try {
      const { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } = await import(
        './connectedServices/connectedServiceChildEnvironment'
      );
      const { ConnectedServiceRuntimeRegistry } = await import('./connectedServices/runtimeRegistry/registry');
      const { ConnectedServiceRefreshCoordinator } = await import(
        './connectedServices/refresh/ConnectedServiceRefreshCoordinator'
      );
      let runtimeRegistry: InstanceType<typeof ConnectedServiceRuntimeRegistry> | null = null;
      const originalSubscribe = ConnectedServiceRuntimeRegistry.prototype.onTargetRegistration;
      vi.spyOn(ConnectedServiceRuntimeRegistry.prototype, 'onTargetRegistration').mockImplementation(function (
        this: InstanceType<typeof ConnectedServiceRuntimeRegistry>,
        listener,
      ) {
        runtimeRegistry = this;
        return originalSubscribe.call(this, listener);
      });
      const applySpy = vi.spyOn(
        ConnectedServiceRefreshCoordinator.prototype,
        'handleExternalCredentialUpdate',
      );
      const { startDaemon } = await import('./startDaemon');
      const run = startDaemon();
      await waitForCondition(
        () => harness.connectedServicesProjectionChangeListeners.length === 1 && runtimeRegistry !== null,
        'Expected connected-services projection and runtime-registry composition',
      );
      const signal = new AbortController().signal;
      const projection = {
        source: 'startup',
        executionAuthority: 'passive_projection' as const,
        signal,
        connectedServicesV2: [],
        connectedServiceCredentialRevisionsV1: [{
          serviceId: 'openai-codex',
          profileId: 'direct',
          credentialRevision: credentialRevisionB,
        }],
      };
      await harness.connectedServicesProjectionChangeListeners[0]?.(projection);
      applySpy.mockClear();
      const { fetchSessionsPage } = await import('@/session/transport/http/sessionsHttp');
      vi.mocked(fetchSessionsPage).mockClear();
      const registration = {
        pid: 7412,
        agentId: 'codex' as const,
        sessionId: 'late-direct-runtime-target',
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'direct' },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'profile',
            serviceId: 'openai-codex',
            profileId: 'direct',
            credentialRevision: credentialRevisionA,
          }]),
        },
      };

      runtimeRegistry!.registerTarget(registration);
      await harness.connectedServicesProjectionChangeListeners[0]?.({ ...projection, source: 'flush-late-registration' });
      runtimeRegistry!.registerTarget(registration);
      await harness.connectedServicesProjectionChangeListeners[0]?.({ ...projection, source: 'flush-reregistration' });

      expect(applySpy).toHaveBeenCalledOnce();
      expect(applySpy).toHaveBeenCalledWith({
        serviceId: 'openai-codex',
        profileId: 'direct',
        credentialBoundary: {
          status: 'present',
          revisionSemantics: 'revisioned',
          credentialRevision: credentialRevisionB,
        },
        executionAuthority: 'passive_projection',
      });
      expect(fetchSessionsPage).not.toHaveBeenCalled();
      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('retries a failed late direct-profile registration on an identical projection, then dedupes after success', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);
    const credentialRevisionA = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const credentialRevisionB = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const latePid = 7413;
    const lateSessionId = 'late-direct-retry-target';
    let daemonTrackedSessionsByPid: Map<number, TrackedSession> | null = null;
    try {
      const { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } = await import(
        './connectedServices/connectedServiceChildEnvironment'
      );
      const { ConnectedServiceRuntimeRegistry } = await import('./connectedServices/runtimeRegistry/registry');
      const { ConnectedServiceRefreshCoordinator } = await import(
        './connectedServices/refresh/ConnectedServiceRefreshCoordinator'
      );
      const webhookModule = await import('./sessions/onHappySessionWebhook');
      vi.mocked(webhookModule.createOnHappySessionWebhook).mockImplementation((params) => {
        daemonTrackedSessionsByPid = params.pidToTrackedSession;
        return vi.fn();
      });
      let runtimeRegistry: InstanceType<typeof ConnectedServiceRuntimeRegistry> | null = null;
      const originalSubscribe = ConnectedServiceRuntimeRegistry.prototype.onTargetRegistration;
      vi.spyOn(ConnectedServiceRuntimeRegistry.prototype, 'onTargetRegistration').mockImplementation(function (
        this: InstanceType<typeof ConnectedServiceRuntimeRegistry>,
        listener,
      ) {
        runtimeRegistry = this;
        return originalSubscribe.call(this, listener);
      });
      const applySpy = vi.spyOn(
        ConnectedServiceRefreshCoordinator.prototype,
        'handleExternalCredentialUpdate',
      );
      const { startDaemon } = await import('./startDaemon');
      const run = startDaemon();
      await waitForCondition(
        () => harness.connectedServicesProjectionChangeListeners.length === 1
          && runtimeRegistry !== null
          && daemonTrackedSessionsByPid !== null,
        'Expected connected-services projection, runtime-registry, and tracked-session composition',
      );
      const projection = {
        source: 'startup',
        executionAuthority: 'passive_projection' as const,
        signal: new AbortController().signal,
        connectedServicesV2: [],
        connectedServiceCredentialRevisionsV1: [{
          serviceId: 'openai-codex',
          profileId: 'direct',
          credentialRevision: credentialRevisionB,
        }],
      };
      await harness.connectedServicesProjectionChangeListeners[0]?.(projection);
      applySpy.mockClear();
      applySpy.mockRejectedValueOnce(new Error('transient late registration failure'));
      const trackedSessionsByPid = daemonTrackedSessionsByPid as Map<number, TrackedSession> | null;
      if (!trackedSessionsByPid) {
        throw new Error('Expected daemon tracked-session registry composition');
      }
      trackedSessionsByPid.set(latePid, {
        pid: latePid,
        startedBy: 'daemon',
        happySessionId: lateSessionId,
        happySessionMetadataFromLocalWebhook: {
          path: '/tmp/direct-readiness',
          host: 'test-host',
          homeDir: '/tmp',
          happyHomeDir: '/tmp/home',
          happyLibDir: '/tmp/lib',
          happyToolsDir: '/tmp/tools',
          hostPid: latePid,
          startedBy: 'daemon',
          machineId: 'machine-automation',
          flavor: 'codex',
        },
      });
      runtimeRegistry!.registerTarget({
        pid: latePid,
        agentId: 'codex',
        sessionId: lateSessionId,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'direct' },
          },
        },
        connectedServiceSelectionsEnv: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
            kind: 'profile', serviceId: 'openai-codex', profileId: 'direct', credentialRevision: credentialRevisionA,
          }]),
        },
      });
      await waitForCondition(() => applySpy.mock.calls.length === 1, 'Expected failed registration reconciliation');

      await harness.connectedServicesProjectionChangeListeners[0]?.({ ...projection, source: 'identical-retry' });
      await harness.connectedServicesProjectionChangeListeners[0]?.({ ...projection, source: 'identical-deduped' });

      expect(applySpy).toHaveBeenCalledTimes(2);
      expect(applySpy).toHaveBeenLastCalledWith({
        serviceId: 'openai-codex',
        profileId: 'direct',
        credentialBoundary: {
          status: 'present',
          revisionSemantics: 'revisioned',
          credentialRevision: credentialRevisionB,
        },
        executionAuthority: 'passive_projection',
      });
      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('registers a daemon account settings listener that refreshes newer compact live hints', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);
    harness.setActiveAccountSettingsSnapshot({ settingsVersion: 2 });

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await waitForCondition(
        () => harness.machineUpdateListeners.length >= 2,
        'Expected daemon machine update listeners to be registered',
      );
      harness.bootstrapAccountSettingsContext.mockClear();

      for (const listener of harness.machineUpdateListeners) {
        listener({
          id: 'upd-settings',
          seq: 5,
          createdAt: Date.now(),
          body: { t: 'account-settings-changed', settingsVersion: 3 },
        });
      }

      await waitForCondition(
        () => harness.bootstrapAccountSettingsContext.mock.calls.length >= 1,
        'Expected account settings refresh to be triggered by newer compact hint',
      );

      expect(harness.bootstrapAccountSettingsContext).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: automationCredentials,
          minSettingsVersion: 3,
          mode: 'blocking',
          refresh: 'auto',
        }),
      );

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('ignores stale or equal daemon account settings live hints', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);
    harness.setActiveAccountSettingsSnapshot({ settingsVersion: 3 });

    try {
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await waitForCondition(
        () => harness.machineUpdateListeners.length >= 2,
        'Expected daemon machine update listeners to be registered',
      );
      harness.bootstrapAccountSettingsContext.mockClear();

      for (const listener of harness.machineUpdateListeners) {
        listener({
          id: 'upd-settings',
          seq: 5,
          createdAt: Date.now(),
          body: { t: 'account-settings-changed', settingsVersion: 3 },
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(harness.bootstrapAccountSettingsContext).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('forces account settings refresh for conservative reconnect hints without a version', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);
    harness.setActiveAccountSettingsSnapshot({ settingsVersion: 3 });

    try {
      const { startDaemon } = await import('./startDaemon');
      const { refreshAccountSettingsForMinimumVersion } = await import('@/settings/accountSettings/refreshAccountSettingsForMinimumVersion');

      const run = startDaemon();
      await waitForCondition(
        () => harness.accountSettingsVersionHintListeners.length >= 1,
        'Expected daemon account settings version hint listener to be registered',
      );

      for (const listener of harness.accountSettingsVersionHintListeners) {
        listener({ settingsVersion: null, source: 'cursor-gone' });
      }

      await waitForCondition(
        () => harness.bootstrapAccountSettingsContext.mock.calls.length >= 1,
        'Expected conservative reconnect hint to force account settings refresh',
      );

      expect(refreshAccountSettingsForMinimumVersion).toHaveBeenCalledWith(expect.objectContaining({
        credentials: automationCredentials,
        minSettingsVersion: null,
        mode: 'blocking',
        forceRefresh: true,
      }));
      expect(harness.bootstrapAccountSettingsContext).toHaveBeenCalledWith(expect.objectContaining({
        refresh: 'force',
      }));

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('uses account settings version hints only for daemon freshness refresh', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);

    try {
      const { startDaemon } = await import('./startDaemon');
      const { buildHappySessionControlArgs } = await import('./sessionSpawnArgs');

      const run = startDaemon();
      await waitForCondition(
        () => harness.apiMachine.setRPCHandlers.mock.calls.length >= 1,
        'Expected daemon RPC handlers to be registered',
      );

      const handlers = harness.apiMachine.setRPCHandlers.mock.calls[0]?.[0] as {
        spawnSession?: (options: unknown) => Promise<unknown>;
      } | undefined;
      if (typeof handlers?.spawnSession !== 'function') {
        throw new Error('Expected spawnSession handler to be registered');
      }

      const spawnResult = await handlers.spawnSession({
        machineId: 'machine-automation',
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        accountSettingsVersionHint: 14,
      });

      expect(spawnResult).toEqual(expect.objectContaining({
        type: 'success',
        sessionIdStatus: 'pending',
      }));

      expect(buildHappySessionControlArgs).toHaveBeenCalledWith(expect.not.objectContaining({
        accountSettingsVersionHint: expect.any(Number),
      }));

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('skips the pre-spawn account settings refresh when the active snapshot already satisfies the hint', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);

    try {
      const { resolveAccountSettingsScopeKey } = await import('@/settings/accountSettings/accountSettingsScopeKey');
      harness.setActiveAccountSettingsSnapshot({
        settingsVersion: 14,
        scopeKey: resolveAccountSettingsScopeKey(automationCredentials),
      });
      const { startDaemon } = await import('./startDaemon');
      const { refreshAccountSettingsForMinimumVersion } = await import('@/settings/accountSettings/refreshAccountSettingsForMinimumVersion');

      const run = startDaemon();
      await waitForCondition(
        () => harness.apiMachine.setRPCHandlers.mock.calls.length >= 1,
        'Expected daemon RPC handlers to be registered',
      );

      const handlers = harness.apiMachine.setRPCHandlers.mock.calls[0]?.[0] as {
        spawnSession?: (options: unknown) => Promise<unknown>;
      } | undefined;
      if (typeof handlers?.spawnSession !== 'function') {
        throw new Error('Expected spawnSession handler to be registered');
      }
      vi.mocked(refreshAccountSettingsForMinimumVersion).mockClear();
      harness.bootstrapAccountSettingsContext.mockClear();

      await handlers.spawnSession({
        machineId: 'machine-automation',
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        accountSettingsVersionHint: 14,
      });

      expect(refreshAccountSettingsForMinimumVersion).not.toHaveBeenCalled();
      expect(harness.bootstrapAccountSettingsContext).not.toHaveBeenCalled();

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('spawns without an account settings version hint when daemon freshness refresh fails', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.setAutoShutdownAfterAutomationStart(false);
    harness.setActiveAccountSettingsSnapshot(null);
    harness.bootstrapAccountSettingsContext.mockRejectedValueOnce(
      Object.assign(new Error('Account settings are not fresh enough for this session spawn.'), {
        code: 'ACCOUNT_SETTINGS_STALE',
      }),
    );

    try {
      const { startDaemon } = await import('./startDaemon');
      const { buildHappySessionControlArgs } = await import('./sessionSpawnArgs');
      vi.mocked(buildHappySessionControlArgs).mockClear();

      const run = startDaemon();
      await waitForCondition(
        () => harness.apiMachine.setRPCHandlers.mock.calls.length >= 1,
        'Expected daemon RPC handlers to be registered',
      );

      const handlers = harness.apiMachine.setRPCHandlers.mock.calls[0]?.[0] as {
        spawnSession?: (options: unknown) => Promise<unknown>;
      } | undefined;
      if (typeof handlers?.spawnSession !== 'function') {
        throw new Error('Expected spawnSession handler to be registered');
      }

      const spawnResult = await handlers.spawnSession({
        machineId: 'machine-automation',
        directory: '/tmp/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        accountSettingsVersionHint: 1_000_000,
      });

      expect(spawnResult).not.toEqual(expect.objectContaining({
        errorCode: 'ACCOUNT_SETTINGS_STALE',
      }));
      expect(buildHappySessionControlArgs).toHaveBeenCalledWith(expect.not.objectContaining({
        accountSettingsVersionHint: expect.any(Number),
      }));

      harness.requestShutdown('happier-cli');
      await run;
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
      await waitForCondition(
        () => harness.apiMachine.onConnectionStateChange.mock.calls.length >= 1,
        'Expected machine connection listener to be registered after bootstrap',
      );

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
