import type {
    DiscoveredPetPackageV1,
    ImportedLocalPetPackageV1,
} from '@happier-dev/protocol/pets/daemonRpc';

import type { z } from 'zod/mini';

import type {
    PetEnabledOverrideSchema,
} from '@/sync/domains/settings/registry/local/localSettingDefinitions.activitySurfaces';
import type { LocalPetPackageSource, LocalPetPreviewAsset } from '@/sync/domains/pets/localPetSourceTypes';
import type { PetDeviceOverrideV1 } from '@happier-dev/protocol/pets/selection';

export type PetEnabledOverride = z.infer<typeof PetEnabledOverrideSchema>;

export type ManagedLocalPet = (ImportedLocalPetPackageV1 | DiscoveredPetPackageV1) & {
    kind: 'happierManagedLocal';
};

export type DetectedPet = DiscoveredPetPackageV1 & {
    kind: 'detectedCodexHome';
};

export type PetImportCandidate = DiscoveredPetPackageV1 | ImportedLocalPetPackageV1;

export type LocalDevicePetRow = Readonly<{
    sourceKey: string;
    petId: string;
    displayName: string;
    source: LocalPetPackageSource & { kind: 'happierManagedLocal' };
    previewAsset: LocalPetPreviewAsset;
}>;

export type PetSelectedPetOverride = PetDeviceOverrideV1;

export type CodexDetectionState = 'idle' | 'loading' | 'success' | 'empty' | 'error' | 'noTarget' | 'daemonMismatch';

export type LocalPetImportDiagnostic = Readonly<{
    code: string;
}>;
