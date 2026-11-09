import type {
    PetAssetMediaTypeV1} from '@happier-dev/protocol/pets/accountLibrary';
import type {
    PetPackageManifestV1} from '@happier-dev/protocol/pets/manifest';
import type {
    PetPackageSourceV1,
} from '@happier-dev/protocol/pets/source';

export type LocalPetPackageSource = Extract<
    PetPackageSourceV1,
    { kind: 'detectedCodexHome' | 'happierManagedLocal' }
>;

export type LocalPetDaemonTarget = Readonly<{
    serverId: string;
    machineId: string;
}>;

export type LocalPetSourceMetadata = Readonly<{
    sourceKey: string;
    source: LocalPetPackageSource;
    displayName: string;
    manifest: PetPackageManifestV1;
    mediaType: PetAssetMediaTypeV1;
    digest: string | null;
    sizeBytes: number | null;
    daemonTarget: LocalPetDaemonTarget;
}>;

export type LocalPetPreviewAsset = Readonly<{
    sourceKey: string;
    mediaType: PetAssetMediaTypeV1;
    digest: string | null;
    sizeBytes: number | null;
    target: LocalPetDaemonTarget;
}>;
