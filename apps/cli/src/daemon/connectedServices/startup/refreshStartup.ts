import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import type { AccountSettings } from '@happier-dev/protocol';
import {
  ConnectedServiceRefreshCoordinator,
} from '../refresh/ConnectedServiceRefreshCoordinator';
import {
  startConnectedServiceRefreshLoop,
} from '../refresh/startConnectedServiceRefreshLoop';
import type { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';

type RefreshCoordinatorParams = ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0];

export function startConnectedServiceRefreshStartup(input: Readonly<{
  env: NodeJS.ProcessEnv;
  api: ApiClient;
  credentials: Credentials;
  runtimeRegistry: ConnectedServiceRuntimeRegistry;
  machineId: string;
  runtimeId: string;
  activeServerDir: string;
  baseDir: string;
  resolvePositiveIntEnv: (raw: string | undefined, fallback: number, bounds: {
    min: number;
    max: number;
  }) => number;
  parseBooleanEnv: (raw: string | undefined, fallback: boolean) => boolean;
  resolveProjectedCredentialHealth?: RefreshCoordinatorParams['resolveProjectedCredentialHealth'];
  accountSettingsProvider: () => AccountSettings | Readonly<Record<string, unknown>> | null | undefined;
  onAuthUpdated?: RefreshCoordinatorParams['onAuthUpdated'];
  onCredentialHealthNotification: NonNullable<RefreshCoordinatorParams['onCredentialHealthNotification']>;
  registerCurrentTargets: () => void;
  onTickError: (error: unknown) => void;
}>): Readonly<{
  coordinator: ConnectedServiceRefreshCoordinator | null;
  loopHandle: ReturnType<typeof startConnectedServiceRefreshLoop> | null;
}> {
  const connectedServicesRefreshEnabled = input.parseBooleanEnv(
    input.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED,
    true,
  );
  if (!connectedServicesRefreshEnabled) {
    return { coordinator: null, loopHandle: null };
  }

  const refreshTickMs = input.resolvePositiveIntEnv(
    input.env.HAPPIER_CONNECTED_SERVICES_REFRESH_TICK_MS,
    30_000,
    { min: 5_000, max: 5 * 60_000 },
  );
  const refreshWindowMs = input.resolvePositiveIntEnv(
    input.env.HAPPIER_CONNECTED_SERVICES_REFRESH_WINDOW_MS,
    10 * 60_000,
    { min: 10_000, max: 60 * 60_000 },
  );
  const refreshLeaseMs = input.resolvePositiveIntEnv(
    input.env.HAPPIER_CONNECTED_SERVICES_REFRESH_LEASE_MS,
    2 * 60_000,
    { min: 10_000, max: 30 * 60_000 },
  );
  const refreshLeaseContentionWaitMaxMs = input.resolvePositiveIntEnv(
    input.env.HAPPIER_CONNECTED_SERVICES_REFRESH_LEASE_CONTENTION_WAIT_MAX_MS,
    5_000,
    { min: 0, max: 30_000 },
  );

  const coordinator = new ConnectedServiceRefreshCoordinator({
    api: input.api,
    credentials: input.credentials,
    runtimeRegistry: input.runtimeRegistry,
    machineIdProvider: () => input.machineId,
    ownerIdProvider: () => `${input.machineId}:${input.runtimeId}`,
    activeServerDir: input.activeServerDir,
    baseDir: input.baseDir,
    refreshWindowMs,
    refreshLeaseMs,
    leaseContentionWaitMaxMs: refreshLeaseContentionWaitMaxMs,
    now: () => Date.now(),
    resolveProjectedCredentialHealth: input.resolveProjectedCredentialHealth,
    accountSettingsProvider: input.accountSettingsProvider,
    processEnv: input.env,
    ...(input.onAuthUpdated ? { onAuthUpdated: input.onAuthUpdated } : {}),
    onCredentialHealthNotification: input.onCredentialHealthNotification,
  });
  input.registerCurrentTargets();

  const loopHandle = startConnectedServiceRefreshLoop({
    enabled: true,
    tickMs: refreshTickMs,
    coordinator,
    onTickError: input.onTickError,
  });

  return { coordinator, loopHandle };
}
