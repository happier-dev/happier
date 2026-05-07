import type {
    DiscoveredPetPackageV1,
    ImportedLocalPetPackageV1,
    PetAssetMediaTypeV1,
} from '@happier-dev/protocol';

export type LocalPetDaemonTarget = Readonly<{
    machineId: string;
    serverId: string;
}>;

export type LocalPetSourceMetadata = Readonly<{
    kind: 'detectedCodexHome' | 'happierManagedLocal';
    sourceKey: string;
    petId: string;
    displayName: string;
    mediaType?: PetAssetMediaTypeV1;
    digest?: string;
    sizeBytes?: number;
    daemonTarget: LocalPetDaemonTarget;
}>;

type LocalPetSourceCandidate = DiscoveredPetPackageV1 | ImportedLocalPetPackageV1;

function readPetAssetMediaType(value: unknown): PetAssetMediaTypeV1 | undefined {
    return value === 'image/png' || value === 'image/webp' ? value : undefined;
}

export function createLocalPetSourceMetadata(
    pet: LocalPetSourceCandidate,
    daemonTarget: LocalPetDaemonTarget,
): LocalPetSourceMetadata | null {
    if (pet.kind !== 'detectedCodexHome' && pet.kind !== 'happierManagedLocal') return null;
    const mediaType = 'mediaType' in pet ? readPetAssetMediaType(pet.mediaType) : undefined;

    return {
        kind: pet.kind,
        sourceKey: pet.sourceKey,
        petId: pet.petId,
        displayName: pet.displayName,
        mediaType,
        digest: pet.digest,
        sizeBytes: pet.sizeBytes,
        daemonTarget,
    };
}
