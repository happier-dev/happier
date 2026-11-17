import type {
    DiscoveredPetPackageV1,
    ImportedLocalPetPackageV1,
} from '@happier-dev/protocol/pets/daemonRpc';

import type { LocalPetDaemonTarget, LocalPetSourceMetadata } from './localPetSourceTypes';

type LocalPetSourceCandidate = DiscoveredPetPackageV1 | ImportedLocalPetPackageV1;

function isLocalPetSourceCandidate(
    pet: LocalPetSourceCandidate,
): pet is LocalPetSourceCandidate & { kind: LocalPetSourceMetadata['kind'] } {
    return pet.kind === 'detectedCodexHome' || pet.kind === 'happierManagedLocal';
}

export function normalizeLocalPetSourceMetadata(
    pets: readonly LocalPetSourceCandidate[],
    daemonTarget: LocalPetDaemonTarget,
): LocalPetSourceMetadata[] {
    return pets
        .filter(isLocalPetSourceCandidate)
        .map((pet) => ({
            sourceKey: pet.sourceKey,
            kind: pet.kind,
            displayName: pet.displayName,
            petId: pet.petId,
            mediaType: pet.mediaType,
            digest: pet.digest ?? null,
            sizeBytes: pet.sizeBytes ?? null,
            daemonTarget,
        }));
}
