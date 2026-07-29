import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { readHttpStatus } from '@/api/client/httpStatusError';
import type { ApiMachineClient } from '@/api/apiMachine';
import { TrackedSession } from './types';
import { MachineMetadata } from '@/api/types';
import type { DaemonState } from '@/api/types';
import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { stopCaffeinate } from '@/integrations/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import { projectPath } from '@/projectPath';
import {
  writeDaemonState,
  acquireDaemonLock,
  releaseDaemonLock,
  readCredentials,
} from '@/persistence';

import { reattachTrackedSessionsFromMarkers } from './sessions/reattachFromMarkers';
import { createDefaultTerminalHostAdapterInventory } from '@/integrations/terminal/host/defaultAdapters';
import { publishOrphanedStartupSessionEnds } from './sessions/publishOrphanedStartupSessionEnds';
import { createOnHappySessionWebhook } from './sessions/onHappySessionWebhook';
import { reconcileAgentRuntimeRestartDisposition } from './sessions/reconcileAgentRuntimeRestartDisposition';
import { createDaemonSessionHandoffMetadataBridge } from './sessions/createDaemonSessionHandoffMetadataBridge';
import { startDaemonHeartbeatLoop } from './lifecycle/heartbeat';

import { initialMachineMetadata } from './machine/metadata';
import { createDaemonShutdownController } from './lifecycle/shutdown';
import { createBeforeShutdownDrain } from './lifecycle/createBeforeShutdownDrain';
import { startDaemonRuntimeBootstrap } from './startup/startDaemonRuntimeBootstrap';
import { migrateTrackedSessionProcessesOutOfDaemonServiceCgroup } from './platform/linux/migrateTrackedSessionsOutOfDaemonServiceCgroup';
import { resolveFilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
export { buildTmuxSpawnConfig, buildTmuxWindowEnv } from './platform/tmux/spawnConfig';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { resolveWaitForAuthConfig } from './startup/waitForAuthConfig';
import { waitForInitialCredentials } from './startup/waitForInitialCredentials';
import { resolveDaemonDiagnosticSubsystemGates } from './startup/diagnosticSubsystemGates';
import { ensureDaemonStartupOwnership } from './startup/ensureDaemonStartupOwnership';
import { startDaemonMachineRegistrationRuntime } from './startup/startDaemonMachineRegistrationRuntime';
import { createDaemonCleanupAndShutdown } from './startup/createDaemonCleanupAndShutdown';
import { startAutomationWorker, type AutomationWorkerHandle } from './automation/automationWorker';
import { startMemoryWorker, type MemoryWorkerHandle } from './memory/memoryWorker';
import { startVoiceInferenceWorker, type VoiceInferenceWorkerHandle } from './voiceInference/voiceInferenceWorker';
import { createDaemonConnectivityCoordinator } from './connection/createDaemonConnectivityCoordinator';
import type { ConnectedServiceRefreshCoordinator } from './connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import type { ConnectedServiceQuotasCoordinator } from './connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { ConnectedServiceRuntimeRegistry } from './connectedServices/runtimeRegistry/registry';
import type { DaemonServerWorkScheduler } from './serverWork';
import type { ConnectedServiceQuotasLoopHandle } from './connectedServices/quotas/startConnectedServiceQuotasLoop';
import { getReleaseRingCatalogEntry } from '@happier-dev/release-runtime/releaseRings';
import {
  createProviderErrorV1,
} from '@happier-dev/protocol';
import { resolveDaemonServiceLabelFromEnv, resolveDaemonTakeoverRequestedFromEnv, resolveDaemonStartupSourceFromEnv } from '@/daemon/ownership/daemonOwnershipMetadata';
import { DaemonOwnershipConflictError } from '@/daemon/ownership/DaemonOwnershipConflictError';
import { resolveDaemonOwnershipConflictExitCode } from '@/daemon/ownership/resolveDaemonOwnershipConflictExitCode';
import { setRespawnDescriptorEncryptionMaterialForRestore } from './reattach';
import {
  startDaemonSessionControlRuntime,
  type ProviderManagedLocalServicesOwner,
} from './startup/startDaemonSessionControlRuntime';
import { prepareDaemonBootstrapContext } from './startup/prepareDaemonBootstrapContext';
import { createDaemonMachineBootstrapRuntime } from './startup/createDaemonMachineBootstrapRuntime';
import { stopManagedServersOnDaemonShutdownBestEffort } from './managedServers/stopManagedServersOnDaemonShutdown';
import { createSshTunnelSupervisor } from './ssh/tunnels';
import { createConnectedServiceGroupHomeCleanupScheduler } from './connectedServices/homes/createConnectedServiceGroupHomeCleanupScheduler';
import { createConnectedServiceMaterializedHomeCleanupScheduler } from './connectedServices/materialize/cleanup/createConnectedServiceMaterializedHomeCleanupScheduler';
import { listConnectedServiceRetainedMaterializedHomeSanitizers } from './connectedServices/catalogHooks';
import { readRetainedConnectedServiceMaterializationKeys } from './connectedServices/materialize/cleanup/readRetainedConnectedServiceMaterializationKeys';
import { resolveConnectedServicesMaterializationBaseDir } from './connectedServices/materialize/resolveConnectedServicesMaterializationBaseDir';
import { createDaemonMachineRpcRouteAttachmentCache } from './machineRpcRouteAttachments';
import { createPersistedTakeoverAdmissionWaiter } from './spawn/persistedTakeoverAdmission';
import type {
  ExternalSessionPersistedTakeoverAdmissionOwner,
} from '@/session/actions/externalSessions/persistedTakeoverAdmission';
import type { LocalServiceInventoryRoutes } from './local/services/inventory/routes';
import { createMachineLiveStreamCaptureRegistry } from './peer/mediation/stream';
import { createSimulatorInputLeaseManager } from './devices/simulator/lease';
import { createServerUrlServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';
import { createDaemonPeerMediationObservabilityRuntime } from './machine/peerMediationObservabilityRuntime';
import { installPeerMediationObservabilityRuntimeActionContextProvider } from './peer/mediation/observability/runtimeActionContextProvider';
import {
  requestDaemonSelfRestartWithLockHandoff,
  resolveDaemonSelfRestartEnvironment,
} from './lifecycle/requestDaemonSelfRestartWithLockHandoff';
import { readDaemonRestartVerifyPollMs, readDaemonRestartVerifyTimeoutMs } from './startupWaitDefaults';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { DaemonPluginChangeOwner } from '@/plugins/daemon/changeService';
import { createDaemonPluginRuntimeOwner } from '@/plugins/daemon/runtimeOwner';
import { resolveConnectedServiceQuotaFetcherDescriptors } from '@/plugins/projection/registry/connectedServiceQuotaFetchers';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createDaemonConnectedAccountPurposeBindingRuntime } from './connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { createConnectedAccountDaemonRuntime } from './connectedServices/ConnectedAccountDaemonRuntime';
import {
  createActiveAccountSettingsConnectedAccountSecrets,
  createQualifiedConnectedAccountDaemonPersistence,
} from './connectedServices/qualifiedConnectedAccountDaemonPersistence';
import {
  createRevisionedLegacyConnectedAccountMaterializationOwner,
  createQualifiedConnectedAccountEstablishedRuntimeOwner,
} from './connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import {
  createQualifiedConnectedAccountAttemptTransactionAdapters,
} from './connectedServices/qualifiedConnectedAccountAttemptTransactionAdapters';
import {
  reconcileConnectedServicesProjectionForPluginConsumers as reconcileProjectionAndInvalidateConnectedAccounts,
} from './connectedServices/purposeBindings/reconcileConnectedServicesProjectionForPluginConsumers';
import {
  listQualifiedConnectedAccountGroupsV4,
  listQualifiedConnectedAccountsV4,
  readQualifiedConnectedAccountGroupV4,
  resolveQualifiedConnectedAccountAtomicV4Negotiation,
  resolveQualifiedConnectedAccountPeerClass,
  resolveQualifiedConnectedAccountPeerOperationTransport,
} from '@/api/client/qualifiedConnectedAccountApi';

