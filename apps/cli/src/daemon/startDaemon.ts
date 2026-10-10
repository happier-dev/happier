import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { createManagedActivityInventory, createLiveWorkProducerGroup, type LiveWorkProducerV1 } from './lifecycle/managedActivity';
import { createExecutionRunLiveWorkProducer } from './executionRunRegistry';
import { createDaemonManagedMachinePolicyRuntime, readManagedMachinePolicyCensus } from './startup/managedMachinePolicyRuntime';
import { ensureSessionMachineAccessKeyBinding } from '@/api/session/ensureSessionMachineAccessKeyBinding';
import { readHttpStatus } from '@/api/client/httpStatusError';
import type { ApiMachineClient, ApiMachineClientLifecycleDependencies } from '@/api/apiMachine';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { installDaemonMachineAdmissionTransport } from './machineAdmissionTransport';
import { createClientActionReverseDispatcher } from '@/session/actions/clientActionReverseDispatch';
import { TrackedSession } from './types';
import { MachineMetadata } from '@/api/types';
import type { DaemonState } from '@/api/types';
import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import {
  createSpawnConnectedServicesTeamResourceCatalogResolver,
  resolvePurposeTeamCredentialBindingIntentsFromHome,
} from '@/session/services/spawnConnectedServicesDefaults';
import { stopCaffeinate } from '@/integrations/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import {
  buildHappyCliSubprocessLaunchSpec,
  pruneHappyCliRunnerSnapshots,
} from '@/utils/spawnHappyCLI';
import { projectPath } from '@/projectPath';
import { resolveRunningCliRuntimeIdentity } from '@/packagedRuntime/resolveRunningCliRuntimeIdentity';
import {
  acquireDaemonLock,
  clearDaemonStateForLockOwner,
  releaseDaemonLock,
  readStoredCredentials,
  readStoredCredentialsForServerId,
  sameStoredCredentials,
  type DaemonStateOwner,
  writeDaemonStateForLockOwner,
} from '@/persistence';

import { reattachTrackedSessionsFromMarkers } from './sessions/reattachFromMarkers';
import { resolveLiveRunnerSnapshotFingerprints } from './sessionRunnerRuntime/resolveLiveRunnerSnapshotFingerprints';
import { createDefaultTerminalHostAdapterInventory } from '@/integrations/terminal/host/defaultAdapters';
import { publishOrphanedStartupSessionEnds } from './sessions/publishOrphanedStartupSessionEnds';
import { createOnHappySessionWebhook } from './sessions/onHappySessionWebhook';
import { createAcceptedSessionWorkspaceRegistration } from './sessions/registerAcceptedSessionWorkspace';
import { reconcileAgentRuntimeRestartDisposition } from './sessions/reconcileAgentRuntimeRestartDisposition';
import { createDaemonSessionHandoffMetadataBridge } from './sessions/createDaemonSessionHandoffMetadataBridge';
import { startDaemonHeartbeatLoop } from './lifecycle/heartbeat';

