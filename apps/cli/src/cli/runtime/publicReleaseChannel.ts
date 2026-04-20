import { basename } from 'node:path';

import {
  readDefaultManagedReleaseChannelSync,
  readEmbeddedPublicReleaseRingFromPath,
} from '@happier-dev/cli-common/firstPartyRuntime';
import {
  getReleaseRingCatalogEntry,
  normalizePublicReleaseRingId,
  resolvePublicReleaseRingIdForCliInvokerName,
  type PublicReleaseRingId,
} from '@happier-dev/release-runtime/releaseRings';

function normalizeInvokerCandidate(raw: string): string {
  return basename(String(raw ?? '').trim())
    .replace(/\.exe$/i, '')
    .replace(/\.m?js$/i, '')
    .trim()
    .toLowerCase();
}

function resolvePublicReleaseRingIdFromPathHint(raw: string | null | undefined): PublicReleaseRingId | '' {
  const normalized = String(raw ?? '').trim().replaceAll('\\', '/').toLowerCase();
  if (!normalized) return '';
  if (/(^|\/)cli-preview(\/|$)/.test(normalized)) return 'preview';
  if (/(^|\/)cli-dev(\/|$)/.test(normalized)) return 'publicdev';
  return '';
}

function hasUnsuffixedHappierInvoker(candidates: readonly string[]): boolean {
  return candidates.some((candidate) => normalizeInvokerCandidate(candidate) === 'happier');
}

export function inferPublicReleaseRingIdFromEnvAndArgv(params: Readonly<{
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  argv0?: string | null;
  execPath?: string | null;
  additionalCandidates?: readonly string[];
}>): PublicReleaseRingId {
  const envValue = String(
    params.env.HAPPIER_PUBLIC_RELEASE_CHANNEL ??
      params.env.HAPPIER_RELEASE_RING ??
      params.env.HAPPIER_RELEASE_CHANNEL ??
      '',
  ).trim();
  const envRing = envValue ? normalizePublicReleaseRingId(envValue) : '';
  if (envRing) return envRing;

  const candidates = [
    params.execPath ?? process.execPath,
    params.argv0 ?? process.argv0,
    params.argv[0] ?? '',
    params.argv[1] ?? '',
    ...(params.additionalCandidates ?? []),
  ];
  for (const candidate of candidates) {
    const ringFromEmbeddedMarker = readEmbeddedPublicReleaseRingFromPath(candidate);
    if (ringFromEmbeddedMarker) return ringFromEmbeddedMarker;
    const ringFromPath = resolvePublicReleaseRingIdFromPathHint(candidate);
    if (ringFromPath) return ringFromPath;
    const name = normalizeInvokerCandidate(candidate);
    if (name === 'happier') continue;
    const ring = resolvePublicReleaseRingIdForCliInvokerName(name);
    if (ring) return ring;
  }

  if (hasUnsuffixedHappierInvoker(candidates)) {
    return readDefaultManagedReleaseChannelSync({ processEnv: params.env });
  }

  return 'stable';
}

export function resolvePublicReleaseRingIdFromCliArgs(params: Readonly<{
  args: readonly string[];
  invokedPath: string;
}>): PublicReleaseRingId {
  const args = [...params.args];
  if (args.includes('--preview')) return 'preview';
  if (args.includes('--dev')) return 'publicdev';

  const ch = args.find((a) => a === '--channel' || a.startsWith('--channel='));
  if (!ch) {
    const ringFromEmbeddedMarker = readEmbeddedPublicReleaseRingFromPath(params.invokedPath);
    if (ringFromEmbeddedMarker) return ringFromEmbeddedMarker;
    const ringFromPath = resolvePublicReleaseRingIdFromPathHint(params.invokedPath);
    if (ringFromPath) return ringFromPath;
    const name = normalizeInvokerCandidate(params.invokedPath);
    const ring = resolvePublicReleaseRingIdForCliInvokerName(name);
    if (ring) return ring;
    return 'stable';
  }

  const value = ch === '--channel'
    ? String(args[args.indexOf(ch) + 1] ?? '')
    : ch.slice('--channel='.length);
  return normalizePublicReleaseRingId(value) || 'stable';
}

export function resolvePublicReleaseRingRollingSuffix(
  ring: PublicReleaseRingId | undefined | null,
): 'stable' | 'preview' | 'dev' {
  const resolved: PublicReleaseRingId = ring ?? 'stable';
  // Public release rings always define rolling suffixes.
  return getReleaseRingCatalogEntry(resolved).rollingReleaseSuffix ?? (resolved === 'publicdev' ? 'dev' : resolved);
}

export function resolveReleaseRingScopedBasename(base: string, ring: PublicReleaseRingId | undefined | null): string {
  const name = String(base ?? '').trim();
  if (!name) {
    throw new Error('base is required');
  }
  const resolved: PublicReleaseRingId = ring ?? 'stable';
  if (resolved === 'stable') return name;
  return `${name}.${resolvePublicReleaseRingRollingSuffix(resolved)}`;
}

export function resolveDaemonStateBasenameForRing(ring: PublicReleaseRingId | undefined | null): string {
  const resolved: PublicReleaseRingId = ring ?? 'stable';
  if (resolved === 'stable') return 'daemon.state.json';
  return `daemon.${resolvePublicReleaseRingRollingSuffix(resolved)}.state.json`;
}
