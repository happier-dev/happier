import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { ApiClient } from '@/api/api';
import type { DaemonState } from '@/api/types';
import {
  createDirectTransferServerLifecycle,
  type DirectTransferServerLifecycle,
} from '@/machines/transfer/directTransferServerLifecycle';
import { createTailscaleTransferServeLifecycle } from '@/machines/transfer/tailscaleTransferServeLifecycle';
import { isLoopbackTransferBindHost, resolveMachineTransferRuntimeConfig } from '@/machines/transfer/transferRuntimeConfig';
import { createDaemonTransferRuntimeState, createDaemonTransferRuntimeStatePublisher } from '../transferRuntimeState';
import { resolveTailscaleTransferListenerState } from '../resolveTailscaleTransferListenerState';
import { createPromptAssetAdapterRegistry } from '@/prompts/assets/createPromptAssetAdapterRegistry';
import { createPromptRegistryAdapterRegistry } from '@/prompts/registries/createPromptRegistryAdapterRegistry';
import { createConnectedServicesAuthUpdatedRestartHandler } from '../connectedServices/refresh/createConnectedServicesAuthUpdatedRestartHandler';
import {
  type ConnectedServiceDaemonRestartDiagnosticInput,
  type ConnectedServiceDaemonRestartDiagnosticRecord,
} from '../connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import { logConnectedServiceDaemonRestartDiagnostic } from './logConnectedServiceDaemonRestartDiagnostic';
import { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import { startConnectedServiceRefreshLoop } from '../connectedServices/refresh/startConnectedServiceRefreshLoop';
import { dispatchConnectedServiceCredentialHealthNotificationAsync } from '../connectedServices/notifications/dispatchConnectedServiceCredentialHealthNotification';
import { ConnectedServiceQuotasCoordinator } from '../connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { createConnectedServiceQuotaFetchers } from '../connectedServices/quotas/createConnectedServiceQuotaFetchers';
import { resolveConnectedServiceQuotasDaemonOptions } from '../connectedServices/quotas/resolveConnectedServiceQuotasDaemonOptions';
import { resolveConnectedServicesQuotasDaemonEnabled } from '../connectedServices/quotas/resolveConnectedServicesQuotasDaemonEnabled';
import { startConnectedServiceQuotasLoop } from '../connectedServices/quotas/startConnectedServiceQuotasLoop';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  createDaemonServerWorkBudget,
  createDaemonServerWorkScheduler,
  type DaemonServerWorkScheduler,
} from '../serverWork';
import { parseBooleanEnv } from '@happier-dev/protocol';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { warmActiveAccountSettingsSnapshotBestEffort } from '@/settings/accountSettings/warmActiveAccountSettingsSnapshot';
import { getSessionNotificationTitle } from '@/agent/runtime/notifications/sessionNotificationContext';