function resolvePositiveIntEnv(raw: string | undefined, fallback: number, bounds: { min: number; max: number }): number {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

export function resolveDaemonRuntimeId(processEnv: NodeJS.ProcessEnv = process.env): string {
  const inheritedRuntimeId = String(processEnv.HAPPIER_DAEMON_RUNTIME_ID ?? '').trim();
  return inheritedRuntimeId || randomUUID();
}

export async function startDaemon(options: Readonly<{ takeover?: boolean }> = {}): Promise<void> {
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  const { requestShutdown, resolvesWhenShutdownRequested } = createDaemonShutdownController();

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());
  const diagnosticSubsystemGates = resolveDaemonDiagnosticSubsystemGates(process.env);

  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const { waitForAuthEnabled, waitForAuthTimeoutMs } = resolveWaitForAuthConfig(process.env);

  let daemonLockHandle: Awaited<ReturnType<typeof acquireDaemonLock>> = null;
  const runtimeId = resolveDaemonRuntimeId(process.env);
  const startupSource = resolveDaemonStartupSourceFromEnv(process.env);
  const serviceLabel = resolveDaemonServiceLabelFromEnv(process.env);
  const takeoverRequested = options.takeover ?? resolveDaemonTakeoverRequestedFromEnv(process.env);
  const publicReleaseChannel = getReleaseRingCatalogEntry(configuration.publicReleaseRing)
    .publicLabel as NonNullable<DaemonState['publicReleaseChannel']>;

  try {
    const ownershipGate = await ensureDaemonStartupOwnership({
      takeoverRequested,
      startupSource,
      runtimeId,
    });
    if (ownershipGate.action === 'exit') {
      return;
    }

    const credentialsGate = await waitForInitialCredentials({
      isInteractive,
      waitForAuthEnabled,
      waitForAuthTimeoutMs,
      credentialsPath: configuration.privateKeyFile,
      readCredentials,
      acquireDaemonLock: () => acquireDaemonLock(5, 200),
      releaseDaemonLock,
      resolvesWhenShutdownRequested,
      logger,
      daemonLockHandle,
    });
    if (credentialsGate.action === 'exit') {
      process.exit(credentialsGate.exitCode);
    }
    if (credentialsGate.action === 'shutdown') {
      return;
    }
    daemonLockHandle = credentialsGate.daemonLockHandle;

    const bootstrapContext = await prepareDaemonBootstrapContext({
      daemonLockHandle,
      initialMachineMetadata,
      startupSource,
    });
    daemonLockHandle = bootstrapContext.daemonLockHandle;
    const credentials = bootstrapContext.credentials;
    const api = bootstrapContext.api;
    const preferredHost = bootstrapContext.preferredHost;
    const metadataForRegistration: MachineMetadata = bootstrapContext.metadataForRegistration;
    let preflightMachineRegistration = bootstrapContext.preflightMachineRegistration;
    let machineId = bootstrapContext.machineId;

    let connectedServiceRefreshCoordinator: ConnectedServiceRefreshCoordinator | null = null;
    let connectedServiceRefreshLoopHandle: Readonly<{
      stop: () => void;
      pause: () => void;
      resume: () => void;
    }> | null = null;
    let connectedServiceQuotasCoordinator: ConnectedServiceQuotasCoordinator | null = null;
    let connectedServiceQuotasLoopHandle: ConnectedServiceQuotasLoopHandle | null = null;
    let daemonServerWorkScheduler: DaemonServerWorkScheduler | null = null;
    let apiMachineForSessions: ApiMachineClient | null = null;
    let localServiceInventoryRoutes: Pick<LocalServiceInventoryRoutes, 'getSnapshot'> | null = null;
    let providerManagedLocalServicesOwner: ProviderManagedLocalServicesOwner | null = null;
    const persistedTakeoverAdmissionWaiter =
      createPersistedTakeoverAdmissionWaiter();
    let persistedTakeoverAdmissionOwner:
      ExternalSessionPersistedTakeoverAdmissionOwner | null = null;
    const attachPersistedTakeoverAdmissionOwner = (
      owner: ExternalSessionPersistedTakeoverAdmissionOwner,
    ): (() => void) => {
      persistedTakeoverAdmissionOwner = owner;
      return () => {
        if (persistedTakeoverAdmissionOwner === owner) {
          persistedTakeoverAdmissionOwner = null;
        }
      };
    };
    const machineRpcRouteAttachments = createDaemonMachineRpcRouteAttachmentCache({
      getApiMachineForSessions: () => apiMachineForSessions,
    });
    const liveStreamCaptureRegistry = createMachineLiveStreamCaptureRegistry();
    const simulatorInputLeaseManager = createSimulatorInputLeaseManager({ ttlMs: 30_000 });
    // PMS-WIRE: own the peer-mediation observability store ONCE at startup. Its emitter is handed to
    // the machine-sync bootstrap relay terminators (write-path) and its store is published on the Api
    // provider bridge below so the runtime-action dispatch (read-path) returns LIVE counters from the
    // SAME store. The daemon's own scope is derived from the credential subject; without it the bridge
    // stays unregistered and the read-path executor fails closed.
    const peerMediationObservabilityRuntime = createDaemonPeerMediationObservabilityRuntime();
    installPeerMediationObservabilityRuntimeActionContextProvider({
      api,
      credentialsToken: credentials.token,
      runtime: peerMediationObservabilityRuntime,
      machineId: () => machineId,
      logger,
    });
    // G9-E: own the daemon-wide cached server-features snapshot ONCE at startup and publish its
    // synchronous read on the Api provider bridge so the runtime-action front door's feature gate
    // reads the LIVE server bits cold. Without this, `getServerFeaturesSnapshot` is undefined
    // daemon-wide and every server-represented runtime-action family (e.g. localServices.preview)
    // fails closed even when the server enables it. The store reuses the same `/v1/features` fetch
    // source the local-services inventory + browser daemon gates already use — no second fetch path.
    const serverFeaturesSnapshotStore = createServerUrlServerFeaturesSnapshotStore({
      serverUrl: configuration.serverUrl,
      timeoutMs: 1_500,
      onError: (error) => {
        logger.debug('[DAEMON RUN] Server-features snapshot refresh failed (non-fatal)', error);
      },
    });
    api.setServerFeaturesSnapshotProvider(() => serverFeaturesSnapshotStore.getSnapshot());
    let refreshBrowserRouteOwners: (() => Promise<void>) | null = null;
    const refreshServerFeaturesAndBrowserRouteOwners = async (): Promise<void> => {
      await serverFeaturesSnapshotStore.refresh();
      await refreshBrowserRouteOwners?.();
    };
    // Prime offline-safe (non-blocking): a freshly booted daemon warms the cache so the first
    // session runtime-action dispatch reads real bits rather than failing closed. After the session
    // control runtime exists, the same refresh also gives browser route owners a late-registration
    // chance if the server was temporarily unreachable during startup.
    void refreshServerFeaturesAndBrowserRouteOwners();
    let serverFeaturesSnapshotRefreshInterval: NodeJS.Timeout | null = setInterval(() => {
      void refreshServerFeaturesAndBrowserRouteOwners();
    }, resolvePositiveIntEnv(
      process.env.HAPPIER_DAEMON_SERVER_FEATURES_REFRESH_INTERVAL_MS,
      5 * 60_000,
      { min: 30_000, max: 60 * 60_000 },
    ));
    serverFeaturesSnapshotRefreshInterval.unref?.();
    let automationWorker: AutomationWorkerHandle | null = null;
    let memoryWorker: MemoryWorkerHandle | null = null;
    let voiceInferenceWorker: VoiceInferenceWorkerHandle | null = null;
    let apiMachine: ApiMachineClient | null = null;
    let daemonUsageLimitRecoveryMutationCustody: Readonly<{
      bindRecoveredJournals(sessionIds: readonly string[]): Promise<Readonly<{
        boundSessionIds: readonly string[];
        retainedSessionIds: readonly string[];
      }>>;
      close(): Promise<void>;
    }> | null = null;
    let machineConnectionStateCleanup: (() => void) | null = null;
    let stopPeerMediationLoopbackServer: () => Promise<void> = async () => {};
    let shutdownInitiated = false;
    let daemonConnectivityCoordinator: ReturnType<typeof createDaemonConnectivityCoordinator> | null = null;
    let pluginChangeService: DaemonPluginChangeOwner | null = null;
    const isDaemonQuiescing = (): boolean => (
      shutdownInitiated || pluginChangeService?.isQuiescing() === true
    );
    let resumeQuiescedMachineRegistration = (): void => {};
    let resumeQuiescedMachineConnectionPublications = async (): Promise<void> => {};
    let resumeQuiescedMachineSyncStartup = async (): Promise<void> => {};
    let resumeQuiescedTransferStatePublication = async (): Promise<void> => {};
    const quiescePluginChangesForLockHandoff = async () => {
      if (!pluginChangeService) {
        throw new Error('Daemon plugin-change service is unavailable for lock handoff');
      }
      const quiescence = await pluginChangeService.quiesceForHandoff();
      return {
        resume: async () => {
          await quiescence.resume();
          resumeQuiescedMachineRegistration();
          await resumeQuiescedMachineConnectionPublications();
          try {
            await resumeQuiescedMachineSyncStartup();
          } finally {
            await resumeQuiescedTransferStatePublication();
          }
        },
      };
    };

    const pidToTrackedSession = new Map<number, TrackedSession>();
    const spawnResourceCleanupByPid = new Map<number, () => void | Promise<void>>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
    const connectedServicesRestartRequestedPids = new Set<number>();
    const connectedServicesMaterializationBaseDir = resolveConnectedServicesMaterializationBaseDir(configuration.happyHomeDir);
    const connectedServiceRuntimeRegistry = new ConnectedServiceRuntimeRegistry();
    let connectedServiceMaterializedHomeCleanupInterval: NodeJS.Timeout | null = null;
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: SpawnSessionResult) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
    const beforeShutdown = createBeforeShutdownDrain({
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      pidToTrackedSession,
      shutdownSpawnDrainGraceMs: resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_MS,
        10_000,
        { min: 0, max: 120_000 },
      ),
      shutdownSpawnDrainPollMs: resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_SHUTDOWN_SPAWN_DRAIN_POLL_MS,
        100,
        { min: 10, max: 5_000 },
      ),
      getApiMachineForSessions: () => apiMachineForSessions,
      buildUnexpectedSpawnResult: (errorMessage) => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage,
      }),
      buildIncompleteRetirementResult: () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage:
          'startup_retirement_incomplete:exit_cleanup_incomplete',
      }),
      drainBackgroundServerWork: async () => {
        await pluginChangeService?.shutdown();
        pluginChangeService = null;
        if (connectedServiceMaterializedHomeCleanupInterval) {
          clearInterval(connectedServiceMaterializedHomeCleanupInterval);
          connectedServiceMaterializedHomeCleanupInterval = null;
        }
        if (serverFeaturesSnapshotRefreshInterval) {
          clearInterval(serverFeaturesSnapshotRefreshInterval);
          serverFeaturesSnapshotRefreshInterval = null;
        }
        await connectedServiceQuotasCoordinator?.flushInBandQuotaPersistence(2_000);
        await daemonServerWorkScheduler?.flushAll(2_000);
      },
      disposePluginRuntimeRegistry: async () => {
        await pluginReloadController.shutdown({
          timeoutMs: resolvePositiveIntEnv(
            process.env.HAPPIER_DAEMON_PLUGIN_RUNTIME_SHUTDOWN_TIMEOUT_MS,
            5_000,
            { min: 0, max: 60_000 },
          ),
        });
      },
    });
    const {
      loadLocalSessionMetadataForHandoff,
      loadLocalHandoffMetadataByVendorResumeId,
      savePreparedTargetLocalMetadata,
    } = createDaemonSessionHandoffMetadataBridge({
      pidToTrackedSession,
      getMachineId: () => machineId,
      activeServerDir: configuration.activeServerDir,
    });
    const sshTunnelSupervisor = createSshTunnelSupervisor();
    await sshTunnelSupervisor.adoptPersistedTunnels();

    setRespawnDescriptorEncryptionMaterialForRestore(credentials.encryption ?? null);
    let orphanedDeadDaemonSessions: Awaited<
      ReturnType<typeof reattachTrackedSessionsFromMarkers>
    >['orphanedDeadDaemonSessions'] = [];
    let disconnectedTerminalHostCandidates: NonNullable<
      Awaited<ReturnType<typeof reattachTrackedSessionsFromMarkers>>['disconnectedTerminalHostCandidates']
    > = [];
    let unresolvedTerminalHostSessionIds: ReadonlyArray<string> = [];
    let managedProviderRecoveryCandidates: NonNullable<
      Awaited<ReturnType<typeof reattachTrackedSessionsFromMarkers>>['managedProviderRecoveryCandidates']
    > = [];
    let terminalHostAdapterInventoryPromise: ReturnType<typeof createDefaultTerminalHostAdapterInventory> | null = null;
    const loadTerminalHostAdapters = async () => {
      terminalHostAdapterInventoryPromise ??= createDefaultTerminalHostAdapterInventory({
        happyHomeDir: configuration.happyHomeDir,
        preference: process.platform === 'win32' ? 'zellij' : 'auto',
      });
      return (await terminalHostAdapterInventoryPromise).adapters;
    };
    try {
      const startupReattachResult = await reattachTrackedSessionsFromMarkers({
        pidToTrackedSession,
        credentials,
        loadTerminalHostAdapters,
      });
      orphanedDeadDaemonSessions = startupReattachResult.orphanedDeadDaemonSessions;
      disconnectedTerminalHostCandidates = startupReattachResult.disconnectedTerminalHostCandidates ?? [];
      unresolvedTerminalHostSessionIds = startupReattachResult.unresolvedTerminalHostSessionIds ?? [];
      managedProviderRecoveryCandidates =
        startupReattachResult.managedProviderRecoveryCandidates ?? [];
      if (process.platform === 'linux' && startupSource === 'background-service') {
        const migratedTrackedSessionProcesses = await migrateTrackedSessionProcessesOutOfDaemonServiceCgroup({
          trackedSessions: pidToTrackedSession.values(),
          daemonPid: process.pid,
        });
        if (migratedTrackedSessionProcesses.length > 0) {
          logger.debug('[DAEMON RUN] Moved reattached session runner process(es) out of the daemon service cgroup', {
            migrations: migratedTrackedSessionProcesses,
          });
        }
      }
    } finally {
      setRespawnDescriptorEncryptionMaterialForRestore(null);
    }

    const connectedServiceGroupHomeCleanupScheduler = createConnectedServiceGroupHomeCleanupScheduler({
      activeServerDir: configuration.activeServerDir,
      pidToTrackedSession,
      resolveGroupDeletionAuthority: async ({ serviceId, groupId }) => {
        try {
          const group = await api.getConnectedServiceAuthGroup({ serviceId, groupId });
          return { status: group === null ? 'deleted' : 'exists' };
        } catch (error) {
          if (readHttpStatus(error) === 404) return { status: 'unknown' };
          throw error;
        }
      },
    });
    void connectedServiceGroupHomeCleanupScheduler.reconcileDeletedGroupHomes({
      resolveGroupDeletionAuthority: async ({ serviceId, groupId }) => {
        try {
          const group = await api.getConnectedServiceAuthGroup({ serviceId, groupId });
          return { status: group === null ? 'deleted' : 'exists' };
        } catch (error) {
          if (readHttpStatus(error) === 404) return { status: 'unknown' };
          throw error;
        }
      },
    }).catch((error) => {
      logger.debug('[DAEMON RUN] Connected-service group home startup reconciliation failed (non-fatal)', error);
    });
    const connectedServiceMaterializedHomeCleanupScheduler = createConnectedServiceMaterializedHomeCleanupScheduler({
      baseDir: connectedServicesMaterializationBaseDir,
      pidToTrackedSession,
      orphanTtlMs: resolvePositiveIntEnv(
        process.env.HAPPIER_CONNECTED_SERVICES_MATERIALIZED_HOME_ORPHAN_TTL_MS,
        7 * 24 * 60 * 60_000,
        { min: 60_000, max: 90 * 24 * 60 * 60_000 },
      ),
      attemptTtlMs: resolvePositiveIntEnv(
        process.env.HAPPIER_CONNECTED_SERVICES_MATERIALIZED_HOME_ATTEMPT_TTL_MS,
        60 * 60_000,
        { min: 60_000, max: 7 * 24 * 60 * 60_000 },
      ),
      maxCleanupRetries: resolvePositiveIntEnv(
        process.env.HAPPIER_CONNECTED_SERVICES_MATERIALIZED_HOME_CLEANUP_MAX_RETRIES,
        3,
        { min: 1, max: 20 },
      ),
      getRetainedMaterializationKeys: async () => await readRetainedConnectedServiceMaterializationKeys({
        credentials,
      }).catch((error) => {
        logger.debug('[DAEMON RUN] Connected-service materialized home retained-session scan failed (non-fatal)', error);
        return { status: 'unavailable' };
      }),
      sanitizeRetainedMaterializedHome: async (homeRootDir) => {
        for (const sanitize of listConnectedServiceRetainedMaterializedHomeSanitizers()) {
          await sanitize(homeRootDir);
        }
      },
    });
    void connectedServiceMaterializedHomeCleanupScheduler.reconcile().catch((error) => {
      logger.debug('[DAEMON RUN] Connected-service materialized home startup reconciliation failed (non-fatal)', error);
    });
    connectedServiceMaterializedHomeCleanupInterval = setInterval(() => {
      void connectedServiceMaterializedHomeCleanupScheduler.cleanupPendingMaterializedHomes().catch((error) => {
        logger.debug('[DAEMON RUN] Connected-service materialized home periodic cleanup failed (non-fatal)', error);
      });
    }, resolvePositiveIntEnv(
      process.env.HAPPIER_CONNECTED_SERVICES_MATERIALIZED_HOME_CLEANUP_INTERVAL_MS,
      60 * 60_000,
      { min: 60_000, max: 24 * 60 * 60_000 },
    ));
    connectedServiceMaterializedHomeCleanupInterval.unref?.();

    let onTrackedSessionPidPromoted:
      NonNullable<
        Parameters<
          typeof createOnHappySessionWebhook
        >[0]['onPidPromoted']
      >
      | null = null;
    const onHappySessionWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      onTrackedSessionReady: async (tracked) => {
        const sessionId = typeof tracked.happySessionId === 'string' ? tracked.happySessionId.trim() : '';
        if (!sessionId) return;
        connectedServiceQuotasCoordinator?.updateSpawnTargetSessionId({
          pid: tracked.pid,
          sessionId,
        });
      },
      onPidPromoted: (input) => {
        if (!onTrackedSessionPidPromoted) {
          throw new Error(
            'Daemon session PID-promotion owner is unavailable',
          );
        }
        onTrackedSessionPidPromoted(input);
      },
    });
    const requestControlServerSelfRestart = async (
      { successorDistClosureFingerprint }: { successorDistClosureFingerprint?: string } = {},
    ): Promise<void> => {
      const result = await requestDaemonSelfRestartWithLockHandoff({
        getCurrentDaemonLockHandle: () => daemonLockHandle,
        setCurrentDaemonLockHandle: (lockHandle) => {
          daemonLockHandle = lockHandle;
        },
        quiesceBeforeLockRelease: quiescePluginChangesForLockHandoff,
        releaseDaemonLock,
        acquireDaemonLock: () => acquireDaemonLock(5, 200),
        requestShutdown,
        selfRestartParams: {
          runtimeId,
          expectedCliVersion: '',
          ownPid: process.pid,
          timeoutMs: readDaemonRestartVerifyTimeoutMs(),
          pollMs: readDaemonRestartVerifyPollMs(),
          postConfirmationOverlapMs: resolvePositiveIntEnv(
            process.env.HAPPIER_DAEMON_RESTART_OVERLAP_EXIT_GRACE_MS,
            1_000,
            { min: 0, max: 5_000 },
          ),
          takeover: true,
          env: resolveDaemonSelfRestartEnvironment(successorDistClosureFingerprint),
        },
      });
      if (result.status !== 'exited') {
        throw new Error(`Daemon self-restart did not exit current process (${result.status})`);
      }
    };
    const connectedAccountPersistence =
      createQualifiedConnectedAccountDaemonPersistence({
        credentials,
        getAccountEncryptionMode: async () => await api.getAccountEncryptionMode(),
        resolveServerFeaturesSnapshot: () =>
          serverFeaturesSnapshotStore.getSnapshot(),
        resolveSessionSyncPendingInputServerContractResult: () =>
          apiMachineForSessions
            ?.getSessionSyncPendingInputServerContractResult()
            ?? null,
        legacyCredentialApi: api,
        secrets: createActiveAccountSettingsConnectedAccountSecrets(),
        attemptTransactions:
          createQualifiedConnectedAccountAttemptTransactionAdapters({
            credentials,
          }),
      });
    const establishedConnectedAccountRuntimeOwner =
      createQualifiedConnectedAccountEstablishedRuntimeOwner({
        reloadController: pluginReloadController,
        credentials,
        getAccountEncryptionMode: () => api.getAccountEncryptionMode(),
        configuration: connectedAccountPersistence.configuration,
      });
    const revisionedLegacyConnectedAccountMaterializationOwner =
      createRevisionedLegacyConnectedAccountMaterializationOwner({
        reloadController: pluginReloadController,
        credentials,
        api,
        getAccountEncryptionMode: () => api.getAccountEncryptionMode(),
        configuration: connectedAccountPersistence.configuration,
      });
    const connectedAccountPurposeBindingRuntime = createDaemonConnectedAccountPurposeBindingRuntime({
      api,
      establishedRuntimeOwner: establishedConnectedAccountRuntimeOwner,
      revisionedLegacyMaterializationOwner:
        revisionedLegacyConnectedAccountMaterializationOwner,
      resolveQualifiedConnectedAccountMaterializationTransport: (service) =>
        resolveQualifiedConnectedAccountPeerOperationTransport({
          snapshot: serverFeaturesSnapshotStore.getSnapshot(),
          serverContract:
            apiMachineForSessions
              ?.getSessionSyncPendingInputServerContractResult()
              ?? null,
          service,
          operation: 'one_shot_materialization',
        }),
      resolveQualifiedConnectedAccountV4Support: () =>
        resolveQualifiedConnectedAccountAtomicV4Negotiation(
          serverFeaturesSnapshotStore.getSnapshot(),
        ),
      qualifiedApi: {
        async listAccounts(service, signal) {
          signal.throwIfAborted();
          const result = await listQualifiedConnectedAccountsV4({
            token: credentials.token,
            service,
          });
          signal.throwIfAborted();
          return result;
        },
        async listGroups(service, signal) {
          signal.throwIfAborted();
          const result = await listQualifiedConnectedAccountGroupsV4({
            token: credentials.token,
            service,
          });
          signal.throwIfAborted();
          return result;
        },
        async readGroup(group, signal) {
          signal.throwIfAborted();
          const result = await readQualifiedConnectedAccountGroupV4({
            token: credentials.token,
            group,
          });
          signal.throwIfAborted();
          return result;
        },
      },
      reloadController: pluginReloadController,
    });
    if (!daemonLockHandle) {
      throw new Error('Plugin runtime startup requires exclusive daemon ownership');
    }
    const pluginRuntimeOwner = createDaemonPluginRuntimeOwner({
      happyHomeDir: configuration.happyHomeDir,
      staleCandidateCleanup: 'exclusiveHome',
      reloadController: pluginReloadController,
      daemonInstanceId: runtimeId,
      daemonUptimeMs: () => Math.max(0, Math.trunc(process.uptime() * 1_000)),
      connectedAccounts: connectedAccountPurposeBindingRuntime.owner,
      qualifiedConnectedAccountEstablishedRuntimeOwner:
        establishedConnectedAccountRuntimeOwner,
      reconcileConnectedAccountPurposePublication:
        connectedAccountPurposeBindingRuntime.reconcileRegistryPublication,
    });
    pluginChangeService = pluginRuntimeOwner.changeService;
    await pluginRuntimeOwner.initialize();
    // Publish the restart fence before any spawn admission can reuse a stale
    // process. Physical retirement waits for machine mutation custody below.
    await reconcileAgentRuntimeRestartDisposition({
      trackedSessions: pidToTrackedSession.values(),
      isShuttingDown: isDaemonQuiescing,
    });
    const connectedAccountDaemonRuntime = createConnectedAccountDaemonRuntime({
      reloadController: pluginReloadController,
      persistence: connectedAccountPersistence,
      resolvePeerOperationTransport: ({ service, operation }) =>
        resolveQualifiedConnectedAccountPeerOperationTransport({
          snapshot: serverFeaturesSnapshotStore.getSnapshot(),
          serverContract:
            apiMachineForSessions
              ?.getSessionSyncPendingInputServerContractResult()
              ?? null,
          service,
          operation,
        }),
      configurationConsequences: {
        async assertAvailable() {
          if (!connectedServiceRefreshCoordinator) {
            throw Object.assign(
              new Error(
                'Connected-account configuration consequence coordinator is unavailable',
              ),
              {
                code:
                  'connected_account_configuration_consequence_unavailable',
              },
            );
          }
        },
        async apply(input) {
          const coordinator = connectedServiceRefreshCoordinator;
          if (!coordinator) {
            throw Object.assign(
              new Error(
                'Connected-account configuration consequence coordinator became unavailable',
              ),
              {
                code:
                  'connected_account_configuration_consequence_unavailable',
              },
            );
          }
          await coordinator
            .applyQualifiedConnectedAccountConfigurationConsequence(input);
        },
      },
      revocation: {
        token: credentials.token,
        establishedRuntimeOwner: establishedConnectedAccountRuntimeOwner,
        legacyCredentialApi: api,
        resolveV4Support: () =>
          resolveQualifiedConnectedAccountAtomicV4Negotiation(
            serverFeaturesSnapshotStore.getSnapshot(),
          ),
      },
    });
    machineRpcRouteAttachments.attachConnectedAccountDaemonRuntime(
      connectedAccountDaemonRuntime,
    );
    const {
      spawnSession,
      stopSession,
      isSessionAlreadyRunning,
      onChildExited,
      controlPort,
      controlToken,
      stopControlServer,
      connectedServiceAuthGroupPreTurnSwitchCoordinator,
      connectedServicePredictiveSwitchGuard,
      connectedServiceRuntimeAuthApplyCapabilityResolver,
      consumeCommittedAuthGroupGeneration,
      requestConnectedServiceRefreshRestartSignal,
      cancelConnectedServiceRuntimeAuthRecovery,
      retryTemporaryThrottleNow,
      reconcileConnectedServicesProjection,
      awaitAgentSessionOpen,
      installExternalSessionHostOperations,
      providerAccountUsageStore,
      connectedServiceRuntimeQuotaSnapshots,
      refreshBrowserRouteOwners: refreshBrowserRouteOwnersFromSessionControl,
    } = await startDaemonSessionControlRuntime({
      machineId,
      runtimeId,
      credentials,
      api,
      loadLocalHandoffMetadataByVendorResumeId,
      connectedServicesMaterializationBaseDir,
      getConnectedServiceRefreshCoordinator: () => connectedServiceRefreshCoordinator,
      getConnectedServiceQuotasCoordinator: () => connectedServiceQuotasCoordinator,
      resolveQualifiedConnectedAccountV4Support: () =>
        resolveQualifiedConnectedAccountAtomicV4Negotiation(
          serverFeaturesSnapshotStore.getSnapshot(),
        ),
      resolveQualifiedConnectedAccountRequestAuthTransport: (service) =>
        resolveQualifiedConnectedAccountPeerOperationTransport({
          snapshot: serverFeaturesSnapshotStore.getSnapshot(),
          serverContract:
            apiMachineForSessions
              ?.getSessionSyncPendingInputServerContractResult()
              ?? null,
          service,
          operation: 'request_auth',
        }),
      establishedConnectedAccountRuntimeOwner,
      connectedServiceRuntimeRegistry,
      pidToTrackedSession,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      getApiMachineForSessions: () => apiMachineForSessions,
      onLocalServicesRoutesReady: (routes) => {
        localServiceInventoryRoutes = routes.localServicesInventory ?? null;
        machineRpcRouteAttachments.attachLocalServicesRoutes(routes);
      },
      onProviderManagedLocalServicesOwnerReady: (owner) => {
        providerManagedLocalServicesOwner = owner;
      },
      onLocalServicesPreviewRoutesReady: machineRpcRouteAttachments.attachLocalServicesPreviewRoutes,
      onBrowserControlRoutesReady: machineRpcRouteAttachments.attachBrowserControlRoutes,
      onBrowserContextRoutesReady: machineRpcRouteAttachments.attachBrowserContextRoutes,
      onBrowserDiagnosticsRoutesReady: machineRpcRouteAttachments.attachBrowserDiagnosticsRoutes,
      onBrowserRecordingRoutesReady: machineRpcRouteAttachments.attachBrowserRecordingRoutes,
      onSimulatorPreviewRoutesReady: machineRpcRouteAttachments.attachSimulatorPreviewRoutes,
      resolveServerFeaturesSnapshot: () => serverFeaturesSnapshotStore.refresh(),
      liveStreamCaptureRegistry,
      simulatorInputLeaseManager,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      connectedServicesRestartRequestedPids,
      loadTerminalHostAdapters,
      startupTerminalRecovery: {
        disconnectedTerminalHostCandidates,
        unresolvedTerminalHostSessionIds,
      },
      startupManagedProviderRecoveryCandidates:
        managedProviderRecoveryCandidates,
      connectedServiceGroupHomeCleanupScheduler,
      connectedServiceMaterializedHomeCleanupScheduler,
      beforeShutdown,
      onHappySessionWebhook,
      setOnTrackedSessionPidPromoted: (handler) => {
        onTrackedSessionPidPromoted = handler;
      },
      admitPersistedTakeover: async (input) => {
        const owner = persistedTakeoverAdmissionOwner;
        if (!owner) {
          throw new Error('persisted_takeover_admission_owner_unavailable');
        }
        if (input.phase === 'admit') {
          await owner.admit(input);
          return;
        }
        await owner.runtimeBound(input);
      },
      sshTunnelSupervisor,
      requestShutdown,
      requestSelfRestart: requestControlServerSelfRestart,
      pluginChangeService,
      resolveManagedPurposeBindingIntent:
        connectedAccountPurposeBindingRuntime.resolveBindingIntent,
      activateSessionPurposeBindings:
        connectedAccountPurposeBindingRuntime.activateSessionPurposeBindings,
      activatePurposeBindings:
        connectedAccountPurposeBindingRuntime.activatePurposeBindings,
      isShuttingDown: isDaemonQuiescing,
      processEnv: process.env,
    });
    connectedAccountPurposeBindingRuntime.bindSessionRestartOwner(({ sessionId, purpose }) => {
      const tracked = Array.from(pidToTrackedSession.values())
        .find((candidate) => candidate.happySessionId === sessionId);
      if (!tracked) {
        logger.debug('[DAEMON RUN] Connected Account purpose changed without a live session runner', {
          sessionId,
          purpose: purpose.purpose,
        });
        return;
      }
      void requestConnectedServiceRefreshRestartSignal({
        pid: tracked.pid,
        delayMs: 0,
        preferProcessGroup: tracked.startedBy === 'daemon',
        restartDiagnostic: {
          trigger: 'reconnect_propagation',
          sessionId,
          reason: `connected_account_purpose_changed:${purpose.purpose}`,
        },
        onSignalFailure: (error) => {
          logger.debug('[DAEMON RUN] Failed to request Connected Account purpose restart', error);
        },
      }).catch((error) => {
        logger.debug('[DAEMON RUN] Connected Account purpose restart owner failed', error);
      });
    });
    const reconcileConnectedServicesProjectionForPluginConsumers = async (
      notification: Parameters<typeof reconcileConnectedServicesProjection>[0],
    ): Promise<void> => {
      await reconcileProjectionAndInvalidateConnectedAccounts({
        notification,
        reconcile: reconcileConnectedServicesProjection,
        invalidateConnectedAccounts: connectedAccountPurposeBindingRuntime.invalidate,
      });
    };
    refreshBrowserRouteOwners = refreshBrowserRouteOwnersFromSessionControl;
    void refreshServerFeaturesAndBrowserRouteOwners();
    const filesystemAccessPolicy = resolveFilesystemAccessPolicy({ env: process.env });
    const connectedServiceQuotaFetcherDescriptors = await resolveMergedContributionRegistry({
      happyHomeDir: configuration.happyHomeDir,
    })
      .then((registry) => resolveConnectedServiceQuotaFetcherDescriptors(registry))
      .catch((error) => {
        logger.debug('[DAEMON RUN] Failed to resolve connected-service quota fetcher contributions; continuing without provider quota fetchers', error);
        return [];
      });
    const runtimeBootstrap = await startDaemonRuntimeBootstrap({
      api,
      credentials,
      logger,
      processEnv: process.env,
      controlPort,
      machineId,
      machineIdProvider: () => machineId,
      runtimeId,
      cliVersion: packageJson.version,
      startupSource,
      serviceLabel,
      daemonLogPath: logger.logFilePath,
      controlToken,
      happyHomeDir: configuration.happyHomeDir,
      activeServerDir: configuration.activeServerDir,
      filesystemAccessPolicy,
      publicReleaseChannel,
      isDaemonQuiescing,
      connectedServicesRestartRequestedPids,
      pidToTrackedSession,
      qualifiedConnectedAccountEstablishedRuntimeOwner:
        establishedConnectedAccountRuntimeOwner,
      listScheduledQualifiedConnectedAccounts:
        connectedAccountPurposeBindingRuntime.listCoordinatorAccounts,
      onQualifiedConnectedAccountCredentialUpdated: () => {
        connectedAccountPurposeBindingRuntime.invalidate();
      },
      resolveQualifiedConnectedAccountV4Support: () =>
        resolveQualifiedConnectedAccountAtomicV4Negotiation(
          serverFeaturesSnapshotStore.getSnapshot(),
        ),
      resolveQualifiedConnectedAccountPeerClass: () =>
        resolveQualifiedConnectedAccountPeerClass(
          serverFeaturesSnapshotStore.getSnapshot(),
          apiMachineForSessions
            ?.getSessionSyncPendingInputServerContractResult()
            ?? null,
        ),
      resolveQualifiedConnectedAccountPeerOperationTransport: ({
        service,
        operation,
      }) =>
        resolveQualifiedConnectedAccountPeerOperationTransport({
          snapshot: serverFeaturesSnapshotStore.getSnapshot(),
          serverContract:
            apiMachineForSessions
              ?.getSessionSyncPendingInputServerContractResult()
            ?? null,
          service,
          operation,
        }),
      stopSession,
      connectedServiceRuntimeRegistry,
      // K2: FSM-routed proactive quota coordinator (built by the session-control runtime).
      connectedServiceAuthGroupPreTurnSwitchCoordinator,
      connectedServicePredictiveSwitchGuard,
      connectedServiceRuntimeAuthApplyCapabilityResolver,
      consumeCommittedAuthGroupGeneration,
      // K3: gated credential-refresh / reconnect restart adapter.
      requestConnectedServiceRefreshRestartSignal,
      // K2: shared single runtime quota-snapshot store (proactive selection + quotas coordinator).
      connectedServiceRuntimeQuotaSnapshots,
      // Canonical provider-account usage source of truth for quota switching/fanout policy.
      providerAccountUsageStore,
      connectedServiceQuotaFetcherDescriptors,
    });
    const {
      fileState,
      initialDaemonState,
      directPeerServerLifecycle,
      directTransferPromptAssetAdapterRegistry,
      directTransferPromptRegistryRegistry,
      transferRuntimeStatePublisher,
      stopDirectPeerServer,
      stopTailscaleTransferServeLifecycle,
    } = runtimeBootstrap;
    resumeQuiescedTransferStatePublication = async () => {
      await transferRuntimeStatePublisher?.resume();
    };
    connectedServiceRefreshCoordinator = runtimeBootstrap.connectedServiceRefreshCoordinator;
    connectedServiceRefreshLoopHandle = runtimeBootstrap.connectedServiceRefreshLoopHandle;
    connectedServiceQuotasCoordinator = runtimeBootstrap.connectedServiceQuotasCoordinator;
    connectedServiceQuotasLoopHandle = runtimeBootstrap.connectedServiceQuotasLoopHandle;
    daemonServerWorkScheduler = runtimeBootstrap.daemonServerWorkScheduler;

    const machineRegistrationRuntime = startDaemonMachineRegistrationRuntime({
      api,
      credentials,
      metadataForRegistration,
      initialDaemonState,
      processEnv: process.env,
      resolvePositiveIntEnv,
      resolvesWhenShutdownRequested,
      initialPreflightMachineRegistration: preflightMachineRegistration,
      resolveMachineId: () => machineId,
      setMachineId: (resolvedMachineId) => {
        if (isDaemonQuiescing()) return;
        machineId = resolvedMachineId;
        if (fileState.machineId !== resolvedMachineId) {
          fileState.machineId = resolvedMachineId;
          writeDaemonState(fileState);
        }
      },
      isShuttingDown: () => shutdownInitiated,
      isQuiescing: isDaemonQuiescing,
      bootstrapRuntime: createDaemonMachineBootstrapRuntime({
        api,
        credentials,
        diagnosticSubsystemGates,
        runtimeId,
        publicReleaseChannel,
        startupSource,
        serviceLabel,
        transferRuntimeStatePublisher,
        spawnSession,
        stopSession,
        awaitAgentSessionOpen,
        installExternalSessionHostOperations,
        isSessionAlreadyRunning,
        loadLocalSessionMetadataForHandoff,
        savePreparedTargetLocalMetadata,
        beforeShutdown,
        requestShutdown,
        directPeerServerLifecycle,
        directTransferPromptAssetAdapterRegistry,
        directTransferPromptRegistryRegistry,
        daemonServerWorkScheduler,
        cancelConnectedServiceRuntimeAuthRecovery,
        retryTemporaryThrottleNow,
        liveStreamCaptureRegistry,
        readActiveLiveStreamControlLease: (input) => simulatorInputLeaseManager.read(input),
        peerMediationObservabilityEmitter: peerMediationObservabilityRuntime.emitter,
        setDaemonServerWorkOnline: runtimeBootstrap.setDaemonServerWorkOnline,
        onMachineConnectionOnline: async () => {
          await refreshServerFeaturesAndBrowserRouteOwners();
          await connectedServiceQuotasCoordinator?.flushInBandQuotaPersistence(0);
        },
        reconcileConnectedServicesProjection: reconcileConnectedServicesProjectionForPluginConsumers,
        subscribeConnectedAccountInvalidations:
          connectedAccountPurposeBindingRuntime.subscribeInvalidations,
        isShuttingDown: isDaemonQuiescing,
        getServerFeaturesSnapshot: () => serverFeaturesSnapshotStore.getSnapshot(),
        readLocalServiceInventorySnapshot: async () => localServiceInventoryRoutes?.getSnapshot() ?? null,
        dispatchProviderLocalServicesBridge: async (request) => {
          if (!providerManagedLocalServicesOwner) return { ok: false, errorCode: 'managed_service_unavailable' };
          return providerManagedLocalServicesOwner.dispatch(request);
        },
        managedCatalogRuntime: {
          launch: async (input) => {
            if (providerManagedLocalServicesOwner) {
              return providerManagedLocalServicesOwner.managedCatalogRuntime.launch(input);
            }
            return {
              ok: false,
              error: createProviderErrorV1('provider_endpoint_unavailable', {
                connectionId: input.request.connectionId,
                machineId: input.request.machineId,
              }),
            };
          },
        },
        resolveManagedPurposeBindingIntent:
          connectedAccountPurposeBindingRuntime.resolveBindingIntent,
        readManagedLocalServicesSnapshot: async () => providerManagedLocalServicesOwner?.getManagedSnapshot() ?? null,
        prepareApiMachineForSessions:
          machineRpcRouteAttachments.prepareApiMachineForSessions,
        persistedTakeoverAdmissionWaiter,
        attachPersistedTakeoverAdmissionOwner,
      }),
      onMachineSyncRuntime: async (machineSyncRuntime) => {
        apiMachine = machineSyncRuntime.apiMachine;
        apiMachineForSessions = machineSyncRuntime.apiMachineForSessions;
        machineRpcRouteAttachments.attachApiMachineForSessions(apiMachineForSessions);
        automationWorker = machineSyncRuntime.automationWorker;
        memoryWorker = machineSyncRuntime.memoryWorker;
        voiceInferenceWorker = machineSyncRuntime.voiceInferenceWorker;
        daemonConnectivityCoordinator = machineSyncRuntime.daemonConnectivityCoordinator;
        machineConnectionStateCleanup = machineSyncRuntime.machineConnectionStateCleanup;
        stopPeerMediationLoopbackServer = machineSyncRuntime.stopPeerMediationLoopbackServer;
        resumeQuiescedMachineConnectionPublications =
          machineSyncRuntime.resumeMachineConnectionPublications;
        daemonUsageLimitRecoveryMutationCustody = machineSyncRuntime.daemonUsageLimitRecoveryMutationCustody;
        let didCompleteMachineSyncStartup = false;
        let machineSyncStartupInFlight: Promise<void> | null = null;
        const completeMachineSyncStartup = async (): Promise<void> => {
          if (isDaemonQuiescing() || didCompleteMachineSyncStartup) return;
          if (machineSyncStartupInFlight) {
            try {
              await machineSyncStartupInFlight;
            } catch {
              // The original caller owns the failure. A concurrent resume retries
              // only while this daemon is still current and no completed result exists.
            }
            if (!isDaemonQuiescing() && !didCompleteMachineSyncStartup) {
              await completeMachineSyncStartup();
            }
            return;
          }

          const operation = (async () => {
            if (machineSyncRuntime.apiMachine) {
              if (!machineSyncRuntime.daemonUsageLimitRecoveryMutationCustody) {
                throw new Error('Daemon usage-limit mutation custody is unavailable during journal recovery');
              }
              const recovery = await machineSyncRuntime.apiMachine.recoverDaemonTerminalSessionMutationJournals({
                bindUsageLimitRecoveryJournals: (sessionIds) =>
                  machineSyncRuntime.daemonUsageLimitRecoveryMutationCustody!.bindRecoveredJournals(sessionIds),
                isShuttingDown: isDaemonQuiescing,
              });
              if (isDaemonQuiescing()) return;

              if (recovery.retainedSessionIds.length > 0) {
                logger.warn('[DAEMON RUN] Retained daemon mutation journals without a resolvable session binding', {
                  sessionIds: recovery.retainedSessionIds,
                });
              }
              // Re-enter the same restart owner after exit staging is durable; the
              // canonical stop lifecycle serializes retirement with public Stop/Resume.
              const restartRetirementResults =
                await reconcileAgentRuntimeRestartDisposition({
                  trackedSessions: pidToTrackedSession.values(),
                  retireSession: stopSession,
                  isShuttingDown: isDaemonQuiescing,
                });
              for (const { sessionId, result } of restartRetirementResults) {
                if (
                  result.status !== 'stopped'
                  && result.status !== 'not_found'
                ) {
                  logger.warn(
                    '[DAEMON RUN] Reattached Agent runtime remains fenced after incomplete startup retirement',
                    {
                      sessionId,
                      result,
                    },
                  );
                }
              }
              if (isDaemonQuiescing()) return;

              await publishOrphanedStartupSessionEnds({
                apiMachine: machineSyncRuntime.apiMachine,
                orphanedDeadDaemonSessions,
                isShuttingDown: isDaemonQuiescing,
              });
              if (isDaemonQuiescing()) return;
            }
            didCompleteMachineSyncStartup = true;
          })();
          machineSyncStartupInFlight = operation;
          try {
            await operation;
          } finally {
            if (machineSyncStartupInFlight === operation) {
              machineSyncStartupInFlight = null;
            }
          }
        };
        resumeQuiescedMachineSyncStartup = completeMachineSyncStartup;
        await completeMachineSyncStartup();
      },
      filesystemAccessPolicy,
      takeoverRequested,
      preferredHost,
      connectedServiceRefreshLoopHandle,
      connectedServiceQuotasLoopHandle,
    });
    resumeQuiescedMachineRegistration = () => {
      machineRegistrationRuntime?.resume();
    };

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const restartOnStaleVersionAndHeartbeat = startDaemonHeartbeatLoop({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => apiMachineForSessions,
      onChildExited,
      controlPort,
      fileState,
      currentCliVersion: configuration.currentCliVersion,
      requestShutdown,
      isShuttingDown: isDaemonQuiescing,
      requestSelfRestart: async (selfRestartParams) =>
        await requestDaemonSelfRestartWithLockHandoff({
          getCurrentDaemonLockHandle: () => daemonLockHandle,
          setCurrentDaemonLockHandle: (lockHandle) => {
            daemonLockHandle = lockHandle;
          },
          quiesceBeforeLockRelease: quiescePluginChangesForLockHandoff,
          releaseDaemonLock,
          acquireDaemonLock: () => acquireDaemonLock(5, 200),
          requestShutdown,
          selfRestartParams,
        }),
    });

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    const cleanupAndShutdown = createDaemonCleanupAndShutdown({
      markShutdownInitiated: () => {
        shutdownInitiated = true;
      },
      processEnv: process.env,
      resolvePositiveIntEnv,
      restartOnStaleVersionAndHeartbeat,
      connectedServiceRefreshLoopHandle,
      connectedServiceQuotasLoopHandle,
      beforeShutdown,
      apiMachine,
      closeDaemonMutationCustody: async () => {
        await daemonUsageLimitRecoveryMutationCustody?.close();
      },
      machineConnectionStateCleanup,
      automationWorker,
      memoryWorker,
      voiceInferenceWorker,
      trackedSessionCount: pidToTrackedSession.size,
      stopDirectPeerServer: async () => {
        await stopPeerMediationLoopbackServer();
        await stopDirectPeerServer();
      },
      stopTailscaleTransferServeLifecycle,
      stopManagedServersOnShutdown: stopManagedServersOnDaemonShutdownBestEffort,
      stopSshTunnelsOnShutdown: sshTunnelSupervisor.stopAllTunnels,
      stopControlServer,
      daemonLockHandle,
      releaseDaemonLock,
    });
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    try {
      if (daemonLockHandle) {
        await releaseDaemonLock(daemonLockHandle);
      }
    } catch {
      // ignore
    }
    if (error instanceof DaemonOwnershipConflictError) {
      process.exit(resolveDaemonOwnershipConflictExitCode(startupSource));
    }
    // IMPORTANT: Do not log raw Axios errors here; they can contain bearer tokens.
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', serializeAxiosErrorForLog(error));
    logger.flushSync();
    process.exit(1);
  }
}
