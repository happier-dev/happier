import type * as React from 'react';
import type { PetPackageSourceV1 } from '@happier-dev/protocol';

import type { BuiltInPetPackage } from '@/components/pets/builtIns/builtInPetRegistry';
import type { SelectedPetPackageSource } from '@/components/pets/source/resolveSelectedPetPackage';
import type { LocalPetPreviewAsset } from '@/sync/domains/pets/localPetSourceTypes';

export type LocalDevicePetSelectorItem = Readonly<{
    sourceKey: string;
    petId: string;
    displayName: string;
    selected: boolean;
    source: Extract<PetPackageSourceV1, { kind: 'happierManagedLocal' }>;
    previewAsset: LocalPetPreviewAsset;
    sourceTestID: string;
    actions: React.ReactNode;
    onPress: () => void;
}>;

export type DetectedDevicePetSelectorItem = Readonly<{
    sourceKey: string;
    petId: string;
    displayName: string;
    source: Extract<PetPackageSourceV1, { kind: 'detectedCodexHome' }>;
    previewAsset: LocalPetPreviewAsset;
    sourceTestID: string;
    previewTestID: string;
    actions: React.ReactNode;
    onPress?: () => void;
}>;

export type AccountDevicePetSelectorItem = Readonly<{
    accountPetId: string;
    petId: string;
    displayName: string;
    selected: boolean;
    source: Extract<SelectedPetPackageSource, { kind: 'accountPet' }>;
    sourceTestID: string;
    previewTestID: string;
    actions: React.ReactNode;
    onPress: () => void;
}>;

export type DevicePetSelectorProps = Readonly<{
    builtInPets: readonly BuiltInPetPackage[];
    companionSizeScale?: number;
    selectedBuiltInPetId: string | null;
    localPets: readonly LocalDevicePetSelectorItem[];
    detectedPets?: readonly DetectedDevicePetSelectorItem[];
    accountPets?: readonly AccountDevicePetSelectorItem[];
    gridTestID?: string;
    contentsTestID?: string;
    onSelectBuiltInPet: (petId: string) => void;
}>;

export type DevicePetTile = Readonly<
    | {
        kind: 'builtIn';
        key: string;
        testID: string;
        pressableTestID: string;
        previewTestID: string;
        petId: string;
        title: string;
        subtitle: string;
        selected: boolean;
        pet: BuiltInPetPackage;
        source: null;
        previewAsset: null;
        actions: null;
        onPress: () => void;
    }
    | {
        kind: 'local';
        key: string;
        testID: string;
        pressableTestID: string;
        previewTestID: string;
        petId: string;
        title: string;
        subtitle: string;
        selected: boolean;
        pet: null;
        source: Extract<PetPackageSourceV1, { kind: 'happierManagedLocal' }>;
        previewAsset: LocalPetPreviewAsset;
        actions: React.ReactNode;
        onPress: () => void;
    }
    | {
        kind: 'account';
        key: string;
        testID: string;
        pressableTestID: string;
        previewTestID: string;
        petId: string;
        title: string;
        subtitle: string;
        selected: boolean;
        pet: null;
        source: Extract<SelectedPetPackageSource, { kind: 'accountPet' }>;
        previewAsset: null;
        actions: React.ReactNode;
        onPress: () => void;
    }
    | {
        kind: 'detected';
        key: string;
        testID: string;
        pressableTestID: string;
        previewTestID: string;
        petId: string;
        title: string;
        subtitle: string;
        selected: false;
        pet: null;
        source: Extract<PetPackageSourceV1, { kind: 'detectedCodexHome' }>;
        previewAsset: LocalPetPreviewAsset;
        actions: React.ReactNode;
        onPress?: () => void;
    }
>;
