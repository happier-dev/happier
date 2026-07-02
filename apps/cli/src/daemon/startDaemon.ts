import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import type { ApiMachineClient } from '@/api/apiMachine';
import { TrackedSession } from './types';
import { MachineMetadata } from '@/api/types';
import type { DaemonState } from '@/api/types';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
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
  readSettings,
} from '@/persistence';

import { reattachTrackedSessionsFromMarkers } from './sessions/reattachFromMarkers';
import { publishOrphanedStartupSessionEnds } from './sessions/publishOrphanedStartupSessionEnds';
import { createOnHappySessionWebhook } from './sessions/onHappySessionWebhook';
import { createDaemonSessionHandoffMetadataBridge } from './sessions/createDaemonSessionHandoffMetadataBridge';
import { startDaemonHeartbeatLoop } from './lifecycle/heartbeat';

import { initialMachineMetadata } from './machine/metadata';
export { initialMachineMetadata } from './machine/metadata';
import { createDaemonShutdownController } from './lifecycle/shutdown';
import { createBeforeShutdownDrain } from './lifecycle/createBeforeShutdownDrain';
import { startDaemonRuntimeBootstrap } from './startup/startDaemonRuntimeBootstrap';
import { migrateTrackedSessionProcessesOutOfDaemonServiceCgroup } from './platform/linux/migrateTrackedSessionsOutOfDaemonServiceCgroup';
import { resolveFilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
export { buildTmuxSpawnConfig, buildTmuxWindowEnv } from './platform/tmux/spawnConfig';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
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
import type { DaemonServerWorkScheduler } from './serverWork';
import type { ConnectedServiceQuotasLoopHandle } from './connectedServices/quotas/startConnectedServiceQuotasLoop';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { getReleaseRingCatalogEntry } from '@happier-dev/release-runtime/releaseRings';
import { resolveDaemonServiceLabelFromEnv, resolveDaemonTakeoverRequestedFromEnv, resolveDaemonStartupSourceFromEnv } from '@/daemon/ownership/daemonOwnershipMetadata';
import { DaemonOwnershipConflictError } from '@/daemon/ownership/DaemonOwnershipConflictError';
import { resolveDaemonOwnershipConflictExitCode } from '@/daemon/ownership/resolveDaemonOwnershipConflictExitCode';
import { setRespawnDescriptorEncryptionMaterialForRestore } from './reattach';
import { startDaemonSessionControlRuntime } from './startup/startDaemonSessionControlRuntime';
import { prepareDaemonBootstrapContext } from './startup/prepareDaemonBootstrapContext';
import { createDaemonMachineBootstrapRuntime } from './startup/createDaemonMachineBootstrapRuntime';
import { stopManagedServersOnDaemonShutdownBestEffort } from './managedServers/stopManagedServersOnDaemonShutdown';
import { createSshTunnelSupervisor } from './ssh/tunnels';
import { createConnectedServiceGroupHomeCleanupScheduler } from './connectedServices/homes/createConnectedServiceGroupHomeCleanupScheduler';
import { createConnectedServiceMaterializedHomeCleanupScheduler } from './connectedServices/materialize/cleanup/createConnectedServiceMaterializedHomeCleanupScheduler';
import { readRetainedConnectedServiceMaterializationKeys } from './connectedServices/materialize/cleanup/readRetainedConnectedServiceMaterializationKeys';

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
    let automationWorker: AutomationWorkerHandle | null = null;
    let memoryWorker: MemoryWorkerHandle | null = null;
    let voiceInferenceWorker: VoiceInferenceWorkerHandle | null = null;
    let apiMachine: ApiMachineClient | null = null;
    let machineConnectionStateCleanup: (() => void) | null = null;
    let stopPeerMediationLoopbackServer: () => Promise<void> = async () => {};
    let shutdownInitiated = false;
    let daemonConnectivityCoordinator: ReturnType<typeof createDaemonConnectivityCoordinator> | null = null;

    const pidToTrackedSession = new Map<number, TrackedSession>();
    const spawnResourceCleanupByPid = new Map<number, () => void>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
    const connectedServicesRestartRequestedPids = new Set<number>();
    const connectedServicesMaterializationBaseDir = join(configuration.happyHomeDir, 'daemon', 'connected-services', 'materialized');
    let connectedServiceMaterializedHomeCleanupInterval: NodeJS.Timeout | null = null;
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: SpawnSessionResult) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
    const beforeShutdown = createBeforeShutdownDrain({
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
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
      drainBackgroundServerWork: async () => {
        if (connectedServiceMaterializedHomeCleanupInterval) {
          clearInterval(connectedServiceMaterializedHomeCleanupInterval);
          connectedServiceMaterializedHomeCleanupInterval = null;
        }
        await connectedServiceQuotasCoordinator?.flushInBandQuotaPersistence(2_000);
        await daemonServerWorkScheduler?.flushAll(2_000);
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
    let orphanedDeadDaemonSessions: ReadonlyArray<{ sessionId: string; pid: number }> = [];
    try {
      const startupReattachResult = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession, credentials });
      orphanedDeadDaemonSessions = startupReattachResult.orphanedDeadDaemonSessions;
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
      groupExists: async ({ serviceId, groupId }) => (await api.getConnectedServiceAuthGroup({ serviceId, groupId })) !== null,
    });
    void connectedServiceGroupHomeCleanupScheduler.reconcileDeletedGroupHomes({
      groupExists: async ({ serviceId, groupId }) => (await api.getConnectedServiceAuthGroup({ serviceId, groupId })) !== null,
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
        return [];
      }),
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

    const onHappySessionWebhook = createOnHappySessionWebhook({ pidToTrackedSession, pidToAwaiter });
    const {
      spawnSession,
      stopSession,
      isSessionAlreadyRunning,
      onChildExited,
      controlPort,
      controlToken,
      stopControlServer,
      connectedServiceAuthGroupPreTurnSwitchCoordinator,
      connectedServiceRecoverySwitchGuard,
      requestConnectedServiceRefreshRestartSignal,
      retryTemporaryThrottleNow,
      connectedServiceRuntimeQuotaSnapshots,
    } = await startDaemonSessionControlRuntime({
      machineId,
      credentials,
      api,
      loadLocalHandoffMetadataByVendorResumeId,
      connectedServicesMaterializationBaseDir,
      getConnectedServiceRefreshCoordinator: () => connectedServiceRefreshCoordinator,
      getConnectedServiceQuotasCoordinator: () => connectedServiceQuotasCoordinator,
      pidToTrackedSession,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      getApiMachineForSessions: () => apiMachineForSessions,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      connectedServicesRestartRequestedPids,
      connectedServiceGroupHomeCleanupScheduler,
      connectedServiceMaterializedHomeCleanupScheduler,
      beforeShutdown,
      onHappySessionWebhook,
      sshTunnelSupervisor,
      requestShutdown,
      isShuttingDown: () => shutdownInitiated,
      processEnv: process.env,
    });
    const filesystemAccessPolicy = resolveFilesystemAccessPolicy({ env: process.env });
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
      connectedServicesRestartRequestedPids,
      pidToTrackedSession,
      // K2: FSM-routed proactive quota coordinator (built by the session-control runtime).
      connectedServiceAuthGroupPreTurnSwitchCoordinator,
      connectedServiceRecoverySoftSwitchGuard: connectedServiceRecoverySwitchGuard,
      // K3: gated credential-refresh / reconnect restart adapter.
      requestConnectedServiceRefreshRestartSignal,
      // K2: shared single runtime quota-snapshot store (proactive selection + quotas coordinator).
      connectedServiceRuntimeQuotaSnapshots,
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
    connectedServiceRefreshCoordinator = runtimeBootstrap.connectedServiceRefreshCoordinator;
    connectedServiceRefreshLoopHandle = runtimeBootstrap.connectedServiceRefreshLoopHandle;
    connectedServiceQuotasCoordinator = runtimeBootstrap.connectedServiceQuotasCoordinator;
    connectedServiceQuotasLoopHandle = runtimeBootstrap.connectedServiceQuotasLoopHandle;
    daemonServerWorkScheduler = runtimeBootstrap.daemonServerWorkScheduler;

    startDaemonMachineRegistrationRuntime({
      api,
      metadataForRegistration,
      initialDaemonState,
      processEnv: process.env,
      resolvePositiveIntEnv,
      resolvesWhenShutdownRequested,
      initialPreflightMachineRegistration: preflightMachineRegistration,
      resolveMachineId: () => machineId,
      setMachineId: (resolvedMachineId) => {
        machineId = resolvedMachineId;
        if (fileState.machineId !== resolvedMachineId) {
          fileState.machineId = resolvedMachineId;
          writeDaemonState(fileState);
        }
      },
      isShuttingDown: () => shutdownInitiated,
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
        isSessionAlreadyRunning,
        loadLocalSessionMetadataForHandoff,
        savePreparedTargetLocalMetadata,
        beforeShutdown,
        requestShutdown,
        directPeerServerLifecycle,
        directTransferPromptAssetAdapterRegistry,
        directTransferPromptRegistryRegistry,
        daemonServerWorkScheduler,
        retryTemporaryThrottleNow,
        setDaemonServerWorkOnline: runtimeBootstrap.setDaemonServerWorkOnline,
        onMachineConnectionOnline: async () => {
          await connectedServiceQuotasCoordinator?.flushInBandQuotaPersistence(0);
        },
        isShuttingDown: () => shutdownInitiated,
      }),
      onMachineSyncRuntime: (machineSyncRuntime) => {
        apiMachine = machineSyncRuntime.apiMachine;
        apiMachineForSessions = machineSyncRuntime.apiMachineForSessions;
        automationWorker = machineSyncRuntime.automationWorker;
        memoryWorker = machineSyncRuntime.memoryWorker;
        voiceInferenceWorker = machineSyncRuntime.voiceInferenceWorker;
        daemonConnectivityCoordinator = machineSyncRuntime.daemonConnectivityCoordinator;
        machineConnectionStateCleanup = machineSyncRuntime.machineConnectionStateCleanup;
        stopPeerMediationLoopbackServer = machineSyncRuntime.stopPeerMediationLoopbackServer;
        if (machineSyncRuntime.apiMachine) {
          publishOrphanedStartupSessionEnds({
            apiMachine: machineSyncRuntime.apiMachine,
            orphanedDeadDaemonSessions,
          });
        }
      },
      filesystemAccessPolicy,
      takeoverRequested,
      preferredHost,
      connectedServiceRefreshLoopHandle,
      connectedServiceQuotasLoopHandle,
    });

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
      isShuttingDown: () => shutdownInitiated,
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
    process.exit(1);
  }
}
