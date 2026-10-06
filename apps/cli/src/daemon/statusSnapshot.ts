import { isPidPresent } from '@happier-dev/cli-common/process';
import { createServerUrlComparableKey } from '@happier-dev/protocol/server/urls/serverUrlComparableKey';
import type { DoctorSnapshot } from '@happier-dev/protocol';

import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { resolveActiveServerAuthReadiness } from '@/auth/resolveActiveServerAuthReadiness';
import { readDaemonState, readSettings } from '@/persistence';
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
  const [settings, readiness, daemonState] = await Promise.all([
    readSettings(),
    resolveActiveServerAuthReadiness(),
    readDaemonState().catch(() => null),
  ]);

  const activeServerId = configuration.activeServerId;
  const activeServer = settings.servers?.[activeServerId];
  const localServerUrl = typeof activeServer?.localServerUrl === 'string' && activeServer.localServerUrl.trim()
    ? activeServer.localServerUrl.trim()
    : null;

  const pid = typeof daemonState?.pid === 'number' ? daemonState.pid : null;
  const daemonRunning = pid != null && isPidPresent(pid);
  // Process presence and service health are separate questions and this snapshot answers both
  // separately. `running` stays exactly what it was — a PID probe — because start, repair and
  // stale-state paths need to know a process is there. `healthy` is the daemon's own last word
  // on whether it can serve a machine RPC; a probe cannot derive it, so when the daemon has not
  // published it the answer is unknown rather than a guess in either direction.
  const daemonHealthy = !daemonRunning
    ? false
    : typeof daemonState?.machineControlReady === 'boolean'
      ? daemonState.machineControlReady
      : null;
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
      autostart: serviceSnapshot.autostart ?? null,
      running: serviceInstalled && daemonRunning,
    },
    auth: {
      authenticated: readiness.authenticated,
      credentialState: readiness.credentialState,
      machineRegistered: readiness.machineRegistered,
      machineRegistrationState: readiness.machineRegistrationState,
      machineId,
      needsAuth: !readiness.authenticated || !readiness.machineRegistered,
      accountId,
      accountLabel: readiness.accountLabel,
    },
  };
}
import { resolveDaemonStartupSourceServiceManagedState } from '@/daemon/ownership/daemonOwnershipMetadata';
