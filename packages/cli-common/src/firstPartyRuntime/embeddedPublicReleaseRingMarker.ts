import { readFileSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

const EMBEDDED_PUBLIC_RELEASE_RING_MARKER_FILE = 'public-release-ring.id';

function readOptionalTrimmedFileSync(path: string): string | null {
  try {
    const value = readFileSync(path, 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function resolveEmbeddedMarkerSearchDirectories(rawPath: string | null | undefined): readonly string[] {
  const candidate = String(rawPath ?? '').trim();
  if (!candidate) return [];

  const directories = [
    candidate,
    dirname(candidate),
    dirname(dirname(candidate)),
    dirname(dirname(dirname(candidate))),
  ];

  return [...new Set(directories.filter((value) => value.length > 0))];
}

export function readEmbeddedPublicReleaseRingFromPath(rawPath: string | null | undefined): PublicReleaseRingId | '' {
  for (const directory of resolveEmbeddedMarkerSearchDirectories(rawPath)) {
    const markerValue = readOptionalTrimmedFileSync(join(directory, EMBEDDED_PUBLIC_RELEASE_RING_MARKER_FILE));
    const releaseRing = normalizePublicReleaseRingId(markerValue);
    if (releaseRing) {
      return releaseRing;
    }
  }
  return '';
}

export async function writeEmbeddedPublicReleaseRingMarker(params: Readonly<{
  payloadRoot: string;
  releaseRing: PublicReleaseRingId;
}>): Promise<void> {
  const markerPath = join(params.payloadRoot, EMBEDDED_PUBLIC_RELEASE_RING_MARKER_FILE);
  await writeFile(markerPath, `${params.releaseRing}\n`, 'utf8');
  // Publication can create this file after the payload permissions are set.
  if (process.platform !== 'win32') await chmod(markerPath, 0o644);
}
