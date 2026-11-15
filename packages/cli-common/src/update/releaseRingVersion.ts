import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

/** A public version belongs to one ring: stable, preview.*, or dev.*. */
export function doesVersionMatchReleaseRing(version: string | null | undefined, ring: PublicReleaseRingId): boolean {
  const value = String(version ?? '').trim().toLowerCase();
  const parsed = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?(?:\+.*)?$/.exec(value);
  if (!parsed) return false;
  const prerelease = parsed[4] ?? '';
  if (ring === 'stable') return prerelease === '';
  if (ring === 'preview') return prerelease.startsWith('preview.');
  return prerelease.startsWith('dev.');
}
