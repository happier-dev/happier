import { basename } from 'node:path';

import {
  getReleaseRingCatalogEntry,
  normalizePublicReleaseRingId,
  type PublicReleaseRingId,
  type PublicReleaseRingLabel,
} from '@happier-dev/release-runtime/releaseRings';

import {
  readDefaultManagedReleaseChannel,
  readDefaultManagedReleaseChannelSync,
} from './defaultReleaseChannelState.js';

export const STANDARD_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS = [
  'HAPPIER_PUBLIC_RELEASE_CHANNEL',
  'HAPPIER_RELEASE_RING',
  'HAPPIER_RELEASE_CHANNEL',
] as const;

export const DAEMON_SERVICE_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS = [
  'HAPPIER_DAEMON_SERVICE_CHANNEL',
  ...STANDARD_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS,
] as const;

export type ManagedCliReleaseChannelSource =
  | 'explicit-arg'
  | 'env'
  | 'path-hint'
  | 'shim-name'
  | 'default-marker'
  | 'default';

export type ManagedCliReleaseChannelMarkerFallback = 'happier-invoker' | 'always' | 'never';
export type ManagedCliToolName = 'happier' | 'hprev' | 'hdev';

export interface ResolvedManagedCliReleaseChannel {
  ringId: PublicReleaseRingId;
  label: PublicReleaseRingLabel;
  source: ManagedCliReleaseChannelSource;
  invokedToolName: string | null;
  channelToolName: ManagedCliToolName;
}

interface ManagedCliReleaseChannelResolverParams {
  args?: readonly string[];
  argv?: readonly string[];
  argv0?: string | null;
  execPath?: string | null;
  invokedPath?: string | null;
  processEnv?: NodeJS.ProcessEnv;
  additionalCandidates?: readonly (string | null | undefined)[];
  envKeys?: readonly string[];
  markerFallback?: ManagedCliReleaseChannelMarkerFallback;
}

interface ReleaseChannelCandidateResolution {
  ringId: PublicReleaseRingId;
  source: ManagedCliReleaseChannelSource;
  invokedToolName: string | null;
}

function normalizeInvokerCandidate(raw: unknown): string {
  return basename(String(raw ?? '').trim())
    .replace(/\.exe$/i, '')
    .replace(/\.m?js$/i, '')
    .trim()
    .toLowerCase();
}

function resolvePublicReleaseRingIdFromPathHint(raw: unknown): PublicReleaseRingId | '' {
  const normalized = String(raw ?? '').trim().replaceAll('\\', '/').toLowerCase();
  if (!normalized) return '';
  if (/(^|\/)cli-preview(\/|$)/.test(normalized)) return 'preview';
  if (/(^|\/)cli-dev(\/|$)/.test(normalized)) return 'publicdev';
  return '';
}

function resolvePublicReleaseRingIdFromInvokerName(name: string): PublicReleaseRingId | '' {
  if (name === 'hprev') return 'preview';
  if (name === 'hdev') return 'publicdev';
  return '';
}

export function resolveManagedCliToolNameForRing(ring: PublicReleaseRingId): ManagedCliToolName {
  if (ring === 'preview') return 'hprev';
  if (ring === 'publicdev') return 'hdev';
  return 'happier';
}

function buildResolvedManagedCliReleaseChannel(
  resolution: ReleaseChannelCandidateResolution,
): ResolvedManagedCliReleaseChannel {
  const label = getReleaseRingCatalogEntry(resolution.ringId).publicLabel;
  return {
    ringId: resolution.ringId,
    label,
    source: resolution.source,
    invokedToolName: resolution.invokedToolName,
    channelToolName: resolveManagedCliToolNameForRing(resolution.ringId),
  };
}

function resolveExplicitArgChannel(args: readonly string[]): PublicReleaseRingId | '' | null {
  const copiedArgs = [...args];
  if (copiedArgs.includes('--preview')) return 'preview';
  if (copiedArgs.includes('--dev')) return 'publicdev';

  const channelFlag = copiedArgs.find((arg) => arg === '--channel' || arg.startsWith('--channel='));
  if (!channelFlag) return null;

  const value = channelFlag === '--channel'
    ? String(copiedArgs[copiedArgs.indexOf(channelFlag) + 1] ?? '')
    : channelFlag.slice('--channel='.length);
  return normalizePublicReleaseRingId(value) || 'stable';
}

function resolveEnvChannel(env: NodeJS.ProcessEnv, envKeys: readonly string[]): PublicReleaseRingId | '' {
  for (const key of envKeys) {
    const normalized = normalizePublicReleaseRingId(String(env[key] ?? '').trim());
    if (normalized) return normalized;
  }
  return '';
}

