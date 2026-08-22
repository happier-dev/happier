import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { ensureSessionMachineAccessKeyBinding } from '@/api/session/ensureSessionMachineAccessKeyBinding';
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
import {
  buildHappyCliSubprocessLaunchSpec,
  pruneHappyCliRunnerSnapshots,
} from '@/utils/spawnHappyCLI';
import { projectPath } from '@/projectPath';
import {
  acquireDaemonLock,
  clearDaemonStateForLockOwner,
  releaseDaemonLock,
  readStoredCredentials,
  type DaemonStateOwner,
  writeDaemonStateForLockOwner,
} from '@/persistence';

import { reattachTrackedSessionsFromMarkers } from './sessions/reattachFromMarkers';
import { resolveLiveRunnerSnapshotFingerprints } from './sessionRunnerRuntime/resolveLiveRunnerSnapshotFingerprints';
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
import { warmActiveAccountSettingsSnapshotBestEffort } from '@/settings/accountSettings/warmActiveAccountSettingsSnapshot';
import { migrateTrackedSessionProcessesOutOfDaemonServiceCgroup } from './platform/linux/migrateTrackedSessionsOutOfDaemonServiceCgroup';
import { resolveFilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
export { buildTmuxSpawnConfig, buildTmuxWindowEnv } from './platform/tmux/spawnConfig';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { resolveWaitForAuthConfig } from './startup/waitForAuthConfig';
import { waitForInitialCredentials } from './startup/waitForInitialCredentials';
import { resolveDaemonDiagnosticSubsystemGates } from './startup/diagnosticSubsystemGates';
import { createDaemonEventLoopStallMonitor } from './diagnostics/daemonEventLoopStallMonitor';
import { ensureDaemonStartupOwnership } from './startup/ensureDaemonStartupOwnership';
import { startDaemonMachineRegistrationRuntime } from './startup/startDaemonMachineRegistrationRuntime';
import { createDaemonCleanupAndShutdown } from './startup/createDaemonCleanupAndShutdown';
import { releaseDaemonOwnershipAfterFatal } from './lifecycle/cleanupAndShutdown';
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
  ConnectedServiceBindingsV1Schema,
  createProviderErrorV1,
  readServerEnabledBit,
} from '@happier-dev/protocol';
import { readOrCreateInstallationIdentity } from './identity/store';
import {
  startPluginWebhookDaemonWorkerV1,
  type PluginWebhookDaemonWorkerHandleV1,
} from '@/plugins/runtime/webhooks/pluginWebhookDaemonWorker';
import { attachPluginWebhookDaemonWakeV1 } from '@/plugins/runtime/webhooks/pluginWebhookDaemonWake';
import { resolveDaemonServiceLabelFromEnv, resolveDaemonTakeoverRequestedFromEnv, resolveDaemonStartupSourceFromEnv } from '@/daemon/ownership/daemonOwnershipMetadata';
import { DaemonOwnershipConflictError } from '@/daemon/ownership/DaemonOwnershipConflictError';
import { resolveDaemonOwnershipConflictExitCode } from '@/daemon/ownership/resolveDaemonOwnershipConflictExitCode';
import {
  startDaemonSessionControlRuntime,
  type ProviderManagedCatalogRuntimeOwner,
} from './startup/startDaemonSessionControlRuntime';
import { prepareDaemonBootstrapContext } from './startup/prepareDaemonBootstrapContext';
import { createDaemonMachineBootstrapRuntime } from './startup/createDaemonMachineBootstrapRuntime';
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
import type {
  ExternalSessionPluginAdmissionOwner,
} from '@/session/actions/externalSessions/pluginExternalSessionAdmissionOwner';
import type { LocalServiceInventoryRoutes } from './local/services/inventory/routes';
import { createMachineLiveStreamCaptureRegistry } from './peer/mediation/stream';
import { createSimulatorInputLeaseManager } from './devices/simulator/lease';
import type {
  AgentExternalSessionsManagedEndpointReadHost,
} from '@/session/external/agentExternalSessionsInvocation';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createServerUrlServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';
import { createDaemonPeerMediationObservabilityRuntime } from './machine/peerMediationObservabilityRuntime';
import { createDaemonSessionMutationCustody } from './connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { installPeerMediationObservabilityRuntimeActionContextProvider } from './peer/mediation/observability/runtimeActionContextProvider';
import {
  requestDaemonSelfRestartWithLockHandoff,
  resolveDaemonSelfRestartEnvironment,
} from './lifecycle/requestDaemonSelfRestartWithLockHandoff';
import { readDaemonRestartVerifyPollMs, readDaemonRestartVerifyTimeoutMs } from './startupWaitDefaults';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { DaemonPluginChangeOwner } from '@/plugins/daemon/changeService';
import { createDaemonPluginRuntimeOwner } from '@/plugins/daemon/runtimeOwner';
import { DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY } from '@/plugins/runtime/context/daemonDatabaseLimitsPolicy';
import { createDaemonPluginAvailabilityReporter } from '@/plugins/availability/daemonReporter';
import { createDaemonPluginRegistryProjectionInvalidation } from './pluginRegistryProjectionInvalidation';
import { createExternalSessionHostOperationOwner } from '@/session/external/hostOperationOwner';
import { resolveConnectedServiceQuotaFetcherDescriptors } from '@/plugins/projection/registry/connectedServiceQuotaFetchers';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createDaemonConnectedAccountPurposeBindingRuntime } from './connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { createManagedProviderOperationAuthority } from './connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountRequestAuthSubjectRegistry } from './connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from './connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import {
  createCurrentRuntimeProviderOperationsSource,
  type RuntimeProviderOperationsProducer,
} from '@/providers/runtimeServices';
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

