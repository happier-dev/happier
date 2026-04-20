import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const stressComposeProjectPrefix = 'happier-stress-';
export const stressComposeOwnerLabelKey = 'happier.stress.owner';
export const stressComposeOwnerLabelValue = 'stress-harness';
export const stressComposeRepoRootLabelKey = 'happier.stress.repo-root';
export const stressComposeImageFingerprintLabelKey = 'happier.stress.image-fingerprint';

export function isStressComposeProjectName(projectName: string): boolean {
  return projectName.startsWith(stressComposeProjectPrefix);
}

export function createRepoRootFingerprint(repoRootDir: string): string {
  return createHash('sha1')
    .update(resolve(repoRootDir))
    .digest('hex')
    .slice(0, 12);
}