function collectCandidateInputs(params: ManagedCliReleaseChannelResolverParams): string[] {
  const argv = params.argv ?? [];
  return [
    params.invokedPath ?? '',
    params.execPath ?? process.execPath,
    params.argv0 ?? process.argv0,
    argv[0] ?? '',
    argv[1] ?? '',
    ...(params.additionalCandidates ?? []),
  ]
    .map((candidate) => String(candidate ?? '').trim())
    .filter(Boolean);
}

function resolveInvokedToolName(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    const name = normalizeInvokerCandidate(candidate);
    if (name === 'happier' || name === 'hprev' || name === 'hdev') {
      return name;
    }
  }
  return null;
}

function resolveCandidateChannel(candidates: readonly string[]): ReleaseChannelCandidateResolution | null {
  const invokedToolName = resolveInvokedToolName(candidates);

  for (const candidate of candidates) {
    const ringFromPath = resolvePublicReleaseRingIdFromPathHint(candidate);
    if (ringFromPath) {
      return { ringId: ringFromPath, source: 'path-hint', invokedToolName };
    }
  }

  for (const candidate of candidates) {
    const name = normalizeInvokerCandidate(candidate);
    const ringFromInvoker = resolvePublicReleaseRingIdFromInvokerName(name);
    if (ringFromInvoker) {
      return { ringId: ringFromInvoker, source: 'shim-name', invokedToolName: name };
    }
  }

  return null;
}

function shouldReadDefaultMarker(
  markerFallback: ManagedCliReleaseChannelMarkerFallback,
  invokedToolName: string | null,
): boolean {
  if (markerFallback === 'always') return true;
  if (markerFallback === 'never') return false;
  return invokedToolName === 'happier';
}

function resolveManagedCliReleaseChannelWithoutMarker(
  params: ManagedCliReleaseChannelResolverParams,
): ReleaseChannelCandidateResolution | null {
  const args = params.args ?? [];
  const explicit = resolveExplicitArgChannel(args);
  if (explicit) {
    return { ringId: explicit, source: 'explicit-arg', invokedToolName: null };
  }

  const env = params.processEnv ?? process.env;
  const envChannel = resolveEnvChannel(
    env,
    params.envKeys ?? STANDARD_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS,
  );
  if (envChannel) {
    return { ringId: envChannel, source: 'env', invokedToolName: null };
  }

  return resolveCandidateChannel(collectCandidateInputs(params));
}

export function resolveManagedCliReleaseChannelSync(
  params: ManagedCliReleaseChannelResolverParams = {},
): ResolvedManagedCliReleaseChannel {
  const nonMarkerResolution = resolveManagedCliReleaseChannelWithoutMarker(params);
  if (nonMarkerResolution) {
    return buildResolvedManagedCliReleaseChannel(nonMarkerResolution);
  }

  const candidates = collectCandidateInputs(params);
  const invokedToolName = resolveInvokedToolName(candidates);
  const markerFallback = params.markerFallback ?? 'happier-invoker';
  if (shouldReadDefaultMarker(markerFallback, invokedToolName)) {
    return buildResolvedManagedCliReleaseChannel({
      ringId: readDefaultManagedReleaseChannelSync({ processEnv: params.processEnv }),
      source: 'default-marker',
      invokedToolName,
    });
  }

  return buildResolvedManagedCliReleaseChannel({
    ringId: 'stable',
    source: 'default',
    invokedToolName,
  });
}

export async function resolveManagedCliReleaseChannel(
  params: ManagedCliReleaseChannelResolverParams = {},
): Promise<ResolvedManagedCliReleaseChannel> {
  const nonMarkerResolution = resolveManagedCliReleaseChannelWithoutMarker(params);
  if (nonMarkerResolution) {
    return buildResolvedManagedCliReleaseChannel(nonMarkerResolution);
  }

  const candidates = collectCandidateInputs(params);
  const invokedToolName = resolveInvokedToolName(candidates);
  const markerFallback = params.markerFallback ?? 'happier-invoker';
  if (shouldReadDefaultMarker(markerFallback, invokedToolName)) {
    return buildResolvedManagedCliReleaseChannel({
      ringId: await readDefaultManagedReleaseChannel({ processEnv: params.processEnv }),
      source: 'default-marker',
      invokedToolName,
    });
  }

  return buildResolvedManagedCliReleaseChannel({
    ringId: 'stable',
    source: 'default',
    invokedToolName,
  });
}
