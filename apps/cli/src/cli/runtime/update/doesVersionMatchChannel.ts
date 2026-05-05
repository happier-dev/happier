import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

export function doesVersionMatchChannel(version: string | null | undefined, channel: PublicReleaseRingId): boolean {
  const value = String(version ?? '').trim().toLowerCase();
  if (!value) return false;

  const parsed = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?(?:\+.*)?$/.exec(value);
  if (!parsed) return false;

  const prerelease = parsed[4] ?? '';
  const isPreview = prerelease.startsWith('preview.');
  const isDev = prerelease.startsWith('dev.');

  if (channel === 'stable') {
    return !prerelease;
  }
  if (channel === 'preview') {
    return isPreview;
  }
  return isDev;
}
