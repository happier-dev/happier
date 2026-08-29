import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { ApiClient } from '@/api/api';
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
import { createPromptAssetAdapterRegistry } from '@/prompts/assets/createPromptAssetAdapterRegistry';
import { resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey } from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createPromptRegistryAdapterRegistry } from '@/prompts/registries/createPromptRegistryAdapterRegistry';
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
import { dispatchConnectedServiceQuotaLifecycleNotificationAsync } from '../connectedServices/notifications/dispatchConnectedServiceQuotaLifecycleNotification';
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
import { readConnectedServiceCredentialProviderAccountId } from '../connectedServices/shared/connectedServiceCredentialRecord';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
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
import {
  parseBooleanEnv,
  type BuiltInLegacyConnectedAccountOperation,
  type ConnectedServiceExecutionAuthorityV1,
  type ConnectedServiceId,
  type QualifiedConnectedAccountProfileV4,
  type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import type {
  AgentSpawnQualifiedPurposeBindingSnapshot,
} from '../connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { resolveStackDebugDirectPeerStartServer } from './resolveStackDebugDirectPeerStartServer';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { warmActiveAccountSettingsSnapshotBestEffort } from '@/settings/accountSettings/warmActiveAccountSettingsSnapshot';
import { getSessionNotificationTitle } from '@/agent/runtime/notifications/sessionNotificationContext';
import type { CatalogAgentId } from '@/agent/catalog/types';

import type { DaemonLocallyPersistedState, StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import type { PromptRegistryRegistry } from '@/prompts/registries/createPromptRegistryAdapterRegistry';
import type { DaemonStartupSource } from '../ownership/daemonOwnershipMetadata';
import { isDaemonStartupSourceServiceManaged } from '../ownership/daemonOwnershipMetadata';
import type { TrackedSession } from '../types';

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
  connectedServicesRestartRequestedPids: Set<number>;
  pidToTrackedSession: Map<number, TrackedSession>;
  qualifiedConnectedAccountEstablishedRuntimeOwner?: Pick<
    QualifiedConnectedAccountEstablishedRuntimeOwner,
    'invokeWithReceipt'
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
  listScheduledQualifiedConnectedAccounts?: () => Promise<
    readonly QualifiedConnectedAccountProfileV4[]
  >;
  listQualifiedConnectedAccountGroupQuotaTargets?: NonNullable<
    ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['qualifiedConnectedAccountRuntime']
  >['listGroupQuotaTargets'];
  resolveConnectedServiceQualifiedPurposeBindingSnapshot?: (input: Readonly<{
    agentId: CatalogAgentId;
    connectedServicesBindingsRaw: unknown;
  }>) => Promise<AgentSpawnQualifiedPurposeBindingSnapshot | null>;
  onQualifiedConnectedAccountCredentialUpdated?: (
    account: QualifiedConnectedAccountRef,
  ) => void | Promise<void>;
  stopSession?: (sessionId: string) => Promise<StopSessionResult>;
  /**
   * K2: FSM-routed proactive quota pre-turn switch coordinator, built by
   * startDaemonSessionControlRuntime (where the FSM/deferral/hot-apply primitives live).
   * Wired into the quotas coordinator so proactive usage-limit switches hot-apply in place
   * when eligible (+ X4) or gate a deferred restart-resume, instead of a raw mid-turn SIGTERM.
   */
  connectedServiceAuthGroupPreTurnSwitchCoordinator: Readonly<{
    switchBeforeTurn: (input: Readonly<{
      sessionId?: string;
      serviceId: string;
      groupId: string;
      reason: 'usage_limit' | 'soft_threshold' | 'same_provider_account_exhausted' | 'auth_expired' | 'account_changed' | 'refresh_failed';
    }>) => Promise<unknown>;
    applyCommittedGeneration: (input: Readonly<{
      sessionId: string;
      serviceId: string;
      groupId: string;
      activeProfileId: string;
      generation: number;
      reason: string;
    }>) => Promise<Readonly<{
      status: string;
      activeProfileId?: string | null;
      generation: number;
      errorCode?: string;
    }>>;
    applyCredentialUpdate: (input: Readonly<{
      sessionId: string;
      serviceId: ConnectedServiceId;
      profileId: string;
      reason: 'account_changed' | 'auth_expired';
      executionAuthority: ConnectedServiceExecutionAuthorityV1;
    }>) => Promise<Readonly<{
      status: 'hot_applied' | 'restart_requested' | 'unchanged' | 'failed';
      errorCode?: string;
    }>>;
  }>;
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
  providerAccountUsageStore: Pick<ProviderAccountUsageStore, 'recordSnapshot' | 'resolveRecordId' | 'resolveBySource'>;
  connectedServiceRuntimeRegistry?: ConnectedServiceRuntimeRegistry;
  connectedServiceQuotaFetcherDescriptors?: readonly ConnectedServiceQuotaFetcherDescriptor[];
}>;

export type StartDaemonRuntimeBootstrapResult = Readonly<{
  fileState: DaemonLocallyPersistedState;
  initialDaemonState: DaemonState;
  directPeerServerLifecycle: DirectTransferServerLifecycle | null;
  directTransferPromptAssetAdapterRegistry: ReturnType<typeof createPromptAssetAdapterRegistry>;
  directTransferPromptRegistryRegistry: PromptRegistryRegistry;
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
  const directTransferPromptAssetAdapterRegistry = createPromptAssetAdapterRegistry({
    readRegisteredAdapters: () => (
      pluginReloadController.getState().activeRegistry?.promptAssetAdapters ?? new Map()
    ),
  });
  const directTransferPromptRegistryRegistry = createPromptRegistryAdapterRegistry();
  const directPeerServerEnabled = directPeerRuntimeConfig.directPeer.serverEnabled;
  const directPeerLocalListenerClasses = ['loopback_http' as const];
  const directPeerTransferListenerClasses = [
    ...directPeerLocalListenerClasses,
    ...(directPeerRuntimeConfig.tailscaleServe.enabled ? ['tailscale_serve_https' as const] : []),
  ] as const;
  const directPeerAdvertisedHosts = ['127.0.0.1'];

  let tailscaleTransferServeLifecycle: ReturnType<typeof createTailscaleTransferServeLifecycle> | null = null;
  let transferRuntimeStatePublisher: ReturnType<typeof createDaemonTransferRuntimeStatePublisher> | null = null;

  const directPeerServerLifecycle = directPeerServerEnabled
    ? createDirectTransferServerLifecycle({
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
        promptAssetUpload: {
          adapterRegistry: directTransferPromptAssetAdapterRegistry,
        },
        ...(stackDebugDirectPeerStartServer
          ? { startServer: stackDebugDirectPeerStartServer }
          : {}),
        resolveTailscaleServeHttpsBaseUrl: () => tailscaleTransferServeLifecycle?.getHttpsBaseUrlWithServePath() ?? null,
        onStateChange: (state) => {
          void transferRuntimeStatePublisher?.publishDirectTransferServerLifecycleState(state);
          return tailscaleTransferServeLifecycle?.observeDirectTransferServerLifecycleState(state);
        },
      })
    : null;

  let stopDirectPeerServer: () => Promise<void> = async () => {};
  let stopTailscaleTransferServeLifecycle: () => Promise<void> = async () => {};
  if (directPeerServerLifecycle) {
    stopDirectPeerServer = async () => {
      await directPeerServerLifecycle.stop();
    };
  }

  const runningRuntime = resolveRunningCliRuntimeIdentity();
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
    enabled: directPeerRuntimeConfig.tailscaleServe.enabled,
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
    transfer: initialTransferState,
  };
  transferRuntimeStatePublisher = createDaemonTransferRuntimeStatePublisher({
    initialTransferState,
    isDaemonQuiescing: params.isDaemonQuiescing,
    warn: (message, error) => {
      params.logger.warn(message, error);
    },
  });
  if (directPeerServerLifecycle && directPeerRuntimeConfig.tailscaleServe.enabled) {
    tailscaleTransferServeLifecycle = createTailscaleTransferServeLifecycle({
      enabled: directPeerRuntimeConfig.tailscaleServe.enabled,
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

  const connectedServicesRefreshEnabled =
    parseBooleanEnv(
      params.processEnv.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED,
      true,
    );
  const connectedServiceRuntimeRegistry = params.connectedServiceRuntimeRegistry ?? new ConnectedServiceRuntimeRegistry();
  let connectedServiceRefreshCoordinator: ConnectedServiceRefreshCoordinator | null = null;
  let connectedServiceRefreshLoopHandle: ConnectedServiceRefreshLoopHandle = null;
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
      const sessionIds = new Set<string>();
      for (const target of event.affectedTargets) {
        const sessionId = target.sessionId?.trim()
          || params.pidToTrackedSession.get(target.pid)?.happySessionId?.trim()
          || '';
        if (sessionId) sessionIds.add(sessionId);
      }
      for (const sessionId of sessionIds) {
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
      baseDir: resolveConnectedServicesMaterializationBaseDir(params.happyHomeDir),
      refreshWindowMs,
      refreshLeaseMs,
      now: () => Date.now(),
      accountSettingsProvider: () => getActiveAccountSettingsSnapshot()?.settings ?? null,
      processEnv: params.processEnv,
      runtimeRegistry: connectedServiceRuntimeRegistry,
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
              ...(params.onQualifiedConnectedAccountCredentialUpdated
                ? {
                    onCredentialUpdated:
                      params.onQualifiedConnectedAccountCredentialUpdated,
                  }
                : {}),
            },
          }
        : {}),
      onAuthUpdated,
      onCredentialHealthNotification: async ({ diagnostic, healthStatus, affectedTargets }) => {
        const settingsSnapshot = getActiveAccountSettingsSnapshot();
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

    connectedServiceRefreshLoopHandle = startConnectedServiceRefreshLoop({
      enabled: true,
      tickMs: refreshTickMs,
      coordinator: connectedServiceRefreshCoordinator,
      runImmediately: true,
      onTickError: (error) => {
        params.logger.debug('[DAEMON RUN] Connected services refresh tick failed (non-fatal)', error);
      },
    });
  }

  const connectedServicesQuotasEnabled =
    await resolveConnectedServicesQuotasDaemonEnabled({
      env: params.processEnv,
      serverUrl: configuration.serverUrl,
      timeoutMs: 1500,
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
    const quotasTickMs = resolvePositiveIntEnv(
      params.processEnv.HAPPIER_CONNECTED_SERVICES_QUOTAS_TICK_MS,
      60_000,
      { min: 5_000, max: 30 * 60_000 },
    );
    const {
      fetchTimeoutMs,
      discoveryEnabled,
      discoveryIntervalMs,
      failureBackoffMinMs,
      failureBackoffMaxMs,
      failureBackoffJitterPct,
    } = resolveConnectedServiceQuotasDaemonOptions(params.processEnv);
    const quotaFetchLeaseMs = resolvePositiveIntEnv(
      params.processEnv.HAPPIER_CONNECTED_SERVICES_QUOTA_FETCH_LEASE_MS,
      30_000,
      { min: 1_000, max: 5 * 60_000 },
    );
    const quotaFetchLeaseContentionWaitMaxMs = resolvePositiveIntEnv(
      params.processEnv.HAPPIER_CONNECTED_SERVICES_QUOTA_FETCH_LEASE_CONTENTION_WAIT_MAX_MS,
      5_000,
      { min: 0, max: 60_000 },
    );
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
      quotaFetchers,
      awaitReadiness: async () => {
        const settingsReady = await warmActiveAccountSettingsSnapshotBestEffort({
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
        })
      ).hydration,
      createCoordinator: () => new ConnectedServiceQuotasCoordinator({
      api: params.api,
      credentials: params.credentials,
      quotaFetchers,
      fetchTimeoutMs,
      discoveryEnabled,
      discoveryIntervalMs,
      failureBackoffMinMs,
      failureBackoffMaxMs,
      failureBackoffJitterPct,
      machineIdProvider: () => params.machineId,
      ownerIdProvider: () => `${params.machineId}:${params.runtimeId}`,
      quotaFetchLeaseMs,
      quotaFetchLeaseContentionWaitMaxMs,
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
      quotaPersistenceMaxConsecutiveFailures: resolvePositiveIntEnv(
        params.processEnv.HAPPIER_CONNECTED_SERVICES_QUOTA_IN_BAND_MAX_CONSECUTIVE_FAILURES,
        5,
        { min: 1, max: 100 },
      ),
      groupSwitchCheckMinIntervalMs,
      onQuotaLifecycleTransition: async (transition) => {
        const settingsSnapshot = getActiveAccountSettingsSnapshot();
        await dispatchConnectedServiceQuotaLifecycleNotificationAsync({
          settings: settingsSnapshot?.settings ?? null,
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
      // profile's credential provider-account id (canonical resolver). Best-effort under a bounded 2s
      // timeout: any read failure yields null so the candidate stays suppressed (fail-closed).
      readPersistedSessionAccountIdentity: async (input) => {
        const boundedMs = 2_000;
        const runBounded = async <T>(work: Promise<T>): Promise<T | null> => {
          let timer: ReturnType<typeof setTimeout> | null = null;
          try {
            return await Promise.race<T | null>([
              work,
              new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), boundedMs);
                (timer as unknown as { unref?: () => void })?.unref?.();
              }),
            ]);
          } catch {
            return null;
          } finally {
            if (timer) clearTimeout(timer);
          }
        };
        const token = typeof params.credentials.token === 'string' ? params.credentials.token.trim() : '';
        if (!token) return null;
        // Require durable evidence the session persists (canonical session read) before trusting a
        // persisted-identity fanout proof; do NOT introduce a second metadata reader.
        const persistedSession = await runBounded(fetchSessionByIdCompat({ token, sessionId: input.sessionId }));
        if (!persistedSession) return null;
        // The released V2/V3 credential resolver consumes the legacy scalar service id only.
        // Reverse-project the qualified key once at this legacy resolver; the scalar id is used
        // only for the binding/map lookup while the returned proof keeps the qualified identity.
        const legacyServiceId = resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(input.serviceId);
        if (!legacyServiceId) return null;
        const byServiceId = await runBounded(resolveConnectedServiceCredentialResolutions({
          credentials: params.credentials,
          api: params.api,
          bindings: [{ serviceId: legacyServiceId, profileId: input.profileId }],
        }));
        const resolution = byServiceId?.get(legacyServiceId) ?? null;
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
        tickMs: quotasTickMs,
        coordinator,
        onTickError: (error) => {
          params.logger.debug('[DAEMON RUN] Connected services quotas tick failed (non-fatal)', error);
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

  return {
    fileState,
    initialDaemonState,
    directPeerServerLifecycle,
    directTransferPromptAssetAdapterRegistry,
    directTransferPromptRegistryRegistry,
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
