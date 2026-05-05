import type {
    DiscoveredPetPackageV1,
    ImportedLocalPetPackageV1,
} from '@happier-dev/protocol';

import type { LocalPetDaemonTarget, LocalPetSourceMetadata } from './localPetSourceTypes';

type LocalPetSourceCandidate = DiscoveredPetPackageV1 | ImportedLocalPetPackageV1;

function isLocalPetSourceCandidate(
    pet: LocalPetSourceCandidate,
): pet is LocalPetSourceCandidate & { source: LocalPetSourceMetadata['source'] } {
    return pet.source.kind === 'detectedCodexHome' || pet.source.kind === 'happierManagedLocal';
}

export function normalizeLocalPetSourceMetadata(
    pets: readonly LocalPetSourceCandidate[],
    daemonTarget: LocalPetDaemonTarget,
): LocalPetSourceMetadata[] {
    return pets
        .filter(isLocalPetSourceCandidate)
        .map((pet) => ({
            sourceKey: pet.sourceKey,
            source: pet.source,
            displayName: pet.displayName,
            manifest: pet.manifest,
            mediaType: pet.mediaType,
            digest: pet.digest ?? null,
            sizeBytes: pet.sizeBytes ?? null,
            daemonTarget,
        }));
}