import { writeDaemonState } from '@/persistence';
import type { Credentials, DaemonLocallyPersistedState } from '@/persistence';
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
  credentials: Credentials;
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
  happyHomeDir: string;
  activeServerDir: string;
  filesystemAccessPolicy: FilesystemAccessPolicy;
  publicReleaseChannel: NonNullable<DaemonState['publicReleaseChannel']>;
  connectedServicesRestartRequestedPids: Set<number>;
  pidToTrackedSession: Map<number, TrackedSession>;
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
      reason: 'usage_limit' | 'soft_threshold' | 'auth_expired' | 'account_changed' | 'refresh_failed';
    }>) => Promise<unknown>;
  }>;
  /**
   * K3 (D7): gated credential-refresh / reconnect restart adapter. Routes the refresh
   * handler's restart through the turn-deferral queue + spawn-time reachability gate
   * (no raw mid-turn SIGTERM).
   */
  requestConnectedServiceRefreshRestartSignal: (signalParams: Readonly<{
    pid: number;
    delayMs: number;
    preferProcessGroup?: boolean;
    shouldSignal?: () => boolean;
    onSignalFailure: (error: unknown) => void;
    restartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticInput;
    recordRestartDiagnostic?: (record: ConnectedServiceDaemonRestartDiagnosticRecord) => void;
      nowMs?: () => number;
  }>) => Promise<Readonly<{ signaled: boolean }>>;
  connectedServiceRecoverySoftSwitchGuard?: ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['softSwitchRecoveryGuard'];
  /**
   * K2: the single runtime quota-snapshot store, owned by startDaemonSessionControlRuntime.
   * The quotas coordinator must record into the SAME store the proactive pre-turn coordinator
   * reads from, so proactive candidate selection sees probed snapshots (single-store design).
   */
  connectedServiceRuntimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
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
  // Incident Jun-11 H-A / FIX-1a: populate the in-memory account-settings snapshot at daemon
  // startup, best-effort and non-blocking. Without this, every getActiveAccountSettingsSnapshot()
  // consumer (switch continuity, resume prompts, materializers) silently degrades after a daemon
  // restart until the first spawn/settings hint arrives.
  void warmActiveAccountSettingsSnapshotBestEffort({
    credentials: params.credentials,
    logger: params.logger,
  });

  const directPeerRuntimeConfig = resolveMachineTransferRuntimeConfig();
  const directTransferPromptAssetAdapterRegistry = createPromptAssetAdapterRegistry();
  const directTransferPromptRegistryRegistry = createPromptRegistryAdapterRegistry();
  const directPeerServerEnabled = directPeerRuntimeConfig.directPeer.serverEnabled;
  const directPeerLocalListenerClasses: readonly ('loopback_http' | 'lan_http')[] =
    isLoopbackTransferBindHost(directPeerRuntimeConfig.directPeer.bindHost)
      ? ['loopback_http' as const]
      : ['lan_http' as const];
  const directPeerTransferListenerClasses = [
    ...directPeerLocalListenerClasses,
    ...(directPeerRuntimeConfig.tailscaleServe.enabled ? ['tailscale_serve_https' as const] : []),
  ] as const;
  const directPeerAdvertisedHosts = directPeerLocalListenerClasses.includes('loopback_http')
    ? ['127.0.0.1']
    : directPeerRuntimeConfig.directPeer.advertisedHosts;

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
        promptAssetUpload: {
          adapterRegistry: directTransferPromptAssetAdapterRegistry,
        },
        resolveTailscaleServeHttpsBaseUrl: () => tailscaleTransferServeLifecycle?.getHttpsBaseUrlWithServePath() ?? null,
        onStateChange: (state) => {
          void transferRuntimeStatePublisher?.publishDirectTransferServerLifecycleState(state);
          void tailscaleTransferServeLifecycle?.observeDirectTransferServerLifecycleState(state);
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

  const fileState: DaemonLocallyPersistedState = {
    pid: process.pid,
    httpPort: params.controlPort,
    startedAt: Date.now(),
    startedWithCliVersion: params.cliVersion,
    startedWithPublicReleaseChannel: params.publicReleaseChannel,
    runtimeId: params.runtimeId,
    startupSource: params.startupSource,
    serviceLabel: params.serviceLabel,
    machineId: params.machineId,
    daemonLogPath: params.daemonLogPath,
    controlToken: params.controlToken,
  };
  writeDaemonState(fileState);
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

  const connectedServicesRefreshEnabled = parseBooleanEnv(params.processEnv.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED, true);
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

    const restartPiOnAuthUpdate = parseBooleanEnv(
      params.processEnv.HAPPIER_CONNECTED_SERVICES_REFRESH_RESTART_PI_ENABLED,
      true,
    );
    const recordConnectedServiceRestartDiagnostic = (record: ConnectedServiceDaemonRestartDiagnosticRecord) => {
      logConnectedServiceDaemonRestartDiagnostic(params.logger, record);
    };

    const onAuthUpdated =
      restartPiOnAuthUpdate
        ? createConnectedServicesAuthUpdatedRestartHandler({
            restartRequestedPids: params.connectedServicesRestartRequestedPids,
            pidToTrackedSession: params.pidToTrackedSession,
            restartAgentIds: new Set(['pi']),
            // K3: route refresh/reconnect restarts through the gated deferral primitive
            // (turn-deferral + spawn-time reachability), not a raw mid-turn SIGTERM.
            requestRestartSignal: params.requestConnectedServiceRefreshRestartSignal,
            restartSignalDelayMs: resolvePositiveIntEnv(
              params.processEnv.HAPPIER_CONNECTED_SERVICES_REFRESH_RESTART_SIGNAL_DELAY_MS,
              250,
              { min: 0, max: 5_000 },
            ),
            recordRestartDiagnostic: recordConnectedServiceRestartDiagnostic,
          })
        : undefined;

    connectedServiceRefreshCoordinator = new ConnectedServiceRefreshCoordinator({
      api: params.api,
      credentials: params.credentials,
      machineIdProvider: params.machineIdProvider,
      ownerIdProvider: () => `${params.machineId}:${params.runtimeId}`,
      activeServerDir: params.activeServerDir,
      baseDir: join(params.happyHomeDir, 'daemon', 'connected-services', 'materialized'),
      refreshWindowMs,
      refreshLeaseMs,
      now: () => Date.now(),
      accountSettingsProvider: () => getActiveAccountSettingsSnapshot()?.settings ?? null,
      processEnv: params.processEnv,
      ...(onAuthUpdated ? { onAuthUpdated } : {}),
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
      onTickError: (error) => {
        params.logger.debug('[DAEMON RUN] Connected services refresh tick failed (non-fatal)', error);
      },
    });
  }

  const connectedServicesQuotasEnabled = await resolveConnectedServicesQuotasDaemonEnabled({
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

    connectedServiceQuotasCoordinator = new ConnectedServiceQuotasCoordinator({
      api: params.api,
      credentials: params.credentials,
      quotaFetchers: createConnectedServiceQuotaFetchers(params.processEnv),
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
      serverWorkScheduler: daemonServerWorkScheduler,
      quotaPersistenceServerScope: params.activeServerDir,
      quotaPersistenceMaxConsecutiveFailures: resolvePositiveIntEnv(
        params.processEnv.HAPPIER_CONNECTED_SERVICES_QUOTA_IN_BAND_MAX_CONSECUTIVE_FAILURES,
        5,
        { min: 1, max: 100 },
      ),
      groupSwitchCheckMinIntervalMs,
      // K2 (cmpn4hhdi fix): the proactive quota pre-turn switch coordinator is built by
      // startDaemonSessionControlRuntime (where the FSM/deferral/hot-apply primitives live)
      // and injected here. It routes the proactive usage-limit switch through the FSM
      // hot-apply/gated-apply path (no raw mid-turn SIGTERM); the previous raw coordinator
      // that bypassed the FSM/deferral/reachability gate has been removed.
      authGroupSwitchCoordinator: params.connectedServiceAuthGroupPreTurnSwitchCoordinator,
      softSwitchRecoveryGuard: params.connectedServiceRecoverySoftSwitchGuard ?? null,
      now: () => Date.now(),
      randomBytes: (length) => randomBytes(length),
    });

    connectedServiceQuotasLoopHandle = startConnectedServiceQuotasLoop({
      enabled: true,
      tickMs: quotasTickMs,
      coordinator: connectedServiceQuotasCoordinator,
      onTickError: (error) => {
        params.logger.debug('[DAEMON RUN] Connected services quotas tick failed (non-fatal)', error);
      },
    });
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
