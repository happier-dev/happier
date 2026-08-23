import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonState } from '@/api/types';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';
type BuildHappyCliSubprocessLaunchSpec = typeof import('@/utils/spawnHappyCLI').buildHappyCliSubprocessLaunchSpec;

const harness = vi.hoisted(() => {
  // A real daemon credential is a JWT whose `sub` is the Account. The previous opaque
  // 'token-automation' fixture made every subject-derived startup branch inert, which is exactly
  // how the peer-mediation observability read-path install went unexercised at this boundary.
  const daemonCredentialAccountId = 'account-automation';
  const daemonCredentialToken = [
    Buffer.from(JSON.stringify({ alg: 'none' }), 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify({ sub: daemonCredentialAccountId }), 'utf8').toString('base64url'),
    'signature',
  ].join('.');

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

  const providerAccountUsagePersistenceFlush = vi.fn(async () => {});
  const createProviderAccountUsagePersistenceScheduler = vi.fn(() => ({
    recordInBandSnapshot: vi.fn(async () => ({ status: 'enqueued' as const, enqueue: 'accepted' as const })),
    flush: providerAccountUsagePersistenceFlush,
    dispose: vi.fn(),
  }));

  const connectedServiceQuotasPause = vi.fn();
  const connectedServiceQuotasResume = vi.fn();
  const connectedServiceQuotasStop = vi.fn();
  const startConnectedServiceQuotasLoop = vi.fn(() => ({
    stop: connectedServiceQuotasStop,
    pause: connectedServiceQuotasPause,
    resume: connectedServiceQuotasResume,
  }));

  const apiMachine = {
    setRPCHandlers: vi.fn(() => ({ externalSessionPluginAdmissionOwner: undefined })),
    getPeerMediationMachineRpcHandlerManager: vi.fn(() => ({
      invokeLocal: vi.fn(async () => ({ ok: true })),
    })),
    registerLiveStreamRelayRoutes: vi.fn(),
    onUpdate: vi.fn(() => () => {}),
    onAccountSettingsVersionHint: vi.fn(() => () => {}),
    onConnectedServicesProjection: vi.fn(() => () => {}),
    onPendingSessionActivationHint: vi.fn(() => () => {}),
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
    updateDaemonState: vi.fn(async (
      _handler: (state: DaemonState | null) => DaemonState,
    ) => {}),
    awaitPendingRpcRequests: vi.fn(async () => {}),
    registerConnectedAccountDaemonRuntime: vi.fn(),
    registerConnectedAccountPurposeBindingRuntime: vi.fn(),
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
    recoverDaemonTerminalSessionMutationJournals: vi.fn(async (params: {
      bindUsageLimitRecoveryJournals: (sessionIds: readonly string[]) => Promise<unknown>;
    }) => {
      await params.bindUsageLimitRecoveryJournals([]);
      return { recoveredSessionIds: [], retainedSessionIds: [] };
    }),
    resolvePluginResourceSessionAccess: vi.fn(),
    enqueueDaemonTerminalExactTurnEnd: vi.fn(async () => undefined),
    shutdown: vi.fn(),
  };

  const lockHandle = { release: vi.fn(async () => {}) };

  // PMS-WIRE composition seam: the real `Api` exposes this publisher and `startDaemon` is the only
  // caller. Holding the spy on the harness (not inside the module factory) keeps its call history
  // readable from a test while `vi.clearAllMocks()` resets it between cases.
  const setPeerMediationObservabilityRuntimeActionContextProvider = vi.fn();

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
    providerAccountUsagePersistenceFlush,
    createProviderAccountUsagePersistenceScheduler,
    startAutomationWorker,
    automationWorkerStop,
    automationWorkerRefreshAssignments,
    automationWorkerPause,
    automationWorkerResume,
    apiMachine,
    lockHandle,
    daemonCredentialAccountId,
    daemonCredentialToken,
    setPeerMediationObservabilityRuntimeActionContextProvider,
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
      setServerFeaturesSnapshotProvider: vi.fn(),
      setPeerMediationObservabilityRuntimeActionContextProvider:
        harness.setPeerMediationObservabilityRuntimeActionContextProvider,
      createBrowserRuntimeActionExecutor: vi.fn(),
      getAccountEncryptionMode: vi.fn(async () => 'plain'),
      getConnectedServiceAuthGroup: vi.fn(async () => null),
    })),
  },
  isMachineContentPublicKeyMismatchError: vi.fn(() => false),
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

vi.mock('@/api/client/serializeAxiosErrorForLog', () => ({
  serializeAxiosErrorForLog: vi.fn(() => ({})),
}));

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: vi.fn(async () => ({
    status: 'unsupported',
    reason: 'endpoint_missing',
  })),
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
    flushSync: vi.fn(),
    logFilePath: '/tmp/happier-daemon.log',
  },
}));

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: vi.fn(async () => ({
    credentials: {
      token: 'token-automation',
      encryption: {
        type: 'dataKey',
        publicKey: new Uint8Array(32).fill(1),
        machineKey: new Uint8Array(32).fill(2),
      },
    },
    machineId: 'machine-automation',
  })),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    privateKeyFile: '/tmp/key',
    happyHomeDir: '/tmp/home',
    activeServerId: 'default',
    serverUrl: 'https://api.happier.dev',
    apiServerUrl: 'https://api.happier.dev',
    webappUrl: 'https://happier.dev',
    activeServerDir: '/tmp/home/servers/active',
    currentCliVersion: '0.0.0-test',
    publicReleaseRing: 'publicdev',
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
  spawnHappyCLI: vi.fn(),
}));

vi.mock('@/session/runtime/catalogHooks', () => ({
  getVendorResumeSupport: vi.fn(async () => () => true),
}));

vi.mock('@/agent/catalog/resolution', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/agent/catalog/resolution')>(),
  resolveAgentCliSubcommand: vi.fn(),
  resolveCatalogAgentId: vi.fn(() => 'codex'),
}));

