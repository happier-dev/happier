import type {
    DiscoveredPetPackageV1,
    ImportedLocalPetPackageV1,
} from '@happier-dev/protocol';

import type { SelectedPetPackageSource } from '@/components/pets/source/resolveSelectedPetPackage';

export type PetEnabledOverride = 'inherit' | 'enabled' | 'disabled';
export type DesktopPetOverlayVisibilityModeOverride =
    | 'inherit'
    | 'attentionOrActive'
    | 'alwaysWhenEnabled'
    | 'attentionOnly';

export type ManagedLocalPet = (ImportedLocalPetPackageV1 | DiscoveredPetPackageV1) & {
    kind: 'happierManagedLocal';
};

export type DetectedPet = DiscoveredPetPackageV1 & {
    kind: 'detectedCodexHome';
};

export type LocalDevicePetRow = Readonly<{
    sourceKey: string;
    petId: string;
    displayName: string;
    source: Extract<SelectedPetPackageSource, { kind: 'happierManagedLocal' }>;
}>;

export type PetSelectedPetOverride =
    | { kind: 'inherit' }
    | { kind: 'detectedCodexHome'; sourceKey: string }
    | { kind: 'happierManagedLocal'; sourceKey: string };

export type CodexDetectionState = 'idle' | 'loading' | 'success' | 'empty' | 'error' | 'noTarget' | 'daemonMismatch';

export type LocalPetRemovalDiagnostic = Readonly<{
    code: 'daemon_forget_failed' | 'daemon_unavailable';
}>;

export type LocalPetImportDiagnostic = Readonly<{
    code: string;
}>;
