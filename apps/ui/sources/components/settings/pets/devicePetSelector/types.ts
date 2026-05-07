import type * as React from 'react';

import type { BuiltInPetPackage } from '@/components/pets/builtIns/builtInPetRegistry';
import type { SelectedPetPackageSource } from '@/components/pets/source/resolveSelectedPetPackage';

export type LocalDevicePetSelectorItem = Readonly<{
    sourceKey: string;
    petId: string;
    displayName: string;
    selected: boolean;
    source: Extract<SelectedPetPackageSource, { kind: 'happierManagedLocal' }>;
    sourceTestID: string;
    actions: React.ReactNode;
    onPress: () => void;
}>;

export type DetectedDevicePetSelectorItem = Readonly<{
    sourceKey: string;
    petId: string;
    displayName: string;
    source: Extract<SelectedPetPackageSource, { kind: 'detectedCodexHome' }>;
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
        selectionControlTestID: string;
        petId: string;
        title: string;
        subtitle: string;
        selected: boolean;
        pet: BuiltInPetPackage;
        actions: null;
        onPress: () => void;
    }
    | {
        kind: 'local';
        key: string;
        testID: string;
        pressableTestID: string;
        previewTestID: string;
        selectionControlTestID: string;
        petId: string;
        title: string;
        subtitle: string;
        selected: boolean;
        source: Extract<SelectedPetPackageSource, { kind: 'happierManagedLocal' }>;
        pet: null;
        actions: React.ReactNode;
        onPress: () => void;
    }
    | {
        kind: 'account';
        key: string;
        testID: string;
        pressableTestID: string;
        previewTestID: string;
        selectionControlTestID: string;
        petId: string;
        title: string;
        subtitle: string;
        selected: boolean;
        source: Extract<SelectedPetPackageSource, { kind: 'accountPet' }>;
        pet: null;
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
        source: Extract<SelectedPetPackageSource, { kind: 'detectedCodexHome' }>;
        pet: null;
        actions: React.ReactNode;
        onPress?: () => void;
    }
>;
