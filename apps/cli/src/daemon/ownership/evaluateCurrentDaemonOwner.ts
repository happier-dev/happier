import { readFileSync } from 'node:fs';

import { getReleaseRingCatalogEntry } from '@happier-dev/release-runtime/releaseRings';

import { configuration } from '@/configuration';
import {
  inspectDaemonRunningStateAndCleanupStaleState,
  type DaemonRunningInspection,
} from '@/daemon/controlClient';
import { findAllHappyProcesses, type HappyProcessInfo } from '@/daemon/doctor';
import { resolveComparableCliVersion } from '@/daemon/resolveComparableCliVersion';
import {
  resolveDaemonStartupSourceServiceManagedState,
  type DaemonStartupSource,
} from '@/daemon/ownership/daemonOwnershipMetadata';
import { projectPath } from '@/projectPath';
import {
  normalizeProcessCommandPathValue,
  processCommandContainsPathFragment,
} from '@/subprocess/processCommandPathMatch';

import type { DaemonLocallyPersistedState } from '@/persistence';

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

function normalizeScopeValue(value: string | null | undefined): string {
  return String(value ?? '').trim();
}

function normalizeServerUrl(value: string | null | undefined): string {
  return normalizeScopeValue(value).replace(/\/+$/, '').toLowerCase();
}

function processEnvValueMatchesCurrent(
  processValue: string | null | undefined,
  currentValue: string | null | undefined,
  normalize: (value: string) => string = normalizeScopeValue,
): boolean {
  const processScopeValue = normalizeScopeValue(processValue);
  if (!processScopeValue) return true;
  const currentScopeValue = normalizeScopeValue(currentValue);
  if (!currentScopeValue) return true;
  return normalize(processScopeValue) === normalize(currentScopeValue);
}

function daemonProcessMatchesCurrentScope(processInfo: HappyProcessInfo): boolean {
  const env = processInfo.daemonOwnershipEnvironmentVariables;
  if (!env) return true;

  if (!processEnvValueMatchesCurrent(
    env.HAPPIER_HOME_DIR,
    configuration.happyHomeDir,
    normalizeProcessCommandPathValue,
  )) {
    return false;
  }
  const processLifecycleScopeId = normalizeScopeValue(env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID);
  const currentLifecycleScopeId = normalizeScopeValue(process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID);
  if (processLifecycleScopeId) {
    // Explicit lifecycle scope is the canonical owner identity. Endpoint profiles and URLs are
    // independently mutable connection facts and must not disqualify that exact owner.
    return Boolean(currentLifecycleScopeId && processLifecycleScopeId === currentLifecycleScopeId);
  }

  // Released stack daemons predate the explicit lifecycle-scope variable. Only that old shape may
  // fall back to the active-server identity and endpoint URL comparison.
  const currentFallbackScope = currentLifecycleScopeId || configuration.activeServerId;
  if (!processEnvValueMatchesCurrent(env.HAPPIER_ACTIVE_SERVER_ID, currentFallbackScope)) {
    return false;
  }

  const processServerUrl = normalizeServerUrl(env.HAPPIER_SERVER_URL);
  if (processServerUrl) {
    const currentServerUrls = new Set([
      normalizeServerUrl(configuration.serverUrl),
      normalizeServerUrl(configuration.apiServerUrl),
      normalizeServerUrl(configuration.publicServerUrl),
    ].filter(Boolean));
    if (currentServerUrls.size > 0 && !currentServerUrls.has(processServerUrl)) {
      return false;
    }
  }

  return true;
}

export function isDaemonProcessForCurrentRuntimeRoot(processInfo: HappyProcessInfo, currentRuntimeRoot: string): boolean {
  if (processInfo.pid === process.pid) return false;
  if (processInfo.type !== 'daemon' && processInfo.type !== 'dev-daemon') return false;

  const command = normalizeProcessCommandPathValue(processInfo.command);
  if (!processCommandContainsPathFragment(command, currentRuntimeRoot)) return false;

  // The public Node wrappers re-exec through `_importRuntimeEntrypoint.mjs` so warning handles
  // cannot leak into the runtime process. During that synchronous re-exec, the parent command
  // still ends in `<wrapper> daemon start-sync`; it is only a bootstrapper, not a relay owner.
  // The imported child includes additional runtime arguments between the wrapper path and
  // `daemon start-sync`, so it remains visible as the real owner.
  if (/\/bin\/happier(?:-dev)?\.mjs["']?\s+daemon\s+start-sync(?:\s|$)/u.test(command)) {
    return false;
  }

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

  const currentRuntimeRoot = normalizeProcessCommandPathValue(projectPath());
  const matching = (await findAllHappyProcesses())
    .filter((processInfo) => isDaemonProcessForCurrentRuntimeRoot(processInfo, currentRuntimeRoot))
    .filter((processInfo) => daemonProcessMatchesCurrentScope(processInfo))
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
