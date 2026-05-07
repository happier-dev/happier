import {
  getReleaseRingCatalogEntry,
  type PublicReleaseRingId,
} from '@happier-dev/release-runtime/releaseRings';

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
