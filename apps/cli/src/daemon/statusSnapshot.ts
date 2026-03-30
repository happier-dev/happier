import { createServerUrlComparableKey, type DoctorSnapshot } from '@happier-dev/protocol';

import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { readCredentials, readDaemonState, readSettings } from '@/persistence';
import { resolveDaemonServiceInstallationSnapshotFromEnv } from '@/daemon/service/cli';

export type DaemonStatusSnapshot = NonNullable<DoctorSnapshot['daemonStatus']>;

function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
    readCredentials(),
    readDaemonState().catch(() => null),
  ]);

  const activeServerId = configuration.activeServerId;
  const activeServer = settings.servers?.[activeServerId];
  const localServerUrl = typeof activeServer?.localServerUrl === 'string' && activeServer.localServerUrl.trim()
    ? activeServer.localServerUrl.trim()
    : null;

  const pid = typeof daemonState?.pid === 'number' ? daemonState.pid : null;
  const daemonRunning = isPidAlive(pid);
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
  const serviceSnapshot = resolveDaemonServiceInstallationSnapshotFromEnv();

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
    },
    service: {
      installed: serviceSnapshot.installed,
      running: serviceSnapshot.installed && daemonRunning,
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
