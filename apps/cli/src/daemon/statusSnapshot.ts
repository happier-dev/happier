import { createServerUrlComparableKey, type DoctorSnapshot } from '@happier-dev/protocol';

import { resolveActiveServerAuthReadiness } from '@/auth/resolveActiveServerAuthReadiness';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { isDaemonRunningCurrentlyInstalledHappyVersion } from '@/daemon/controlClient';
import { resolveDaemonStartupSourceServiceManagedState } from '@/daemon/ownership/daemonOwnershipMetadata';
import { evaluateCurrentDaemonOwner, type DaemonOwnerEvaluation } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { readDaemonState, readSettings } from '@/persistence';
import { resolveDaemonServiceInstallationSnapshotFromEnv } from '@/daemon/service/cli';
import { maybeRefreshCliUpdateCacheInBackground } from '@/cli/runtime/update/autoUpdateNotice';
import { readCliUpdateFactsForThisCli } from '@/cli/runtime/update/cliUpdateFacts';
import { compareVersions } from '@happier-dev/cli-common/update';
import { projectPath } from '@/projectPath';

export type DaemonStatusSnapshot = NonNullable<DoctorSnapshot['daemonStatus']>;
export type DaemonRuntimeConvergence = NonNullable<DaemonStatusSnapshot['runtimeConvergence']>;

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

function readTokenSubject(token: string | null | undefined): string | null {
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
}

/**
 * What the running daemon is actually doing, as opposed to the files beside it.
 *
 * Liveness is the authenticated control endpoint (never host-visible PID equality),
 * ownership is the canonical owner evaluation, and identity/version are read from the
 * state that evaluation proved live. A daemon left running as one account while another
 * account's credentials were written is therefore reported as not converged.
 */
async function deriveRuntimeConvergence(params: Readonly<{
  expectedMachineId: string | null;
  expectedServiceLabel: string;
  serviceInstalled: boolean;
}>): Promise<DaemonRuntimeConvergence> {
  const evaluation: DaemonOwnerEvaluation = await evaluateCurrentDaemonOwner();
  const runningOwner = evaluation.kind !== 'none' && evaluation.owner.source === 'state' && (evaluation.owner.status === 'running' || evaluation.owner.status === 'starting')
    ? evaluation.owner
    : null;
  if (!runningOwner) {
    return {
      controlReachable: false,
      daemonStarting: false,
      serviceOwnsRunningDaemon: false,
      machineIdMatches: false,
      cliVersionMatches: false,
    };
  }

  const runningMachineId = typeof runningOwner.state.machineId === 'string' ? runningOwner.state.machineId.trim() : '';
  const runningServiceLabel = typeof runningOwner.state.serviceLabel === 'string' ? runningOwner.state.serviceLabel.trim() : '';
  const isStarting = runningOwner.status === 'starting';
  return {
    controlReachable: runningOwner.status === 'running',
    daemonStarting: isStarting,
    serviceOwnsRunningDaemon: evaluation.kind === 'compatible'
      && runningOwner.serviceManaged === true
      && params.serviceInstalled
      && runningServiceLabel === params.expectedServiceLabel,
    machineIdMatches: params.expectedMachineId !== null && runningMachineId === params.expectedMachineId,
    cliVersionMatches: await isDaemonRunningCurrentlyInstalledHappyVersion(),
  };
}

/**
 * This CLI's update state for the desktop's Update action (plan R17) and its K5 update facts
 * (plan R13) — the same facts the daemon publishes in machine metadata. The status read is the
 * ambient fast path, so it only reads the channel's cached daily check and, when that is stale,
 * lets the existing background refresh run for the next read — never a network call here.
 */
function readCliUpdate(): DaemonStatusSnapshot['cliUpdate'] {
  maybeRefreshCliUpdateCacheInBackground({
    homeDir: configuration.happyHomeDir,
    cliRootDir: projectPath(),
    env: process.env,
    publicReleaseRing: configuration.publicReleaseRing,
  });
  const facts = readCliUpdateFactsForThisCli();
  return {
    ...facts,
    updateAvailable: facts.latestVersion !== null && compareVersions(facts.latestVersion, facts.currentVersion) > 0,
  };
}

export async function readDaemonStatusSnapshot(): Promise<DaemonStatusSnapshot> {
  const [settings, authReadiness, daemonState] = await Promise.all([
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
  const machineId = authReadiness.machineId;
  const credentials = authReadiness.credentials;
  const serviceSnapshot = resolveDaemonServiceInstallationSnapshotFromEnv();
  const runtimeConvergence = await deriveRuntimeConvergence({
    expectedMachineId: machineId,
    expectedServiceLabel: serviceSnapshot.label,
    serviceInstalled: serviceSnapshot.installed,
  });
  const daemonRunning = runtimeConvergence.controlReachable || runtimeConvergence.daemonStarting;

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
      serviceManaged: resolveDaemonStartupSourceServiceManagedState(daemonState?.startupSource, daemonState?.serviceLabel),
      serviceLabel: typeof daemonState?.serviceLabel === 'string'
        ? daemonState.serviceLabel
        : null,
    },
    service: {
      installed: serviceSnapshot.installed,
      running: serviceSnapshot.installed && daemonRunning,
      targetMode: serviceSnapshot.targetMode,
      autostart: serviceSnapshot.autostart,
    },
    auth: {
      authenticated: credentials != null,
      machineRegistered: machineId != null,
      machineId,
      needsAuth: credentials == null || machineId == null,
      accountId: readTokenSubject(credentials?.token),
      credentialState: authReadiness.credentialState,
      validatedAccountId: authReadiness.validatedAccountId,
      accountLabel: authReadiness.validatedAccountLabel,
    },
    runtimeConvergence,
    cliUpdate: readCliUpdate(),
  };
}
