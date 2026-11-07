import type { OwnServerDeploymentImageReference } from '@/deployments/targets/ownServer/releaseRetention';
import { normalizeNativeComposePlatform } from '@/daemon/local/services/launch/nativeComposeImageIdentity';

export const storageDockerImageKey = (image: Readonly<{ configDigest: string; platform: string }>) =>
    JSON.stringify([image.configDigest, normalizeNativeComposePlatform(image.platform)]);

/** One ownership decision for the read projection and the native prune owner.
 * Native container use and identity are supplied by their observation owners. */
export function createStorageDockerImageCustody(projection: Readonly<{
    protectedImages: readonly OwnServerDeploymentImageReference[];
    expiredImages: readonly OwnServerDeploymentImageReference[];
}>) {
    const protectedKeys = new Set(projection.protectedImages.map(row => storageDockerImageKey(row.image)));
    const eligibleKeys = new Set(projection.expiredImages.map(row => storageDockerImageKey(row.image)));
    const eligibleRefs = new Set(projection.expiredImages.flatMap(row => [row.ownedTag, row.activationRef]));
    const proofByReference = new Map(projection.expiredImages.flatMap(row =>
        [[row.ownedTag, row], [row.activationRef, row]] as const));
    return { protectedKeys, eligibleRefs, proofByReference,
        permits(image: Readonly<{ variants: readonly Readonly<{ configDigest: string; platform: string }>[];
            repoTags: readonly string[]; repoDigests: readonly string[] }>): boolean {
            const keys = image.variants.map(storageDockerImageKey);
            const references = [...image.repoTags, ...image.repoDigests];
            return keys.length > 0 && references.some(reference => proofByReference.has(reference))
                && keys.every(key => !protectedKeys.has(key) && eligibleKeys.has(key))
                && references.every(reference => eligibleRefs.has(reference));
        },
    };
}
