import { join, resolve, sep } from 'node:path';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

function resolvePublicReleaseRingSuffix(ring: PublicReleaseRingId): 'stable' | 'preview' | 'dev' {
  return ring === 'publicdev' ? 'dev' : ring;
}

export function resolveSessionAttachBaseDir(happyHomeDir: string, publicReleaseRing: PublicReleaseRingId = 'stable'): string {
  const suffix = resolvePublicReleaseRingSuffix(publicReleaseRing);
  const dirName = suffix === 'stable' ? 'session-attach' : `session-attach.${suffix}`;
  return resolve(join(happyHomeDir, 'tmp', dirName));
}

export function assertSessionAttachFilePathWithinBaseDir(baseDir: string, filePath: string): void {
  const resolvedBaseDir = resolve(baseDir);
  const resolvedFilePath = resolve(filePath);
  if (!(resolvedFilePath === resolvedBaseDir || resolvedFilePath.startsWith(resolvedBaseDir + sep))) {
    throw new Error('Invalid session attach file location');
  }
}