vi.mock('@/persistence', () => ({
  writeDaemonState: vi.fn(),
  writeDaemonStateForLockOwner: vi.fn(() => true),
  clearDaemonStateForLockOwner: vi.fn(() => true),
  acquireDaemonLock: vi.fn(async () => harness.lockHandle),
  releaseDaemonLock: vi.fn(async () => {}),
  readStoredCredentials: vi.fn(async () => ({
    token: harness.daemonCredentialToken,
    encryption: {
      type: 'dataKey',
      publicKey: new Uint8Array(32).fill(1),
      machineKey: new Uint8Array(32).fill(2),
    },
  })),
  readSettings: vi.fn(async () => ({ experiments: true })),
}));

vi.mock('@/daemon/deviceLocalSecretStorage', () => ({
  readOrCreateDeviceLocalSecretStorage: vi.fn(async () => ({
    sealJson: vi.fn(() => 'sealed'),
    openJson: vi.fn(() => null),
    deriveOpaqueIdentity: vi.fn(() => 'opaque'),
    deriveSecretKey: vi.fn(() => new Uint8Array(32)),
  })),
}));

vi.mock('./controlClient', () => ({
  cleanupDaemonState: vi.fn(async () => {}),
  ensureDaemonSshTunnel: vi.fn(async () => ({ ok: true })),
  isDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(async () => false),
  listDaemonSshTunnels: vi.fn(async () => []),
  releaseDaemonSshTunnel: vi.fn(async () => ({ ok: true })),
  resolveDaemonSpawnSessionByNonce: vi.fn(async () => null),
  stopDaemon: vi.fn(async () => {}),
  stopDaemonSshTunnel: vi.fn(async () => ({ ok: true })),
}));

vi.mock('./controlServer', () => ({
  startDaemonControlServer: vi.fn(async () => ({
    port: 43210,
    stop: vi.fn(async () => {}),
  })),
}));

vi.mock('./sessions/reattachFromMarkers', () => ({
  reattachTrackedSessionsFromMarkers: vi.fn(async () => ({
    orphanedDeadDaemonSessions: [],
    connectedServiceRestartIntents: [],
  })),
}));

vi.mock('./sessions/onHappySessionWebhook', async (importOriginal) => ({
  ...await importOriginal<typeof import('./sessions/onHappySessionWebhook')>(),
  createOnHappySessionWebhook: vi.fn(() => vi.fn()),
}));

vi.mock('./sessions/onChildExited', () => ({
  createOnChildExited: vi.fn(() => vi.fn()),
}));

vi.mock('./sessions/visibleConsoleSpawnWaiter', () => ({
  waitForVisibleConsoleSessionWebhook: vi.fn(async () => null),
}));

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
  resolveTerminalRequestFromSpawnOptions: vi.fn(() => null),
}));

vi.mock('@/terminal/runtime/envVarSanitization', () => ({
  validateEnvVarRecordStrict: vi.fn(() => ({ ok: true, env: {} })),
}));

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: vi.fn(async () => ({ status: 'error', reason: 'network' })),
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

vi.mock('./memory/memoryWorker', () => ({
  startMemoryWorker: vi.fn(async () => null),
}));

vi.mock('./voiceInference/voiceInferenceWorker', () => ({
  startVoiceInferenceWorker: vi.fn(async () => null),
}));

