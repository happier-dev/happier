import { createServerUrlComparableKey, type DoctorSnapshot } from '@happier-dev/protocol';

import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { readDaemonState, readSettings, readStoredCredentials } from '@/persistence';
import { resolveDaemonServiceInstallationSnapshotFromEnv } from '@/daemon/service/cli';
import { isPidAliveBySignal } from '@/daemon/processRunState';

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
  const [settings, credentials, daemonState] = await Promise.all([
    readSettings(),
    readStoredCredentials(),
    readDaemonState().catch(() => null),
  ]);

  const activeServerId = configuration.activeServerId;
  const activeServer = settings.servers?.[activeServerId];
  const localServerUrl = typeof activeServer?.localServerUrl === 'string' && activeServer.localServerUrl.trim()
    ? activeServer.localServerUrl.trim()
    : null;

  const pid = typeof daemonState?.pid === 'number' ? daemonState.pid : null;
  const daemonRunning = pid != null && isPidAliveBySignal(pid);
  const machineId = typeof settings.machineId === 'string' && settings.machineId.trim()
    ? settings.machineId.trim()
    : null;
  const accountId = (() => {
    const token = credentials?.token ?? '';
    if (!token) {
      return null;
    }
    try {
      const payload = decodeJwtPayload(token);
      return typeof payload?.sub === 'string' && payload.sub.trim()
        ? payload.sub.trim()
        : null;
    } catch {
      return null;
    }
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
      pid,
      httpPort: typeof daemonState?.httpPort === 'number' ? daemonState.httpPort : null,
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
      running: serviceInstalled && daemonRunning,
    },
    auth: {
      authenticated: credentials != null,
      machineRegistered: machineId != null,
      machineId,
      needsAuth: credentials == null || machineId == null,
      accountId,
    },
  };
}
import { resolveDaemonStartupSourceServiceManagedState } from '@/daemon/ownership/daemonOwnershipMetadata';
