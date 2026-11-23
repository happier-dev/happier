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
  // An authenticated publication can confirm takeover while the platform probe lags.
  const needsServiceProof = !serviceSnapshot.installed && daemonServiceManaged === true
    && daemonServiceLabel != null && daemonServiceLabel === serviceSnapshot.label;
  const publishedPresence = daemonRunning && daemonState?.controlToken && (daemonState.machineControlReady === true || needsServiceProof)
    ? await inspectPublishedDaemonPresence(daemonState).catch(() => null) : null;
  const currentPublication = publishedPresence?.status === 'running' && publishedPresence.controlVerified
    ? publishedPresence : null;
  let daemonHealthy: boolean | null = daemonRunning ? daemonState?.machineControlReady ?? null : false;
  if (daemonHealthy === true) daemonHealthy = currentPublication?.machineControlReady ?? null;
  const serviceInstalled = serviceSnapshot.installed || (needsServiceProof && currentPublication !== null);

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