vi.mock('./connectedServices/accountUsage/persistence', () => ({
  createProviderAccountUsagePersistenceScheduler: harness.createProviderAccountUsagePersistenceScheduler,
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

vi.mock('@/machines/transfer/directPeerTransport', () => ({
  createDirectPeerTransferRegistry: vi.fn(() => ({
    publishTransfer: vi.fn(() => ({
      endpointCandidates: [],
      expiresAt: 30_000,
    })),
    readPublishedTransfer: vi.fn(() => null),
    resolveOnDemandTransferOnOpen: vi.fn(async () => null),
    clearPublishedTransfer: vi.fn(),
    cleanupExpiredPublishedTransfers: vi.fn(),
    getNextPublishedTransferExpiryAt: vi.fn(() => null),
    hasPublishedTransfers: vi.fn(() => false),
    dispose: vi.fn(async () => {}),
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

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: ((value: T) => void) | null = null;
  let reject: ((error: unknown) => void) | null = null;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve: (value) => resolve?.(value),
    reject: (error) => reject?.(error),
  };
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('startDaemon automation wiring (integration)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

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

      const { writeDaemonStateForLockOwner } = await import('@/persistence');
      const { startDaemon } = await import('./startDaemon');
      await startDaemon();

      expect(stopDaemon).toHaveBeenCalledTimes(1);
      expect(writeDaemonStateForLockOwner).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          machineId: 'machine-rotated',
        }),
      );
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
      await vi.waitFor(() => {
        expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(1);
      });

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
      restoreEnvVar('HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_BASE_DELAY_MS', retryBaseDelayOriginal);
      restoreEnvVar('HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS', retryDelayOriginal);
      restoreEnvVar('HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_MAX_DELAY_MS', retryMaxDelayOriginal);
      restoreEnvVar('HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_JITTER_MS', retryJitterOriginal);
      vi.useRealTimers();
      exitSpy.mockRestore();
    }
  });

  it('unrefs and cancels machine registration retry sleep on shutdown', async () => {
    vi.useRealTimers();
    harness.setAutoShutdownAfterAutomationStart(false);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const retryBaseDelayOriginal = process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_BASE_DELAY_MS;
    const retryDelayOriginal = process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS;
    const retryMaxDelayOriginal = process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_MAX_DELAY_MS;
    const retryJitterOriginal = process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_JITTER_MS;
    process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_BASE_DELAY_MS = '60000';
    process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS = '60000';
    process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_MAX_DELAY_MS = '60000';
    process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_JITTER_MS = '0';

    type TimeoutHandle = ReturnType<typeof setTimeout> & { hasRef?: () => boolean };
    const retryTimeoutRef: { current: TimeoutHandle | null } = { current: null };
    let run: Promise<void> | null = null;
    try {
      const { ensureMachineRegistered } = await import('@/api/machine/ensureMachineRegistered');
      const ensureMachineRegisteredMock = vi.mocked(ensureMachineRegistered);
      ensureMachineRegisteredMock.mockRejectedValueOnce(new Error('transient machine registration failure'));

      const { startDaemon } = await import('./startDaemon');

      run = startDaemon();
      await vi.waitFor(() => {
        const retryTimerIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 60_000);
        expect(retryTimerIndex).toBeGreaterThanOrEqual(0);
        retryTimeoutRef.current = setTimeoutSpy.mock.results[retryTimerIndex]?.value as TimeoutHandle;
      });

      expect(retryTimeoutRef.current?.hasRef?.()).toBe(false);

      harness.requestShutdown('happier-cli');
      await run;
      expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(1);
    } finally {
      harness.requestShutdown('happier-cli');
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
      if (run) {
        await run;
      }
      restoreEnvVar('HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_BASE_DELAY_MS', retryBaseDelayOriginal);
      restoreEnvVar('HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS', retryDelayOriginal);
      restoreEnvVar('HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_MAX_DELAY_MS', retryMaxDelayOriginal);
      restoreEnvVar('HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_JITTER_MS', retryJitterOriginal);
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

      const { writeDaemonStateForLockOwner } = await import('@/persistence');
      const { startDaemon } = await import('./startDaemon');

      const run = startDaemon();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(writeDaemonStateForLockOwner).toHaveBeenCalledTimes(1);

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('binds exact Session Resource access only after the live machine client is available', async () => {
    harness.setAutoShutdownAfterAutomationStart(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const machineRegistrationParams: {
      current: Parameters<
        typeof import('./startup/startDaemonMachineRegistrationRuntime').startDaemonMachineRegistrationRuntime
      >[0] | null;
    } = { current: null };
    const pluginRuntimeOwnerParams: {
      current: Readonly<Record<string, unknown>> | null;
    } = { current: null };
    const pluginChangeService = {
      requestPluginChange: vi.fn(),
      decidePluginChange: vi.fn(),
      shutdown: vi.fn(async () => {}),
      quiesceForHandoff: vi.fn(async () => ({ resume: vi.fn() })),
      isQuiescing: () => false,
      runHardRevocationCurrentnessChange: vi.fn(),
    };
    vi.doMock('@/plugins/daemon/runtimeOwner', () => ({
      createDaemonPluginRuntimeOwner: vi.fn((params: Readonly<Record<string, unknown>>) => {
        pluginRuntimeOwnerParams.current = params;
        return {
          changeService: pluginChangeService,
          initialize: vi.fn(async () => {
            const onInitialRegistryPublished = params.onInitialRegistryPublished as
              | (() => void)
              | undefined;
            const awaitInitialRuntimeActivation = params.awaitInitialRuntimeActivation as
              | (() => Promise<void>)
              | undefined;
            const onDurableRegistryApplied = params.onDurableRegistryApplied as
              | (() => void)
              | undefined;
            onInitialRegistryPublished?.();
            await awaitInitialRuntimeActivation?.();
            onDurableRegistryApplied?.();
          }),
          reportCurrentAvailability: vi.fn(),
          readCatalog: vi.fn(async () => []),
        };
      }),
    }));
    vi.doMock('./startup/startDaemonMachineRegistrationRuntime', () => ({
      startDaemonMachineRegistrationRuntime: vi.fn((params) => {
        machineRegistrationParams.current = params;
        return { resume: vi.fn() };
      }),
    }));

    let run: Promise<void> | null = null;
    try {
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await vi.waitFor(() => {
        expect(machineRegistrationParams.current).not.toBeNull();
        expect(pluginRuntimeOwnerParams.current).not.toBeNull();
      });

      // Daemon startup is the production policy boundary. A declared database
      // must not become unavailable merely because the registry owner received
      // no policy injection.
      const daemonDatabaseLimits = pluginRuntimeOwnerParams.current
        ?.daemonDatabaseLimits as Readonly<{
          protocolMaximumDatabaseBytes: number;
          resolvePluginLimits(pluginId: string): Readonly<{
            maximumDatabaseBytes: number;
          }> | null;
        }> | undefined;
      expect(daemonDatabaseLimits).toEqual(expect.objectContaining({
        protocolMaximumDatabaseBytes: expect.any(Number),
        resolvePluginLimits: expect.any(Function),
      }));
      expect(daemonDatabaseLimits?.resolvePluginLimits('examples.background-indexer'))
        .toEqual(expect.objectContaining({
          maximumDatabaseBytes: expect.any(Number),
        }));

      // Collection admission AND plugin-facing feature decisions consume the daemon's
      // existing feature snapshot cache through one supplied resolver; neither may
      // create a second feature fetch/currentness path.
      const resolveServerFeaturesSnapshot = pluginRuntimeOwnerParams.current
        ?.resolveServerFeaturesSnapshot as (() => unknown) | undefined;
      expect(resolveServerFeaturesSnapshot).toEqual(expect.any(Function));
      expect(
        (pluginRuntimeOwnerParams.current?.accountStorageDependencies as Readonly<{
          resolveServerFeaturesSnapshot?: () => unknown;
        }> | undefined)?.resolveServerFeaturesSnapshot,
      ).toBeUndefined();
      await vi.waitFor(() => {
        expect(resolveServerFeaturesSnapshot?.()).toEqual({
          status: 'unsupported',
          reason: 'endpoint_missing',
        });
      });

      const resolveSessionResourceAccess = pluginRuntimeOwnerParams.current
        ?.resolveSessionResourceAccess as ((input: Readonly<{
          accountId: string;
          sessionId: string;
          signal: AbortSignal;
        }>) => Promise<unknown>) | undefined;
      if (!resolveSessionResourceAccess) {
        throw new Error('expected exact Session Resource access resolver');
      }
      const signal = new AbortController().signal;
      const input = Object.freeze({
        accountId: 'account-resource-access',
        sessionId: 'session-resource-access',
        signal,
      });

      await expect(resolveSessionResourceAccess(input)).rejects.toThrow(
        'plugin_resource_session_access_unavailable',
      );
      expect(harness.apiMachine.resolvePluginResourceSessionAccess).not.toHaveBeenCalled();

      const sentinel = Object.freeze({
        accountId: input.accountId,
        throughCursor: 17,
        status: 'available' as const,
      });
      harness.apiMachine.resolvePluginResourceSessionAccess.mockResolvedValueOnce(sentinel);
      const onMachineSyncRuntime = machineRegistrationParams.current?.onMachineSyncRuntime;
      if (!onMachineSyncRuntime) throw new Error('expected machine sync runtime callback');
      harness.apiMachine.updateDaemonState.mockClear();
      const machineSyncSettlement = onMachineSyncRuntime({
        apiMachine: harness.apiMachine,
        apiMachineForSessions: harness.apiMachine,
        automationWorker: null,
        memoryWorker: null,
        voiceInferenceWorker: null,
        daemonConnectivityCoordinator: null,
        machineConnectionStateCleanup: null,
        stopPeerMediationLoopbackServer: async () => {},
        resumeMachineConnectionPublications: async () => {},
        daemonSessionMutationCustody: {
          bindRecoveredJournals: async () => ({
            boundSessionIds: [],
            retainedSessionIds: [],
          }),
          close: async () => {},
          stage: async () => {},
        },
        providerOperationsProducer: {
          machineServices: {},
          bind: vi.fn(),
        },
      } as unknown as Parameters<typeof onMachineSyncRuntime>[0]);

      await expect(resolveSessionResourceAccess(input)).resolves.toBe(sentinel);
      expect(harness.apiMachine.resolvePluginResourceSessionAccess).toHaveBeenCalledOnce();
      expect(harness.apiMachine.resolvePluginResourceSessionAccess).toHaveBeenCalledWith(input);
      await vi.waitFor(() => {
        expect(harness.apiMachine.updateDaemonState).toHaveBeenCalledOnce();
      });
      const updateDaemonState = harness.apiMachine.updateDaemonState.mock.calls[0]?.[0];
      if (typeof updateDaemonState !== 'function') {
        throw new Error('expected daemon-state currentness updater');
      }
      const currentDaemonState = Object.freeze({ status: 'running' as const, pid: 17 });
      expect(updateDaemonState(currentDaemonState)).toBe(currentDaemonState);
      harness.requestShutdown('happier-cli');
      void Promise.resolve(machineSyncSettlement).catch(() => undefined);
    } finally {
      harness.requestShutdown('happier-cli');
      await run?.catch(() => undefined);
      vi.doUnmock('./startup/startDaemonMachineRegistrationRuntime');
      vi.doUnmock('@/plugins/daemon/runtimeOwner');
      exitSpy.mockRestore();
    }
  });

  it('does not publish a machine-sync attempt rejected during post-publication handoff', async () => {
    harness.setAutoShutdownAfterAutomationStart(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const machineRegistrationParams: {
      current: Parameters<
        typeof import('./startup/startDaemonMachineRegistrationRuntime').startDaemonMachineRegistrationRuntime
      >[0] | null;
    } = { current: null };
    const pluginRuntimeOwnerParams: {
      current: Readonly<Record<string, unknown>> | null;
    } = { current: null };
    const pluginChangeService = {
      requestPluginChange: vi.fn(),
      decidePluginChange: vi.fn(),
      shutdown: vi.fn(async () => {}),
      quiesceForHandoff: vi.fn(async () => ({ resume: vi.fn() })),
      isQuiescing: () => false,
      runHardRevocationCurrentnessChange: vi.fn(),
    };
    vi.doMock('@/plugins/daemon/runtimeOwner', () => ({
      createDaemonPluginRuntimeOwner: vi.fn((params: Readonly<Record<string, unknown>>) => {
        pluginRuntimeOwnerParams.current = params;
        return {
          changeService: pluginChangeService,
          initialize: vi.fn(async () => {
            const onInitialRegistryPublished = params.onInitialRegistryPublished as
              | (() => void)
              | undefined;
            const awaitInitialRuntimeActivation = params.awaitInitialRuntimeActivation as
              | (() => Promise<void>)
              | undefined;
            onInitialRegistryPublished?.();
            await awaitInitialRuntimeActivation?.();
          }),
          reportCurrentAvailability: vi.fn(),
          readCatalog: vi.fn(async () => []),
        };
      }),
    }));
    vi.doMock('./startup/startDaemonMachineRegistrationRuntime', () => ({
      startDaemonMachineRegistrationRuntime: vi.fn((params) => {
        machineRegistrationParams.current = params;
        return { resume: vi.fn() };
      }),
    }));
    const firstIdentityFailure = new Error('first-attempt-installation-identity-failure');
    const readOrCreateInstallationIdentity = vi
      .fn()
      .mockRejectedValueOnce(firstIdentityFailure)
      .mockResolvedValue({ installationId: 'installation-test' });
    vi.doMock('./identity/store', () => ({
      readOrCreateInstallationIdentity,
    }));
    vi.doMock('@/settings/accountSettings/warmActiveAccountSettingsSnapshot', () => ({
      warmActiveAccountSettingsSnapshotBestEffort: vi.fn(async () => false),
    }));
    vi.doMock('@/plugins/runtime/webhooks/pluginWebhookDaemonWorker', () => ({
      startPluginWebhookDaemonWorkerV1: vi.fn(() => ({
        trigger: vi.fn(),
        stop: vi.fn(async () => {}),
      })),
    }));
    vi.doMock('@/plugins/runtime/webhooks/pluginWebhookDaemonWake', () => ({
      attachPluginWebhookDaemonWakeV1: vi.fn(() => () => {}),
    }));

    let run: Promise<void> | null = null;
    try {
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await vi.waitFor(() => {
        expect(exitSpy).not.toHaveBeenCalled();
        expect(pluginRuntimeOwnerParams.current).not.toBeNull();
        expect(machineRegistrationParams.current).not.toBeNull();
      });

      const resolveSessionResourceAccess = pluginRuntimeOwnerParams.current
        ?.resolveSessionResourceAccess as ((input: Readonly<{
          accountId: string;
          sessionId: string;
          signal: AbortSignal;
        }>) => Promise<unknown>) | undefined;
      if (!resolveSessionResourceAccess) {
        throw new Error('expected exact Session Resource access resolver');
      }
      const providerSource = pluginRuntimeOwnerParams.current?.providers as Readonly<{
        bind(binding: Readonly<{ signal: AbortSignal; isCurrent(): boolean }>): Readonly<{
          connections: Readonly<{
            describe(request: unknown): Promise<unknown>;
          }>;
        }>;
      }> | undefined;
      if (!providerSource) throw new Error('expected Provider operations source');
      const pluginAdmissionOwner = pluginRuntimeOwnerParams.current
        ?.externalSessionPluginAdmissionOwner as Readonly<{
          materializeStart(input: unknown): Promise<unknown>;
        }> | undefined;
      if (!pluginAdmissionOwner) {
        throw new Error('expected external-session plugin admission owner');
      }
      const onMachineSyncRuntime = machineRegistrationParams.current?.onMachineSyncRuntime;
      if (!onMachineSyncRuntime) throw new Error('expected machine sync runtime callback');
      const input = Object.freeze({
        accountId: 'account-resource-access',
        sessionId: 'session-resource-access',
        signal: new AbortController().signal,
      });
      const providerBinding = Object.freeze({
        signal: new AbortController().signal,
        isCurrent: () => true,
      });
      const staleResourceAccess = Object.freeze({
        accountId: input.accountId,
        throughCursor: 13,
        status: 'available' as const,
      });
      const firstProviderDescribe = vi.fn(async () => ({
        status: 'success' as const,
        connections: [],
      }));
      const firstProviderBind = vi.fn(() => Object.freeze({
        connections: Object.freeze({ describe: firstProviderDescribe }),
      }));
      const firstMaterializeStart = vi.fn(async () => ({
        ok: true as const,
        source: 'retired-attempt',
      }));
      const firstApiMachine = {
        ...harness.apiMachine,
        recoverDaemonTerminalSessionMutationJournals: vi.fn(async () => {
          return { recoveredSessionIds: [], retainedSessionIds: [] };
        }),
        resolvePluginResourceSessionAccess: vi.fn(async () => staleResourceAccess),
        registerLocalServicesPreviewRoutes: vi.fn(),
        registerLocalServicesRoutes: vi.fn(),
        registerBrowserControlRoutes: vi.fn(),
        registerBrowserContextRoutes: vi.fn(),
        registerBrowserDiagnosticsRoutes: vi.fn(),
        registerBrowserRecordingRoutes: vi.fn(),
        registerSimulatorPreviewRoutes: vi.fn(),
        registerConnectedAccountDaemonRuntime: vi.fn(),
        registerConnectedAccountPurposeBindingRuntime: vi.fn(),
      };

      // No replacement callback is supplied between attempts. These probes
      // therefore observe whether the failed attempt remains globally selected
      // while the registration retry waits.
      await expect(onMachineSyncRuntime({
        apiMachine: firstApiMachine,
        apiMachineForSessions: firstApiMachine,
        externalSessionPluginAdmissionOwner: {
          materializeStart: firstMaterializeStart,
        },
        automationWorker: null,
        memoryWorker: null,
        voiceInferenceWorker: null,
        daemonConnectivityCoordinator: null,
        machineConnectionStateCleanup: null,
        stopPeerMediationLoopbackServer: async () => {},
        resumeMachineConnectionPublications: async () => {},
        daemonSessionMutationCustody: {
          bindRecoveredJournals: async () => ({
            boundSessionIds: [],
            retainedSessionIds: [],
          }),
          close: async () => {},
          stage: async () => {},
        },
        providerOperationsProducer: {
          machineServices: {},
          bind: firstProviderBind,
        },
      } as unknown as Parameters<typeof onMachineSyncRuntime>[0])).rejects.toBe(firstIdentityFailure);

      expect(readOrCreateInstallationIdentity).toHaveBeenCalledOnce();
      await expect(resolveSessionResourceAccess(input)).rejects.toThrow(
        'plugin_resource_session_access_unavailable',
      );
      expect(firstApiMachine.resolvePluginResourceSessionAccess).not.toHaveBeenCalled();
      await expect(providerSource.bind(providerBinding).connections.describe({}))
        .rejects.toMatchObject({ code: 'plugin_service_unavailable' });
      expect(firstProviderBind).not.toHaveBeenCalled();
      await expect(pluginAdmissionOwner.materializeStart({})).resolves.toMatchObject({
        ok: false,
        error: { code: 'source_unavailable' },
      });
      expect(firstMaterializeStart).not.toHaveBeenCalled();
      expect(firstApiMachine.registerConnectedAccountDaemonRuntime).not.toHaveBeenCalled();
      expect(firstApiMachine.registerConnectedAccountPurposeBindingRuntime).not.toHaveBeenCalled();

      const sentinel = Object.freeze({
        accountId: input.accountId,
        throughCursor: 17,
        status: 'available' as const,
      });
      const secondApiMachine = {
        ...harness.apiMachine,
        resolvePluginResourceSessionAccess: vi.fn(async () => sentinel),
        registerLocalServicesPreviewRoutes: vi.fn(),
        registerLocalServicesRoutes: vi.fn(),
        registerBrowserControlRoutes: vi.fn(),
        registerBrowserContextRoutes: vi.fn(),
        registerBrowserDiagnosticsRoutes: vi.fn(),
        registerBrowserRecordingRoutes: vi.fn(),
        registerSimulatorPreviewRoutes: vi.fn(),
        registerConnectedAccountDaemonRuntime: vi.fn(),
        registerConnectedAccountPurposeBindingRuntime: vi.fn(),
      };
      const secondProviderDescribe = vi.fn(async () => ({
        status: 'success' as const,
        connections: [],
      }));
      const secondProviderBind = vi.fn(() => Object.freeze({
        connections: Object.freeze({ describe: secondProviderDescribe }),
      }));
      const secondMaterializeStart = vi.fn(async () => ({
        ok: true as const,
        source: 'current-attempt',
      }));
      await onMachineSyncRuntime({
        apiMachine: secondApiMachine,
        apiMachineForSessions: secondApiMachine,
        externalSessionPluginAdmissionOwner: {
          materializeStart: secondMaterializeStart,
        },
        automationWorker: null,
        memoryWorker: null,
        voiceInferenceWorker: null,
        daemonConnectivityCoordinator: null,
        machineConnectionStateCleanup: null,
        stopPeerMediationLoopbackServer: async () => {},
        resumeMachineConnectionPublications: async () => {},
        daemonSessionMutationCustody: {
          bindRecoveredJournals: async () => ({
            boundSessionIds: [],
            retainedSessionIds: [],
          }),
          close: async () => {},
          stage: async () => {},
        },
        providerOperationsProducer: {
          machineServices: {},
          bind: secondProviderBind,
        },
      } as unknown as Parameters<typeof onMachineSyncRuntime>[0]);

      await expect(resolveSessionResourceAccess(input)).resolves.toBe(sentinel);
      expect(secondApiMachine.resolvePluginResourceSessionAccess).toHaveBeenCalledOnce();
      await expect(providerSource.bind(providerBinding).connections.describe({}))
        .resolves.toMatchObject({ status: 'success' });
      expect(secondProviderBind).toHaveBeenCalledWith(providerBinding);
      await expect(pluginAdmissionOwner.materializeStart({})).resolves.toMatchObject({
        ok: true,
        source: 'current-attempt',
      });
      expect(secondMaterializeStart).toHaveBeenCalledOnce();
      harness.requestShutdown('happier-cli');
    } finally {
      harness.requestShutdown('happier-cli');
      await run?.catch(() => undefined);
      vi.doUnmock('@/plugins/runtime/webhooks/pluginWebhookDaemonWake');
      vi.doUnmock('@/plugins/runtime/webhooks/pluginWebhookDaemonWorker');
      vi.doUnmock('@/settings/accountSettings/warmActiveAccountSettingsSnapshot');
      vi.doUnmock('./identity/store');
      vi.doUnmock('./startup/startDaemonMachineRegistrationRuntime');
      vi.doUnmock('@/plugins/daemon/runtimeOwner');
      exitSpy.mockRestore();
    }
  });

  it('fences daemon publication and resumes retained startup work after an aborted handoff', async () => {
    harness.setAutoShutdownAfterAutomationStart(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let quiescing = false;
    const transferRuntimeStateResume = vi.fn(async () => {});
    const machineRegistrationResume = vi.fn();
    const machineConnectionPublicationsResume = vi.fn(async () => {});
    const runtimeBootstrapParams: {
      current: Parameters<
        typeof import('./startup/startDaemonRuntimeBootstrap').startDaemonRuntimeBootstrap
      >[0] | null;
    } = { current: null };
    const machineRegistrationParams: {
      current: Parameters<
        typeof import('./startup/startDaemonMachineRegistrationRuntime').startDaemonMachineRegistrationRuntime
      >[0] | null;
    } = { current: null };
    const pluginRuntimeOwnerParams: {
      current: Readonly<Record<string, unknown>> | null;
    } = { current: null };
    let pluginRuntimeInitializationSettled = false;
    const pluginChangeService = {
      requestPluginChange: vi.fn(),
      decidePluginChange: vi.fn(),
      shutdown: vi.fn(async () => {}),
      quiesceForHandoff: vi.fn(async () => {
        quiescing = true;
        return { resume: () => { quiescing = false; } };
      }),
      isQuiescing: () => quiescing,
      runHardRevocationCurrentnessChange: vi.fn(),
    };
    vi.doMock('@/plugins/daemon/runtimeOwner', () => ({
      createDaemonPluginRuntimeOwner: vi.fn((params: Readonly<Record<string, unknown>>) => {
        pluginRuntimeOwnerParams.current = params;
        return {
          changeService: pluginChangeService,
          initialize: vi.fn(async () => {
            const onInitialRegistryPublished = params.onInitialRegistryPublished as
              | (() => void)
              | undefined;
            const awaitInitialRuntimeActivation = params.awaitInitialRuntimeActivation as
              | (() => Promise<void>)
              | undefined;
            onInitialRegistryPublished?.();
            await awaitInitialRuntimeActivation?.();
            pluginRuntimeInitializationSettled = true;
          }),
          reportCurrentAvailability: vi.fn(),
          readCatalog: vi.fn(async () => []),
        };
      }),
    }));
    vi.doMock('./startup/startDaemonMachineRegistrationRuntime', () => ({
      startDaemonMachineRegistrationRuntime: vi.fn((params) => {
        machineRegistrationParams.current = params;
        return { resume: machineRegistrationResume };
      }),
    }));
    vi.doMock('./startup/startDaemonRuntimeBootstrap', async () => {
      const actual = await vi.importActual<typeof import('./startup/startDaemonRuntimeBootstrap')>(
        './startup/startDaemonRuntimeBootstrap',
      );
      return {
        ...actual,
        startDaemonRuntimeBootstrap: vi.fn(async (params) => {
          runtimeBootstrapParams.current = params;
          const runtime = await actual.startDaemonRuntimeBootstrap(params);
          return {
            ...runtime,
            transferRuntimeStatePublisher: runtime.transferRuntimeStatePublisher
              ? {
                  ...runtime.transferRuntimeStatePublisher,
                  resume: transferRuntimeStateResume,
                }
              : null,
          };
        }),
      };
    });
    vi.doMock('./lifecycle/requestDaemonSelfRestartWithLockHandoff', async () => {
      const actual = await vi.importActual<
        typeof import('./lifecycle/requestDaemonSelfRestartWithLockHandoff')
      >('./lifecycle/requestDaemonSelfRestartWithLockHandoff');
      return {
        ...actual,
        requestDaemonSelfRestartWithLockHandoff: vi.fn(async (params) => {
          const handoffQuiescence = await params.quiesceBeforeLockRelease();
          await handoffQuiescence.resume();
          return { status: 'spawn_failed' };
        }),
      };
    });

    let run: Promise<void> | null = null;
    try {
      const { writeDaemonStateForLockOwner } = await import('@/persistence');
      const { startDaemonHeartbeatLoop } = await import('./lifecycle/heartbeat');
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();
      await vi.waitFor(() => {
        expect(machineRegistrationParams.current).not.toBeNull();
        expect(startDaemonHeartbeatLoop).toHaveBeenCalledOnce();
      }, { timeout: 3_000 });
      vi.mocked(writeDaemonStateForLockOwner).mockClear();
      quiescing = true;
      const heartbeatParams = vi.mocked(startDaemonHeartbeatLoop).mock.calls[0]?.[0];
      machineRegistrationParams.current?.setMachineId('machine-after-handoff');

      expect.soft(heartbeatParams?.isShuttingDown?.()).toBe(true);
      expect.soft(runtimeBootstrapParams.current?.isDaemonQuiescing?.()).toBe(true);
      expect.soft(machineRegistrationParams.current?.isShuttingDown()).toBe(false);
      expect.soft(machineRegistrationParams.current?.isQuiescing?.()).toBe(true);
      expect.soft(machineRegistrationParams.current?.bootstrapRuntime.isShuttingDown()).toBe(true);
      expect.soft(writeDaemonStateForLockOwner).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          machineId: 'machine-after-handoff',
        }),
      );

      harness.apiMachine.recoverDaemonTerminalSessionMutationJournals.mockClear();
      const onMachineSyncRuntime = machineRegistrationParams.current?.onMachineSyncRuntime;
      if (!onMachineSyncRuntime) throw new Error('expected machine sync runtime callback');
      const providerSource = pluginRuntimeOwnerParams.current?.providers as Readonly<{
        bind(binding: Readonly<{ signal: AbortSignal; isCurrent(): boolean }>): unknown;
      }> | undefined;
      if (!providerSource) throw new Error('expected Provider operations source');
      const providerBinding = Object.freeze({
        signal: new AbortController().signal,
        isCurrent: () => true,
      });
      const earlyProviderService = providerSource.bind(providerBinding) as Readonly<{
        connections: Readonly<{
          describe(request: unknown): Promise<unknown>;
        }>;
      }> | null;
      expect(earlyProviderService).not.toBeNull();
      expect(pluginRuntimeInitializationSettled).toBe(false);
      const providerDescribe = vi.fn(async () => ({
        status: 'success' as const,
        connections: [],
      }));
      const providerService = Object.freeze({
        connections: Object.freeze({ describe: providerDescribe }),
      });
      const providerBind = vi.fn(() => providerService);
      // Test harness boundary: this fixture supplies only the settled runtime fields the callback reads.
      await onMachineSyncRuntime({
        apiMachine: harness.apiMachine,
        apiMachineForSessions: null,
        automationWorker: null,
        memoryWorker: null,
        voiceInferenceWorker: null,
        daemonConnectivityCoordinator: null,
        machineConnectionStateCleanup: null,
        stopPeerMediationLoopbackServer: async () => {},
        resumeMachineConnectionPublications: machineConnectionPublicationsResume,
        daemonSessionMutationCustody: {
          bindRecoveredJournals: async () => ({
            boundSessionIds: [],
            retainedSessionIds: [],
          }),
          close: async () => {},
          stage: async () => {},
        },
        providerOperationsProducer: {
          machineServices: {},
          bind: providerBind,
        },
      } as unknown as Parameters<typeof onMachineSyncRuntime>[0]);
      await expect(earlyProviderService?.connections.describe({}))
        .resolves.toMatchObject({ status: 'success' });
      expect(providerDescribe).toHaveBeenCalledWith({});
      expect(providerBind).toHaveBeenCalledWith(providerBinding);
      expect(pluginRuntimeInitializationSettled).toBe(true);
      expect(harness.apiMachine.recoverDaemonTerminalSessionMutationJournals).not.toHaveBeenCalled();

      await heartbeatParams?.requestSelfRestart?.({} as never);
      expect(pluginChangeService.quiesceForHandoff).toHaveBeenCalledOnce();
      expect(quiescing).toBe(false);
      expect(machineRegistrationResume).toHaveBeenCalledOnce();
      expect(machineConnectionPublicationsResume).toHaveBeenCalledOnce();
      expect(transferRuntimeStateResume).toHaveBeenCalledOnce();
      expect(harness.apiMachine.recoverDaemonTerminalSessionMutationJournals).toHaveBeenCalledOnce();
    } finally {
      harness.requestShutdown('happier-cli');
      await run?.catch(() => undefined);
      vi.doUnmock('./startup/startDaemonMachineRegistrationRuntime');
      vi.doUnmock('./startup/startDaemonRuntimeBootstrap');
      vi.doUnmock('./lifecycle/requestDaemonSelfRestartWithLockHandoff');
      vi.doUnmock('@/plugins/daemon/runtimeOwner');
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
      expect(harness.automationWorkerStop).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('constructs and attaches the connected-account command owner before machine RPC becomes reachable', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let run: Promise<void> | null = null;

    try {
      harness.setAutoShutdownAfterAutomationStart(false);
      const { startDaemon } = await import('./startDaemon');
      run = startDaemon();

      await vi.waitFor(() => {
        expect(harness.apiMachine.registerConnectedAccountDaemonRuntime).toHaveBeenCalledTimes(1);
        expect(harness.apiMachine.setRPCHandlers).toHaveBeenCalledTimes(1);
      }, { timeout: 30_000 });
      expect(harness.apiMachine.registerConnectedAccountDaemonRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          execute: expect.any(Function),
        }),
      );
      expect(harness.apiMachine.registerConnectedAccountDaemonRuntime)
        .toHaveBeenCalledBefore(harness.apiMachine.setRPCHandlers);

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      harness.requestShutdown('happier-cli');
      await run?.catch(() => undefined);
      exitSpy.mockRestore();
    }
  });

  it('recovers daemon journals before staging exact orphan terminal evidence after machine sync', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const reattachModule = await import('./sessions/reattachFromMarkers');
      vi.mocked(reattachModule.reattachTrackedSessionsFromMarkers).mockResolvedValueOnce({
        orphanedDeadDaemonSessions: [
          {
            sessionId: 'sess-orphaned-6480',
            pid: 6480,
            activeTurnId: 'turn-exact-orphan',
          },
        ],
        connectedServiceRestartIntents: [],
      });

      const { startDaemon } = await import('./startDaemon');
      await startDaemon();

      await vi.waitFor(() => expect(harness.apiMachine.enqueueDaemonTerminalExactTurnEnd).toHaveBeenCalledWith({
        v: 1,
        sessionId: 'sess-orphaned-6480',
        mutationId: expect.stringMatching(/^daemon-observed-exit:/),
        action: 'end_session',
        turnId: 'turn-exact-orphan',
        observedAt: expect.any(Number),
      }));
      expect(harness.apiMachine.recoverDaemonTerminalSessionMutationJournals)
        .toHaveBeenCalledBefore(harness.apiMachine.enqueueDaemonTerminalExactTurnEnd);
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
      await vi.waitFor(() => {
        expect(harness.apiMachine.onConnectionStateChange).toHaveBeenCalledTimes(1);
        expect(harness.apiMachine.connect).toHaveBeenCalledTimes(1);
        expect(harness.startAutomationWorker).toHaveBeenCalledTimes(1);
      });

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
      // Provider account-usage persistence pauses a key after repeated failures and
      // keeps its unchanged payload. Reconnect must resubmit it, or usage silently
      // stops updating for the rest of the daemon's life.
      await vi.waitFor(() =>
        expect(harness.providerAccountUsagePersistenceFlush).toHaveBeenCalledWith(0));

      harness.requestShutdown('happier-cli');
      await run;
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('warms authenticated Account Settings before creating the plugin runtime', async () => {
    harness.setAutoShutdownAfterAutomationStart(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const deferredWarm = createDeferred<boolean>();
    const bootstrapCredentials = Object.freeze({
      token: 'token-settings-startup-order',
      encryption: {
        type: 'dataKey' as const,
        publicKey: new Uint8Array(32).fill(1),
        machineKey: new Uint8Array(32).fill(2),
      },
    });
    const warmParams: { current: Readonly<{ credentials: unknown }> | null } = { current: null };
    const warmActiveAccountSettingsSnapshotBestEffort = vi.fn((params: Readonly<{ credentials: unknown }>) => {
      warmParams.current = params;
      return deferredWarm.promise;
    });
    const pluginRuntimeOwnerParams: { current: Readonly<Record<string, unknown>> | null } = { current: null };
    const pluginRuntimeInitialize = vi.fn(async () => {
      const onInitialRegistryPublished = pluginRuntimeOwnerParams.current
        ?.onInitialRegistryPublished as (() => void) | undefined;
      onInitialRegistryPublished?.();
    });
    const pluginChangeService = {
      requestPluginChange: vi.fn(),
      decidePluginChange: vi.fn(),
      shutdown: vi.fn(async () => {}),
      quiesceForHandoff: vi.fn(async () => ({ resume: vi.fn() })),
      isQuiescing: () => false,
      runHardRevocationCurrentnessChange: vi.fn(),
    };
    const createDaemonPluginRuntimeOwner = vi.fn((params: Readonly<Record<string, unknown>>) => {
      pluginRuntimeOwnerParams.current = params;
      return {
        changeService: pluginChangeService,
        initialize: pluginRuntimeInitialize,
        reportCurrentAvailability: vi.fn(),
        readCatalog: vi.fn(async () => []),
      };
    });

    vi.doMock('@/settings/accountSettings/warmActiveAccountSettingsSnapshot', () => ({
      warmActiveAccountSettingsSnapshotBestEffort,
    }));
    vi.doMock('@/plugins/daemon/runtimeOwner', () => ({
      createDaemonPluginRuntimeOwner,
    }));

    let run: Promise<void> | null = null;
    try {
      const { authAndSetupMachineIfNeeded } = await import('@/ui/auth');
      vi.mocked(authAndSetupMachineIfNeeded).mockResolvedValueOnce({
        credentials: bootstrapCredentials,
        machineId: 'machine-automation',
      });
      const { startDaemon } = await import('./startDaemon');

      run = startDaemon();
      await vi.waitFor(() => {
        expect(warmActiveAccountSettingsSnapshotBestEffort).toHaveBeenCalledOnce();
      });

      expect(warmParams.current?.credentials).toBe(bootstrapCredentials);
      expect(createDaemonPluginRuntimeOwner).not.toHaveBeenCalled();
      expect(pluginRuntimeInitialize).not.toHaveBeenCalled();

      deferredWarm.resolve(false);
      await vi.waitFor(() => {
        expect(pluginRuntimeInitialize).toHaveBeenCalledOnce();
      });
    } finally {
      deferredWarm.resolve(false);
      harness.requestShutdown('happier-cli');
      await run?.catch(() => undefined);
      vi.doUnmock('@/settings/accountSettings/warmActiveAccountSettingsSnapshot');
      vi.doUnmock('@/plugins/daemon/runtimeOwner');
      exitSpy.mockRestore();
    }
  });
});
