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
import { createPromptAssetAdapterRegistry } from '@/promptAssets/createPromptAssetAdapterRegistry';
import { createPromptRegistryAdapterRegistry } from '@/promptRegistries/createPromptRegistryAdapterRegistry';
import { createConnectedServicesAuthUpdatedRestartHandler } from '../connectedServices/refresh/createConnectedServicesAuthUpdatedRestartHandler';
import { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import { startConnectedServiceRefreshLoop } from '../connectedServices/refresh/startConnectedServiceRefreshLoop';
import { ConnectedServiceQuotasCoordinator } from '../connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { createConnectedServiceQuotaFetchers } from '../connectedServices/quotas/createConnectedServiceQuotaFetchers';
import { resolveConnectedServiceQuotasDaemonOptions } from '../connectedServices/quotas/resolveConnectedServiceQuotasDaemonOptions';
import { resolveConnectedServicesQuotasDaemonEnabled } from '../connectedServices/quotas/resolveConnectedServicesQuotasDaemonEnabled';
import { startConnectedServiceQuotasLoop } from '../connectedServices/quotas/startConnectedServiceQuotasLoop';
import { parseBooleanEnv } from '@happier-dev/protocol';

import { writeDaemonState } from '@/persistence';
import type { Credentials, DaemonLocallyPersistedState } from '@/persistence';
import { configuration } from '@/configuration';
import type { PromptRegistryRegistry } from '@/promptRegistries/createPromptRegistryAdapterRegistry';
import type { DaemonStartupSource } from '../ownership/daemonOwnershipMetadata';
import { isDaemonStartupSourceServiceManaged } from '../ownership/daemonOwnershipMetadata';
import type { TrackedSession } from '../types';

type LoggerLike = Readonly<{
  debug: (message: string, details?: unknown) => void;
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
  publicReleaseChannel: NonNullable<DaemonState['publicReleaseChannel']>;
  connectedServicesRestartRequestedPids: Set<number>;
  pidToTrackedSession: Map<number, TrackedSession>;
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
  stopDirectPeerServer: () => Promise<void>;
  stopTailscaleTransferServeLifecycle: () => Promise<void>;
}>;

export async function startDaemonRuntimeBootstrap(
  params: StartDaemonRuntimeBootstrapParams,
): Promise<StartDaemonRuntimeBootstrapResult> {
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
    const onAuthUpdated =
      restartPiOnAuthUpdate
        ? createConnectedServicesAuthUpdatedRestartHandler({
            restartRequestedPids: params.connectedServicesRestartRequestedPids,
            pidToTrackedSession: params.pidToTrackedSession,
            restartAgentIds: new Set(['pi']),
          })
        : undefined;

    connectedServiceRefreshCoordinator = new ConnectedServiceRefreshCoordinator({
      api: params.api,
      credentials: params.credentials,
      machineIdProvider: params.machineIdProvider,
      activeServerDir: params.activeServerDir,
      baseDir: join(params.happyHomeDir, 'daemon', 'connected-services', 'materialized'),
      refreshWindowMs,
      refreshLeaseMs,
      now: () => Date.now(),
      ...(onAuthUpdated ? { onAuthUpdated } : {}),
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
    stopDirectPeerServer,
    stopTailscaleTransferServeLifecycle,
  };
}
