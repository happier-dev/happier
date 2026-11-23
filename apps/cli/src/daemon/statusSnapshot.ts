import { isPidPresent } from '@happier-dev/cli-common/process';
import { createServerUrlComparableKey } from '@happier-dev/protocol/server/urls/serverUrlComparableKey';
import type { DoctorSnapshot } from '@happier-dev/protocol';

import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { resolveActiveServerAuthReadiness } from '@/auth/resolveActiveServerAuthReadiness';
import { readDaemonState } from '@/persistence';
import { inspectPublishedDaemonPresence } from '@/daemon/controlClient';
import { resolveDaemonServiceInstallationSnapshotFromEnv } from '@/daemon/service/cli';

export type DaemonStatusSnapshot = NonNullable<DoctorSnapshot['daemonStatus']>;

function resolveComparableKey(rawUrl: string): string | null {
  const value = String(rawUrl ?? '').trim();
  if (!value) {
    return null;
  }
  try {
    return createServerUrlComparableKey(value);
  } catch {
    return null;
  }
}

export async function readDaemonStatusSnapshot(): Promise<DaemonStatusSnapshot> {
  const [readiness, daemonState] = await Promise.all([
    resolveActiveServerAuthReadiness(),
    readDaemonState().catch(() => null),
  ]);

  const activeServerId = configuration.activeServerId;
  const localServerUrl = configuration.apiServerUrl !== configuration.serverUrl
    ? configuration.apiServerUrl : null;

  const pid = typeof daemonState?.pid === 'number' ? daemonState.pid : null;
  const daemonRunning = pid != null && isPidPresent(pid);
  // A ready publication must still belong to the listener that wrote it.
  // Preserve the PID-based observation for callers that need local process presence.
  let daemonHealthy: boolean | null = daemonRunning ? daemonState?.machineControlReady ?? null : false;
  if (daemonHealthy === true && daemonState) {
    const presence = await inspectPublishedDaemonPresence(daemonState).catch(() => null);
    daemonHealthy = presence?.status === 'running' ? presence.machineControlReady ?? null : null;
  }
  const machineId = readiness.machineId;
  const accountId = (() => {
    const token = readiness.credentials?.token ?? '';
    if (!token) {
      return null;
    }
    return readAccountIdFromToken(token);
  })();
  const serviceSnapshot = await resolveDaemonServiceInstallationSnapshotFromEnv();
  const daemonServiceLabel = typeof daemonState?.serviceLabel === 'string'
    ? daemonState.serviceLabel
    : null;
  const daemonServiceManaged = resolveDaemonStartupSourceServiceManagedState(daemonState?.startupSource, daemonServiceLabel);
  // Treat the current relay as service-installed when the running daemon is already owned
  // by the expected background-service label, even if the filesystem probe lags after takeover.
  const serviceInstalled = serviceSnapshot.installed || (
    daemonRunning
    && daemonServiceManaged === true
    && daemonServiceLabel != null
    && daemonServiceLabel === serviceSnapshot.label
  );

  return {
    server: {
      activeServerId,
      serverUrl: configuration.serverUrl,
      localServerUrl,
      publicServerUrl: configuration.publicServerUrl,
      webappUrl: configuration.webappUrl,
      comparableKey: resolveComparableKey(configuration.publicServerUrl || configuration.serverUrl),
    },
    daemon: {
      running: daemonRunning,
      healthy: daemonHealthy,
      pid,
      httpPort: typeof daemonState?.httpPort === 'number' && daemonState.httpPort > 0 ? daemonState.httpPort : null,
      startedWithCliVersion: typeof daemonState?.startedWithCliVersion === 'string'
        ? daemonState.startedWithCliVersion
        : undefined,
      startedWithPublicReleaseChannel: daemonState?.startedWithPublicReleaseChannel ?? null,
      runtimeId: typeof daemonState?.runtimeId === 'string' ? daemonState.runtimeId : undefined,
      startupSource: typeof daemonState?.startupSource === 'string' ? daemonState.startupSource : undefined,
      serviceManaged: daemonServiceManaged,
      serviceLabel: daemonServiceLabel,
    },
    service: {
      installed: serviceInstalled,
      autostart: serviceSnapshot.autostart ?? null,
      running: serviceInstalled && daemonRunning,
    },
    auth: {
      authenticated: readiness.authenticated,
      credentialState: readiness.credentialState,
      machineRegistered: readiness.machineRegistered,
      machineRegistrationState: readiness.machineRegistrationState,
      machineId,
      needsAuth: readiness.unusableReason !== null || !readiness.machineRegistered,
      accountId,
      accountLabel: readiness.accountLabel,
    },
  };
}
import { resolveDaemonStartupSourceServiceManagedState } from '@/daemon/ownership/daemonOwnershipMetadata';
