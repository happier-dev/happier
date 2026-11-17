import type {
    PetAssetMediaTypeV1} from '@happier-dev/protocol/pets/accountLibrary';
import type { DiscoveredPetPackageV1 } from '@happier-dev/protocol/pets/daemonRpc';
import type { PetPackageManifestV1 } from '@happier-dev/protocol/pets/manifest';

export type LocalPetPackageSource = Readonly<{
    kind: Extract<DiscoveredPetPackageV1['kind'], 'detectedCodexHome' | 'happierManagedLocal'>;
    sourceKey: DiscoveredPetPackageV1['sourceKey'];
}>;

export type LocalPetDaemonTarget = Readonly<{
    serverId: string;
    machineId: string;
}>;

export type LocalPetSourceMetadata = Readonly<Pick<DiscoveredPetPackageV1,
    'sourceKey' | 'petId' | 'displayName'
> & {
    kind: LocalPetPackageSource['kind'];
    mediaType?: PetAssetMediaTypeV1;
    spriteVersionNumber?: PetPackageManifestV1['spriteVersionNumber'];
    digest?: string | null;
    sizeBytes?: number | null;
    daemonTarget: LocalPetDaemonTarget;
}>;

export type LocalPetPreviewAsset = Readonly<{
    sourceKey: string;
    mediaType?: PetAssetMediaTypeV1;
    spriteVersionNumber?: PetPackageManifestV1['spriteVersionNumber'];
    digest: string | null;
    sizeBytes: number | null;
    target: LocalPetDaemonTarget;
}>;
