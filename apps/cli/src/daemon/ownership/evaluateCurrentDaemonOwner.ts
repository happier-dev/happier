import { readFileSync } from 'node:fs';

import { getReleaseRingCatalogEntry } from '@happier-dev/release-runtime/releaseRings';

import { configuration } from '@/configuration';
import {
  inspectDaemonRunningStateAndCleanupStaleState,
  type DaemonRunningInspection,
} from '@/daemon/controlClient';
import { resolveComparableCliVersion } from '@/daemon/resolveComparableCliVersion';
import { findAllHappyProcesses, type HappyProcessInfo } from '@/daemon/doctor';
import {
  resolveDaemonStartupSourceServiceManagedState,
  type DaemonStartupSource,
} from '@/daemon/ownership/daemonOwnershipMetadata';
import { projectPath } from '@/projectPath';

import type { DaemonLocallyPersistedState } from '@/persistence';
import { daemonProcessMatchesCurrentScope } from './daemonProcessScopeIdentity';

export type CurrentDaemonOwner = Readonly<{
  status: Extract<DaemonRunningInspection['status'], 'starting' | 'running'>;
  source: 'state' | 'process';
  state: DaemonLocallyPersistedState;
  currentCliVersion: string;
  currentPublicReleaseChannel: 'stable' | 'preview' | 'dev';
  versionMatches: boolean;
  releaseChannelMatches: boolean;
  serviceManaged: boolean | null;
  startupSource: DaemonStartupSource | 'unknown';
}>;

export type DaemonOwnerEvaluation =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'compatible'; owner: CurrentDaemonOwner }>
  | Readonly<{ kind: 'conflict'; owner: CurrentDaemonOwner }>;

function resolveCurrentCliVersion(): string {
  return resolveComparableCliVersion({
    fallbackVersion: configuration.currentCliVersion,
    projectRootPath: projectPath(),
    readFileSyncImpl: readFileSync,
  });
}

function normalizePathFragment(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

export function isDaemonProcessForCurrentRuntimeRoot(processInfo: HappyProcessInfo, currentRuntimeRoot: string): boolean {
  if (processInfo.pid === process.pid) return false;
  if (processInfo.type !== 'daemon' && processInfo.type !== 'dev-daemon') return false;

  const command = normalizePathFragment(processInfo.command);
  if (!command.includes(currentRuntimeRoot)) return false;

  // The process classifier labels both the transient `daemon start` launcher and the actual
  // `daemon start-sync` daemon as `daemon`/`dev-daemon`. Only `start-sync` is a real, long-lived
  // daemon owner. The launcher is a bootstrapper that spawns the detached daemon and then blocks
  // waiting for the relay, so counting it here makes managed startup conflict with its own
  // launcher — producing the all-"unknown" stateless-owner conflict that prevents the daemon from
  // ever coming up.
  return command.includes('daemon start-sync');
}

async function findStateLessDaemonProcessForCurrentRuntimeRoot(): Promise<HappyProcessInfo | null> {
  if (process.env.NODE_ENV === 'test' && process.env.HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK !== '1') {
    return null;
  }

  const currentRuntimeRoot = normalizePathFragment(projectPath());
  const matching = (await findAllHappyProcesses())
    .filter((processInfo) => isDaemonProcessForCurrentRuntimeRoot(processInfo, currentRuntimeRoot))
    .filter((processInfo) => daemonProcessMatchesCurrentScope(processInfo, { requireScopeIdentity: true }))
    .sort((a, b) => a.pid - b.pid);
  return matching[0] ?? null;
}

export async function evaluateCurrentDaemonOwner(): Promise<DaemonOwnerEvaluation> {
  const inspection = await inspectDaemonRunningStateAndCleanupStaleState();
  const currentCliVersion = resolveCurrentCliVersion();
  const currentPublicReleaseChannel = getReleaseRingCatalogEntry(configuration.publicReleaseRing).publicLabel;

  if (inspection.status === 'not-running') {
    const processOnlyOwner = await findStateLessDaemonProcessForCurrentRuntimeRoot();
    if (processOnlyOwner) {
      const owner: CurrentDaemonOwner = {
        status: 'running',
        source: 'process',
        state: {
          pid: processOnlyOwner.pid,
          httpPort: 0,
          startedAt: Date.now(),
          startedWithCliVersion: 'unknown',
        },
        currentCliVersion,
        currentPublicReleaseChannel,
        versionMatches: false,
        releaseChannelMatches: false,
        serviceManaged: null,
        startupSource: 'unknown',
      };
      return { kind: 'conflict', owner };
    }
    return { kind: 'none' };
  }

  if (!('state' in inspection)) {
    return { kind: 'none' };
  }

  const state = inspection.state;
  const versionMatches = state.startedWithCliVersion === currentCliVersion;
  const releaseChannelMatches = Boolean(
    state.startedWithPublicReleaseChannel
    && state.startedWithPublicReleaseChannel === currentPublicReleaseChannel,
  );
  const hasLegacyMissingReleaseChannel = !state.startedWithPublicReleaseChannel;
  const startupSource = state.startupSource ?? 'unknown';
  const owner: CurrentDaemonOwner = {
    status: inspection.status,
    source: 'state',
    state,
    currentCliVersion,
    currentPublicReleaseChannel,
    versionMatches,
    releaseChannelMatches,
    serviceManaged: resolveDaemonStartupSourceServiceManagedState(state.startupSource, state.serviceLabel),
    startupSource,
  };

  return versionMatches && (releaseChannelMatches || hasLegacyMissingReleaseChannel)
    ? { kind: 'compatible', owner }
    : { kind: 'conflict', owner };
}