function resolveDaemonPluginRecoveryRequestedFromEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return String(processEnv.HAPPIER_DAEMON_PLUGIN_RECOVERY ?? '').trim() === '1';
}

export async function startDaemon(
  options: Readonly<{ takeover?: boolean; pluginRecovery?: boolean }> = {},
): Promise<void> {
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
  let daemonStateOwner: DaemonStateOwner | null = null;
  const runtimeId = resolveDaemonRuntimeId(process.env);
  const startupSource = resolveDaemonStartupSourceFromEnv(process.env);
  const serviceLabel = resolveDaemonServiceLabelFromEnv(process.env);
  const takeoverRequested = options.takeover ?? resolveDaemonTakeoverRequestedFromEnv(process.env);
  const pluginRecoveryRequested = options.pluginRecovery
    ?? resolveDaemonPluginRecoveryRequestedFromEnv(process.env);
  if (pluginRecoveryRequested) {
    logger.warn(
      '[PLUGIN RUNTIME] Recovery startup is skipping externally installed plugin activation; disable, remove, or repair the faulty plugin before a normal restart.',
    );
  }
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
      readCredentials: readStoredCredentials,
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
    const deviceLocalSecretStorage = bootstrapContext.deviceLocalSecretStorage;

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
    const eventLoopStallMonitor = createDaemonEventLoopStallMonitor({
      getActiveRpcOperations: () =>
        apiMachineForSessions?.getActiveRpcHandlerExecutions() ?? [],
      warn: (message, data) => logger.warn(message, data),
    });
    eventLoopStallMonitor.start();
    let localServiceInventoryRoutes: Pick<LocalServiceInventoryRoutes, 'getSnapshot'> | null = null;
    let providerManagedCatalogRuntimeOwner: ProviderManagedCatalogRuntimeOwner | null = null;
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
    let pluginWebhookWorker: PluginWebhookDaemonWorkerHandleV1 | null = null;
    let pluginWebhookWakeCleanup: (() => void) | null = null;
    let apiMachine: ApiMachineClient | null = null;
    let providerOperationsProducer: RuntimeProviderOperationsProducer | null = null;
    let externalSessionPluginAdmissionOwner:
      ExternalSessionPluginAdmissionOwner | null = null;
    const pluginAdmissionOwner: ExternalSessionPluginAdmissionOwner =
      Object.freeze({
        async materializeStart(input) {
          const start = externalSessionPluginAdmissionOwner?.materializeStart;
          if (!start) {
            return {
              ok: false,
              error: {
                code: 'source_unavailable',
                message: 'External-session materialization is unavailable.',
              },
            };
          }
          return await start(input);
        },
        async takeoverStart(input, context) {
          const start = externalSessionPluginAdmissionOwner?.takeoverStart;
          if (!start) {
            return {
              ok: false,
              error: {
                code: 'source_unavailable',
                message: 'External-session takeover is unavailable.',
              },
            };
          }
          return await start(input, context);
        },
        async hookManagementAction(actionId, input, options) {
          const execute =
            externalSessionPluginAdmissionOwner?.hookManagementAction;
          if (!execute) {
            return {
              ok: false,
              errorCode: 'unsupported_action',
              error: `unsupported_action:${actionId}`,
            };
          }
          return await execute(actionId, input, options);
        },
      });
    const providerOperationsSource =
      createCurrentRuntimeProviderOperationsSource(
        () => providerOperationsProducer,
      );
    let resolveInitialPluginRegistryPublished!: () => void;
    const initialPluginRegistryPublished = new Promise<void>((resolve) => {
      resolveInitialPluginRegistryPublished = resolve;
    });
    let resolveMachineProviderBindingSettled!: () => void;
    const machineProviderBindingSettled = new Promise<void>((resolve) => {
      resolveMachineProviderBindingSettled = resolve;
    });
    const daemonSessionMutationCustody = createDaemonSessionMutationCustody({ credentials });
    let cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop = async (
      _input: Readonly<{ sessionId: string }>,
    ): Promise<unknown> => null;
    let machineConnectionStateCleanup: (() => void) | null = null;
    let stopPeerMediationLoopbackServer: () => Promise<void> = async () => {};
    let shutdownInitiated = false;
    let daemonConnectivityCoordinator: ReturnType<typeof createDaemonConnectivityCoordinator> | null = null;
    let pluginChangeService: DaemonPluginChangeOwner | null = null;
    const isDaemonQuiescing = (): boolean => (
      shutdownInitiated || pluginChangeService?.isQuiescing() === true
    );
    const pluginRegistryProjectionInvalidation =
      createDaemonPluginRegistryProjectionInvalidation({
        getApiMachine: () => apiMachine,
        isDaemonQuiescing,
        onPublicationFailure: (error) => {
          logger.warn('[DAEMON RUN] Failed to publish durable plugin registry invalidation', {
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });
    const publishDaemonStateForCurrentOwner = (
      state: Parameters<typeof writeDaemonStateForLockOwner>[1],
    ): boolean => {
      const published = !isDaemonQuiescing()
      && daemonLockHandle !== null
      && writeDaemonStateForLockOwner(daemonLockHandle, state);
      if (published) daemonStateOwner = state;
      return published;
    };
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
          pluginRegistryProjectionInvalidation.resume();
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
        pluginWebhookWakeCleanup?.();
        pluginWebhookWakeCleanup = null;
        await pluginWebhookWorker?.stop();
        pluginWebhookWorker = null;
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

    let orphanedDeadDaemonSessions: Awaited<
      ReturnType<typeof reattachTrackedSessionsFromMarkers>
    >['orphanedDeadDaemonSessions'] = [];
    let disconnectedTerminalHostCandidates: NonNullable<
      Awaited<ReturnType<typeof reattachTrackedSessionsFromMarkers>>['disconnectedTerminalHostCandidates']
    > = [];
    let unresolvedTerminalHostSessionIds: ReadonlyArray<string> = [];
    let terminalHostAdapterInventoryPromise: ReturnType<typeof createDefaultTerminalHostAdapterInventory> | null = null;
    const loadTerminalHostAdapters = async () => {
      terminalHostAdapterInventoryPromise ??= createDefaultTerminalHostAdapterInventory({
        happyHomeDir: configuration.happyHomeDir,
        preference: process.platform === 'win32' ? 'zellij' : 'auto',
      });
      return (await terminalHostAdapterInventoryPromise).adapters;
    };
    const startupReattachResult = await reattachTrackedSessionsFromMarkers({
      pidToTrackedSession,
      credentials,
      deviceLocalSecretStorage,
      loadTerminalHostAdapters,
    });
    orphanedDeadDaemonSessions = startupReattachResult.orphanedDeadDaemonSessions;
    disconnectedTerminalHostCandidates = startupReattachResult.disconnectedTerminalHostCandidates ?? [];
    unresolvedTerminalHostSessionIds = startupReattachResult.unresolvedTerminalHostSessionIds ?? [];
    const pendingSessionMachineAccessBindingIds = new Set(startupReattachResult.recoveredLiveSessionIds ?? []);
    let sessionMachineAccessBindingReconcileInFlight: Promise<void> | null = null;
    const reconcileSessionMachineAccessBindings = async (): Promise<void> => {
      if (!apiMachineForSessions || pendingSessionMachineAccessBindingIds.size === 0) return;
      if (sessionMachineAccessBindingReconcileInFlight) {
        await sessionMachineAccessBindingReconcileInFlight;
        if (!apiMachineForSessions || pendingSessionMachineAccessBindingIds.size === 0) return;
      }

      sessionMachineAccessBindingReconcileInFlight = (async () => {
        const liveSessionIds = new Set(
          Array.from(pidToTrackedSession.values())
            .map((tracked) => tracked.happySessionId?.trim())
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
        );
        for (const sessionId of pendingSessionMachineAccessBindingIds) {
          if (!liveSessionIds.has(sessionId)) {
            pendingSessionMachineAccessBindingIds.delete(sessionId);
            continue;
          }
          try {
            await ensureSessionMachineAccessKeyBinding({
              serverUrl: configuration.apiServerUrl,
              token: credentials.token,
              sessionId,
              machineId,
            });
            pendingSessionMachineAccessBindingIds.delete(sessionId);
          } catch (error) {
            logger.warn('[DAEMON RUN] Failed to reconcile recovered session machine control; will retry on reconnect', {
              sessionId,
              machineId,
              error: serializeAxiosErrorForLog(error),
            });
          }
        }
      })().finally(() => {
        sessionMachineAccessBindingReconcileInFlight = null;
      });
      await sessionMachineAccessBindingReconcileInFlight;
    };
    pruneHappyCliRunnerSnapshots(
      resolveLiveRunnerSnapshotFingerprints(pidToTrackedSession.values()),
    );
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
      deviceLocalSecretStorage,
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
        ...(credentials.encryption
          ? {
            attemptTransactions:
              createQualifiedConnectedAccountAttemptTransactionAdapters({
                credentials,
              }),
          }
          : {}),
      });
    const establishedConnectedAccountRuntimeOwner =
      createQualifiedConnectedAccountEstablishedRuntimeOwner({
        reloadController: pluginReloadController,
        credentials,
        getAccountEncryptionMode: (signal) => api.getAccountEncryptionMode({ signal }),
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
      resolveConnectedAccountEndpoints: async ({ account, signal }) =>
        await establishedConnectedAccountRuntimeOwner.readConfiguredEndpoints({
          account,
          signal,
        }),
      qualifiedApi: {
        async listAccounts(service, signal) {
          signal.throwIfAborted();
          const result = await listQualifiedConnectedAccountsV4({
            token: credentials.token,
            service,
            signal,
          });
          signal.throwIfAborted();
          return result;
        },
        async listGroups(service, signal) {
          signal.throwIfAborted();
          const result = await listQualifiedConnectedAccountGroupsV4({
            token: credentials.token,
            service,
            signal,
          });
          signal.throwIfAborted();
          return result;
        },
        async readGroup(group, signal) {
          signal.throwIfAborted();
          const result = await readQualifiedConnectedAccountGroupV4({
            token: credentials.token,
            group,
            signal,
          });
          signal.throwIfAborted();
          return result;
        },
      },
      reloadController: pluginReloadController,
    });
    const connectedAccountRequestAuthRegistry =
      createConnectedAccountRequestAuthSubjectRegistry();
    let connectedAccountRequestAuthHttpPort: number | null = null;
    let managedServiceEndpointReadHost:
      AgentExternalSessionsManagedEndpointReadHost | null = null;
    const managedProviderOperationAuthority =
      createManagedProviderOperationAuthority({
        materializationBaseDir: join(
          configuration.happyHomeDir,
          'providers',
          'managed-operation-auth',
        ),
        purposeBindingOwner: {
          activatePurposeBindings:
            connectedAccountPurposeBindingRuntime.activatePurposeBindings,
        },
        requestAuthRegistry: connectedAccountRequestAuthRegistry,
        resolveRequestAuthHttpPort() {
          if (connectedAccountRequestAuthHttpPort === null) {
            throw new Error(
              'connected_account_request_auth_http_port_unavailable',
            );
          }
          return connectedAccountRequestAuthHttpPort;
        },
        createRedactionLease: () =>
          createProviderRedactionLease({ values: [] }),
      });
    if (!daemonLockHandle) {
      throw new Error('Plugin runtime startup requires exclusive daemon ownership');
    }
    await warmActiveAccountSettingsSnapshotBestEffort({
      credentials,
      logger,
    });
    const externalSessionHostOperationOwner =
      createExternalSessionHostOperationOwner();
    const resolveCurrentMachineExecutionOriginContext =
      createCurrentMachineExecutionOriginContextResolver({
        serverUrl: configuration.serverUrl,
        resolveCurrentMachineId: () => machineId,
        timeoutMs: 1_500,
      });
    const pluginRuntimeOwner = createDaemonPluginRuntimeOwner({
      happyHomeDir: configuration.happyHomeDir,
      daemonDatabaseLimits: DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY,
      resolveCurrentMachineId: () => machineId,
      resolveComposerMediaStageTransferRpcHandler: () => (
        apiMachineForSessions?.getPeerMediationMachineRpcHandlerManager() ?? null
      ),
      resolveCurrentMachineExecutionOriginContext,
      resolveSessionResourceAccess: async (input) => {
        const currentApiMachine = apiMachineForSessions;
        if (!currentApiMachine) {
          throw new Error('plugin_resource_session_access_unavailable');
        }
        return await currentApiMachine.resolvePluginResourceSessionAccess(input);
      },
      // Account Collection client preflight and plugin-facing feature decisions are
      // both advisory reads of this existing daemon-owned snapshot. Supplying it once
      // here keeps a single cache/currentness path; the resolved runtime fans it out.
      resolveServerFeaturesSnapshot: () => serverFeaturesSnapshotStore.getSnapshot(),
      staleCandidateCleanup: 'exclusiveHome',
      reloadController: pluginReloadController,
      availabilityReporter: createDaemonPluginAvailabilityReporter({
        credentials,
        serverFeaturesSnapshotStore,
        getMachineId: () => machineId,
      }),
      connectedAccounts: connectedAccountPurposeBindingRuntime.owner,
      actionFormConnectedAccounts: Object.freeze({
        resolveBindingIntent:
          connectedAccountPurposeBindingRuntime.resolveBindingIntent,
        activatePurposeBindings:
          connectedAccountPurposeBindingRuntime.activatePurposeBindings,
      }),
      providers: providerOperationsSource,
      onInitialRegistryPublished: resolveInitialPluginRegistryPublished,
      awaitInitialRuntimeActivation: async () => {
        await Promise.race([
          machineProviderBindingSettled,
          resolvesWhenShutdownRequested.then(() => undefined),
        ]);
      },
      onDurableRegistryApplied:
        pluginRegistryProjectionInvalidation.onDurableRegistryApplied,
      managedProviderOperationAuthority,
      qualifiedConnectedAccountEstablishedRuntimeOwner:
        establishedConnectedAccountRuntimeOwner,
      reconcileConnectedAccountPurposePublication:
        connectedAccountPurposeBindingRuntime.reconcileRegistryPublication,
      runtimeActionExecute: api.createBrowserRuntimeActionExecutor(),
      managedEndpointRead: async (input) => {
        const host = managedServiceEndpointReadHost;
        if (!host) {
          throw new Error(
            'Managed server endpoint read owner is unavailable',
          );
        }
        return await host(input);
      },
      externalSessionPluginAdmissionOwner: pluginAdmissionOwner,
      resolveExternalSessionCurrentMachineId: () => machineId,
      externalSessionHostOperationOwner,
      externalSessionsActiveServerDir: configuration.activeServerDir,
      externalSessionsActiveServerId: configuration.activeServerId,
      ...(pluginRecoveryRequested ? { startupMode: 'pluginRecovery' as const } : {}),
    });
    pluginChangeService = pluginRuntimeOwner.changeService;
    const pluginRuntimeInitialization = pluginRuntimeOwner.initialize();
    void pluginRuntimeInitialization.catch((error) => {
      requestShutdown(
        'exception',
        error instanceof Error ? error.message : String(error),
      );
    });
    await Promise.race([
      initialPluginRegistryPublished,
      pluginRuntimeInitialization.then(() => {
        throw new Error(
          'Plugin runtime initialization completed without publishing its initial registry',
        );
      }),
    ]);
    // Publish the restart fence before any spawn admission can reuse a stale
    // process. Physical retirement waits for machine mutation custody below.
    await reconcileAgentRuntimeRestartDisposition({
      trackedSessions: pidToTrackedSession.values(),
      isShuttingDown: isDaemonQuiescing,
      deferRunnerAuthorityReattach: true,
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
    machineRpcRouteAttachments.attachConnectedAccountPurposeBindingRuntime(
      connectedAccountPurposeBindingRuntime,
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
      reconcileReattachedConnectedServiceCredentialProjection,
      reconcileConnectedServicesProjection,
      awaitAgentSessionOpen,
      installExternalSessionHostOperations,
      providerAccountUsageStore,
      connectedServiceRuntimeQuotaSnapshots,
      createAgentCatalogObservation,
      refreshBrowserRouteOwners: refreshBrowserRouteOwnersFromSessionControl,
    } = await startDaemonSessionControlRuntime({
      machineId,
      externalSessionHostOperationOwner,
      runtimeId,
      credentials,
      daemonSessionMutationCustody,
      cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop: async (input) =>
        await cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop(input),
      deviceLocalSecretStorage,
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
      connectedAccountRequestAuthRegistry,
      onConnectedAccountRequestAuthHttpPortReady(port) {
        connectedAccountRequestAuthHttpPort = port;
      },
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
      onProviderManagedCatalogRuntimeOwnerReady: (owner) => {
        providerManagedCatalogRuntimeOwner = owner;
      },
      onManagedServiceEndpointReadHostReady: (host) => {
        managedServiceEndpointReadHost = host;
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
      onAlreadyRunningSessionAdopted: async (sessionId) => {
        pendingSessionMachineAccessBindingIds.add(sessionId);
        await reconcileSessionMachineAccessBindings();
      },
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
      hardRevokeRunningSessionsForGenerationIntegrityFailure:
        pluginRuntimeOwner
          .hardRevokeRunningSessionsForGenerationIntegrityFailure,
      resolveManagedPurposeBindingIntent:
        connectedAccountPurposeBindingRuntime.resolveBindingIntent,
      activateSessionPurposeBindings:
        connectedAccountPurposeBindingRuntime.activateSessionPurposeBindings,
      resolveCurrentSessionPurposeBindingSnapshot:
        connectedAccountPurposeBindingRuntime
          .resolveCurrentSessionPurposeBindingSnapshot,
      resolveCurrentRequestAuthBinding:
        connectedAccountPurposeBindingRuntime
          .resolveCurrentRequestAuthBinding,
      materializeRequestAuthBearer:
        connectedAccountPurposeBindingRuntime.materializeRequestAuthBearer,
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
      daemonSessionMutationCustody,
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
      publishDaemonState: publishDaemonStateForCurrentOwner,
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
      listQualifiedConnectedAccountGroupQuotaTargets:
        connectedAccountPurposeBindingRuntime.listGroupQuotaTargets,
      resolveConnectedServiceQualifiedPurposeBindingSnapshot: async ({
        agentId,
        connectedServicesBindingsRaw,
      }) => {
        const bindings = ConnectedServiceBindingsV1Schema.safeParse(
          connectedServicesBindingsRaw,
        );
        if (!bindings.success) return null;
        const lease =
          await acquireAuthoritativePluginRuntimeRegistryLease({
            happyHomeDir: configuration.happyHomeDir,
          });
        try {
          return resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
            agentId,
            bindings: bindings.data,
            contributions: lease.registry.contributes,
          });
        } finally {
          await lease.release();
        }
      },
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
    await reconcileReattachedConnectedServiceCredentialProjection().catch((error) => {
      logger.debug(
        '[DAEMON RUN] Failed to reconcile connected-service credential projection after daemon replacement',
        { error: serializeAxiosErrorForLog(error) },
      );
    });

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
        if (fileState.machineId === resolvedMachineId) {
          machineId = resolvedMachineId;
          return;
        }
        const nextFileState = {
          ...fileState,
          machineId: resolvedMachineId,
        };
        if (!publishDaemonStateForCurrentOwner(nextFileState)) {
          requestShutdown(
            'exception',
            'daemon_state_publication_ownership_lost',
          );
          return;
        }
        fileState.machineId = resolvedMachineId;
        machineId = resolvedMachineId;
      },
      isShuttingDown: () => shutdownInitiated,
      isQuiescing: isDaemonQuiescing,
      bootstrapRuntime: createDaemonMachineBootstrapRuntime({
        api,
        credentials,
        daemonSessionMutationCustody,
        deviceLocalSecretStorage,
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
          await reconcileSessionMachineAccessBindings();
          await refreshServerFeaturesAndBrowserRouteOwners();
          pluginRuntimeOwner.reportCurrentAvailability();
          await connectedServiceQuotasCoordinator?.flushInBandQuotaPersistence(0);
        },
        reconcileConnectedServicesProjection: reconcileConnectedServicesProjectionForPluginConsumers,
        subscribeConnectedAccountInvalidations:
          connectedAccountPurposeBindingRuntime.subscribeInvalidations,
        isShuttingDown: isDaemonQuiescing,
        getServerFeaturesSnapshot: () => serverFeaturesSnapshotStore.getSnapshot(),
        readLocalServiceInventorySnapshot: async () => localServiceInventoryRoutes?.getSnapshot() ?? null,
        managedCatalogRuntime: {
          launch: async (input) => {
            if (providerManagedCatalogRuntimeOwner) {
              return providerManagedCatalogRuntimeOwner.managedCatalogRuntime.launch(input);
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
        createAgentCatalogObservation,
        onAutomationWorkerStarted: (worker: AutomationWorkerHandle) => {
          automationWorker = worker;
        },
        prepareApiMachineForSessions:
          machineRpcRouteAttachments.prepareApiMachineForSessions,
        persistedTakeoverAdmissionWaiter,
        attachPersistedTakeoverAdmissionOwner,
      }),
      onMachineSyncRuntime: async (machineSyncRuntime) => {
        cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop =
          machineSyncRuntime.cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop;
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
              const mutationCustody = machineSyncRuntime.daemonSessionMutationCustody;
              if (!mutationCustody) {
                throw new Error('Daemon session mutation custody is unavailable during journal recovery');
              }
              const recovery = await machineSyncRuntime.apiMachine.recoverDaemonTerminalSessionMutationJournals({
                bindUsageLimitRecoveryJournals: (sessionIds) =>
                  mutationCustody.bindRecoveredJournals(sessionIds),
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
        const previousResumeQuiescedMachineSyncStartup = resumeQuiescedMachineSyncStartup;
        resumeQuiescedMachineSyncStartup = completeMachineSyncStartup;
        try {
          await completeMachineSyncStartup();
        } catch (error) {
          // This continuation must be present while a lock handoff interrupts
          // recovery, but a rejected attempt must not remain resumable after
          // its registration owner retires it.
          if (resumeQuiescedMachineSyncStartup === completeMachineSyncStartup) {
            resumeQuiescedMachineSyncStartup = previousResumeQuiescedMachineSyncStartup;
          }
          throw error;
        }

        const attemptedApiMachine = machineSyncRuntime.apiMachine;
        const attemptedApiMachineForSessions = machineSyncRuntime.apiMachineForSessions;
        const attemptedProviderOperationsProducer =
          machineSyncRuntime.providerOperationsProducer;
        const attemptedExternalSessionPluginAdmissionOwner =
          machineSyncRuntime.externalSessionPluginAdmissionOwner ?? null;
        try {
          apiMachine = attemptedApiMachine;
          apiMachineForSessions = attemptedApiMachineForSessions;
          await reconcileSessionMachineAccessBindings();
          providerOperationsProducer = attemptedProviderOperationsProducer;
          externalSessionPluginAdmissionOwner =
            attemptedExternalSessionPluginAdmissionOwner;
          resolveMachineProviderBindingSettled();
          await pluginRuntimeInitialization;
          if (!pluginWebhookWorker) {
            const installationIdentity = await readOrCreateInstallationIdentity();
            pluginWebhookWorker = startPluginWebhookDaemonWorkerV1({
              credentials,
              machineId: () => machineId,
              machineInstallationId: installationIdentity.installationId,
              enabled: () => {
                const snapshot = serverFeaturesSnapshotStore.getSnapshot();
                return snapshot?.status === 'ready'
                  ? readServerEnabledBit(snapshot.features, 'plugins.webhooks') === true
                  : false;
              },
              logger,
            });
          }
          pluginWebhookWakeCleanup?.();
          pluginWebhookWakeCleanup = attemptedApiMachine
            ? attachPluginWebhookDaemonWakeV1({
                apiMachine: attemptedApiMachine,
                getWorker: () => pluginWebhookWorker,
              })
            : null;
          machineRpcRouteAttachments.attachApiMachineForSessions(apiMachineForSessions);
          automationWorker = machineSyncRuntime.automationWorker;
          memoryWorker = machineSyncRuntime.memoryWorker;
          voiceInferenceWorker = machineSyncRuntime.voiceInferenceWorker;
          daemonConnectivityCoordinator = machineSyncRuntime.daemonConnectivityCoordinator;
          machineConnectionStateCleanup = machineSyncRuntime.machineConnectionStateCleanup;
          stopPeerMediationLoopbackServer = machineSyncRuntime.stopPeerMediationLoopbackServer;
          resumeQuiescedMachineConnectionPublications =
            machineSyncRuntime.resumeMachineConnectionPublications;
        } catch (error) {
          if (apiMachine === attemptedApiMachine) apiMachine = null;
          if (apiMachineForSessions === attemptedApiMachineForSessions) {
            apiMachineForSessions = null;
          }
          if (providerOperationsProducer === attemptedProviderOperationsProducer) {
            providerOperationsProducer = null;
          }
          if (
            externalSessionPluginAdmissionOwner
            === attemptedExternalSessionPluginAdmissionOwner
          ) {
            externalSessionPluginAdmissionOwner = null;
          }
          throw error;
        }
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
      writeDaemonStateForCurrentOwner: publishDaemonStateForCurrentOwner,
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
        eventLoopStallMonitor.stop();
      },
      processEnv: process.env,
      resolvePositiveIntEnv,
      restartOnStaleVersionAndHeartbeat,
      connectedServiceRefreshLoopHandle,
      connectedServiceQuotasLoopHandle,
      beforeShutdown,
      apiMachine,
      closeDaemonMutationCustody: async () => {
        await daemonSessionMutationCustody.close();
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
      stopSshTunnelsOnShutdown: sshTunnelSupervisor.stopAllTunnels,
      stopControlServer,
      daemonStateOwner: fileState,
      daemonLockHandle,
      releaseDaemonLock,
    });
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    try {
      await releaseDaemonOwnershipAfterFatal({
        daemonLockHandle,
        daemonStateOwner,
      });
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
