import { readFileSync } from 'node:fs';

import { getReleaseRingCatalogEntry } from '@happier-dev/release-runtime/releaseRings';

import { configuration } from '@/configuration';
import {
  inspectDaemonRunningStateAndCleanupStaleState,
  type DaemonRunningInspection,
} from '@/daemon/controlClient';
import { resolveComparableCliVersion } from '@/daemon/resolveComparableCliVersion';
import {
  resolveDaemonStartupSourceServiceManagedState,
  type DaemonStartupSource,
} from '@/daemon/ownership/daemonOwnershipMetadata';
import { projectPath } from '@/projectPath';

import type { DaemonLocallyPersistedState } from '@/persistence';

export type CurrentDaemonOwner = Readonly<{
  status: Extract<DaemonRunningInspection['status'], 'starting' | 'running'>;
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

export async function evaluateCurrentDaemonOwner(): Promise<DaemonOwnerEvaluation> {
  const inspection = await inspectDaemonRunningStateAndCleanupStaleState();
  if (inspection.status === 'not-running') {
    return { kind: 'none' };
  }

  const state = inspection.state;
  const currentCliVersion = resolveCurrentCliVersion();
  const currentPublicReleaseChannel = getReleaseRingCatalogEntry(configuration.publicReleaseRing).publicLabel;
  const versionMatches = state.startedWithCliVersion === currentCliVersion;
  const releaseChannelMatches = Boolean(
    state.startedWithPublicReleaseChannel
    && state.startedWithPublicReleaseChannel === currentPublicReleaseChannel,
  );
  const hasLegacyMissingReleaseChannel = !state.startedWithPublicReleaseChannel;
  const startupSource = state.startupSource ?? 'unknown';
  const owner: CurrentDaemonOwner = {
    status: inspection.status,
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