import { initialMachineMetadata } from './machine/metadata';
import { createDaemonShutdownController } from './lifecycle/shutdown';
import { getDaemonAgentInstallJobOwner } from '@/capabilities/installJobs/agentInstallJobOwner';
import { createBeforeShutdownDrain } from './lifecycle/createBeforeShutdownDrain';
import { createDaemonAdmissionDrain } from './lifecycle/admissionDrain';
import { startDaemonRuntimeBootstrap } from './startup/startDaemonRuntimeBootstrap';
import { createRequesterSessionRuntimeContext } from './sessionEncryption/createRequesterSessionRuntimeContext';
import type { AdmittedRequesterSessionBootstrap, RequesterSessionRuntimeContext, ResolveRequesterSessionRuntimeContext } from './sessionEncryption/requesterSessionCredentials';
import { resolveRequesterSessionBootstrap, resolveRequesterSessionBootstrapFromCustody, bindRequesterSessionRuntimeMachineAdmissionCurrentness, listRequesterSessionCredentialBindings } from './sessionEncryption/requesterSessionCredentials';
import { notifyActiveAccountConnectedServicesProjection } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { warmActiveAccountSettingsSnapshotBestEffort } from '@/settings/accountSettings/warmActiveAccountSettingsSnapshot';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { migrateTrackedSessionProcessesOutOfDaemonServiceCgroup } from './platform/linux/migrateTrackedSessionsOutOfDaemonServiceCgroup';
import { shouldUseSystemdUserSessionResourceGovernor } from './platform/linux/systemdUserResourceGovernor';
import { resolveFilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
export { buildTmuxSpawnConfig, buildTmuxWindowEnv } from './platform/tmux/spawnConfig';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { resolveWaitForAuthConfig } from './startup/waitForAuthConfig';
import { waitForInitialCredentials } from './startup/waitForInitialCredentials';
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
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import type { ConnectedServiceId } from '@happier-dev/protocol';
import { readIrohRelayConfigFromEnv } from '@happier-dev/iroh-native/node';
import { readHomeApplicationCarrierEligibilityFromEnv } from '@happier-dev/cli-common/homeEnrollment';
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
import { createDaemonMachineBootstrapRuntime, createProjectFiniteSourceManifestInspector } from './startup/createDaemonMachineBootstrapRuntime';
import { createProductionDaemonWorkflowRuntime } from './workflows/daemonRuntime';
import { isWorkflowRuntimeEnabled } from './automation/workflowFeatureGate';
import {
  createProductionDaemonWorkspaceSyncRuntime,
  type ProductionDaemonWorkspaceSyncRuntime,
} from './startup/createProductionDaemonWorkspaceSyncRuntime';
import { createDaemonWorkspaceSyncRuntimeCustody } from './startup/daemonWorkspaceSyncRuntimeCustody';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createProjectWorkerAction } from '@/workspaces/execution/projectWorkerAction';
import { createAccountServerMachineFinitePolicyClient } from '@/api/machine/accountServerMachineFinitePolicyClient';
import { createAccountServerWorkspaceWorkerPreferenceClient } from '@/api/workspaces/workspaceWorkerPreferences';
import { resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import { readProjectFiniteIngressRefusal } from '@/workspaces/projectSetup/projectFiniteAction';
import { readRequesterAccountActionContext, resolveAdmittedRequesterAccountReadRuntime } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createWorkspaceSyncWorkerPreparation } from '@/workspaces/sync/workspaceSyncPreparation';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readInstallationIdentityIfExistsSync } from './identity/store';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { cleanupDaemonHomeMachineWorkspace } from './startup/daemonHomeMachineWorkspaceCleanup';
import { createSshTunnelSupervisor } from './ssh/tunnels';
import { createConnectedServiceGroupHomeCleanupScheduler } from './connectedServices/homes/createConnectedServiceGroupHomeCleanupScheduler';
import { createConnectedServiceMaterializedHomeCleanupScheduler } from './connectedServices/materialize/cleanup/createConnectedServiceMaterializedHomeCleanupScheduler';
import { listConnectedServiceRetainedMaterializedHomeSanitizers } from './connectedServices/catalogHooks';
import { readRetainedConnectedServiceMaterializationKeys } from './connectedServices/materialize/cleanup/readRetainedConnectedServiceMaterializationKeys';
import { resolveConnectedServicesMaterializationBaseDir } from './connectedServices/materialize/resolveConnectedServicesMaterializationBaseDir';
import { createDaemonMachineRpcRouteAttachmentCache } from './machineRpcRouteAttachments';
import { createPersistedTakeoverAdmissionWaiter } from './spawn/persistedTakeoverAdmission';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import type { SessionSpawnDirectTargetTransport } from '@/session/actions/createCliActionDeps';
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
import type {
  ManagedServiceSessionBaseUrlResolver,
  ManagedServiceSessionClientAccessResolver,
} from '@/plugins/runtime/invocation/services/managedServiceEndpointProjection';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createServerUrlServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';
import { startServerFeaturesSnapshotRefreshLoop } from './serverFeaturesSnapshotRefreshLoop';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createDaemonPeerMediationObservabilityRuntime } from './machine/peerMediationObservabilityRuntime';
import { resolvePeerMediationTrustRoots as resolvePeerMediationTrustRootsFromSnapshot } from './peer/mediation/resolvePeerMediationTrustRoots';
import {
  createDaemonMachineIrohRuntime,
  type DaemonMachineIrohRuntime,
} from './peer/iroh/daemonMachineIrohRuntime';
import { createWorkspaceMachineCarrierTunnelOpen } from './peer/iroh/workspaceMachineCarrierTunnelOpen';
import { createProviderBrokerMachineCarrierTunnelOpen } from './peer/iroh/providerBrokerMachineCarrierTunnelOpen';
import {
  applyDaemonHomeDescriptorRefresh,
  prepareDaemonHomeIrohTransport,
  type DaemonHomeTransport,
} from './peer/iroh/daemonHomeIrohTransport';
import { resolveCliHomeTarget, resolveCurrentCliHomeTarget } from '@/server/homeTarget';
import { getServerProfile } from '@/server/serverProfiles';
import { createDaemonSessionMutationCustody } from './connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { installPeerMediationObservabilityRuntimeActionContextProvider } from './peer/mediation/observability/runtimeActionContextProvider';
import {
  requestDaemonSelfRestartWithLockHandoff,
  resolveDaemonSelfRestartEnvironment,
} from './lifecycle/requestDaemonSelfRestartWithLockHandoff';
import {
  readDaemonRestartVerifyPollMs,
  readDaemonRestartVerifyTimeoutMs,
} from './startupWaitDefaults';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { DaemonPluginChangeOwner } from '@/plugins/daemon/changeService';
import { createDaemonPluginRuntimeOwner } from '@/plugins/daemon/runtimeOwner';
import { createClientActionMachineRpcExecutor } from '@/plugins/runtime/invocation/actions/clientActionMachineRpc';
import { DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY } from '@/plugins/runtime/context/daemonDatabaseLimitsPolicy';
import { createDaemonPluginAvailabilityReporter } from '@/plugins/availability/daemonReporter';
import { createDaemonPluginRegistryProjectionInvalidation } from './pluginRegistryProjectionInvalidation';
import { withTrackedSessionRpc } from './sessionEncryption/withTrackedSessionRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createExternalSessionHostOperationOwner } from '@/session/external/hostOperationOwner';
import { resolveConnectedServiceQuotaFetcherDescriptors } from '@/plugins/projection/registry/connectedServiceQuotaFetchers';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
  resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceId,
} from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
import { createDaemonConnectedAccountPurposeBindingRuntime } from './connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import {
  createDaemonTeamCredentialDirectMaterialReconciler,
} from './connectedServices/directMaterial/daemonTeamCredentialDirectMaterialReconciler';
import { createHttpTeamCredentialDirectMaterialClient } from './connectedServices/directMaterial/teamCredentialDirectMaterialClient';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { prepareProviderConnectionsCatalogForCli } from '@/providers/settings/hydrate';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { ProviderBrokerApplicationBindingV1, ProviderBrokerRelayApplicationBindingV1 } from '@happier-dev/protocol';
import { TeamCredentialResourceEntitledPageV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import type { TeamCredentialResourceSummaryV1 } from '@happier-dev/protocol/teams';
import {
  daemonExternalProviderRequestPolicyAcceptsResource,
  revalidateExternalProviderBrokerAuthorization,
  resolveRunnerCredentialSelectionCurrentness,
  startDaemonProviderBrokerRuntime,
} from '@/providers/broker/daemonProviderBrokerRuntime';
import {
  createConnectedServicesBrokerSourceMemberSelect,
  createConnectedServicesBrokerSourceOpen,
} from '@/providers/broker/connectedServicesSource';
import {
  createTeamCredentialBrokerSourceOwner,
  teamCredentialBrokerPlacementAcceptsMachine,
} from '@/providers/broker/teamCredentialBrokerSourceOwner';
import {
  createTeamCredentialExternalModelCatalog,
  isSameTeamCredentialBrokerApplication,
  type TeamCredentialModelCatalogResolver,
} from '@/providers/broker/teamCredentialModelCatalog';
import {
  resolveTeamCredentialResourceCatalogApplications,
  resolveTeamCredentialSourceModelCatalog,
} from '@/providers/broker/resourceTestCandidate';
import {
  classifyTeamCredentialRequestRouteV1,
  evaluateTeamCredentialRequestPolicyV1,
} from '@/providers/broker/requestPolicyV1';
import {
  createProviderConnectionBrokerSourceOpen,
  isProviderConnectionBrokerSourceCurrent,
  isProviderConnectionDirectSourceCurrent,
  materializeProviderConnectionDirectCredential,
  resolveAdmittedProviderConnectionDirectSourceSnapshot,
} from '@/providers/broker/providerConnectionSource';
import { createProviderConnectionTeamCredentialSourceSnapshot } from '@/providers/broker/teamCredentialSourceSnapshot';
import { createProviderConnectionCpxBridge } from '@/providers/broker/providerConnectionCpxBridge';
import { createAccountConnectionBrokerSourceOpen, retireAccountConnectionBrokerSource } from '@/providers/broker/accountConnectionSource';
import { openAccountConnectionProviderBrokerAccess } from '@/providers/broker/accountConnectionClient';
import { createDaemonAccountConnectionManagedConsumerOpen } from './providers/accountConnectionManagedConsumerComposition';
import { collectProviderConnectionDnsEvidence } from '@/providers/registry/dnsEvidence';
import { resolveProviderContributionRegistryView } from '@/providers/registry';
import { createProviderOperationLifetime } from '@/providers/operationLifetime';
import {
  getActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshotChanges,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { hydrateSavedSecretCatalog } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { createManagedProviderOperationAuthority } from './connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountRequestAuthSubjectRegistry } from './connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from './connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { openSessionTeamCredentialProviderBinding } from '@/providers/broker/sessionTeamCredentialProviderBinding';
import { createDaemonTeamCredentialDirectMaterialOpen } from './providers/teamCredentialDirectMaterialComposition';
import {
  createCurrentRuntimeProviderOperationsSource,
  type RuntimeProviderOperationsProducer,
} from '@/providers/runtimeServices';
import {
  createConnectedAccountDaemonConfigurationOwner,
  createConnectedAccountDaemonRuntime,
} from './connectedServices/ConnectedAccountDaemonRuntime';
import {
  createActiveAccountSettingsConnectedAccountSecrets,
  createQualifiedConnectedAccountDaemonPersistence,
} from './connectedServices/qualifiedConnectedAccountDaemonPersistence';
import {
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
  resolveQualifiedConnectedAccountRemovalReviewNegotiation,
  resolveQualifiedConnectedAccountPeerClass,
  resolveQualifiedConnectedAccountPeerOperationTransport,
} from '@/api/client/qualifiedConnectedAccountApi';

function readTeamCredentialCatalogNextCursor(page: object): string | null {
  if (!('nextCursor' in page)) return null;
  return typeof page.nextCursor === 'string' ? page.nextCursor : null;
}

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
  const homeTransportCancellation = new AbortController();
  void resolvesWhenShutdownRequested.then(() => homeTransportCancellation.abort());

  logger.debug('[DAEMON RUN] Starting daemon process...');
  // Which bytes this daemon is about to run. `startedWithCliVersion` is identical across
  // every bundle built from the same package version, so it cannot distinguish a current
  // build from one an earlier package build left in the checkout; this line can.
  const runningRuntime = resolveRunningCliRuntimeIdentity();
  logger.infoFile(
    `[DAEMON RUN] Runtime ${runningRuntime.tree ?? 'unknown'} ${runningRuntime.entrypoint ?? '(unresolved)'}`
    + ` built ${runningRuntime.builtAt ?? '(unverified)'}`,
  );
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const { waitForAuthEnabled, waitForAuthTimeoutMs } = resolveWaitForAuthConfig(process.env);

  let daemonLockHandle: Awaited<ReturnType<typeof acquireDaemonLock>> = null;
  let daemonStateOwner: DaemonStateOwner | null = null;
  const workspaceSyncRuntimeCustody =
    createDaemonWorkspaceSyncRuntimeCustody<ProductionDaemonWorkspaceSyncRuntime & Pick<ApiMachineClientLifecycleDependencies, 'createProjectFiniteRuntime' | 'readProjectFiniteLoad'>>();
  let projectWorkerAdmission: ReturnType<typeof createProjectWorkerAdmission> | null = null;
  let projectWorkerAction: ActionExecutorDeps['projectWorkerAction'];
  let machineIrohRuntime: DaemonMachineIrohRuntime | null = null;
  let homeIrohTransport: DaemonHomeTransport | null = null;
  const preparedIrohState: {
    machine: DaemonMachineIrohRuntime | null;
    home: DaemonHomeTransport | null;
    failedStartupCleanup: (() => Promise<void>) | null;
  } = { machine: null, home: null, failedStartupCleanup: null };
  let stopMachineIrohAcceptor: () => Promise<void> = async () => {};
  const stopWorkspaceSyncRuntime = workspaceSyncRuntimeCustody.stop;
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

    let homeTarget = await resolveCurrentCliHomeTarget();
    const bootstrapContext = await prepareDaemonBootstrapContext({
      daemonLockHandle,
      initialMachineMetadata,
      startupSource,
      prepareServerTransport: async ({ persistedCredentials }) => {
        const applicationCarrierEligibility = readHomeApplicationCarrierEligibilityFromEnv(process.env);
        // Local native-endpoint initialization is optional carrier
        // preparation. Its failure is handed to the Home transport owner as
        // native-runtime unavailability; that owner is the single owner of the
        // trusted-HTTPS-or-fail-closed decision, and it still fails closed for
        // an Iroh-only Home or a selected-Iroh identity, authentication or
        // descriptor-integrity failure. No fallback decision is made here.
        if (applicationCarrierEligibility !== 'standard_only') {
          const createdIrohRuntime = await createDaemonMachineIrohRuntime({
            happyHomeDir: configuration.happyHomeDir,
            relayConfig: readIrohRelayConfigFromEnv(process.env),
          });
          if (createdIrohRuntime.available) {
            preparedIrohState.machine = createdIrohRuntime;
          } else {
            if (createdIrohRuntime.reason === 'startup_failed') {
              preparedIrohState.failedStartupCleanup = createdIrohRuntime.shutdown;
            }
            logger.warn('[DAEMON RUN] Iroh carrier is unavailable; the Home transport owner evaluates independently trusted HTTPS', {
              reason: createdIrohRuntime.reason,
            });
          }
        }
        preparedIrohState.home = await prepareDaemonHomeIrohTransport({
          signal: homeTransportCancellation.signal,
          runtime: preparedIrohState.machine,
          profile: homeTarget.profileId ? await getServerProfile(homeTarget.profileId) : {
            serverUrl: homeTarget.canonicalAuthUrl,
            ...(homeTarget.descriptor ? { homeConnectionDescriptor: homeTarget.descriptor } : {}),
          },
          applicationCarrierEligibility,
          ...(persistedCredentials ? { token: persistedCredentials.token } : {}),
        });
        logger.info('[DAEMON RUN] Home transport prepared', {
          carrier: preparedIrohState.home.carrier,
          observedPath: preparedIrohState.home.observedPath,
        });
      },
      verifyServerTransport: async ({ credentials }) => {
        if (!preparedIrohState.home) return;
        const readiness = await preparedIrohState.home.verifyAuthenticated(credentials.token);
        if (readiness.status !== 'ready') {
          throw new Error(readiness.errorMessage ?? `Authenticated Home transport probe failed: ${readiness.status}`);
        }
      },
    });
    machineIrohRuntime = preparedIrohState.machine;
    homeIrohTransport = preparedIrohState.home;
    daemonLockHandle = bootstrapContext.daemonLockHandle;
    const credentials = bootstrapContext.credentials;
    const api = bootstrapContext.api;
    // Authentication can establish a descriptor for a credential-seeded or
    // predecessor profile. Downstream owners consume that same persisted binding.
    if (homeTarget.profileId) {
      homeTarget = await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: homeTarget.profileId });
    }
    // Missing/refused Project rows leave Project effects unavailable, while
    // unrelated daemon services remain usable with supported older Homes.
    await readProjectAccountRows({
      credentials,
      serverId: configuration.activeServerId,
      signal: homeTransportCancellation.signal,
    }).catch((error) => {
      if (homeTransportCancellation.signal.aborted) throw error;
      logger.warn('[DAEMON RUN] Project Account rows unavailable during startup', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    const preferredHost = bootstrapContext.preferredHost;
    const metadataForRegistration: MachineMetadata = bootstrapContext.metadataForRegistration;
    // This is the Account subject of the daemon's currently authenticated
    // connection, not a request claim or a persisted Account projection. An
    // opaque/malformed connection credential leaves public PAT ingress off.
    const externalActionAccountId = readAccountIdFromToken(credentials.token);
    let pluginChangeService: DaemonPluginChangeOwner | null = null;
    const admissionDrain = createDaemonAdmissionDrain({
      isPluginHandoffQuiescing: () => pluginChangeService?.isQuiescing() === true,
    });
    const workflowRuntime = externalActionAccountId
      ? createProductionDaemonWorkflowRuntime({
          credentials,
          accountId: externalActionAccountId,
          serverId: configuration.activeServerId,
          admissionDrain,
        })
      : null;
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
    let teamCredentialDirectMaterialChangeCleanup: (() => void) | null = null;
    let teamCredentialDirectMaterialAccountChangeCleanup: (() => void) | null = null;
    let reconcileTeamCredentialDirectMaterialAfterSourceChange = (): void => {};
    let daemonServerWorkScheduler: DaemonServerWorkScheduler | null = null;
    let apiMachineForSessions: ApiMachineClient | null = null;
    let managedMachinePolicyRuntime: ReturnType<typeof createDaemonManagedMachinePolicyRuntime> | null = null;
    let confidentialSecretFill: ReturnType<typeof api.createConfidentialSecretFillExecutor> | null = null;
    const machineAdmissionTransport = async (
      request: Parameters<ApiMachineClient['enqueueSessionPendingByMachine']>[0],
      options?: Parameters<ApiMachineClient['enqueueSessionPendingByMachine']>[1],
    ) => {
      const currentApiMachine = apiMachineForSessions;
      if (!currentApiMachine) {
        return { status: 'rejected' as const, code: 'session_input_target_unavailable' as const };
      }
      return await currentApiMachine.enqueueSessionPendingByMachine(request, options);
    };
    const releaseMachineAdmissionTransport = installDaemonMachineAdmissionTransport({
      serverId: configuration.activeServerId,
      transport: machineAdmissionTransport,
      clientActionExecute: createClientActionReverseDispatcher(() => apiMachineForSessions),
      confidentialSecretFill: async (args) => confidentialSecretFill
        ? await confidentialSecretFill(args) : { status: 'refused', code: 'target_unavailable' },
    });
    let apiMachine: ApiMachineClient | null = null;
    let machineBootstrapRuntime: ReturnType<typeof createDaemonMachineBootstrapRuntime> | null = null;
    let homeTransportReplacementPending = false;
    const eventLoopStallMonitor = createDaemonEventLoopStallMonitor({
      getActiveRpcOperations: () =>
        apiMachineForSessions?.getActiveRpcHandlerExecutions() ?? [],
      warn: (message, data) => logger.warn(message, data),
    });
    eventLoopStallMonitor.start();
    let localServiceInventoryRoutes: Pick<LocalServiceInventoryRoutes, 'getSnapshot'> | null = null;
    let localServiceSummary: Parameters<typeof createDaemonMachineBootstrapRuntime>[0]['localServiceSummary'];
    let isProjectServiceExecutionLive: (() => boolean) | undefined;
    let acquireLocalServicePreviewApplication: Parameters<typeof createDaemonMachineBootstrapRuntime>[0]['acquireLocalServicePreviewApplication'];
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
    const peerMediationObservabilityRuntime = createDaemonPeerMediationObservabilityRuntime({
      isEnabled: () => {
        const snapshot = serverFeaturesSnapshotStore.getSnapshot();
        return snapshot?.status === 'ready'
          && readServerEnabledBit(snapshot.features, 'machines.peerMediation.observability') === true;
      },
    });
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
    let retireProviderBrokerClaimsForFeatureDisable: (() => Promise<void>) | null = null;
    const serverFeaturesSnapshotStore = createServerUrlServerFeaturesSnapshotStore({
      serverUrl: resolveServerHttpBaseUrl,
      token: credentials.token,
      onAuthenticatedReady: async (features) => {
        await applyDaemonHomeDescriptorRefresh({
          features,
          homeTarget,
          requestReconnect: () => {
            if (!apiMachine?.requestServerTransportReconnect()) {
              homeTransportReplacementPending = true;
              return;
            }
            homeTransportReplacementPending = false;
          },
        });
        await apiMachine?.refreshProviderBrokerIngressAdvertisement(features);
        await hydrateSavedSecretCatalog({
          token: credentials.token,
          serverFeatures: features,
        }).catch((error) => {
          logger.debug('[DAEMON RUN] Saved Secret catalog feature reconciliation failed (non-fatal)', {
            error: serializeAxiosErrorForLog(error),
          });
        });
        if (readServerEnabledBit(features, 'teams.credentialResources') !== true) {
          await retireProviderBrokerClaimsForFeatureDisable?.();
        }
      },
      onError: (error) => {
        logger.debug('[DAEMON RUN] Server-features snapshot refresh failed (non-fatal)', error);
      },
    });
    api.setServerFeaturesSnapshotProvider(
      () => serverFeaturesSnapshotStore.getSnapshot(),
      () => serverFeaturesSnapshotStore.refresh(),
    );
    const resolvePeerMediationTrustRoots = () => {
      return resolvePeerMediationTrustRootsFromSnapshot(
        serverFeaturesSnapshotStore.getSnapshot(),
        Date.now(),
      );
    };
    let refreshBrowserRouteOwners: (() => Promise<void>) | null = null;
    const minimumServerFeaturesSnapshotRefreshIntervalMs = 30_000;
    const configuredServerFeaturesSnapshotRefreshIntervalMs = resolvePositiveIntEnv(
      process.env.HAPPIER_DAEMON_SERVER_FEATURES_REFRESH_INTERVAL_MS,
      5 * 60_000,
      { min: minimumServerFeaturesSnapshotRefreshIntervalMs, max: 60 * 60_000 },
    );
    const refreshServerFeaturesAndBrowserRouteOwners = async (): Promise<void> => {
      await serverFeaturesSnapshotStore.refresh();
      await refreshBrowserRouteOwners?.();
    };
    // Prime offline-safe (non-blocking): a freshly booted daemon warms the cache so the first
    // session runtime-action dispatch reads real bits rather than failing closed. After the session
    // control runtime exists, the same refresh also gives browser route owners a late-registration
    // chance if the server was temporarily unreachable during startup.
    const serverFeaturesSnapshotRefreshLoop = startServerFeaturesSnapshotRefreshLoop({
      refresh: refreshServerFeaturesAndBrowserRouteOwners,
      isTransitionActive: serverFeaturesSnapshotStore.isRefreshTransitionActive,
      transitionIntervalMs: minimumServerFeaturesSnapshotRefreshIntervalMs,
      stableIntervalMs: configuredServerFeaturesSnapshotRefreshIntervalMs,
      onError: (error) => {
        logger.debug('[DAEMON RUN] Server-features scheduled refresh failed (non-fatal)', error);
      },
    });
    let automationWorker: AutomationWorkerHandle | null = null;
    let memoryWorker: MemoryWorkerHandle | null = null;
    let voiceInferenceWorker: VoiceInferenceWorkerHandle | null = null;
    let pluginWebhookWorker: PluginWebhookDaemonWorkerHandleV1 | null = null;
    let pluginWebhookWakeCleanup: (() => void) | null = null;
    let providerOperationsProducer: RuntimeProviderOperationsProducer | null = null;
    let externalSessionPluginAdmissionOwner:
      ExternalSessionPluginAdmissionOwner | null = null;
    let externalSessionHostActionExecutor: RpcActionExecutor | null = null;
    let sessionSpawnDirectTargetTransport:
      SessionSpawnDirectTargetTransport | null = null;
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
    let daemonConnectivityCoordinator: ReturnType<typeof createDaemonConnectivityCoordinator> | null = null;
    const isDaemonQuiescing = admissionDrain.isQuiescing;
    let publishSessionPluginCatalogInvalidation = (_revision: number): void => {};
    const pluginRegistryProjectionInvalidation =
      createDaemonPluginRegistryProjectionInvalidation({
        getApiMachine: () => apiMachine,
        isDaemonQuiescing: admissionDrain.isPublicationQuiescing,
        onProjectionInvalidated: revision => publishSessionPluginCatalogInvalidation(revision),
        onPublicationFailure: (error) => {
          logger.warn('[DAEMON RUN] Failed to publish durable plugin registry invalidation', {
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });
    const publishDaemonStateForCurrentOwner = (
      state: Parameters<typeof writeDaemonStateForLockOwner>[1],
    ): boolean => {
      const published = !admissionDrain.isPublicationQuiescing()
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
      admissionDrain.notifyPluginHandoffChanged();
      return {
        resume: async () => {
          await quiescence.resume();
          admissionDrain.notifyPluginHandoffChanged();
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
    let sessionActivityOwner: LiveWorkProducerV1 | null = null;
    const sessionActivity = createLiveWorkProducerGroup(() => sessionActivityOwner ? [sessionActivityOwner] : null);
    const machineActivity = createLiveWorkProducerGroup(() => apiMachineForSessions
      ? [apiMachineForSessions.getLiveWorkProducer()] : null);
    const automationActivity = createLiveWorkProducerGroup(() => automationWorker
      ? [automationWorker.liveWorkProducer] : null);
    const serviceActivity = createLiveWorkProducerGroup(() => {
      const lease = pluginReloadController.tryAcquireRuntimeRegistry();
      if (!lease) return null;
      const source = lease.registry.projectManagedServices.activity;
      void lease.release();
      return [source];
    });
    const syncActivity = createLiveWorkProducerGroup(() => {
      const runtime = workspaceSyncRuntimeCustody.get();
      return runtime ? [runtime.activity] : null;
    });
    const transferActivity = createLiveWorkProducerGroup(() => [transferLiveWorkProducer]);
    const managedActivity = createManagedActivityInventory({ producers: [
      sessionActivity, machineActivity, automationActivity, serviceActivity, syncActivity,
      transferActivity, createExecutionRunLiveWorkProducer(), getDaemonAgentInstallJobOwner({ admissionDrain }).activity,
    ] });
    const releaseManagedActivityRegistryEdges = pluginReloadController.subscribe(() => serviceActivity.notifyChanged());
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
      admissionDrain,
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
      retireFiniteExecution: async () => await machineBootstrapRuntime?.retireProjectFiniteExecution(),
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
        await managedMachinePolicyRuntime?.stop();
        managedMachinePolicyRuntime = null;
        releaseManagedActivityRegistryEdges();
        managedActivity.dispose();
        for (const source of [sessionActivity, machineActivity, automationActivity, serviceActivity, syncActivity, transferActivity]) source.dispose();
        await getDaemonAgentInstallJobOwner().shutdown();
        await stopWorkspaceSyncRuntime();
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
        teamCredentialDirectMaterialChangeCleanup?.();
        teamCredentialDirectMaterialChangeCleanup = null;
        teamCredentialDirectMaterialAccountChangeCleanup?.();
        teamCredentialDirectMaterialAccountChangeCleanup = null;
        serverFeaturesSnapshotRefreshLoop.stop();
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
      resolveHostedSessionWorkingDirectory,
    } = createDaemonSessionHandoffMetadataBridge({
      pidToTrackedSession,
      getMachineId: () => machineId,
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
    if (shouldUseSystemdUserSessionResourceGovernor({ platform: process.platform, startupSource })) {
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

    const resolveGroupDeletionAuthority = async ({
      serviceId,
      groupId,
    }: Readonly<{
      serviceId: ConnectedServiceId;
      groupId: string;
    }>) => {
      if (
        resolveQualifiedConnectedAccountAtomicV4Negotiation(
          serverFeaturesSnapshotStore.getSnapshot(),
        ) !== 'advertised'
      ) {
        return { status: 'unknown' as const };
      }
      const service =
        resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceId(
          serviceId,
        );
      if (!service) return { status: 'unknown' as const };
      try {
        const group = await readQualifiedConnectedAccountGroupV4({
          token: credentials.token,
          group: { service, groupId },
        });
        return { status: group === null ? 'deleted' as const : 'exists' as const };
      } catch (error) {
        if (readHttpStatus(error) === 404) return { status: 'unknown' as const };
        throw error;
      }
    };
    const connectedServiceGroupHomeCleanupScheduler = createConnectedServiceGroupHomeCleanupScheduler({
      activeServerDir: configuration.activeServerDir,
      pidToTrackedSession,
      resolveGroupDeletionAuthority,
    });
    void connectedServiceGroupHomeCleanupScheduler.reconcileDeletedGroupHomes({
      resolveGroupDeletionAuthority,
    }).catch((error) => {
      logger.debug('[DAEMON RUN] Connected-service group home startup reconciliation failed (non-fatal)', error);
    });
    const connectedServiceMaterializedHomeCleanupScheduler = createConnectedServiceMaterializedHomeCleanupScheduler({
      baseDir: connectedServicesMaterializationBaseDir,
      isolationBaseDir: join(configuration.activeServerDir, 'isolation'),
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
      registerAcceptedWorkspace: createAcceptedSessionWorkspaceRegistration({
        credentials,
        serverId: configuration.activeServerId,
        machineId,
        signal: homeTransportCancellation.signal,
      }),
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
      {
        successorDistClosureFingerprint,
        onReplacementConfirmed,
    }: {
      successorDistClosureFingerprint?: string;
      onReplacementConfirmed?: () => Promise<void>;
    } = {},
    ): Promise<void> => {
      const restartVerifyTimeoutMs = readDaemonRestartVerifyTimeoutMs();
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
          timeoutMs: restartVerifyTimeoutMs,
          deadlineAtMs: Date.now() + restartVerifyTimeoutMs,
          pollMs: readDaemonRestartVerifyPollMs(),
          postConfirmationOverlapMs: resolvePositiveIntEnv(
            process.env.HAPPIER_DAEMON_RESTART_OVERLAP_EXIT_GRACE_MS,
            1_000,
            { min: 0, max: 5_000 },
          ),
          ...(onReplacementConfirmed ? { onReplacementConfirmed } : {}),
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
        secrets: createActiveAccountSettingsConnectedAccountSecrets({
          expectedScopeKey: resolveAccountSettingsScopeKey(credentials),
        }),
        onAccountSettled: async (settled) => {
          const coordinator = connectedServiceQuotasCoordinator;
          if (!coordinator) throw new Error('Qualified quota source initializer is unavailable');
          await coordinator.initializeQualifiedAccountQuotaSource(settled);
        },
        // Attempt durability is Account-mode aware, so a plaintext Account keeps the
        // same OAuth/device restart recovery as an E2EE one. Key presence never
        // decides installation.
        attemptTransactions:
          createQualifiedConnectedAccountAttemptTransactionAdapters({
            credentials,
            getMachineId: () => machineId,
            getAccountEncryptionMode: async () =>
              await api.getAccountEncryptionMode(),
          }),
      });
    const connectedAccountConfigurationOwner =
      createConnectedAccountDaemonConfigurationOwner({
        reloadController: pluginReloadController,
        persistence: connectedAccountPersistence.configuration,
      });
    const establishedConnectedAccountRuntimeOwner =
      createQualifiedConnectedAccountEstablishedRuntimeOwner({
        reloadController: pluginReloadController,
        credentials,
        getAccountEncryptionMode: (signal) => api.getAccountEncryptionMode({ signal }),
        configuration: connectedAccountPersistence.configuration,
        configurationOwner: connectedAccountConfigurationOwner,
      });
    const teamCredentialDirectMaterialClient = createHttpTeamCredentialDirectMaterialClient({
      token: credentials.token,
      serverUrl: resolveServerHttpBaseUrl(),
      async readRecipientEncryptionMaterial(signal) {
        const mode = await api.getAccountEncryptionMode({ signal });
        if (mode === 'plain') return { mode: 'plain' };
        if (mode !== 'e2ee' || !credentials.encryption) {
          return { mode: 'e2ee_unavailable' };
        }
        return {
          mode: 'e2ee',
          secretKeyOrSeed: credentials.encryption.type === 'dataKey'
            ? credentials.encryption.machineKey
            : credentials.encryption.secret,
        };
      },
    });
    const connectedAccountPurposeBindingRuntime = createDaemonConnectedAccountPurposeBindingRuntime({
      workerMachineId: machineId,
      establishedRuntimeOwner: establishedConnectedAccountRuntimeOwner,
      openTeamDirect: teamCredentialDirectMaterialClient.open,
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
    let managedServiceSessionBaseUrlResolver:
      ManagedServiceSessionBaseUrlResolver | null = null;
    let managedServiceSessionClientAccessResolver:
      ManagedServiceSessionClientAccessResolver | null = null;
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
          readCredentialConfigurationRevision:
            connectedAccountPurposeBindingRuntime.readCredentialConfigurationRevision,
        },
        listActionFormConnectedAccountOptions:
          connectedAccountPurposeBindingRuntime.listActionFormConnectedAccountOptions,
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
      });
    const managedPolicyServerHttpBaseUrl = resolveServerHttpBaseUrl();
    const pluginRemovalOrigin = await resolveCurrentMachineExecutionOriginContext();
    const managedPolicyHomeId = pluginRemovalOrigin?.serverIdentityId ?? null;
    const pluginRemovalInstallation = readInstallationIdentityIfExistsSync();
    const managedResourcePreflight = pluginRemovalOrigin?.machineId === machineId && pluginRemovalInstallation
      ? { credentials, serverUrl: managedPolicyServerHttpBaseUrl, homeId: pluginRemovalOrigin.serverIdentityId,
          controller: { machineId, installationId: pluginRemovalInstallation.installationId }, signal: homeTransportCancellation.signal }
      : undefined;
    const readCurrentManagedMachinePolicies = async (signal?: AbortSignal) => {
      const origin = await resolveCurrentMachineExecutionOriginContext(signal);
      const installation = readInstallationIdentityIfExistsSync();
      if (!managedPolicyHomeId || !origin || origin.serverIdentityId !== managedPolicyHomeId
        || origin.machineId !== machineId || !installation || !externalActionAccountId) {
        throw Object.assign(new Error('controller_unavailable'), { code: 'controller_unavailable' });
      }
      return await readManagedMachinePolicyCensus({ homeId: managedPolicyHomeId,
        controller: { machineId, installationId: installation.installationId },
        custodianAccountId: externalActionAccountId, privateKey: installation.privateKey,
        token: credentials.token, serverUrl: managedPolicyServerHttpBaseUrl, signal });
    };
    const browserRuntimeActionExecute = api.createBrowserRuntimeActionExecutor();
    confidentialSecretFill = api.createConfidentialSecretFillExecutor({
      machineId: () => machineId, readHostIdentity: resolveCurrentMachineExecutionOriginContext });
    const pluginRuntimeOwner = createDaemonPluginRuntimeOwner({
      happyHomeDir: configuration.happyHomeDir,
      ...(managedResourcePreflight ? { managedResourcePreflight } : {}),
      daemonDatabaseLimits: DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY,
      resolveCurrentMachineId: () => machineId,
      machineAdmissionTransport,
      executeClientAction: createClientActionMachineRpcExecutor(() => apiMachineForSessions),
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
        signal: homeTransportCancellation.signal,
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
      onDurableRegistryApplied: () => {
        pluginRegistryProjectionInvalidation.invalidateProjection();
        reconcileTeamCredentialDirectMaterialAfterSourceChange();
      },
      onRuntimeProjectionInvalidated: () => {
        pluginRegistryProjectionInvalidation.invalidateProjection();
        reconcileTeamCredentialDirectMaterialAfterSourceChange();
      },
      managedProviderOperationAuthority,
      qualifiedConnectedAccountEstablishedRuntimeOwner:
        establishedConnectedAccountRuntimeOwner,
      reconcileConnectedAccountPurposePublication:
        connectedAccountPurposeBindingRuntime.reconcileRegistryPublication,
      runtimeActionExecute: browserRuntimeActionExecute,
      managedEndpointRead: async (input) => {
        const host = managedServiceEndpointReadHost;
        if (!host) {
          throw new Error(
            'Managed server endpoint read owner is unavailable',
          );
        }
        return await host(input);
      },
      resolveManagedServiceSessionBaseUrl: async (input) => {
        const resolver = managedServiceSessionBaseUrlResolver;
        if (!resolver) {
          throw new Error('Managed server Session endpoint owner is unavailable');
        }
        return await resolver(input);
      },
      resolveManagedServiceSessionClientAccess: async (input) => {
        const resolver = managedServiceSessionClientAccessResolver;
        if (!resolver) {
          throw new Error('Managed server Session client access owner is unavailable');
        }
        return await resolver(input);
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
      configurationOwner: connectedAccountConfigurationOwner,
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
        resolveRemovalReviewSupport: () =>
          resolveQualifiedConnectedAccountRemovalReviewNegotiation(
            serverFeaturesSnapshotStore.getSnapshot(),
          ),
      },
    });
    const homeDomainAction = externalActionAccountId
      ? createAccountServerActionDeps({
        token: credentials.token,
        credentials,
        serverId: configuration.activeServerId,
        serverHttpBaseUrl: resolveServerHttpBaseUrl(),
        resolveServerFeaturesSnapshot: () => serverFeaturesSnapshotStore.getSnapshot(),
      }).homeDomainAction
      : undefined;
    if (externalActionAccountId && homeDomainAction) {
        const reconciler = createDaemonTeamCredentialDirectMaterialReconciler({
          token: credentials.token,
          accountId: externalActionAccountId,
          homeDomainAction,
          establishedRuntimeOwner: establishedConnectedAccountRuntimeOwner,
          async listAccounts(service, signal) {
            return await listQualifiedConnectedAccountsV4({ token: credentials.token, service, signal });
          },
          async readGroup(source, signal) {
            return await readQualifiedConnectedAccountGroupV4({
              token: credentials.token,
              group: source.target,
              signal,
            });
          },
          async resolveProviderSource(source, signal) {
            const catalog = await prepareProviderConnectionsCatalogForCli({ expectedScopeKey: resolveAccountSettingsScopeKey(credentials), signal });
            if (catalog.status !== 'ready') return null;
            const accountSnapshot = getActiveAccountSettingsSnapshot();
            if (!accountSnapshot) return null;
            const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
              happyHomeDir: configuration.happyHomeDir,
              controller: pluginReloadController,
            });
            try {
              const registry = resolveProviderContributionRegistryView(
                lease.registry.contributes,
                lease.durableRevision,
                lease.registry.readPluginOccurrenceId,
              );
              const dnsEvidenceByEndpointUrl = await collectProviderConnectionDnsEvidence({
                connectionId: source.connectionId,
                machineId,
                providerSettings: readProviderSettingsForCli(accountSnapshot).settings,
                registry,
                lifetime: createProviderOperationLifetime({
                  signal,
                  wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
                }),
              });
              const resolved = await resolveAdmittedProviderConnectionDirectSourceSnapshot({
                source,
                machineId,
                expectedScopeKey: resolveAccountSettingsScopeKey(credentials),
                registry,
                dnsEvidenceByEndpointUrl,
                getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
                signal,
              });
              if (!resolved.ok) return null;
              const credential = await materializeProviderConnectionDirectCredential({
                expected: resolved.snapshot,
                registry,
                dnsEvidenceByEndpointUrl,
                getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
              });
              if (!credential.ok) return null;
              return createProviderConnectionTeamCredentialSourceSnapshot({
                sourceAccountId: externalActionAccountId,
                expected: resolved.snapshot,
                resolvedCredential: credential.credential,
                isPersistedSourceCurrent: () => true,
                async isProviderSourceCurrent(expected) {
                  const currentSnapshot = getActiveAccountSettingsSnapshot();
                  if (!currentSnapshot) return false;
                  const currentLease = await acquireAuthoritativePluginRuntimeRegistryLease({
                    happyHomeDir: configuration.happyHomeDir,
                    controller: pluginReloadController,
                  });
                  try {
                    const currentRegistry = resolveProviderContributionRegistryView(
                      currentLease.registry.contributes,
                      currentLease.durableRevision,
                      currentLease.registry.readPluginOccurrenceId,
                    );
                    const currentDnsEvidence = await collectProviderConnectionDnsEvidence({
                      connectionId: source.connectionId,
                      machineId,
                      providerSettings: readProviderSettingsForCli(currentSnapshot).settings,
                      registry: currentRegistry,
                      lifetime: createProviderOperationLifetime({
                        signal,
                        wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
                      }),
                    });
                    return isProviderConnectionDirectSourceCurrent({
                      expected,
                      registry: currentRegistry,
                      dnsEvidenceByEndpointUrl: currentDnsEvidence,
                      getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
                    });
                  } finally {
                    await currentLease.release();
                  }
                },
              });
            } finally {
              await lease.release();
            }
          },
        });
        const reconcileIfEnabled = async (
          target?: Parameters<typeof reconciler.reconcile>[0],
          signal?: AbortSignal,
        ) => {
          const snapshot = serverFeaturesSnapshotStore.getSnapshot();
          if (
            snapshot?.status !== 'ready'
            || readServerEnabledBit(snapshot.features, 'teams.credentialResources') !== true
          ) return { prepared: 0, remaining: 0, failures: [] };
          return await reconciler.reconcile(target, signal);
        };
        const reconcileDirectMaterialBestEffort = () => void reconcileIfEnabled(undefined).catch((error) => logger.debug(
            '[DAEMON RUN] Team credential direct-material reconciliation failed (non-fatal)',
            { error: serializeAxiosErrorForLog(error) },
          ));
        reconcileTeamCredentialDirectMaterialAfterSourceChange = reconcileDirectMaterialBestEffort;
        // Direct preparation consumes Provider settings, Saved Secrets and the
        // Account lifetime from the snapshot, which publishes only on change;
        // Team grant, recipient and connected-service facts arrive through the
        // AccountChange wake attached with the machine client below.
        teamCredentialDirectMaterialChangeCleanup = subscribeActiveAccountSettingsSnapshotChanges(
          reconcileDirectMaterialBestEffort,
        );
        reconcileDirectMaterialBestEffort();
    }
    machineRpcRouteAttachments.attachConnectedAccountDaemonRuntime(
      connectedAccountDaemonRuntime,
    );
    machineRpcRouteAttachments.attachConnectedAccountPurposeBindingRuntime(
      connectedAccountPurposeBindingRuntime,
    );
    const openTeamCredentialProviderBinding: NonNullable<
      Parameters<typeof startDaemonSessionControlRuntime>[0]['openTeamCredentialProviderBinding']
    > | undefined = homeDomainAction && externalActionAccountId
      ? async (input) => {
          const workerMachineId = machineId;
          const openTunnel = machineIrohRuntime
            ? createProviderBrokerMachineCarrierTunnelOpen({
                accountId: externalActionAccountId,
                localMachineId: workerMachineId,
                runtime: machineIrohRuntime,
                resolveTrustRoots: resolvePeerMediationTrustRoots,
              })
            : undefined;
          const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
            happyHomeDir: configuration.happyHomeDir,
            controller: pluginReloadController,
          });
          try {
            const opened = await openSessionTeamCredentialProviderBinding({
              ...(input.sessionId ? { sessionId: input.sessionId } : {}),
              ...(input.consumer ? { consumer: input.consumer } : {}),
              machineId: workerMachineId,
              agentId: input.agentId,
              agentTargetKey: input.agentTargetKey,
              modelId: input.modelId,
              binding: {
                v: 1,
                slot: { kind: 'provider_model' },
                resourceId: input.resourceId,
                expectedResourceRevision: input.expectedResourceRevision,
                deliveryMode: input.deliveryMode,
                teamId: input.teamId,
              },
              lease,
              materializationBaseDir: join(configuration.happyHomeDir, 'providers', 'materialized'),
              signal: input.signal,
              readCatalog: async (signal) => {
                let cursor: string | null = null;
                do {
                  const raw = await homeDomainAction({
                    actionId: 'teams.credentials.entitled.list', input: { teamId: input.teamId, ...(cursor ? { cursor } : {}) },
                    context: { surface: 'cli' }, signal,
                  });
                  const parsed = TeamCredentialResourceEntitledPageV1Schema.parse(raw);
                  const resource = parsed.resources.find(candidate => candidate.id === input.resourceId);
                  if (resource) return resource.providerModels;
                  cursor = readTeamCredentialCatalogNextCursor(parsed);
                } while (cursor);
                return [];
              },
              ...(openTunnel ? {
                openBroker: async (request, signal) =>
                  await api.openTeamCredentialProviderBroker(request, { signal }),
                openTunnel,
              } : {}),
              openTeamDirect: createDaemonTeamCredentialDirectMaterialOpen({
                clientOpen: teamCredentialDirectMaterialClient.open,
                workerMachineId,
                signal: input.signal,
              }),
            });
            if (!opened) throw new Error('team_credential_provider_selection_not_current');
            return opened;
          } finally {
            await lease.release();
          }
        }
      : undefined;
    let createRequesterRuntime: ((bootstrap: AdmittedRequesterSessionBootstrap) => Promise<RequesterSessionRuntimeContext | null>) | null = null;
    const requesterRuntimeServerId = configuration.activeServerId;
    const requesterRuntimeServerHttpBaseUrl = resolveServerHttpBaseUrl();
    const openRunAccountConnectionSource = managedPolicyHomeId && externalActionAccountId
      ? createDaemonAccountConnectionManagedConsumerOpen({
          homeId: managedPolicyHomeId, accountId: externalActionAccountId, machineId: () => machineId,
          isHomeCurrent: () => !isDaemonQuiescing() && configuration.activeServerId === requesterRuntimeServerId,
          custody: targetMachineId => createManagedProviderExplicitStartCustody({ machineId: targetMachineId,
            happyHomeDir: configuration.happyHomeDir, controller: pluginReloadController }),
          withRegistry: async read => {
            const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
              happyHomeDir: configuration.happyHomeDir, controller: pluginReloadController,
            });
            try { return await read(resolveProviderContributionRegistryView(lease.registry.contributes,
              lease.durableRevision, lease.registry.readPluginOccurrenceId)); }
            finally { await lease.release(); }
          },
          projectModelsForAccount: async (request, context) => {
            const producer = providerOperationsProducer;
            if (!producer) throw new Error('provider_source_projection_unavailable');
            return await producer.machineServices.projectModelsForAccount(request, context);
          },
          openRemote: async (request, isCurrent) => {
            const runtime = machineIrohRuntime;
            if (!runtime) return null;
            return await openAccountConnectionProviderBrokerAccess({
              ...request,
              homeId: managedPolicyHomeId, accountId: externalActionAccountId, initiatorMachineId: machineId,
              openBroker: async (request, signal) => await api.openAccountConnectionProviderBroker(request, { signal }),
              admitConsumer: async (authority, signal) => await isCurrent()
                && (await api.admitAccountConnectionProviderBroker({ v: 2, authority }, { signal })).ok
                && await isCurrent(),
              openTunnel: createProviderBrokerMachineCarrierTunnelOpen({
                homeId: managedPolicyHomeId, accountId: externalActionAccountId, localMachineId: machineId,
                runtime, resolveTrustRoots: resolvePeerMediationTrustRoots,
              }),
            });
          },
        })
      : undefined;
    const requesterMachineAdmissionBoundary = (attribution?: AdmittedRequesterSessionBootstrap['attribution']) => ({
      machineId, daemonToken: credentials.token, readInstallation: readInstallationIdentityIfExistsSync,
      isHomeCurrent: () => configuration.activeServerId === requesterRuntimeServerId
        && (!attribution || attribution.serverId === requesterRuntimeServerId && attribution.machineId === machineId),
    });
    const resolveRequesterSessionRuntimeContext: ResolveRequesterSessionRuntimeContext = async (sessionId, attribution) => {
      const tracked = [...pidToTrackedSession.values()].find(candidate => candidate.happySessionId === sessionId);
      const context = tracked?.requesterSessionRuntimeContext;
      if (!context && !createRequesterRuntime) return null;
      let stamp = tracked?.requesterWorkAttributionV1 ?? tracked?.spawnOptions?.requesterWorkAttributionV1
        ?? context?.bootstrap.attribution ?? attribution;
      const coldBootstrap = !stamp ? await resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: configuration.happyHomeDir,
        serverId: requesterRuntimeServerId, sessionId, serverHttpBaseUrl: requesterRuntimeServerHttpBaseUrl,
        machineAdmissionBoundary: requesterMachineAdmissionBoundary() }) : null;
      stamp ??= coldBootstrap?.attribution;
      if (!stamp || attribution && (stamp.serverId !== attribution.serverId || stamp.accountId !== attribution.accountId
        || stamp.machineId !== attribution.machineId || stamp.installationId !== attribution.installationId)) return null;
      if (context) {
        const contextStamp = context.bootstrap.attribution;
        if (contextStamp.serverId !== stamp.serverId || contextStamp.accountId !== stamp.accountId
          || contextStamp.machineId !== stamp.machineId || contextStamp.installationId !== stamp.installationId
          || context.bootstrap.getBoundSessionId() !== sessionId) return null;
        if (await context.isCurrent()) return context;
      }
      if (!createRequesterRuntime) return null;
      const bootstrap = coldBootstrap ?? await resolveRequesterSessionBootstrap({ happyHomeDir: configuration.happyHomeDir,
        sessionId, attribution: stamp, serverHttpBaseUrl: requesterRuntimeServerHttpBaseUrl,
        machineAdmissionBoundary: requesterMachineAdmissionBoundary(stamp) });
      if (!bootstrap) return null;
      const recovered = await createRequesterRuntime(bootstrap);
      if (!recovered) { bootstrap.savedSecretOperationContext.withdrawCatalog(); return null; }
      if (tracked) {
        const stillTracked = [...pidToTrackedSession.values()].some(candidate => candidate === tracked
          && candidate.happySessionId === sessionId);
        if (!stillTracked) { await recovered.dispose(); return null; }
        const incumbent = tracked.requesterSessionRuntimeContext;
        if (incumbent && incumbent !== context) {
          await recovered.dispose();
          const incumbentStamp = incumbent.bootstrap.attribution;
          return incumbentStamp.serverId === stamp.serverId && incumbentStamp.accountId === stamp.accountId
            && incumbentStamp.machineId === stamp.machineId && incumbentStamp.installationId === stamp.installationId
            && incumbent.bootstrap.getBoundSessionId() === sessionId
            && await incumbent.isCurrent() ? incumbent : null;
        }
        tracked.requesterSessionRuntimeContext = recovered;
        if (context) await context.dispose();
      }
      return recovered;
    };
    publishSessionPluginCatalogInvalidation = revision => {
      const projection = { runtimeId, contributionRegistryProjectionRevision: revision };
      for (const tracked of pidToTrackedSession.values()) {
        if (!tracked.happySessionId) continue;
        void (async () => {
          const requester = await resolveRequesterSessionRuntimeContext(tracked.happySessionId!, tracked.requesterWorkAttributionV1);
          const result = await withTrackedSessionRpc({
            tracked, credentials, custodianAccountId: externalActionAccountId,
            serverId: requesterRuntimeServerId, machineId,
            serverHttpBaseUrl: requesterRuntimeServerHttpBaseUrl,
            ...(requester ? { requesterBootstrap: requester.bootstrap } : {}),
            isTrackedCurrent: () => !admissionDrain.isPublicationQuiescing()
              && pidToTrackedSession.get(tracked.pid) === tracked,
          }, callRpc => callRpc(SESSION_RPC_METHODS.SESSION_PLUGIN_CATALOG_INVALIDATE_V1, projection));
          if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
            logger.debug('[DAEMON RUN] Session plugin catalog hint unavailable', { sessionId: tracked.happySessionId });
          }
        })().catch(error => logger.debug('[DAEMON RUN] Session plugin catalog hint failed', {
          sessionId: tracked.happySessionId, error: error instanceof Error ? error.message : String(error),
        }));
      }
    };
    const ownedConnectedServiceRuntimeRegistry = connectedServiceRuntimeRegistry.scopeToRequester(target => {
      const tracked = pidToTrackedSession.get(target.pid)
        ?? [...pidToTrackedSession.values()].find(candidate => candidate.happySessionId === target.sessionId);
      const stamp = target.requesterWorkAttributionV1 ?? tracked?.requesterWorkAttributionV1 ?? tracked?.spawnOptions?.requesterWorkAttributionV1;
      return !stamp || stamp.serverId === configuration.activeServerId && stamp.accountId === externalActionAccountId;
    }, externalActionAccountId ? { serverId: requesterRuntimeServerId, accountId: externalActionAccountId } : undefined);
    const {
      sessionLiveWorkProducer,
      spawnSession,
      stopSession,
      stopRequesterSessionForHandoff,
      isSessionAlreadyRunning,
      sessionRunnerStatus,
      onChildExited,
      onTrackedSessionHealthy,
      controlPort,
      controlToken,
      stopControlServer,
      connectedServiceAuthGroupPreTurnSwitchCoordinator,
      connectedServicePredictiveSwitchGuard,
      consumeCommittedAuthGroupGeneration,
      requestConnectedServiceRefreshRestartSignal,
      cancelConnectedServiceRuntimeAuthRecovery,
      retryTemporaryThrottleNow,
      readTemporaryThrottleRecovery,
      cancelTemporaryThrottleRecovery,
      reconcileReattachedConnectedServiceCredentialProjection,
      reconcileConnectedServicesProjection,
      awaitAgentSessionOpen,
      installExternalSessionHostOperations,
      providerAccountUsageStore,
      flushProviderAccountUsagePersistence,
      connectedServiceRuntimeQuotaSnapshots,
      createAgentCatalogObservation,
      externalActionIngressOwner,
      managedMachinePolicyAdapter,
      refreshBrowserRouteOwners: refreshBrowserRouteOwnersFromSessionControl,
    } = await startDaemonSessionControlRuntime({
      admissionDrain,
      requesterSessionCustodyServerId: requesterRuntimeServerId,
      readLiveWorkInventory: managedActivity.read,
      machineId,
      managedProviderOperationAuthority,
      readManagedMachinePolicyCurrent: async (managedId, signal) => (
        await readCurrentManagedMachinePolicies(signal)
      ).machines.find(machine => machine.id === managedId) ?? null,
      externalActionAccountId,
      resolveProjectWorkerAction: () => projectWorkerAction,
      serverId: configuration.activeServerId,
      serverBaseUrl: resolveServerHttpBaseUrl(),
      runtimeActionExecute: browserRuntimeActionExecute,
      ...(workflowRuntime
        ? {
            workflowAcceptedAuthorizationCurrentness:
              workflowRuntime.isAcceptedAuthorizationCurrent,
          }
        : {}),
      currentMachineHost: metadataForRegistration.host,
      currentMachineHomeDir: metadataForRegistration.homeDir,
      resolveCurrentMachineExecutionOriginContext,
      resolveExternalSessionHostAction: () => {
        const executor = externalSessionHostActionExecutor;
        if (!executor) return undefined;
        return async ({ actionId, input, context, signal }) =>
          await executor.execute(actionId, input, {
            ...context,
            ...(signal ? { signal } : {}),
          });
      },
      externalSessionPluginAdmissionOwner: pluginAdmissionOwner,
      resolveSessionSpawnDirectTargetTransport: () =>
        sessionSpawnDirectTargetTransport ?? undefined,
      externalSessionHostOperationOwner,
      runtimeId,
      credentials,
      readPluginCatalogProjection: () => ({ runtimeId,
        contributionRegistryProjectionRevision: pluginRegistryProjectionInvalidation.readRevision() }),
      createRequesterSessionRuntimeContext: async bootstrap => await createRequesterRuntime?.(bootstrap) ?? null,
      resolveRequesterSessionRuntimeContext,
      daemonSessionMutationCustody,
      cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop: async (input) =>
        await cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop(input),
      deviceLocalSecretStorage,
      api,
      ...(openTeamCredentialProviderBinding ? { openTeamCredentialProviderBinding } : {}),
      ...(openRunAccountConnectionSource ? { openAccountConnectionManagedConsumerSource: openRunAccountConnectionSource } : {}),
      ...(managedPolicyHomeId && externalActionAccountId ? {
        openAccountConnectionProviderBrokerAccess: async request => {
          const runtime = machineIrohRuntime;
          if (!runtime) throw createProviderErrorV1('provider_endpoint_unavailable', {
            connectionId: request.connectionId, machineId: request.targetMachineId,
          });
          const openTunnel = createProviderBrokerMachineCarrierTunnelOpen({
            homeId: managedPolicyHomeId, accountId: externalActionAccountId, localMachineId: machineId,
            runtime, resolveTrustRoots: resolvePeerMediationTrustRoots,
          });
          return await openAccountConnectionProviderBrokerAccess({
            ...request, homeId: managedPolicyHomeId, accountId: externalActionAccountId, initiatorMachineId: machineId,
            openBroker: async (openRequest, signal) => await api.openAccountConnectionProviderBroker(openRequest, { signal }),
            admitConsumer: async (authority, signal) => (await api.admitAccountConnectionProviderBroker({ v: 2, authority }, { signal })).ok,
            openTunnel,
          });
        },
      } : {}),
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
      ownedConnectedServiceRuntimeRegistry,
      pidToTrackedSession,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      persistedTakeoverAdmissionWaiter,
      getApiMachineForSessions: () => apiMachineForSessions,
      onLocalServicesRoutesReady: (routes) => {
        localServiceInventoryRoutes = routes.localServicesInventory ?? null;
        machineRpcRouteAttachments.attachLocalServicesRoutes(routes);
      },
      onLocalServicesSummaryReady: (source) => {
        localServiceSummary = source;
        isProjectServiceExecutionLive = source.isProjectServiceExecutionLive;
      },
      onProviderManagedCatalogRuntimeOwnerReady: (owner) => {
        providerManagedCatalogRuntimeOwner = owner;
      },
      onManagedServiceEndpointReadHostReady: (host) => {
        managedServiceEndpointReadHost = host;
      },
      onManagedServiceSessionBaseUrlResolverReady: (resolver) => {
        managedServiceSessionBaseUrlResolver = resolver;
      },
      onManagedServiceSessionClientAccessResolverReady: (resolver) => {
        managedServiceSessionClientAccessResolver = resolver;
      },
      onLocalServicesPreviewRoutesReady: (routes) => {
        machineRpcRouteAttachments.attachLocalServicesPreviewRoutes(routes);
        acquireLocalServicePreviewApplication = routes.acquireNativeApplication;
      },
      onBrowserControlRoutesReady: machineRpcRouteAttachments.attachBrowserControlRoutes,
      onBrowserContextRoutesReady: machineRpcRouteAttachments.attachBrowserContextRoutes,
      onBrowserDiagnosticsRoutesReady: machineRpcRouteAttachments.attachBrowserDiagnosticsRoutes,
      onBrowserRecordingRoutesReady: machineRpcRouteAttachments.attachBrowserRecordingRoutes,
      onSimulatorPreviewRoutesReady: machineRpcRouteAttachments.attachSimulatorPreviewRoutes,
      onConnectedServicePoolSelectionReadReady: machineRpcRouteAttachments.attachConnectedServicePoolSelectionRead,
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
      ...(externalActionAccountId && homeDomainAction
        ? {
            resolveSessionTeamCredentialBindingIntents: async ({ teamResourceSelections }) =>
              await resolvePurposeTeamCredentialBindingIntentsFromHome({
                teamResourceSelections,
                resolveTeamCredentialResourceCatalog:
                  createSpawnConnectedServicesTeamResourceCatalogResolver({
                    homeDomainAction,
                    serverId: configuration.activeServerId,
                    accountId: externalActionAccountId,
                  }),
              }),
          }
        : {}),
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
    sessionActivityOwner = sessionLiveWorkProducer;
    sessionActivity.notifyChanged();
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
        invalidateConfiguredExternalSessionSources: () => {
          notifyActiveAccountConnectedServicesProjection(
            resolveAccountSettingsScopeKey(credentials),
          );
        },
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
      admissionDrain,
      isDaemonQuiescing: admissionDrain.isPublicationQuiescing,
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
        const bindings = ConnectedServiceBindingsV2IngressSchema.safeParse(
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
      connectedServiceRuntimeRegistry: ownedConnectedServiceRuntimeRegistry,
      // K2: FSM-routed proactive quota coordinator (built by the session-control runtime).
      connectedServiceAuthGroupPreTurnSwitchCoordinator,
      connectedServicePredictiveSwitchGuard,
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
      transferLiveWorkProducer,
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
    createRequesterRuntime = async bootstrap => {
      if (bootstrap.serverHttpBaseUrl !== requesterRuntimeServerHttpBaseUrl
        || !requesterMachineAdmissionBoundary(bootstrap.attribution).isHomeCurrent()) return null;
      bindRequesterSessionRuntimeMachineAdmissionCurrentness({
        bootstrap, boundary: requesterMachineAdmissionBoundary(bootstrap.attribution),
      });
      return await createRequesterSessionRuntimeContext({ bootstrap,
        activeServerDir: configuration.activeServerDir, connectedServicesMaterializationBaseDir,
        resolveQualifiedConnectedAccountV4Support: () => resolveQualifiedConnectedAccountAtomicV4Negotiation(serverFeaturesSnapshotStore.getSnapshot()),
        coordinatorInput: {
          machineId, machineIdProvider: () => machineId, runtimeId, happyHomeDir: configuration.happyHomeDir,
          logger, processEnv: process.env, pidToTrackedSession, connectedServiceRuntimeRegistry,
          connectedServiceAuthGroupPreTurnSwitchCoordinator, connectedServicePredictiveSwitchGuard,
          consumeCommittedAuthGroupGeneration, connectedServiceQuotaFetcherDescriptors,
          resolveQualifiedConnectedAccountPeerClass: () => resolveQualifiedConnectedAccountPeerClass(
            serverFeaturesSnapshotStore.getSnapshot(), apiMachineForSessions?.getSessionSyncPendingInputServerContractResult() ?? null),
          resolveQualifiedConnectedAccountPeerOperationTransport: ({ service, operation }) => resolveQualifiedConnectedAccountPeerOperationTransport({
            snapshot: serverFeaturesSnapshotStore.getSnapshot(), serverContract: apiMachineForSessions?.getSessionSyncPendingInputServerContractResult() ?? null,
            service, operation,
          }),
          resolveConnectedServiceQualifiedPurposeBindingSnapshot: async ({ agentId, connectedServicesBindingsRaw }) => {
            const bindings = ConnectedServiceBindingsV2IngressSchema.safeParse(connectedServicesBindingsRaw);
            if (!bindings.success) return null;
            const lease = await acquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir: configuration.happyHomeDir });
            try { return resolveQualifiedPurposeBindingSnapshotForAgentSpawn({ agentId, bindings: bindings.data, contributions: lease.registry.contributes }); }
            finally { await lease.release(); }
          },
        },
      });
    };
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
        if (admissionDrain.isPublicationQuiescing()) return;
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
      isShuttingDown: admissionDrain.isFinalShutdown,
      isQuiescing: admissionDrain.isPublicationQuiescing,
      bootstrapRuntime: machineBootstrapRuntime = createDaemonMachineBootstrapRuntime({
        api,
        credentials,
        requesterServerId: requesterRuntimeServerId,
        resolveCurrentMachineExecutionOriginContext,
        resolveRequesterSessionRuntimeContext,
        readRequesterSessionCredentialBindings: async () => {
          const installation = readInstallationIdentityIfExistsSync();
          if (!installation || configuration.activeServerId !== requesterRuntimeServerId) {
            return { status: 'unavailable', reason: 'requester_session_custody_unavailable' };
          }
          return await listRequesterSessionCredentialBindings({ happyHomeDir: configuration.happyHomeDir,
            serverId: requesterRuntimeServerId, machineId, installationId: installation.installationId });
        },
        releaseRequesterSessionRuntimeContext: async context => {
          if ([...pidToTrackedSession.values()].some(tracked => tracked.requesterSessionRuntimeContext === context)) return;
          await context.dispose();
        },
        stopRequesterSessionForHandoff,
        daemonSessionMutationCustody,
        deviceLocalSecretStorage,
        ...(openRunAccountConnectionSource ? { openAccountConnectionManagedConsumerSource: openRunAccountConnectionSource } : {}),
        ...(openTeamCredentialProviderBinding
          ? {
              prepareRunTeamCredentialProviderBinding: async (request) => {
                const selection = request.selection;
                if (!selection) return null;
                const currentMachineId = machineId;
                if (!request.machineId || request.machineId !== currentMachineId) {
                  throw new Error('team_credential_provider_machine_not_current');
                }
                const lifetime = new AbortController();
                const opened = await openTeamCredentialProviderBinding({
                  teamId: selection.teamId,
                  resourceId: selection.resourceId,
                  expectedResourceRevision: selection.expectedResourceRevision,
                  deliveryMode: selection.deliveryMode,
                  agentId: request.agentId,
                  agentTargetKey: selection.agentTargetKey,
                  modelId: selection.modelId,
                  consumer: { kind: 'execution_run', executionRunId: request.runId },
                  signal: lifetime.signal,
                });
                let closed = false;
                return Object.freeze({
                  ...opened,
                  async cleanup() {
                    if (closed) return;
                    closed = true;
                    lifetime.abort();
                    await opened.cleanup();
                  },
                });
              },
            }
          : {}),
        ...(homeDomainAction
          ? {
              startProviderBrokerApplication: async ({
                machineId: registeredMachineId,
                apiMachine: brokerApiMachine,
              }) => {
                const readResource = async (
                  resourceId: string,
                  signal: AbortSignal,
                ): Promise<TeamCredentialResourceSummaryV1 | null> => {
                  try {
                    return await api.getTeamCredentialResource(resourceId, { signal });
                  } catch {
                    return null;
                  }
                };
                // The broker serves its own source, so its catalog is that
                // source's canonical current projection — not the recipient
                // catalog, which would require the custodian to be an audience
                // member of the resource it offers to others. The Home decides
                // the requester's entitlement per request; request policy is
                // intersected by the broker's request-policy owner.
                const resolveCatalog = async (input: Readonly<{
                  resource: TeamCredentialResourceSummaryV1;
                  application: ProviderBrokerApplicationBindingV1;
                  signal: AbortSignal;
                }>) => {
                  const producer = providerOperationsProducer;
                  const source = input.resource.source;
                  if (!producer || !source) return null;
                  return await resolveTeamCredentialSourceModelCatalog({
                    machineId: registeredMachineId,
                    teamId: input.resource.teamId,
                    resourceId: input.resource.id,
                    resourceRevision: input.resource.revision,
                    source,
                    application: input.application,
                    projectModels: async (projectionRequest) =>
                      await producer.machineServices.projectModels(projectionRequest),
                    signal: input.signal,
                  });
                };
                const brokerManagedProviderCustody = createManagedProviderExplicitStartCustody({
                  machineId: registeredMachineId,
                  happyHomeDir: configuration.happyHomeDir,
                  controller: pluginReloadController,
                });
                const withBrokerProviderRegistry: import('@/providers/broker/providerConnectionSource').ProviderConnectionRegistryReader = async (read) => {
                  const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
                    happyHomeDir: configuration.happyHomeDir,
                    controller: pluginReloadController,
                  });
                  try {
                    return await read(resolveProviderContributionRegistryView(
                      lease.registry.contributes,
                      lease.durableRevision,
                      lease.registry.readPluginOccurrenceId,
                    ));
                  } finally {
                    await lease.release();
                  }
                };
                const sourceOwner = createTeamCredentialBrokerSourceOwner({
                  machineId: registeredMachineId,
                  custody: brokerManagedProviderCustody,
                  selectConnectedServicesSourceMember: createConnectedServicesBrokerSourceMemberSelect({
                    withRegistry: withBrokerProviderRegistry,
                    resolveBindingIntentSelection: connectedAccountPurposeBindingRuntime.resolveBindingIntentSelection,
                  }),
                  openConnectedServicesSource: createConnectedServicesBrokerSourceOpen({
                    withRegistry: withBrokerProviderRegistry,
                    readResource,
                    resolveBindingIntentSelection: connectedAccountPurposeBindingRuntime.resolveBindingIntentSelection,
                    custody: brokerManagedProviderCustody,
                  }),
                  openProviderConnectionSource: createProviderConnectionBrokerSourceOpen({
                    machineId: registeredMachineId,
                    readResource: async (resourceId, signal) => {
                      const resource = await readResource(resourceId, signal);
                      return resource?.source && resource.brokerPlacement
                        ? {
                            teamId: resource.teamId,
                            source: resource.source,
                            brokerPlacement: resource.brokerPlacement,
                            revision: resource.revision,
                            enabled: resource.enabled,
                          }
                        : null;
                    },
                    withRegistry: withBrokerProviderRegistry,
                    getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
                    collectDnsEvidence: async ({ source, registry, signal }) => {
                      const snapshot = getActiveAccountSettingsSnapshot();
                      if (!snapshot) return new Map();
                      return await collectProviderConnectionDnsEvidence({
                        connectionId: source.connectionId,
                        machineId: registeredMachineId,
                        providerSettings: readProviderSettingsForCli(snapshot).settings,
                        registry,
                        lifetime: createProviderOperationLifetime({
                          signal,
                          wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
                        }),
                      });
                    },
                    openCpxProviderConnection: createProviderConnectionCpxBridge({
                      custody: brokerManagedProviderCustody,
                    }).open,
                    resolveExactSelection: async (request) => await (
                      providerOperationsProducer?.machineServices
                        .resolveTeamCredentialBrokerSourceSelection(request)
                      ?? Promise.resolve(null)
                    ),
                  }),
                });
                const authorizeExternalAuthorization = async (input: Readonly<{
                  binding: Extract<ProviderBrokerRelayApplicationBindingV1, { kind: 'external_api_key' }>;
                  expectedResourceRevision: number;
                  application: ProviderBrokerApplicationBindingV1;
                  signal?: AbortSignal;
                }>) => await api.authorizeTeamCredentialProviderModelCatalog({
                  v: 1,
                  binding: input.binding,
                  brokerMachineId: registeredMachineId,
                  expectedResourceRevision: input.expectedResourceRevision,
                  application: input.application,
                }, input.signal ? { signal: input.signal } : undefined);
                const runtime = await startDaemonProviderBrokerRuntime({
                  machineId: registeredMachineId,
                  ...(managedPolicyHomeId && externalActionAccountId ? {
                    accountConnection: {
                      homeId: managedPolicyHomeId,
                      accountId: externalActionAccountId,
                      retire: async ({ authority }) => await retireAccountConnectionBrokerSource({
                        homeId: managedPolicyHomeId, accountId: externalActionAccountId, machineId: registeredMachineId,
                        custody: brokerManagedProviderCustody, authority,
                      }),
                      open: createAccountConnectionBrokerSourceOpen({
                        homeId: managedPolicyHomeId,
                        accountId: externalActionAccountId,
                        machineId: registeredMachineId,
                        expectedAccountSettingsScopeKey: resolveAccountSettingsScopeKey(credentials),
                        custody: brokerManagedProviderCustody,
                        withRegistry: withBrokerProviderRegistry,
                        getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
                        resolveBindingIntent: connectedAccountPurposeBindingRuntime.resolveBindingIntent,
                        projectModels: async request => {
                          const producer = providerOperationsProducer;
                          if (!producer) throw new Error('provider_source_projection_unavailable');
                          return await producer.machineServices.projectModels(request);
                        },
                        admitConsumer: async (authority, signal) => (await api.admitAccountConnectionProviderBroker({ v: 2, authority }, { signal })).ok,
                      }),
                    },
                  } : {}),
                  resolveTrustRoots: resolvePeerMediationTrustRoots,
                  nowMs: () => Date.now(),
                  createRequestId: randomUUID,
                  sourceOwner,
                  checkRunnerCredentialSelectionCurrentness: async ({ selection, modelId, signal }) => {
                    const resolveEligibility = providerOperationsProducer?.machineServices
                      .resolveTeamCredentialBrokerEligibility;
                    if (!resolveEligibility) return 'update_required';
                    return await resolveRunnerCredentialSelectionCurrentness({
                      registeredMachineId,
                      selection,
                      modelId,
                      signal,
                      readResource,
                      resolveEligibility: async (request, currentnessSignal) =>
                        await resolveEligibility(request, currentnessSignal),
                    });
                  },
                  resolveRequestPolicy: async ({ authority, request }) => {
                    const signal = request.signal ?? new AbortController().signal;
                    const resource = await readResource(authority.resourceId, signal);
                    if (
                      !resource
                      || !resource.enabled
                      || resource.teamId !== authority.teamId
                      || !resource.source
                      || !teamCredentialBrokerPlacementAcceptsMachine(resource.brokerPlacement, registeredMachineId)
                    ) return null;
                    const catalog = await resolveCatalog({
                      resource,
                      application: authority.application,
                      signal,
                    }).catch(() => null);
                    return catalog
                      ? {
                          resourceRevision: resource.revision,
                          sourceRevision: catalog.sourceRevision,
                          application: catalog.application,
                          policy: resource.requestPolicy,
                          source: resource.source,
                          modelCatalog: {
                            models: catalog.rows.map((row) => ({
                              id: row.descriptor.id,
                              ...(row.descriptor.name === undefined ? {} : { name: row.descriptor.name }),
                            })),
                            resolveCanonicalModelId: catalog.resolveCanonicalModelId,
                          },
                        }
                      : null;
                  },
                  admitRequest: async (request) => await api.admitTeamCredentialProviderBrokerRequest({
                    v: 1,
                    authority: request.authority,
                    expectedResourceRevision: request.expectedResourceRevision,
                    sourceMemberKey: request.sourceMemberKey,
                    requestId: request.requestId,
                    requestFacts: request.requestFacts,
                  }, { signal: request.request.signal }),
                  authorizeModelCatalog: async ({ authorization, expectedResourceRevision, request }) => {
                    if (authorization.kind === 'resource_test') {
                      return { ok: false as const, reasonCode: 'resource_unavailable' as const };
                    }
                    return authorization.kind === 'private'
                      ? await api.authorizeTeamCredentialProviderModelCatalog({
                            v: 1,
                            authority: authorization.authority,
                            expectedResourceRevision,
                          }, { signal: request.signal })
                      : await authorizeExternalAuthorization({
                          binding: authorization.binding,
                          expectedResourceRevision,
                          application: authorization.application,
                          ...(request.signal ? { signal: request.signal } : {}),
                        });
                  },
                  resolveExternalRequestPolicy: async ({ binding, request }) => {
                    const signal = request.signal ?? new AbortController().signal;
                    const resource = await readResource(binding.resourceId, signal);
                    const route = classifyTeamCredentialRequestRouteV1(request.pathAndQuery);
                    const source = resource?.source;
                    const protocol = route?.kind === 'openai_responses'
                      ? 'openai-responses'
                      : route?.kind === 'openai_chat_completions'
                        ? 'openai-chat'
                        : route?.kind === 'anthropic_messages' ? 'anthropic' : null;
                    if (
                      !daemonExternalProviderRequestPolicyAcceptsResource({
                        resource,
                        bindingTeamId: binding.teamId,
                        registeredMachineId,
                      })
                      || !source
                    ) return null;
                    const producer = providerOperationsProducer;
                    if (!producer) return null;
                    const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
                      happyHomeDir: configuration.happyHomeDir,
                      controller: pluginReloadController,
                    });
                    let agentTargetKeys: string[];
                    try {
                      agentTargetKeys = [...lease.registry.contributes.agentDefinitionsById.values()]
                        .flatMap((agent) => agent.identity
                          ? [buildBackendTargetKeyV2({ kind: 'agent', identity: agent.identity })]
                          : []);
                    } finally {
                      await lease.release();
                    }
                    const applications = await resolveTeamCredentialResourceCatalogApplications({
                      machineId: registeredMachineId,
                      teamId: resource.teamId,
                      resourceId: resource.id,
                      expectedResourceRevision: resource.revision,
                      source,
                      agentTargetKeys,
                      projectModels: async (projectionRequest) =>
                        await producer.machineServices.projectModels(projectionRequest),
                      signal,
                    }).catch(() => []);
                    if (request.method === 'GET' && request.pathAndQuery === '/v1/models') {
                      const resolvedCatalogs = await Promise.all(applications.map(async (candidate) =>
                        await resolveCatalog({ resource, application: candidate, signal }).catch(() => null)));
                      if (resolvedCatalogs.some((catalog) => catalog === null)) {
                        return { kind: 'denied' as const, reasonCode: 'resource_unavailable' as const };
                      }
                      const catalogs = resolvedCatalogs.filter(
                        (catalog): catalog is TeamCredentialModelCatalogResolver => catalog !== null,
                      );
                      const catalog = createTeamCredentialExternalModelCatalog(catalogs);
                      return catalog
                        ? {
                            kind: 'model_catalog' as const,
                            resourceRevision: resource.revision,
                            policy: resource.requestPolicy,
                            applications: catalog.applications,
                            modelCatalog: {
                              models: catalog.models,
                              resolveCanonicalModelId: catalog.resolveCanonicalModelId,
                            },
                          }
                        : null;
                    }
                    if (!protocol) return { kind: 'denied' as const, reasonCode: 'route_not_allowed' as const };
                    const protocolApplications = applications.filter((candidate) => candidate.protocol === protocol);
                    if (protocolApplications.length === 0) {
                      return { kind: 'denied' as const, reasonCode: 'route_not_allowed' as const };
                    }
                    const policy = resource.requestPolicy ?? {
                      allowedProtocolKinds: null,
                      allowedModelIds: null,
                      reasoningEffort: null,
                    };
                    const evaluatedCatalogs: TeamCredentialModelCatalogResolver[] = [];
                    let firstFailure: Extract<
                      ReturnType<typeof evaluateTeamCredentialRequestPolicyV1>,
                      { ok: false }
                    > | null = null;
                    for (const application of protocolApplications) {
                      const catalog = await resolveCatalog({ resource, application, signal }).catch(() => null);
                      if (!catalog) {
                        return { kind: 'denied' as const, reasonCode: 'resource_unavailable' as const };
                      }
                      const evaluated = evaluateTeamCredentialRequestPolicyV1({
                        policy,
                        request,
                        resolveCanonicalModelId: catalog.resolveCanonicalModelId,
                      });
                      if (evaluated.ok) evaluatedCatalogs.push(catalog);
                      else if (!firstFailure) firstFailure = evaluated;
                    }
                    if (evaluatedCatalogs.length === 0) {
                      return {
                        kind: 'denied' as const,
                        reasonCode: firstFailure?.reasonCode ?? 'resource_unavailable' as const,
                      };
                    }
                    if (evaluatedCatalogs.length !== 1) {
                      return { kind: 'denied' as const, reasonCode: 'route_not_allowed' as const };
                    }
                    const catalog = evaluatedCatalogs[0]!;
                    return {
                          kind: 'application' as const,
                          resourceRevision: resource.revision,
                          policy: resource.requestPolicy,
                          application: catalog.application,
                          modelCatalog: {
                            models: catalog.rows.map((row) => ({
                              id: row.descriptor.id,
                              ...(row.descriptor.name === undefined ? {} : { name: row.descriptor.name }),
                            })),
                            resolveCanonicalModelId: catalog.resolveCanonicalModelId,
                          },
                        };
                  },
                  admitExternalRequest: async (request) => await api.admitTeamCredentialExternalProviderRequest({
                    v: 1,
                    binding: request.binding,
                    brokerMachineId: registeredMachineId,
                    expectedResourceRevision: request.expectedResourceRevision,
                    application: request.application,
                    requestFacts: request.requestFacts,
                  }, { signal: request.request.signal }),
                  revalidateExternalAuthorization: async (request) => (
                    revalidateExternalProviderBrokerAuthorization(
                      await authorizeExternalAuthorization(request),
                    )
                  ),
                  retireExternalApiKey: async ({ externalApiKeyId, operationId, application }) =>
                    await brokerManagedProviderCustody.retireExternalApiKey({
                      identity: application.implementationIdentity,
                      externalApiKeyId,
                      operationId,
                    }),
                  retireExternalOperation: async ({ externalApiKeyId, operationId, brokerMachineId }) => {
                    if (brokerMachineId !== registeredMachineId) throw new Error('Broker Machine changed');
                    await brokerApiMachine.retireTeamCredentialExternalProviderOperation({ externalApiKeyId, operationId });
                  },
                  recordExternalTerminalUsage: async (request) =>
                    await api.recordTeamCredentialExternalProviderTerminalUsage(request),
                  resolveResourceTestRequestPolicy: async ({ binding, request }) => {
                    const signal = request.signal ?? new AbortController().signal;
                    const resource = await readResource(binding.resourceId, signal);
                    if (
                      !resource
                      || !resource.enabled
                      || resource.teamId !== binding.teamId
                      || resource.revision !== binding.expectedResourceRevision
                      || !resource.source
                      || !pluginJsonValuesEqual(resource.source, binding.source)
                      || !teamCredentialBrokerPlacementAcceptsMachine(resource.brokerPlacement, registeredMachineId)
                    ) return null;
                    const catalog = await resolveCatalog({
                      resource,
                      application: binding.application,
                      signal,
                    }).catch(() => null);
                    return catalog
                      ? {
                          resourceRevision: resource.revision,
                          policy: resource.requestPolicy,
                          application: binding.application,
                          modelCatalog: {
                            models: catalog.rows.map((row) => ({
                              id: row.descriptor.id,
                              ...(row.descriptor.name === undefined ? {} : { name: row.descriptor.name }),
                            })),
                            resolveCanonicalModelId: catalog.resolveCanonicalModelId,
                          },
                        }
                      : null;
                  },
                  admitResourceTestRequest: async (request) => await api.admitTeamCredentialResourceTestRequest({
                    v: 1,
                    binding: request.binding,
                    brokerMachineId: registeredMachineId,
                    relayAuthorization: request.relayAuthorization,
                    requestFacts: request.requestFacts,
                  }, { signal: request.request.signal }),
                });
                let current = true;
                const revalidateRetainedClaims = async (
                  invalidation: Readonly<{ signal: AbortSignal }>,
                ): Promise<void> => {
                  if (!current) return;
                  await brokerManagedProviderCustody.revalidateRetainedClaims(
                    invalidation.signal,
                  );
                };
                const retireAllClaims = async (): Promise<void> => {
                  if (!current) return;
                  await brokerManagedProviderCustody.retireAll();
                };
                const unsubscribeCurrentness =
                  brokerApiMachine.onManagedProviderRetainedCurrentnessInvalidation(
                    revalidateRetainedClaims,
                  );
                retireProviderBrokerClaimsForFeatureDisable = retireAllClaims;
                return Object.freeze({
                  ...runtime,
                  async close() {
                    if (!current) return;
                    current = false;
                    unsubscribeCurrentness();
                    if (retireProviderBrokerClaimsForFeatureDisable === retireAllClaims) {
                      retireProviderBrokerClaimsForFeatureDisable = null;
                    }
                    try {
                      await runtime.close();
                    } finally {
                      await brokerManagedProviderCustody.retireAll();
                    }
                  },
                });
              },
            }
          : {}),
        createWorkspaceSyncRuntime: async ({
          machineId: registeredMachineId,
          onReadinessPublished,
          onStatusPublished,
        }) => {
          return await workspaceSyncRuntimeCustody.acquire(registeredMachineId, async () => {
            const finiteServerId = configuration.activeServerId;
            const finiteServerHttpBaseUrl = resolveServerHttpBaseUrl();
            const isCurrent = async () => !admissionDrain.isFinalShutdown()
              && configuration.activeServerId === finiteServerId
              && sameStoredCredentials(credentials, await readStoredCredentialsForServerId(finiteServerId).catch(() => null));
            const policyClient = await createAccountServerMachineFinitePolicyClient({
              machineId: registeredMachineId, credentials, serverHttpBaseUrl: resolveServerHttpBaseUrl(),
              isCredentialCurrent: async () => !admissionDrain.isFinalShutdown(),
            });
            const admission = createProjectWorkerAdmission({ machineId: registeredMachineId,
              readPolicy: policyClient.get, admissionDrain });
            projectWorkerAdmission = admission;
            const openMachineCarrierTunnel = machineIrohRuntime && externalActionAccountId
              ? createWorkspaceMachineCarrierTunnelOpen({
                accountId: externalActionAccountId,
                localMachineId: registeredMachineId,
                runtime: machineIrohRuntime,
                resolveTrustRoots: resolvePeerMediationTrustRoots,
                readTargetMachine: async (targetMachineId, signal) => await api.getMachine(targetMachineId, { signal }),
                mintGrant: async (request, signal) => await api.mintPeerMediationRouteGrant(request, { signal }),
              })
              : undefined;
            const runtime = await createProductionDaemonWorkspaceSyncRuntime({
              homeTarget,
              happyHomeDir: configuration.happyHomeDir,
              activeServerDir: configuration.activeServerDir,
              activeServerId: configuration.activeServerId,
              localMachineId: registeredMachineId,
              releaseChannel: configuration.publicReleaseRing,
              credentials,
              isCurrent,
              callWorkspaceTargetPhase: async (descriptor, ingress) => {
                const client = apiMachineForSessions;
                const custodianCredentials = await readStoredCredentialsForServerId(finiteServerId).catch(() => null);
                if (!client || !custodianCredentials) throw Object.assign(new Error('Workspace target authority is unavailable'), { code: 'peer_unavailable' });
                return await client.callWorkspaceSyncTargetPhase({ ...descriptor, credentials: custodianCredentials,
                  context: buildActionExecutorContextForRpc({ ...ingress, serverId: finiteServerId }) });
              },
              callWorkspaceSeedExport: async (descriptor, ingress) => {
                const client = apiMachineForSessions;
                const custodianCredentials = await readStoredCredentialsForServerId(finiteServerId).catch(() => null);
                if (!client || !custodianCredentials) throw Object.assign(new Error('Workspace seed authority is unavailable'), { code: 'peer_unavailable' });
                return await client.callWorkspaceSyncSeedExport({ ...descriptor, credentials: custodianCredentials,
                  context: buildActionExecutorContextForRpc({ ...ingress, serverId: finiteServerId }) });
              },
              readProjectWorkerDependencies: (workspaceRefId, relationshipId) => admission.dependencies({ workspaceRefId,
                ...(relationshipId ? { relationshipId } : {}) }),
              onReadinessPublished,
              onStatusPublished,
              ...(openMachineCarrierTunnel ? { openMachineCarrierTunnel } : {}),
              ...(directPeerServerLifecycle
                ? { requestDirectTransferPayloadFile: directPeerServerLifecycle.requestPayloadFile }
                : {}),
            });
            projectWorkerAction = createProjectWorkerAction({ machineId: registeredMachineId,
              serverId: configuration.activeServerId, serverHttpBaseUrl: resolveServerHttpBaseUrl(),
              credentials, ...(externalActionAccountId ? { accountId: externalActionAccountId } : {}),
              admission, workspaceSync: runtime.workspaceSync,
              isFiniteExecutionLive: () => apiMachineForSessions?.isProjectFiniteExecutionLive() === true,
              isServiceExecutionLive: () => isProjectServiceExecutionLive?.() === true });
            const createProjectFiniteRuntime: NonNullable<ApiMachineClientLifecycleDependencies['createProjectFiniteRuntime']> = async (ports, ingress) => {
              if (!externalActionAccountId || !await isCurrent()) return null;
              const installationId = readInstallationIdentityIfExistsSync()?.installationId;
              const requester = ingress.callerInputAuthorization && installationId
                ? await resolveAdmittedRequesterAccountReadRuntime({ ingress, serverId: finiteServerId,
                  machineId: registeredMachineId, installationId, isInstalledCurrent: isCurrent }) : null;
              if (ingress.callerInputAuthorization && !requester || !requester && readProjectFiniteIngressRefusal(ingress)) return null;
              const currentCredentials = requester ? null : await readStoredCredentialsForServerId(finiteServerId).catch(() => null);
              if (!requester && (!currentCredentials || !sameStoredCredentials(credentials, currentCredentials)) || !await isCurrent()) return null;
              const runtimeCurrent = requester?.isCurrent ?? isCurrent;
              const requesterContext = requester ? readRequesterAccountActionContext(requester.accountAuthorization) : null;
              const io = createProjectNativeIo();
              const accountAccess = requester ?? (currentCredentials ? { serverId: finiteServerId, machineId: registeredMachineId,
                accountId: externalActionAccountId, credentials: currentCredentials, serverHttpBaseUrl: finiteServerHttpBaseUrl } : null);
              if (!accountAccess) return null;
              return { ...ports, ...accountAccess, workerAdmission: admission, isCurrent: runtimeCurrent,
                nativeIo: io.commandIo, environmentIo: io.environmentIo,
                plugins: { async resolveProjectNativeAdapter(reference, role) {
                  if (!await runtimeCurrent()) return { kind: 'refused', code: 'native_adapter_retired' };
                  const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
                    happyHomeDir: configuration.happyHomeDir, controller: pluginReloadController,
                  });
                  try {
                    const selected = await lease.registry.resolveProjectNativeAdapter(reference, role);
                    return await runtimeCurrent() ? selected : { kind: 'refused', code: 'native_adapter_retired' };
                  } finally { await lease.release(); }
                } },
                successHomeDir: configuration.happyHomeDir,
                ...(currentCredentials ? { inspectSourceProjectManifest: createProjectFiniteSourceManifestInspector({ api,
                  credentials: currentCredentials, serverId: finiteServerId, serverHttpBaseUrl: finiteServerHttpBaseUrl,
                  accountId: externalActionAccountId, ingress, isCurrent }),
                  ...createWorkspaceSyncWorkerPreparation({ serverId: finiteServerId,
                  serverHttpBaseUrl: finiteServerHttpBaseUrl, targetMachineId: registeredMachineId,
                  credentials: currentCredentials, isCurrent,
                  prepareBetween: (request, signal) => runtime.handoffAdapter.prepareBetween(request, signal) }) } : {}),
                resolveWorkspaceExecutionConfig: async (context, currentIngress, actionId) => {
                  const preferenceCredentials = requesterContext?.credentials ?? currentCredentials;
                  if (!preferenceCredentials || !await runtimeCurrent()) return null;
                  const origin = await resolveCurrentMachineExecutionOriginContext(currentIngress.signal);
                  if (!origin || origin.machineId !== registeredMachineId || !await isCurrent()) return null;
                  const authorization = currentIngress.callerInputAuthorization;
                  const requestContext = { ...context, ...(authorization ? {
                    externalActionExecutionAuthorization: authorization,
                    externalActionTarget: authorization.binding.target,
                  } : {}) };
                  const installation = readInstallationIdentityIfExistsSync();
                  return await createAccountServerWorkspaceWorkerPreferenceClient({
                    token: preferenceCredentials.token, credentials: preferenceCredentials,
                    serverHttpBaseUrl: accountAccess.serverHttpBaseUrl, signal: currentIngress.signal,
                    context: requestContext, actionId, isCredentialCurrent: runtimeCurrent,
                    ...(requesterContext ? { operationContext: requesterContext.savedSecretOperationContext } : {}),
                    resolveRequestHeaders: async request => {
                      if (requester) return await requester.accountAuthorization.requesterHttpProjection!.createRequestHeaders({
                        effectActionId: request.effectActionId, method: request.method, path: request.path,
                        ...(request.body === undefined ? {} : { body: request.body }), signal: currentIngress.signal,
                      });
                      const result = resolveExternalActionServerRequestHeaders({ ...request,
                        daemonToken: preferenceCredentials.token, serverIdentityId: origin.serverIdentityId,
                        ...(installation ? { privateKey: installation.privateKey, installationId: installation.installationId } : {}),
                      });
                      return result.ok ? result.headers : null;
                    },
                  });
                },
              };
            };
            const readProjectFiniteLoad: NonNullable<ApiMachineClientLifecycleDependencies['readProjectFiniteLoad']> = async () => {
              const live = () => projectWorkerAdmission === admission
                && apiMachineForSessions?.isProjectFiniteExecutionLive() === true;
              if (!live() || !await isCurrent()) return { kind: 'unknown' };
              const { load } = await admission.observeFiniteEligibility();
              return live() && await isCurrent() ? load : { kind: 'unknown' };
            };
            return { ...runtime, createProjectFiniteRuntime, readProjectFiniteLoad };
          });
        },
        onMachineMetadataChanged: () => projectWorkerAdmission?.notifyChanged(),
        onProjectOperationInspection: () => projectWorkerAdmission?.notifyChanged(),
        runtimeId,
        publicReleaseChannel,
        startupSource,
        serviceLabel,
        transferRuntimeStatePublisher,
        spawnSession,
        stopSession,
        sessionRunnerStatus,
        awaitAgentSessionOpen,
        installExternalSessionHostOperations,
        isSessionAlreadyRunning,
        loadLocalSessionMetadataForHandoff,
        resolveHostedSessionWorkingDirectory,
        beforeShutdown,
        requestShutdown,
        directPeerServerLifecycle,
        ...(machineIrohRuntime ? { machineIrohRuntime } : {}),
        prepareServerTransportForReconnect: async () => (
          homeIrohTransport
            ? await homeIrohTransport.reacquire()
            : { status: 'ready' as const }
        ),
        acquireWorkspaceSyncMachineIngress: async (input) => {
          const runtime = workspaceSyncRuntimeCustody.get();
          if (!runtime) throw new Error('Workspace sync runtime is not ready');
          return await runtime.acquireWorkspaceSyncMachineIngress(input);
        },
        directTransferPromptAssetAdapterRegistry,
        directTransferPromptRegistryRegistry,
        daemonServerWorkScheduler,
        cancelConnectedServiceRuntimeAuthRecovery,
        retryTemporaryThrottleNow,
        readTemporaryThrottleRecovery,
        cancelTemporaryThrottleRecovery,
        liveStreamCaptureRegistry,
        readActiveLiveStreamControlLease: (input) => simulatorInputLeaseManager.read(input),
        peerMediationObservabilityEmitter: peerMediationObservabilityRuntime.emitter,
        setDaemonServerWorkOnline: runtimeBootstrap.setDaemonServerWorkOnline,
        onMachineConnectionOnline: async () => {
          await reconcileSessionMachineAccessBindings();
          await refreshServerFeaturesAndBrowserRouteOwners();
          pluginRuntimeOwner.reportCurrentAvailability();
          await connectedServiceQuotasCoordinator?.flushInBandQuotaPersistence(0);
          await flushProviderAccountUsagePersistence(0);
        },
        reconcileConnectedServicesProjection: reconcileConnectedServicesProjectionForPluginConsumers,
        subscribeConnectedAccountInvalidations:
          connectedAccountPurposeBindingRuntime.subscribeInvalidations,
        isShuttingDown: isDaemonQuiescing,
        admissionDrain,
        managedActivity: { activity: managedActivity, admissionDrain },
        isPublicationQuiescing: admissionDrain.isPublicationQuiescing,
        getServerFeaturesSnapshot: () => serverFeaturesSnapshotStore.getSnapshot(),
        resolvePeerMediationTrustRoots,
        refreshServerFeaturesSnapshot: () => serverFeaturesSnapshotStore.refresh(),
        readLocalServiceInventorySnapshot: async () => localServiceInventoryRoutes?.getSnapshot() ?? null,
        localServiceSummary,
        acquireLocalServicePreviewApplication,
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
          automationActivity.notifyChanged();
        },
        ...(workflowRuntime
          ? {
              isWorkflowFeatureEnabled: () => isWorkflowRuntimeEnabled(
                process.env,
                serverFeaturesSnapshotStore.getSnapshot(),
              ),
              createWorkflowRunCoordinatorForMachine: (input) =>
                workflowRuntime.createCoordinatorForMachine({ ...input, managedMachineAction: managedMachinePolicyAdapter }),
              createWorkflowRecoveryForMachine: (input) =>
                workflowRuntime.createRecoveryForMachine(input),
            }
          : {}),
        prepareApiMachineForSessions:
          machineRpcRouteAttachments.prepareApiMachineForSessions,
        persistedTakeoverAdmissionWaiter,
        attachPersistedTakeoverAdmissionOwner,
        ...(externalActionIngressOwner
          ? { externalActionIngressOwner }
          : {}),
      }),
      onMachineSyncRuntime: async (machineSyncRuntime) => {
        cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop =
          machineSyncRuntime.cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop;
        let didCompleteMachineSyncStartup = false;
        let machineSyncStartupInFlight: Promise<void> | null = null;
        const completeMachineSyncStartup = async (): Promise<void> => {
          if (admissionDrain.isPublicationQuiescing() || didCompleteMachineSyncStartup) return;
          if (machineSyncStartupInFlight) {
            try {
              await machineSyncStartupInFlight;
            } catch {
              // The original caller owns the failure. A concurrent resume retries
              // only while this daemon is still current and no completed result exists.
            }
            if (!admissionDrain.isPublicationQuiescing() && !didCompleteMachineSyncStartup) {
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
                isShuttingDown: admissionDrain.isPublicationQuiescing,
              });
              if (admissionDrain.isPublicationQuiescing()) return;

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
                  isShuttingDown: admissionDrain.isPublicationQuiescing,
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
              if (admissionDrain.isPublicationQuiescing()) return;

              await publishOrphanedStartupSessionEnds({
                apiMachine: machineSyncRuntime.apiMachine,
                orphanedDeadDaemonSessions,
                isShuttingDown: admissionDrain.isPublicationQuiescing,
              });
              if (admissionDrain.isPublicationQuiescing()) return;
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
        const attemptedExternalSessionHostActionExecutor =
          machineSyncRuntime.externalSessionHostActionExecutor ?? null;
        const attemptedSessionSpawnDirectTargetTransport =
          machineSyncRuntime.sessionSpawnDirectTargetTransport ?? null;
        let attemptedManagedMachinePolicyRuntime: ReturnType<typeof createDaemonManagedMachinePolicyRuntime> | null = null;
        try {
          await managedMachinePolicyRuntime?.stop();
          managedMachinePolicyRuntime = null;
          apiMachine = attemptedApiMachine;
          if (homeTransportReplacementPending && attemptedApiMachine) {
            homeTransportReplacementPending = !attemptedApiMachine.requestServerTransportReconnect();
          }
          apiMachineForSessions = attemptedApiMachineForSessions;
          machineActivity.notifyChanged();
          syncActivity.notifyChanged();
          sessionLiveWorkProducer.notifyChanged();
          await reconcileSessionMachineAccessBindings();
          providerOperationsProducer = attemptedProviderOperationsProducer;
          externalSessionPluginAdmissionOwner =
            attemptedExternalSessionPluginAdmissionOwner;
          externalSessionHostActionExecutor =
            attemptedExternalSessionHostActionExecutor;
          sessionSpawnDirectTargetTransport =
            attemptedSessionSpawnDirectTargetTransport;
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
          // Direct-material preparation is woken by the relevant AccountChange
          // (grant, recipient, Team and connected-service changes) and by every
          // reconnect, whose census reconstructs missing work (teams-lane-10 06 §11).
          teamCredentialDirectMaterialAccountChangeCleanup?.();
          teamCredentialDirectMaterialAccountChangeCleanup = attemptedApiMachine
            ? attemptedApiMachine.onManagedProviderRetainedCurrentnessInvalidation(
                () => reconcileTeamCredentialDirectMaterialAfterSourceChange(),
              )
            : null;
          pluginWebhookWakeCleanup?.();
          pluginWebhookWakeCleanup = attemptedApiMachine
            ? attachPluginWebhookDaemonWakeV1({
                apiMachine: attemptedApiMachine,
                getWorker: () => pluginWebhookWorker,
              })
            : null;
          machineRpcRouteAttachments.attachApiMachineForSessions(apiMachineForSessions);
          if (attemptedApiMachineForSessions) {
            attemptedApiMachineForSessions.registerManagedFiniteWake({
              readCurrent: async (managedId, signal) => (await readCurrentManagedMachinePolicies(signal)).machines.find(machine => machine.id === managedId) ?? null,
              executePolicy: managedMachinePolicyAdapter.executePolicy,
            });
            attemptedManagedMachinePolicyRuntime = createDaemonManagedMachinePolicyRuntime({
              apiMachine: attemptedApiMachineForSessions,
              readCensus: readCurrentManagedMachinePolicies,
              executePolicy: managedMachinePolicyAdapter.executePolicy,
              onUnavailable: error => logger.debug('[DAEMON RUN] Managed policy execution unavailable', error),
            });
            managedMachinePolicyRuntime = attemptedManagedMachinePolicyRuntime;
          }
          automationWorker = machineSyncRuntime.automationWorker;
          memoryWorker = machineSyncRuntime.memoryWorker;
          voiceInferenceWorker = machineSyncRuntime.voiceInferenceWorker;
          daemonConnectivityCoordinator = machineSyncRuntime.daemonConnectivityCoordinator;
          machineConnectionStateCleanup = machineSyncRuntime.machineConnectionStateCleanup;
          stopPeerMediationLoopbackServer = machineSyncRuntime.stopPeerMediationLoopbackServer;
          stopMachineIrohAcceptor = machineSyncRuntime.stopMachineIrohAcceptor;
          resumeQuiescedMachineConnectionPublications =
            machineSyncRuntime.resumeMachineConnectionPublications;
        } catch (error) {
          await attemptedManagedMachinePolicyRuntime?.stop();
          if (managedMachinePolicyRuntime === attemptedManagedMachinePolicyRuntime) managedMachinePolicyRuntime = null;
          if (apiMachine === attemptedApiMachine) apiMachine = null;
          if (apiMachineForSessions === attemptedApiMachineForSessions) {
            apiMachineForSessions = null;
            machineActivity.notifyChanged();
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
          if (
            externalSessionHostActionExecutor
            === attemptedExternalSessionHostActionExecutor
          ) {
            externalSessionHostActionExecutor = null;
          }
          if (
            sessionSpawnDirectTargetTransport
            === attemptedSessionSpawnDirectTargetTransport
          ) {
            sessionSpawnDirectTargetTransport = null;
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
    // Startup reconciliation has populated the existing tracked census.
    // Reattached Sessions may still hold the previous daemon's catalog.
    publishSessionPluginCatalogInvalidation(pluginRegistryProjectionInvalidation.readRevision());

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
      onTrackedSessionHealthy,
      controlPort,
      fileState,
      currentCliVersion: configuration.currentCliVersion,
      requestShutdown,
      isShuttingDown: admissionDrain.isPublicationQuiescing,
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
        admissionDrain.beginShutdown();
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
        connectedAccountDaemonRuntime.dispose();
        await daemonSessionMutationCustody.close();
      },
      machineConnectionStateCleanup,
      automationWorker,
      memoryWorker,
      voiceInferenceWorker,
      trackedSessionCount: pidToTrackedSession.size,
      stopDirectPeerServer: async () => {
        await cleanupDaemonHomeMachineWorkspace({
          stopWorkspaceSync: stopWorkspaceSyncRuntime,
          stopMachineAcceptor: stopMachineIrohAcceptor,
          stopPeerMediation: stopPeerMediationLoopbackServer,
          stopDirectPeer: stopDirectPeerServer,
          releaseHomeTransport: async () => await homeIrohTransport?.release(),
          shutdownMachineIroh: async () => await machineIrohRuntime?.shutdown(),
          cleanupFailedIrohStartup: async () => await preparedIrohState.failedStartupCleanup?.(),
        });
      },
      stopTailscaleTransferServeLifecycle,
      stopSshTunnelsOnShutdown: sshTunnelSupervisor.stopAllTunnels,
      stopControlServer,
      daemonStateOwner: fileState,
      daemonLockHandle,
      releaseDaemonLock,
    });
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
    releaseMachineAdmissionTransport();
  } catch (error) {
    await getDaemonAgentInstallJobOwner().shutdown().catch(() => {
      logger.debug('[DAEMON RUN] Agent installer process cleanup could not be verified during shutdown');
    });
    await cleanupDaemonHomeMachineWorkspace({
      stopWorkspaceSync: stopWorkspaceSyncRuntime,
      stopMachineAcceptor: stopMachineIrohAcceptor,
      stopPeerMediation: async () => undefined,
      stopDirectPeer: async () => undefined,
      releaseHomeTransport: async () => await (homeIrohTransport ?? preparedIrohState.home)?.release(),
      shutdownMachineIroh: async () => await (machineIrohRuntime ?? preparedIrohState.machine)?.shutdown(),
      cleanupFailedIrohStartup: async () => await preparedIrohState.failedStartupCleanup?.(),
    }).catch(() => undefined);
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
