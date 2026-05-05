import type { BuiltInPetPackage } from '@/components/pets/builtIns/builtInPetRegistry';
import { t } from '@/text';

import { BUILT_IN_PET_SUBTITLE_KEYS } from './constants';
import type {
    AccountDevicePetSelectorItem,
    DetectedDevicePetSelectorItem,
    DevicePetTile,
    LocalDevicePetSelectorItem,
} from './types';

type BuildDevicePetTilesParams = Readonly<{
    builtInPets: readonly BuiltInPetPackage[];
    selectedBuiltInPetId: string | null;
    localPets: readonly LocalDevicePetSelectorItem[];
    detectedPets: readonly DetectedDevicePetSelectorItem[];
    accountPets: readonly AccountDevicePetSelectorItem[];
    onSelectBuiltInPet: (petId: string) => void;
}>;

export function buildDevicePetTiles(params: BuildDevicePetTilesParams): DevicePetTile[] {
    return [
        ...params.builtInPets.map((pet): DevicePetTile => ({
            kind: 'builtIn',
            key: `built-in:${pet.id}`,
            testID: `settings-pets-built-in-tile-${pet.id}`,
            pressableTestID: `settings-pets-built-in-source-${pet.id}`,
            previewTestID: `settings-pets-built-in-preview-${pet.id}`,
            petId: pet.id,
            title: pet.manifest.displayName,
            subtitle: t(BUILT_IN_PET_SUBTITLE_KEYS[pet.id]),
            selected: params.selectedBuiltInPetId === pet.id,
            pet,
            source: null,
            previewAsset: null,
            actions: null,
            onPress: () => params.onSelectBuiltInPet(pet.id),
        })),
        ...params.localPets.map((pet): DevicePetTile => ({
            kind: 'local',
            key: `local:${pet.sourceKey}`,
            testID: `settings-pets-local-tile-${pet.petId}`,
            pressableTestID: pet.sourceTestID,
            previewTestID: `settings-pets-local-preview-${pet.petId}`,
            petId: pet.petId,
            title: pet.displayName,
            subtitle: t('settingsPets.importedLocalSubtitle'),
            selected: pet.selected,
            pet: null,
            source: pet.source,
            previewAsset: pet.previewAsset,
            actions: pet.actions,
            onPress: pet.onPress,
        })),
        ...params.accountPets.map((pet): DevicePetTile => ({
            kind: 'account',
            key: `account:${pet.accountPetId}`,
            testID: `settings-pets-account-tile-${pet.petId}`,
            pressableTestID: pet.sourceTestID,
            previewTestID: pet.previewTestID,
            petId: pet.petId,
            title: pet.displayName,
            subtitle: t('settingsPets.accountPetTileSubtitle'),
            selected: pet.selected,
            pet: null,
            source: pet.source,
            previewAsset: null,
            actions: pet.actions,
            onPress: pet.onPress,
        })),
        ...params.detectedPets.map((pet): DevicePetTile => ({
            kind: 'detected',
            key: `detected:${pet.sourceKey}`,
            testID: `settings-pets-detected-tile-${pet.petId}`,
            pressableTestID: pet.sourceTestID,
            previewTestID: pet.previewTestID,
            petId: pet.petId,
            title: pet.displayName,
            subtitle: t('settingsPets.detectedCodexPetsTileSubtitle'),
            selected: false,
            pet: null,
            source: pet.source,
            previewAsset: pet.previewAsset,
            actions: pet.actions,
            onPress: pet.onPress,
        })),
    ];
}
