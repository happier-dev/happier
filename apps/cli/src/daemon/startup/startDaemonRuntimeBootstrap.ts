import type { TargetSecretSourcesV1 } from '@/plugins/runtime/lifecycle/contributions/targetSecretSources';
import type { ProviderAccountUsageUsageIdentityResolver } from '../connectedServices/accountUsage/hydration';
import type { RequesterConnectedAccountObservation } from '@/api/client/accountEncryptionCurrentnessObservation';
import { readQualifiedConnectedAccountCredentialIdentity, readQualifiedConnectedAccountCredentialMaterial } from '../connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { ApiClient } from '@/api/api';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCredentialedAccountArtifactStore, type ArtifactQueryHintBackfillResult, type ArtifactQueryHintFeatures } from '@/api/artifacts/accountArtifactStore';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { LiveWorkProducerV1 } from '../lifecycle/managedActivity';
import type { DaemonAdmissionDrain } from '../lifecycle/admissionDrain';
import {
  acquireQualifiedConnectedAccountRefreshLeaseV4,
  listQualifiedConnectedAccountsV4,
  listQualifiedConnectedAccountGroupsV4,
  mutateQualifiedConnectedAccountCredentialV4,
  mutateQualifiedConnectedAccountCredentialHealthV4,
  readQualifiedConnectedAccountGroupV4,
  readQualifiedConnectedAccountQuotaV4,
  readQualifiedConnectedAccountCredentialV4,
  readQualifiedProviderAccountUsageRecordV4,
  resolveQualifiedProviderAccountUsageSourceV4,
  updateQualifiedConnectedAccountGroupRuntimeStateV4,
  writeQualifiedProviderAccountUsageV4,
  type QualifiedConnectedAccountPeerClass,
  type QualifiedConnectedAccountPeerOperationTransport,
} from '@/api/client/qualifiedConnectedAccountApi';
import type { DaemonState } from '@/api/types';
import {
  createDirectTransferServerLifecycle,
  type DirectTransferServerLifecycle,
} from '@/machines/transfer/directTransferServerLifecycle';
import { createTailscaleTransferServeLifecycle } from '@/machines/transfer/tailscaleTransferServeLifecycle';
import { resolveMachineTransferRuntimeConfig } from '@/machines/transfer/transferRuntimeConfig';
import { createDaemonTransferRuntimeState, createDaemonTransferRuntimeStatePublisher } from '../transferRuntimeState';
import { resolveTailscaleTransferListenerState } from '../resolveTailscaleTransferListenerState';
import { resolveRunningCliRuntimeIdentity } from '@/packagedRuntime/resolveRunningCliRuntimeIdentity';
import { resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey } from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import {
  createActiveDaemonComposerMediaStageStore,
  runActiveDaemonComposerMediaStageStartupMaintenance,
} from '@/transfers/staging/composerMediaStageStore';
import { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import type {
  QualifiedConnectedAccountEstablishedRuntimeOwner,
} from '../connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import type {
  QualifiedConnectedAccountV4Support,
} from '../connectedServices/qualifiedConnectedAccountV4Support';
import { startConnectedServiceRefreshLoop } from '../connectedServices/refresh/startConnectedServiceRefreshLoop';
import { dispatchConnectedServiceCredentialHealthNotificationAsync } from '../connectedServices/notifications/dispatchConnectedServiceCredentialHealthNotification';
import { dispatchConnectedServiceAutomaticQuotaResetNotificationAsync, dispatchConnectedServiceQuotaLifecycleNotificationAsync } from '../connectedServices/notifications/dispatchConnectedServiceQuotaLifecycleNotification';
import {
  ConnectedServiceQuotasCoordinator,
  type ConsumeCommittedAuthGroupGeneration,
} from '../connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { commitConnectedServiceQuotaLifecycleSessionEvents } from '../connectedServices/quotas/commitConnectedServiceQuotaLifecycleSessionEvents';
import type { DaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { createConnectedServiceQuotaFetchers } from '../connectedServices/quotas/createConnectedServiceQuotaFetchers';
import type { ConnectedServiceQuotaFetcherDescriptor } from '../connectedServices/quotas/types';
import { resolveConnectedServiceQuotasDaemonOptions } from '../connectedServices/quotas/resolveConnectedServiceQuotasDaemonOptions';
import { resolveConnectedServicesQuotasDaemonEnabled } from '../connectedServices/quotas/resolveConnectedServicesQuotasDaemonEnabled';
import { startConnectedServiceQuotasLoop } from '../connectedServices/quotas/startConnectedServiceQuotasLoop';
import { createConnectedServiceRuntimeIdentityFanoutReader } from '../connectedServices/quotas/identity/readConnectedServiceRuntimeIdentityForQuotaFanout';
import {
  resolveConnectedServiceCredentialResolutions,
} from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import { computeConnectedServiceAccessTokenFingerprint } from '../connectedServices/refresh/credentialFreshness/tokenFingerprint';
import { readConnectedServiceCredentialProviderAccountId } from '../connectedServices/shared/connectedServiceCredentialRecord';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { resolveConnectedServiceRefreshSessionIds } from './connectedServiceRefreshSessionNotifications';
import type { startDaemonSessionControlRuntime } from './startDaemonSessionControlRuntime';
import type { StopSessionResult } from '../sessions/stopSessionContract';
import { resolveConnectedServicesMaterializationBaseDir } from '../connectedServices/materialize/resolveConnectedServicesMaterializationBaseDir';
import type { ProviderAccountUsageStore } from '../connectedServices/accountUsage/store';
import { hydrateProviderAccountUsageStoreFromConnectedServiceInventory } from '../connectedServices/accountUsage/currentSourceHydration';
import { activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration } from '../connectedServices/accountUsage/startupActivation';
import {
  createDaemonServerWorkBudget,
  createDaemonServerWorkScheduler,
  type DaemonServerWorkScheduler,
} from '../serverWork';
import { parseBooleanEnv } from '@happier-dev/protocol/env/parseBooleanEnv';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { BuiltInLegacyConnectedAccountOperation, ConnectedServiceExecutionAuthorityV1, ConnectedServiceId, QualifiedConnectedAccountProfileV4, QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import type {
  AgentSpawnQualifiedPurposeBindingSnapshot,
} from '../connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { resolveStackDebugDirectPeerStartServer } from './resolveStackDebugDirectPeerStartServer';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { getActiveAccountSettingsSnapshot, subscribeActiveAccountSettingsKeys } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { warmActiveAccountSettingsSnapshotBestEffort } from '@/settings/accountSettings/warmActiveAccountSettingsSnapshot';
import { getSessionNotificationTitle } from '@/agent/runtime/notifications/sessionNotificationContext';
import type { CatalogAgentId } from '@/agent/catalog/types';

import type { DaemonLocallyPersistedState, StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import type { DaemonStartupSource } from '../ownership/daemonOwnershipMetadata';
import { isDaemonStartupSourceServiceManaged } from '../ownership/daemonOwnershipMetadata';
import type { TrackedSession } from '../types';
import { createResolveHostedSessionWorkingDirectory } from '../sessions/createLoadLocalSessionMetadataForHandoff';
import { startPublicProfileRefresh } from '../account/publicProfileRefresh';
import { sanitizeConnectedServiceDiagnosticError } from '../connectedServices/runtimeAuth/sanitizeConnectedServiceDiagnosticString';
import type { SingleFlightIntervalLoopHandle } from '../lifecycle/singleFlightIntervalLoop';

/** Retained daemon logs carry redacted summaries, never the raw tick error (its message and response can hold credentials and local paths). */
function summarizeConnectedServiceTickError(error: unknown): Readonly<{ error: string; causes?: readonly string[] }> {
  return {
    error: sanitizeConnectedServiceDiagnosticError(error),
    ...(error instanceof AggregateError ? { causes: error.errors.map(cause => sanitizeConnectedServiceDiagnosticError(cause)) } : {}),
  };
}

type LoggerLike = Readonly<{
  debug: (message: string, details?: unknown) => void;
  info: (message: string, details?: unknown) => void;
  warn: (message: string, error?: unknown) => void;
}>;

type ConnectedServiceRefreshLoopHandle = ReturnType<typeof startConnectedServiceRefreshLoop>;
type ConnectedServiceQuotasLoopHandle = ReturnType<typeof startConnectedServiceQuotasLoop>;

function resolvePositiveIntEnv(raw: string | undefined, fallback: number, bounds: { min: number; max: number }): number {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

function resolveTrackedSessionNotificationTitle(tracked: TrackedSession | null | undefined): string | null {
  return getSessionNotificationTitle(() => tracked?.happySessionMetadataFromLocalWebhook ?? null);
}

export type StartDaemonRuntimeBootstrapParams = Readonly<{
  secretSources?: TargetSecretSourcesV1;
  artifactQueryHints?: Readonly<{ signal: AbortSignal; isCurrent(): Promise<boolean>; resolveServerFeaturesSnapshot: ArtifactQueryHintFeatures }>;
  publicProfileRefresh?: Omit<Parameters<typeof startPublicProfileRefresh>[0], 'scheduler'>;
  api: ApiClient;
  credentials: StoredCredentials;
  daemonSessionMutationCustody?: Pick<DaemonSessionMutationCustody, 'stageTranscriptEvent'>;
  logger: LoggerLike;
  processEnv: NodeJS.ProcessEnv;
  controlPort: number;
  machineId: string;
  machineIdProvider: () => string;
  runtimeId: string;
  cliVersion: string;
  startupSource: DaemonStartupSource;
  serviceLabel: string | undefined;
  daemonLogPath: string;
  controlToken: string;
  publishDaemonState: (state: DaemonLocallyPersistedState) => boolean;
  happyHomeDir: string;
  activeServerDir: string;
  filesystemAccessPolicy: FilesystemAccessPolicy;
  publicReleaseChannel: NonNullable<DaemonState['publicReleaseChannel']>;
  isDaemonQuiescing?: () => boolean;
  admissionDrain?: DaemonAdmissionDrain;
  connectedServicesRestartRequestedPids: Set<number>;
  pidToTrackedSession: Map<number, TrackedSession>;
  qualifiedConnectedAccountEstablishedRuntimeOwner?: Pick<
    QualifiedConnectedAccountEstablishedRuntimeOwner,
    'invokeWithReceipt' | 'invokeScheduledWithReceipts' | 'readQuotaSourceSnapshot'
  >;
  resolveQualifiedConnectedAccountV4Support?: () =>
    QualifiedConnectedAccountV4Support;
  resolveQualifiedConnectedAccountPeerClass?: () =>
    QualifiedConnectedAccountPeerClass;
  resolveQualifiedConnectedAccountPeerOperationTransport?: (
    input: Readonly<{
      service: QualifiedConnectedAccountRef['service'];
      operation: BuiltInLegacyConnectedAccountOperation;
    }>,
  ) => QualifiedConnectedAccountPeerOperationTransport;
  resolveConnectedAccountUsageIdentity?: ProviderAccountUsageUsageIdentityResolver;
  listScheduledQualifiedConnectedAccounts?: (service?: QualifiedConnectedAccountRef['service']) => Promise<
    readonly QualifiedConnectedAccountProfileV4[]
  >;
  subscribeConnectedAccountInvalidations?: (listener: (event?: RequesterConnectedAccountObservation) => void) => () => void;
  listQualifiedConnectedAccountGroupQuotaTargets?: NonNullable<
    ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['qualifiedConnectedAccountRuntime']
  >['listGroupQuotaTargets'];
  resolveConnectedServiceQualifiedPurposeBindingSnapshot?: (input: Readonly<{
    agentId: CatalogAgentId;
    connectedServicesBindingsRaw: unknown;
  }>) => Promise<AgentSpawnQualifiedPurposeBindingSnapshot | null>;
  activatePurposeBindings?: ConstructorParameters<
    typeof ConnectedServiceRefreshCoordinator
  >[0]['activatePurposeBindings'];
  onQualifiedConnectedAccountCredentialUpdated?: (
    account: QualifiedConnectedAccountRef,
    options?: Readonly<{ reason?: 'provider_context' }>,
  ) => void | Promise<void>;
  stopSession?: (sessionId: string) => Promise<StopSessionResult>;
  /**
   * K2: FSM-routed proactive quota pre-turn switch coordinator, built by
   * startDaemonSessionControlRuntime (where the FSM/deferral/hot-apply primitives live).
   * Wired into the quotas coordinator so proactive usage-limit switches hot-apply in place
   * when eligible (+ X4) or gate a deferred restart-resume, instead of a raw mid-turn SIGTERM.
   */
  connectedServiceAuthGroupPreTurnSwitchCoordinator: Awaited<
    ReturnType<typeof startDaemonSessionControlRuntime>
  >['connectedServiceAuthGroupPreTurnSwitchCoordinator'];
  consumeCommittedAuthGroupGeneration?: ConsumeCommittedAuthGroupGeneration;
  connectedServicePredictiveSwitchGuard?: ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['predictiveSwitchGuard'];
  /**
   * K2: the single runtime quota-snapshot store, owned by startDaemonSessionControlRuntime.
   * The quotas coordinator must record into the SAME store the proactive pre-turn coordinator
   * reads from, so proactive candidate selection sees probed snapshots (single-store design).
   */
  connectedServiceRuntimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
  /**
   * Canonical provider-account usage read model, owned by startDaemonSessionControlRuntime.
   * The quotas coordinator must consume this store directly for switch/fanout authority instead
   * of falling back to runtime quota snapshots when canonical usage evidence exists.
   */
  providerAccountUsageStore: Pick<ProviderAccountUsageStore, 'recordSnapshot' | 'resolveRecordId' | 'resolveBySource' | 'retainSourcesForProfile'>;
  connectedServiceRuntimeRegistry?: ConnectedServiceRuntimeRegistry;
  connectedServiceQuotaFetcherDescriptors?: readonly ConnectedServiceQuotaFetcherDescriptor[];
}>;

export type StartDaemonRuntimeBootstrapResult = Readonly<{
  artifactQueryHintBackfill: Promise<ArtifactQueryHintBackfillResult> | null;
  publicProfileRefreshHandle: SingleFlightIntervalLoopHandle | null;
  fileState: DaemonLocallyPersistedState;
  initialDaemonState: DaemonState;
  directPeerServerLifecycle: DirectTransferServerLifecycle | null;
  transferLiveWorkProducer: LiveWorkProducerV1;
  directTransferRegistryHost: ReturnType<typeof createCliRegistryHostV1>;
  transferRuntimeStatePublisher: ReturnType<typeof createDaemonTransferRuntimeStatePublisher>;
  connectedServiceRefreshCoordinator: ConnectedServiceRefreshCoordinator | null;
  connectedServiceRefreshLoopHandle: ConnectedServiceRefreshLoopHandle;
  connectedServiceQuotasCoordinator: ConnectedServiceQuotasCoordinator | null;
  connectedServiceQuotasLoopHandle: ConnectedServiceQuotasLoopHandle;
  daemonServerWorkScheduler: DaemonServerWorkScheduler;
  setDaemonServerWorkOnline: (online: boolean) => void;
  stopDirectPeerServer: () => Promise<void>;
  stopTailscaleTransferServeLifecycle: () => Promise<void>;
}>;

export async function startDaemonRuntimeBootstrap(
  params: StartDaemonRuntimeBootstrapParams,
): Promise<StartDaemonRuntimeBootstrapResult> {
  // Completed stages survive daemon restarts. Reclaim expired root-owned entries
  // once at the daemon-lifetime owner, never from hot store construction paths.
  void runActiveDaemonComposerMediaStageStartupMaintenance().catch(() => undefined);
  const directPeerRuntimeConfig = resolveMachineTransferRuntimeConfig();
  const stackDebugDirectPeerStartServer =
    await resolveStackDebugDirectPeerStartServer();
  const directTransferRegistryHost = createCliRegistryHostV1({credentials:params.credentials,secretSources:params.secretSources});
  const directPeerServerEnabled = directPeerRuntimeConfig.directPeer.serverEnabled;
  const tailscaleServeEnabled = directPeerServerEnabled && directPeerRuntimeConfig.tailscaleServe.enabled;
  const directPeerLocalListenerClasses = ['loopback_http' as const];
  const directPeerTransferListenerClasses = [
    ...directPeerLocalListenerClasses,
    ...(tailscaleServeEnabled ? ['tailscale_serve_https' as const] : []),
  ] as const;
  const directPeerAdvertisedHosts = ['127.0.0.1'];

  let tailscaleTransferServeLifecycle: ReturnType<typeof createTailscaleTransferServeLifecycle> | null = null;
  let transferRuntimeStatePublisher: ReturnType<typeof createDaemonTransferRuntimeStatePublisher> | null = null;

  const directPeerServerLifecycle = createDirectTransferServerLifecycle({
    admissionDrain: params.admissionDrain,
    attachmentUpload: {
      resolveSessionWorkingDirectory: createResolveHostedSessionWorkingDirectory({
        pidToTrackedSession: params.pidToTrackedSession,
        getMachineId: params.machineIdProvider,
      }),
    },
    bindPort: directPeerRuntimeConfig.directPeer.bindPort,
    bindHost: directPeerRuntimeConfig.directPeer.bindHost,
    listenerClasses: directPeerTransferListenerClasses,
    advertisedHosts: directPeerAdvertisedHosts,
    idleStopMs: directPeerRuntimeConfig.directPeer.idleStopMs,
    accessPolicy: params.filesystemAccessPolicy,
    composerMediaStage: {
      executionTarget: {
        serverId: configuration.activeServerId,
        machineId: params.machineId,
      },
      store: createActiveDaemonComposerMediaStageStore({ machineId: params.machineId }),
    },
    ...(stackDebugDirectPeerStartServer
      ? { startServer: stackDebugDirectPeerStartServer }
      : {}),
    resolveTailscaleServeHttpsBaseUrl: () => tailscaleTransferServeLifecycle?.getHttpsBaseUrlWithServePath() ?? null,
    onStateChange: (state) => {
      void transferRuntimeStatePublisher?.publishDirectTransferServerLifecycleState(state);
      return tailscaleTransferServeLifecycle?.observeDirectTransferServerLifecycleState(state);
    },
  });
  // Home's prepared byte owner is independent of optional direct listener publication.
  const transferLiveWorkProducer: LiveWorkProducerV1 = directPeerServerLifecycle.activity;

  const stopDirectPeerServer = async () => { await directPeerServerLifecycle.stop(); };
  let stopTailscaleTransferServeLifecycle: () => Promise<void> = async () => {};

  const runningRuntime = resolveRunningCliRuntimeIdentity();
  const accountId = readAccountIdFromToken(params.credentials.token);
  const fileState: DaemonLocallyPersistedState = {
    pid: process.pid,
    httpPort: params.controlPort,
    startedAt: Date.now(),
    startedWithCliVersion: params.cliVersion,
    startedWithPublicReleaseChannel: params.publicReleaseChannel,
    ...(runningRuntime.entrypoint ? { startedWithRuntimeEntrypoint: runningRuntime.entrypoint } : {}),
    ...(runningRuntime.builtAt ? { startedWithRuntimeBuiltAt: runningRuntime.builtAt } : {}),
    runtimeId: params.runtimeId,
    startupSource: params.startupSource,
    serviceLabel: params.serviceLabel,
    machineId: params.machineId,
    ...(accountId ? { accountId } : {}),
    daemonLogPath: params.daemonLogPath,
    controlToken: params.controlToken,
  };
  if (!params.publishDaemonState(fileState)) {
    throw new Error('Daemon lifecycle ownership changed before state publication');
  }
  params.logger.debug('[DAEMON RUN] Daemon state written');

  // The caller completes the final daemon state before persisting it, so keep the
  // local file state and daemon state assembly together here.
  const initialTailscaleTransferListenerState = await resolveTailscaleTransferListenerState({
    enabled: tailscaleServeEnabled,
    transferPort: directPeerRuntimeConfig.directPeer.bindPort,
    servePath: directPeerRuntimeConfig.tailscaleServe.servePath,
    httpsPort: directPeerRuntimeConfig.tailscaleServe.httpsPort,
    env: params.processEnv,
  });
  const initialTransferState = createDaemonTransferRuntimeState({
    directPeer: directPeerRuntimeConfig.directPeer,
    tailscaleServe: initialTailscaleTransferListenerState,
  });
  const initialDaemonState: DaemonState = {
    status: 'offline',
    pid: process.pid,
    httpPort: params.controlPort,
    startedAt: Date.now(),
    runtimeId: params.runtimeId,
    cliVersion: params.cliVersion,
    publicReleaseChannel: params.publicReleaseChannel,
    startupSource: params.startupSource,
    serviceManaged: isDaemonStartupSourceServiceManaged(params.startupSource),
    serviceLabel: params.serviceLabel,
    daemonPendingSessionActivationSupported: true,
    transfer: initialTransferState,
  };
  transferRuntimeStatePublisher = createDaemonTransferRuntimeStatePublisher({
    initialTransferState,
    isDaemonQuiescing: params.isDaemonQuiescing,
    warn: (message, error) => {
      params.logger.warn(message, error);
    },
  });
  if (tailscaleServeEnabled) {
    tailscaleTransferServeLifecycle = createTailscaleTransferServeLifecycle({
      enabled: tailscaleServeEnabled,
      servePath: directPeerRuntimeConfig.tailscaleServe.servePath,
      httpsPort: directPeerRuntimeConfig.tailscaleServe.httpsPort,
      env: params.processEnv,
      onListenerStateChange: (state) => {
        void transferRuntimeStatePublisher?.publishTailscaleTransferListenerState(state);
      },
      warn: (message, error) => {
        params.logger.warn(message, error);
      },
    });
    stopTailscaleTransferServeLifecycle = async () => {
      await tailscaleTransferServeLifecycle?.stop();
    };
  }

  const {
    connectedServiceRefreshCoordinator, connectedServiceRefreshLoopHandle,
    connectedServiceQuotasCoordinator, connectedServiceQuotasLoopHandle,
    daemonServerWorkScheduler, setDaemonServerWorkOnline,
  } = await startDaemonConnectedServiceRuntime(params);
  // This is native Account custody. The reusable Connected Services bootstrap
  // below also serves transient requester Accounts and must not start this work.
  const publicProfileRefreshHandle = params.publicProfileRefresh ? startPublicProfileRefresh({
    ...params.publicProfileRefresh, scheduler: daemonServerWorkScheduler,
  }) : null;
  // Native daemon Account lifetime owns one terminal attempt, never notifications,
  // requester runtimes, store construction or ordinary inventory reads.
  const artifactQueryHintBackfill = params.artifactQueryHints
    ? createCredentialedAccountArtifactStore(params.credentials, {
      resolveServerFeaturesSnapshot: params.artifactQueryHints.resolveServerFeaturesSnapshot,
    }).backfillQueryHints(params.artifactQueryHints) : null;
  return {
    artifactQueryHintBackfill,
    publicProfileRefreshHandle,
    fileState,
    initialDaemonState,
    directPeerServerLifecycle,
    transferLiveWorkProducer,
    directTransferRegistryHost,
    transferRuntimeStatePublisher,
    connectedServiceRefreshCoordinator,
    connectedServiceRefreshLoopHandle,
    connectedServiceQuotasCoordinator,
    connectedServiceQuotasLoopHandle,
    daemonServerWorkScheduler,
    setDaemonServerWorkOnline,
    stopDirectPeerServer,
    stopTailscaleTransferServeLifecycle,
  };
}

/** One Account-bound coordinator composition for daemon and requester Session custody. */
export async function startDaemonConnectedServiceRuntime(
  params: Pick<StartDaemonRuntimeBootstrapParams,
    'activeServerDir' | 'api' | 'credentials' | 'secretSources' | 'machineId' | 'machineIdProvider' | 'runtimeId'
    | 'happyHomeDir' | 'logger' | 'processEnv' | 'pidToTrackedSession' | 'isDaemonQuiescing'
    | 'connectedServiceAuthGroupPreTurnSwitchCoordinator' | 'connectedServicePredictiveSwitchGuard'
    | 'connectedServiceQuotaFetcherDescriptors' | 'connectedServiceRuntimeQuotaSnapshots'
    | 'connectedServiceRuntimeRegistry' | 'consumeCommittedAuthGroupGeneration'
    | 'daemonSessionMutationCustody' | 'providerAccountUsageStore'
    | 'listQualifiedConnectedAccountGroupQuotaTargets' | 'listScheduledQualifiedConnectedAccounts' | 'subscribeConnectedAccountInvalidations'
    | 'onQualifiedConnectedAccountCredentialUpdated' | 'qualifiedConnectedAccountEstablishedRuntimeOwner'
    | 'resolveConnectedServiceQualifiedPurposeBindingSnapshot' | 'resolveQualifiedConnectedAccountPeerClass'
    | 'resolveQualifiedConnectedAccountPeerOperationTransport' | 'resolveConnectedAccountUsageIdentity' | 'activatePurposeBindings'> & Readonly<{
    accountSettingsSnapshot?: () => import('@/settings/accountSettings/activeAccountSettingsSnapshot').ActiveAccountSettingsSnapshot | null;
    savedSecretOperationContext?: import('@/settings/secrets/savedSecretOperationContext').SavedSecretOperationContextV1;
    subscribeAccountSettingsSnapshot?: (listener: () => void) => () => void;
    connectedServicesMaterializationBaseDir?: string;
    isAccountRuntimeCurrent?: () => Promise<boolean>;
    runAccountOperation?: <T>(operation: () => Promise<T>) => Promise<T>;
    allowNativeAccountState?: boolean;
    connectedAccountsOwner?: ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0]['connectedAccountsOwner'];
  }>,
): Promise<Pick<StartDaemonRuntimeBootstrapResult,
  'connectedServiceRefreshCoordinator' | 'connectedServiceRefreshLoopHandle'
  | 'connectedServiceQuotasCoordinator' | 'connectedServiceQuotasLoopHandle'
  | 'daemonServerWorkScheduler' | 'setDaemonServerWorkOnline'>> {
  const accountId = readAccountIdFromToken(params.credentials.token);
  const readAccountSettingsSnapshot = params.accountSettingsSnapshot ?? getActiveAccountSettingsSnapshot;
  const connectedServicesRefreshEnabled =
    parseBooleanEnv(
      params.processEnv.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED,
      true,
    );
  const connectedServiceRuntimeRegistry = params.connectedServiceRuntimeRegistry ?? new ConnectedServiceRuntimeRegistry();
  const subscribeCoordinatorWake = (listener: () => void, settingsKeys: readonly string[],
    invalidateInventory?: (event?: RequesterConnectedAccountObservation) => void): (() => void) => {
    const onInventoryChanged = (event?: RequesterConnectedAccountObservation) => { invalidateInventory?.(event); listener(); };
    const cleanups = [
      connectedServiceRuntimeRegistry.subscribeTargetRegistrations(listener),
      params.subscribeConnectedAccountInvalidations?.(onInventoryChanged),
      params.subscribeAccountSettingsSnapshot?.(onInventoryChanged)
        ?? (!params.accountSettingsSnapshot ? subscribeActiveAccountSettingsKeys({ settings: settingsKeys }, () => onInventoryChanged()) : undefined),
      pluginReloadController.subscribe(() => onInventoryChanged()),
    ];
    return () => { for (const cleanup of cleanups) cleanup?.(); };
  };
  let connectedServiceRefreshCoordinator: ConnectedServiceRefreshCoordinator | null = null;
  let connectedServiceRefreshLoopHandle: ConnectedServiceRefreshLoopHandle = null;
  let startRefreshLoop: ((skipQualified: boolean) => void) | undefined;
  if (connectedServicesRefreshEnabled) {
    const refreshTickMs = resolvePositiveIntEnv(
      params.processEnv.HAPPIER_CONNECTED_SERVICES_REFRESH_TICK_MS,
      30_000,
      { min: 5_000, max: 5 * 60_000 },
    );
    const refreshWindowMs = resolvePositiveIntEnv(
      params.processEnv.HAPPIER_CONNECTED_SERVICES_REFRESH_WINDOW_MS,
      10 * 60_000,
      { min: 10_000, max: 60 * 60_000 },
    );
    const refreshLeaseMs = resolvePositiveIntEnv(
      params.processEnv.HAPPIER_CONNECTED_SERVICES_REFRESH_LEASE_MS,
      2 * 60_000,
      { min: 10_000, max: 30 * 60_000 },
    );

    const onAuthUpdated: NonNullable<ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0]['onAuthUpdated']> = async (event) => {
      const sessionIds = resolveConnectedServiceRefreshSessionIds({
        affectedTargets: event.affectedTargets,
        registry: connectedServiceRuntimeRegistry,
        trackedSessions: params.pidToTrackedSession,
      });
      for (const sessionId of sessionIds) {
        if (params.isAccountRuntimeCurrent && !await params.isAccountRuntimeCurrent()) {
          throw new Error('connected_account_runtime_not_current');
        }
        const result = await params.connectedServiceAuthGroupPreTurnSwitchCoordinator.applyCredentialUpdate({
          sessionId,
          serviceId: event.binding.serviceId,
          profileId: event.binding.profileId,
          reason: 'account_changed',
          executionAuthority: event.executionAuthority,
        });
        if (result.status === 'failed' && event.executionAuthority !== 'passive_projection') {
          throw new Error(result.errorCode ?? 'connected_service_credential_update_application_failed');
        }
      }
    };

    connectedServiceRefreshCoordinator = new ConnectedServiceRefreshCoordinator({
      api: params.api,
      credentials: params.credentials,
      machineIdProvider: params.machineIdProvider,
      ownerIdProvider: () => `${params.machineId}:${params.runtimeId}`,
      activeServerDir: params.activeServerDir,
      baseDir: params.connectedServicesMaterializationBaseDir ?? resolveConnectedServicesMaterializationBaseDir(params.happyHomeDir),
      refreshWindowMs,
      refreshLeaseMs,
      healthProbeIntervalMs: refreshTickMs,
      now: () => Date.now(),
      accountSettingsProvider: () => readAccountSettingsSnapshot()?.settings ?? null,
      processEnv: params.processEnv,
      runtimeRegistry: connectedServiceRuntimeRegistry,
      isAccountRuntimeCurrent: params.isAccountRuntimeCurrent,
      runAccountOperation: params.runAccountOperation,
      allowNativeAccountState: params.allowNativeAccountState,
      connectedAccountsOwner: params.connectedAccountsOwner,
      ...(params.activatePurposeBindings
        ? { activatePurposeBindings: params.activatePurposeBindings }
        : {}),
      ...(params.resolveConnectedServiceQualifiedPurposeBindingSnapshot
        ? {
            resolveQualifiedPurposeBindingSnapshot:
              params.resolveConnectedServiceQualifiedPurposeBindingSnapshot,
          }
        : {}),
      ...(params.qualifiedConnectedAccountEstablishedRuntimeOwner
        && params.resolveQualifiedConnectedAccountPeerClass
        ? {
            qualifiedConnectedAccountRuntime: {
              resolvePeerClass:
                params.resolveQualifiedConnectedAccountPeerClass,
              ...(params.resolveQualifiedConnectedAccountPeerOperationTransport
                ? {
                    resolveOperationTransport:
                      params.resolveQualifiedConnectedAccountPeerOperationTransport,
                  }
                : {}),
              establishedRuntimeOwner:
                params.qualifiedConnectedAccountEstablishedRuntimeOwner,
              mutateCredentialHealth:
                mutateQualifiedConnectedAccountCredentialHealthV4,
              readCredential:
                readQualifiedConnectedAccountCredentialV4,
              readGroup: ({ service, groupId }) =>
                readQualifiedConnectedAccountGroupV4({
                  token: params.credentials.token,
                  group: { service, groupId },
                }),
              acquireRefreshLease:
                acquireQualifiedConnectedAccountRefreshLeaseV4,
              mutateCredential:
                mutateQualifiedConnectedAccountCredentialV4,
              ...(params.listScheduledQualifiedConnectedAccounts
                ? {
                    listScheduledAccounts:
                      params.listScheduledQualifiedConnectedAccounts,
                  }
                : {}),
              onCredentialUpdated: async (account: QualifiedConnectedAccountRef, options?: Readonly<{ reason?: 'provider_context' }>) => {
                await params.onQualifiedConnectedAccountCredentialUpdated?.(account, options);
                if (options?.reason === 'provider_context') return;
                const serviceId = buildQualifiedPluginContributionKey(account.service);
                const affectedTargets = connectedServiceRuntimeRegistry.listRefreshTargets().filter((target) =>
                  target.bindings.some((binding) => binding.serviceId === serviceId && binding.profileId === account.accountId));
                if (affectedTargets.length === 0) return;
                await onAuthUpdated({
                  binding: { serviceId, profileId: account.accountId },
                  affectedTargets,
                  trigger: 'refresh_triggered_restart',
                  executionAuthority: 'runtime_recovery',
                });
              },
            },
          }
        : {}),
      onAuthUpdated,
      onCredentialHealthNotification: async ({ diagnostic, healthStatus, affectedTargets }) => {
        const settingsSnapshot = readAccountSettingsSnapshot();
        const notificationTargets = affectedTargets.length > 0
          ? affectedTargets.map((target) => ({
            sessionId: target.sessionId,
            tracked: params.pidToTrackedSession.get(target.pid) ?? null,
          }))
          : [{
            sessionId: `connected-service:${diagnostic.serviceId}:${diagnostic.profileId}`,
            tracked: null,
          }];
        await Promise.all(notificationTargets.map(async (target) => {
          await dispatchConnectedServiceCredentialHealthNotificationAsync({
            settings: settingsSnapshot?.settings ?? null,
            secretSources: params.secretSources,
            operationContext: params.savedSecretOperationContext,
            settingsSecretsReadKeys: settingsSnapshot?.settingsSecretsReadKeys ?? [],
            expoPushSender: params.api.push(),
            listConnectedServiceProfiles: params.api.listConnectedServiceProfiles.bind(params.api),
            source: {
              sessionId: target.sessionId,
              sessionTitle: resolveTrackedSessionNotificationTitle(target.tracked),
              serviceId: diagnostic.serviceId,
              profileId: diagnostic.profileId,
              status: healthStatus,
              reason: diagnostic.category ?? diagnostic.status,
              providerStatus: diagnostic.providerStatus ?? null,
              providerErrorCode: diagnostic.providerErrorCode ?? null,
            },
            nowMs: () => Date.now(),
            dedupeWindowMs: resolvePositiveIntEnv(
              params.processEnv.HAPPIER_CONNECTED_SERVICES_CREDENTIAL_HEALTH_NOTIFICATION_DEDUPE_MS,
              60_000,
              { min: 0, max: 24 * 60 * 60_000 },
            ),
          });
        }));
      },
    });

    startRefreshLoop = (skipQualified) => { connectedServiceRefreshLoopHandle = startConnectedServiceRefreshLoop({
      enabled: true,
      tickMs: refreshTickMs,
      subscribeWake: listener => subscribeCoordinatorWake(listener, ['connectedServicesProviderStateSharingSettingsV1']),
      coordinator: { tickOnce: async () => {
        // Selected refresh reads and effects own their fresh authority checks;
        // an empty wake (including quota-owned qualified work) needs no proof.
        const operation = () => connectedServiceRefreshCoordinator!.tickOnce({ skipQualified });
        return await (params.runAccountOperation ? params.runAccountOperation(operation) : operation());
      } },
      runImmediately: true,
      onTickError: (error) => {
        params.logger.debug('[DAEMON RUN] Connected services refresh tick failed (non-fatal)', summarizeConnectedServiceTickError(error));
      },
    }); };
  }

  const connectedServicesQuotasEnabled =
    await resolveConnectedServicesQuotasDaemonEnabled({
      env: params.processEnv,
      serverUrl: resolveServerHttpBaseUrl(),
    });
  let connectedServiceQuotasCoordinator: ConnectedServiceQuotasCoordinator | null = null;
  let connectedServiceQuotasLoopHandle: ConnectedServiceQuotasLoopHandle = null;
  // K2: share the single runtime quota-snapshot store owned by the session-control runtime
  // (do NOT create a second store — the proactive pre-turn coordinator reads from this one).
  const connectedServiceQuotaRuntimeSnapshots = params.connectedServiceRuntimeQuotaSnapshots;
  let daemonServerWorkOnline = true;
  const setDaemonServerWorkOnline = (online: boolean) => {
    daemonServerWorkOnline = online;
  };
  const daemonServerWorkScheduler = createDaemonServerWorkScheduler({
    budget: createDaemonServerWorkBudget({
      maxConcurrentWrites: resolvePositiveIntEnv(
        params.processEnv.HAPPIER_DAEMON_SERVER_WORK_MAX_CONCURRENT_WRITES,
        1,
        { min: 1, max: 16 },
      ),
    }),
    gate: () => daemonServerWorkOnline
      ? { status: 'open' }
      : { status: 'deferred', reason: 'offline' },
    logger: {
      debug: (message, ...args) => params.logger.debug(message, args.length === 1 ? args[0] : args),
      warn: (message, ...args) => params.logger.warn(message, args.length === 1 ? args[0] : args),
    },
  });
  if (connectedServicesQuotasEnabled) {
    const {
      fetchTimeoutMs,
      probeIntervalMs: quotasTickMs,
      discoveryEnabled,
      discoveryIntervalMs,
      failureBackoffMinMs,
      failureBackoffMaxMs,
      failureBackoffJitterPct,
      quotaPersistenceMaxConsecutiveFailures,
    } = resolveConnectedServiceQuotasDaemonOptions(params.processEnv);
    const groupSwitchCheckMinIntervalMs = resolvePositiveIntEnv(
      params.processEnv.HAPPIER_CONNECTED_SERVICES_QUOTA_GROUP_SWITCH_CHECK_MIN_INTERVAL_MS,
      60_000,
      { min: 0, max: 30 * 60_000 },
    );

    const quotaFetchers = createConnectedServiceQuotaFetchers(
      params.processEnv,
      params.connectedServiceQuotaFetcherDescriptors ?? [],
    );

    const activation = await activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration({
      enabled: true,
      isCurrent: () => !params.isDaemonQuiescing?.(),
      quotaFetchers,
      awaitReadiness: async () => {
        const settingsReady = params.accountSettingsSnapshot
          ? readAccountSettingsSnapshot() !== null
          : await warmActiveAccountSettingsSnapshotBestEffort({
              credentials: params.credentials,
              logger: params.logger,
            });
        if (!settingsReady) {
          throw new Error('Connected-service account settings are unavailable during quota startup');
        }
      },
      hydrate: async ({ serviceIds }) => (
        await hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
          serviceIds,
          api: {
            listAccounts: async ({ service }) => await listQualifiedConnectedAccountsV4({
              token: params.credentials.token,
              service,
            }),
            listGroups: async ({ service }) => await listQualifiedConnectedAccountGroupsV4({
              token: params.credentials.token,
              service,
            }),
            resolveSource: async ({ source }) => await resolveQualifiedProviderAccountUsageSourceV4({
              token: params.credentials.token,
              source,
            }),
            readProviderAccountUsageRecord: async ({ recordId }) =>
              await readQualifiedProviderAccountUsageRecordV4({
                token: params.credentials.token,
                recordId,
              }),
            getAccountEncryptionMode: async () => await params.api.getAccountEncryptionMode(),
          },
          credentials: params.credentials,
          store: params.providerAccountUsageStore,
          nowMs: Date.now(),
          resolveUsageIdentity: params.resolveConnectedAccountUsageIdentity,
          resolveCurrentProviderAccountIdentityForSource: async (source) => {
            const material = await readQualifiedConnectedAccountCredentialMaterial({
              credentials: params.credentials, account: source.ref,
              getAccountEncryptionMode: () => params.api.getAccountEncryptionMode(),
            });
            return material ? readQualifiedConnectedAccountCredentialIdentity(material) : null;
          },
        })
      ).hydration,
      createCoordinator: () => new ConnectedServiceQuotasCoordinator({
      qualifiedHealth: connectedServiceRefreshCoordinator,
      api: params.api,
      credentials: params.credentials,
      quotaFetchers,
      fetchTimeoutMs,
      discoveryEnabled,
      discoveryIntervalMs,
      probeIntervalMs: quotasTickMs,
      failureBackoffMinMs,
      failureBackoffMaxMs,
      failureBackoffJitterPct,
      runtimeQuotaSnapshots: connectedServiceQuotaRuntimeSnapshots,
      accountUsageStore: params.providerAccountUsageStore,
      runtimeRegistry: connectedServiceRuntimeRegistry,
      ...(params.qualifiedConnectedAccountEstablishedRuntimeOwner
        && params.resolveQualifiedConnectedAccountPeerClass
        && params.listScheduledQualifiedConnectedAccounts
        ? {
            qualifiedConnectedAccountRuntime: {
              resolvePeerClass:
                params.resolveQualifiedConnectedAccountPeerClass,
              ...(params.resolveQualifiedConnectedAccountPeerOperationTransport
                ? {
                    resolveOperationTransport:
                      params.resolveQualifiedConnectedAccountPeerOperationTransport,
                  }
                : {}),
              establishedRuntimeOwner:
                params.qualifiedConnectedAccountEstablishedRuntimeOwner,
              listScheduledAccounts:
                params.listScheduledQualifiedConnectedAccounts,
              resolveUsageIdentity: params.resolveConnectedAccountUsageIdentity,
              resolveCurrentCredentialProof: async (account) => {
                const serviceKey = buildQualifiedPluginContributionKey(account.service);
                const legacyServiceId = resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(serviceKey);
                if (!legacyServiceId) return null;
                const resolutions = await resolveConnectedServiceCredentialResolutions({ credentials: params.credentials,
                  api: params.api, bindings: [{ serviceId: legacyServiceId, profileId: account.accountId }] });
                const resolution = resolutions.get(legacyServiceId);
                if (resolution?.revisionSemantics !== 'revisioned') return null;
                return { providerAccountId: readConnectedServiceCredentialProviderAccountId(resolution.record),
                  providerOrganizationId: resolution.providerOrganizationId ?? null,
                  credentialFingerprint: resolution.record.kind === 'oauth'
                    ? computeConnectedServiceAccessTokenFingerprint(resolution.record.oauth.accessToken) : null };
              },
              enrichCredentialContext: async (input) => connectedServiceRefreshCoordinator
                ? await connectedServiceRefreshCoordinator.enrichQualifiedConnectedAccountCredentialContext(input)
                : { status: 'unavailable' as const },
              listAccounts: async ({ service, signal }) => (
                await listQualifiedConnectedAccountsV4({
                  token: params.credentials.token,
                  service,
                  ...(signal ? { signal } : {}),
                })
              ).accounts,
              ...(params.listQualifiedConnectedAccountGroupQuotaTargets
                ? { listGroupQuotaTargets: params.listQualifiedConnectedAccountGroupQuotaTargets }
                : {}),
              readGroup: async ({ service, groupId, signal }) =>
                await readQualifiedConnectedAccountGroupV4({
                  token: params.credentials.token,
                  group: { service, groupId },
                  ...(signal ? { signal } : {}),
                }),
              updateGroupRuntimeState: async ({
                service,
                groupId,
                expectedGeneration,
                expectedIncarnation,
                expectedRuntimeStateRevision,
                runtimeState,
              }) => await updateQualifiedConnectedAccountGroupRuntimeStateV4({
                token: params.credentials.token,
                patch: {
                  service,
                  groupId,
                  expectedGeneration,
                  expectedIncarnation,
                  expectedRuntimeStateRevision,
                  runtimeState,
                },
              }),
              readQuota: readQualifiedConnectedAccountQuotaV4,
              writeProviderAccountUsage:
                writeQualifiedProviderAccountUsageV4,
            },
          }
        : {}),
      serverWorkScheduler: daemonServerWorkScheduler,
      quotaPersistenceServerScope: params.activeServerDir,
      quotaPersistenceMaxConsecutiveFailures,
      groupSwitchCheckMinIntervalMs,
      onAutomaticQuotaResetConsumed: async (event) => {
        const settingsSnapshot = readAccountSettingsSnapshot();
        await dispatchConnectedServiceAutomaticQuotaResetNotificationAsync({
          settings: settingsSnapshot?.settings ?? null,
          secretSources: params.secretSources,
          operationContext: params.savedSecretOperationContext,
          settingsSecretsReadKeys: settingsSnapshot?.settingsSecretsReadKeys ?? [],
          expoPushSender: params.api.push(), event,
        });
      },
      onQuotaLifecycleTransition: async (transition) => {
        const settingsSnapshot = readAccountSettingsSnapshot();
        await dispatchConnectedServiceQuotaLifecycleNotificationAsync({
          settings: settingsSnapshot?.settings ?? null,
          secretSources: params.secretSources,
          operationContext: params.savedSecretOperationContext,
          settingsSecretsReadKeys: settingsSnapshot?.settingsSecretsReadKeys ?? [],
          expoPushSender: params.api.push(),
          transition,
        }).catch((error) => {
          params.logger.debug('[DAEMON RUN] Connected-service quota lifecycle notification failed (non-fatal)', error);
        });
        if (!params.daemonSessionMutationCustody) {
          throw new Error('daemon_session_mutation_custody_unavailable');
        }
        await commitConnectedServiceQuotaLifecycleSessionEvents({
          mutationCustody: params.daemonSessionMutationCustody,
          transition,
        });
      },
      onAccountUsageSnapshotAccepted: async (transition) => {
        const settingsSnapshot = readAccountSettingsSnapshot();
        await dispatchConnectedServiceQuotaLifecycleNotificationAsync({
          settings: settingsSnapshot?.settings ?? null,
          secretSources: params.secretSources,
          operationContext: params.savedSecretOperationContext,
          settingsSecretsReadKeys: settingsSnapshot?.settingsSecretsReadKeys ?? [],
          ...(params.accountSettingsSnapshot ? {
            notificationChannelCatalog: settingsSnapshot?.notificationChannelCatalog ?? { status: 'loading' as const },
            savedSecretMaterializer: settingsSnapshot ? createSavedSecretMaterializerFromSnapshotV1(settingsSnapshot) : undefined,
            isCurrent: params.isAccountRuntimeCurrent,
          } : {}),
          expoPushSender: params.api.push(), transition,
          ...(accountId ? { usageNoticeArtifactStore: { accountId,
            store: createCredentialedAccountArtifactStore(params.credentials) } } : {}),
        }).catch((error) => {
          params.logger.debug('[DAEMON RUN] Connected-service usage notification failed (non-fatal)', error);
        });
      },
      accountSettingsProvider: () => {
        const snapshot = readAccountSettingsSnapshot();
        return snapshot?.source === 'none' ? null : snapshot?.settings;
      },
      // K2 (cmpn4hhdi fix): the proactive quota pre-turn switch coordinator is built by
      // startDaemonSessionControlRuntime (where the FSM/deferral/hot-apply primitives live)
      // and injected here. It routes the proactive usage-limit switch through the FSM
      // hot-apply/gated-apply path (no raw mid-turn SIGTERM); the previous raw coordinator
      // that bypassed the FSM/deferral/reachability gate has been removed.
      authGroupSwitchCoordinator: params.connectedServiceAuthGroupPreTurnSwitchCoordinator,
      consumeCommittedAuthGroupGeneration: params.consumeCommittedAuthGroupGeneration ?? null,
      predictiveSwitchGuard: params.connectedServicePredictiveSwitchGuard ?? null,
      sameAccountFanoutStrategyResolver: async ({ agentId }) => {
        const catalogAgentId = typeof agentId === 'string' && agentId.trim()
          ? agentId.trim() as CatalogAgentId
          : null;
        // The host already requires an exact runtime/persisted account-identity
        // proof before fanout. That proof, not an Agent-authored strategy flag,
        // is the authority for applying same-account quota state.
        return catalogAgentId ? 'provider_account_id' : 'none';
      },
      readRuntimeAccountIdentityForFanout: createConnectedServiceRuntimeIdentityFanoutReader({
        credentials: params.credentials,
      }),
      // Durable same-account fanout fallback (codex): when the live runtime-identity probe cannot
      // verify a sibling's account, prove it from PERSISTED artifacts that survive daemon restarts —
      // the session's persisted metadata (canonical session read proves durability) plus the persisted
      // profile's credential provider-account id (canonical resolver). The canonical transports
      // own their request lifetimes; the quota fanout owner suppresses candidates on read failure.
      readPersistedSessionAccountIdentity: async (input) => {
        const token = typeof params.credentials.token === 'string' ? params.credentials.token.trim() : '';
        if (!token) return null;
        // Require durable evidence the session persists (canonical session read) before trusting a
        // persisted-identity fanout proof; do NOT introduce a second metadata reader.
        const persistedSession = await fetchSessionByIdCompat({ reason: 'session-control', token, sessionId: input.sessionId });
        if (!persistedSession) return null;
        // The native credential projection takes a scalar binding and delegates to the current
        // qualified credential reader. Only its binding/map lookup uses the scalar id; the
        // returned proof keeps the qualified identity.
        const legacyServiceId = resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(input.serviceId);
        if (!legacyServiceId) return null;
        const byServiceId = await resolveConnectedServiceCredentialResolutions({
          credentials: params.credentials,
          api: params.api,
          bindings: [{ serviceId: legacyServiceId, profileId: input.profileId }],
        });
        const resolution = byServiceId.get(legacyServiceId) ?? null;
        if (resolution?.revisionSemantics !== 'revisioned') return null;
        const record = resolution.record;
        const providerAccountId = readConnectedServiceCredentialProviderAccountId(record);
        if (!providerAccountId) return null;
        return {
          providerAccountId,
          serviceId: input.serviceId,
          groupId: input.groupId,
          profileId: input.profileId,
          groupGeneration: input.expectedGroupGeneration,
        };
      },
      now: () => Date.now(),
      randomBytes: (length) => randomBytes(length),
      }),
      startLoop: (coordinator) => startConnectedServiceQuotasLoop({
        enabled: true,
        runImmediately: true,
        tickMs: quotasTickMs,
        subscribeWake: listener => subscribeCoordinatorWake(listener, ['usageQuotaNotificationsV1'], event => coordinator.invalidateInventory(event)),
        coordinator: { tickOnce: async () => {
          if (params.isAccountRuntimeCurrent && !await params.isAccountRuntimeCurrent()) return { nextAutomaticRunAfterMs: null };
          const operation = () => coordinator.tickOnce();
          return await (params.runAccountOperation ? params.runAccountOperation(operation) : operation());
        } },
        onTickError: (error) => {
          params.logger.debug('[DAEMON RUN] Connected services quotas tick failed (non-fatal)', summarizeConnectedServiceTickError(error));
        },
      }),
      onActivationError: (error) => {
        params.logger.warn('[DAEMON RUN] Connected-service quota automation disabled because startup hydration failed', error);
      },
    });
    if (activation.status === 'active') {
      connectedServiceQuotasCoordinator = activation.coordinator;
      connectedServiceQuotasLoopHandle = activation.loopHandle;
    }
  }
  // Quota's incumbent loop owns the combined qualified deadline. The refresh
  // loop retains released legacy work, or all health work when quota is disabled.
  startRefreshLoop?.(connectedServiceQuotasCoordinator !== null
    && params.qualifiedConnectedAccountEstablishedRuntimeOwner !== undefined
    && params.listScheduledQualifiedConnectedAccounts !== undefined);

  return { connectedServiceRefreshCoordinator, connectedServiceRefreshLoopHandle,
    connectedServiceQuotasCoordinator, connectedServiceQuotasLoopHandle,
    daemonServerWorkScheduler, setDaemonServerWorkOnline };
}
