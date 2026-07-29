import {
  createManagedEndpointSupervisor,
  DEFAULT_MANAGED_CONNECTION_POLICY,
} from '@happier-dev/connection-supervisor';

import { createLoopbackReadinessProbe } from '@/api/connection/createLoopbackReadinessProbe';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import type { ApiClient } from '@/api/api';
import type { MachineMetadata } from '@/api/types';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';
import type { ConnectedServiceQuotasLoopHandle } from '../connectedServices/quotas/startConnectedServiceQuotasLoop';
import { startDaemonMachineRegistration } from '../machine/startDaemonMachineRegistration';
import type {
  MachineRegistrationRetryLoopHandle,
  MachineRegistrationRetryWakeSource,
} from '../machine/startMachineRegistrationRetryLoop';

type ResolvePositiveIntEnv = (
  raw: string | undefined,
  fallback: number,
  bounds: { min: number; max: number },
) => number;

function createMachineRegistrationRetryWakeSource(
  params: Readonly<{ token: string }>,
): MachineRegistrationRetryWakeSource {
  let supervisor: ReturnType<typeof createManagedEndpointSupervisor> | null = null;
  let startPromise: Promise<void> | null = null;

  const getSupervisor = () => {
    if (supervisor) return supervisor;
    supervisor = createManagedEndpointSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      probeReadiness: createLoopbackReadinessProbe({
        serverUrl: configuration.apiServerUrl,
        token: params.token,
      }),
    });
    return supervisor;
  };

  const ensureStarted = () => {
    if (startPromise) return;
    startPromise = getSupervisor().start().catch((error) => {
      startPromise = null;
      logger.warn('[DAEMON RUN] Failed to start machine registration readiness probe', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  };

  return {
    reportFailure: (report) => {
      const current = getSupervisor();
      ensureStarted();
      current.reportFailure(report);
    },
    invalidate: () => {
      const current = getSupervisor();
      ensureStarted();
      current.invalidate();
    },
    subscribe: (listener) => getSupervisor().subscribe(listener),
    stop: async () => {
      const current = supervisor;
      supervisor = null;
      startPromise = null;
      await current?.stop();
    },
  };
}

export function startDaemonMachineRegistrationRuntime(
  params: Readonly<{
    api: ApiClient;
    credentials: Pick<Credentials, 'token'>;
    metadataForRegistration: MachineMetadata;
    initialDaemonState: Parameters<typeof startDaemonMachineRegistration>[0]['initialDaemonState'];
    processEnv: NodeJS.ProcessEnv;
    resolvePositiveIntEnv: ResolvePositiveIntEnv;
    resolvesWhenShutdownRequested: Promise<unknown>;
    initialPreflightMachineRegistration: Parameters<typeof startDaemonMachineRegistration>[0]['initialPreflightMachineRegistration'];
    resolveMachineId: () => string;
    setMachineId: (resolvedMachineId: string) => void;
    isShuttingDown: () => boolean;
    isQuiescing?: () => boolean;
    bootstrapRuntime: Omit<
      Parameters<typeof startDaemonMachineRegistration>[0]['bootstrapRuntime'],
      | 'preferredHost'
      | 'happyHomeDir'
      | 'happyLibDir'
      | 'filesystemAccessPolicy'
      | 'takeoverRequested'
      | 'connectedServiceRefreshLoopHandle'
      | 'connectedServiceQuotasLoopHandle'
    >;
    onMachineSyncRuntime: Parameters<typeof startDaemonMachineRegistration>[0]['onMachineSyncRuntime'];
    filesystemAccessPolicy: Parameters<typeof startDaemonMachineRegistration>[0]['bootstrapRuntime']['filesystemAccessPolicy'];
    takeoverRequested: boolean;
    preferredHost: string;
    connectedServiceRefreshLoopHandle: Readonly<{
      stop: () => void;
      pause: () => void;
      resume: () => void;
    }> | null;
    connectedServiceQuotasLoopHandle: ConnectedServiceQuotasLoopHandle | null;
  }>,
): MachineRegistrationRetryLoopHandle {
  const machineRegistrationTimeoutMs = params.resolvePositiveIntEnv(
    params.processEnv.HAPPIER_DAEMON_MACHINE_REGISTRATION_TIMEOUT_MS,
    10_000,
    { min: 250, max: 120_000 },
  );
  const machineRegistrationRetryBaseDelayMs = params.resolvePositiveIntEnv(
    params.processEnv.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_BASE_DELAY_MS
      ?? params.processEnv.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS,
    10_000,
    { min: 0, max: 5 * 60_000 },
  );
  const machineRegistrationRetryMaxDelayMs = params.resolvePositiveIntEnv(
    params.processEnv.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_MAX_DELAY_MS,
    5 * 60_000,
    { min: 0, max: 30 * 60_000 },
  );
  const machineRegistrationRetryJitterMs = params.resolvePositiveIntEnv(
    params.processEnv.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_JITTER_MS,
    1_000,
    { min: 0, max: 60_000 },
  );
  const machineRegistrationRetryEffectiveMaxDelayMs = Math.max(
    machineRegistrationRetryBaseDelayMs,
    machineRegistrationRetryMaxDelayMs,
  );
  const machineRegistrationMaxAttempts = params.resolvePositiveIntEnv(
    params.processEnv.HAPPIER_DAEMON_MACHINE_REGISTRATION_MAX_ATTEMPTS,
    0,
    { min: 0, max: 10_000 },
  );
  const machineRegistrationRetryWakeSource = createMachineRegistrationRetryWakeSource({
    token: params.credentials.token,
  });

  return startDaemonMachineRegistration({
    api: params.api,
    metadataForRegistration: params.metadataForRegistration,
    initialDaemonState: params.initialDaemonState,
    machineRegistrationTimeoutMs,
    machineRegistrationRetryBaseDelayMs,
    machineRegistrationRetryMaxDelayMs: machineRegistrationRetryEffectiveMaxDelayMs,
    machineRegistrationRetryJitterMs,
    machineRegistrationMaxAttempts,
    resolvesWhenShutdownRequested: params.resolvesWhenShutdownRequested,
    initialPreflightMachineRegistration: params.initialPreflightMachineRegistration,
    resolveMachineId: params.resolveMachineId,
    setMachineId: params.setMachineId,
    isShuttingDown: params.isShuttingDown,
    ...(params.isQuiescing ? { isQuiescing: params.isQuiescing } : {}),
    machineRegistrationRetryWakeSource,
    bootstrapRuntime: {
      ...params.bootstrapRuntime,
      preferredHost: params.preferredHost,
      happyHomeDir: configuration.happyHomeDir,
      happyLibDir: projectPath(),
      filesystemAccessPolicy: params.filesystemAccessPolicy,
      takeoverRequested: params.takeoverRequested,
      connectedServiceRefreshLoopHandle: params.connectedServiceRefreshLoopHandle,
      connectedServiceQuotasLoopHandle: params.connectedServiceQuotasLoopHandle,
    },
    onMachineSyncRuntime: params.onMachineSyncRuntime,
  });
}
