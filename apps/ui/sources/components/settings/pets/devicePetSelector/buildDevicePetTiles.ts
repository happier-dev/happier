import { t } from '@/text';

import { BUILT_IN_PET_SUBTITLE_KEYS } from './constants';
import type {
    AccountDevicePetSelectorItem,
    DetectedDevicePetSelectorItem,
    DevicePetTile,
    LocalDevicePetSelectorItem,
} from './types';
import type { BuiltInPetPackage } from '@/components/pets/builtIns/builtInPetRegistry';

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
            selectionControlTestID: `settings-pets-selection-control-${pet.id}`,
            petId: pet.id,
            title: pet.manifest.displayName,
            subtitle: t(BUILT_IN_PET_SUBTITLE_KEYS[pet.id]),
            selected: params.selectedBuiltInPetId === pet.id,
            pet,
            actions: null,
            onPress: () => params.onSelectBuiltInPet(pet.id),
        })),
        ...params.localPets.map((pet): DevicePetTile => ({
            kind: 'local',
            key: `local:${pet.sourceKey}`,
            testID: `settings-pets-local-tile-${pet.sourceKey.replace(/[^A-Za-z0-9_-]+/g, '-')}`,
            pressableTestID: pet.sourceTestID,
            previewTestID: `settings-pets-local-preview-${pet.sourceKey.replace(/[^A-Za-z0-9_-]+/g, '-')}`,
            selectionControlTestID: `settings-pets-selection-control-${pet.sourceKey.replace(/[^A-Za-z0-9_-]+/g, '-')}`,
            petId: pet.petId,
            title: pet.displayName,
            subtitle: t('settingsPets.importedLocalSubtitle'),
            selected: pet.selected,
            source: pet.source,
            pet: null,
            actions: pet.actions,
            onPress: pet.onPress,
        })),
        ...params.accountPets.map((pet): DevicePetTile => ({
            kind: 'account',
            key: `account:${pet.accountPetId}`,
            testID: `settings-pets-account-tile-${pet.accountPetId.replace(/[^A-Za-z0-9_-]+/g, '-')}`,
            pressableTestID: pet.sourceTestID,
            previewTestID: pet.previewTestID,
            selectionControlTestID: `settings-pets-selection-control-${pet.accountPetId.replace(/[^A-Za-z0-9_-]+/g, '-')}`,
            petId: pet.petId,
            title: pet.displayName,
            subtitle: t('settingsPets.accountPetTileSubtitle'),
            selected: pet.selected,
            source: pet.source,
            pet: null,
            actions: pet.actions,
            onPress: pet.onPress,
        })),
        ...params.detectedPets.map((pet): DevicePetTile => ({
            kind: 'detected',
            key: `detected:${pet.sourceKey}`,
            testID: `settings-pets-detected-tile-${pet.sourceKey.replace(/[^A-Za-z0-9_-]+/g, '-')}`,
            pressableTestID: pet.sourceTestID,
            previewTestID: pet.previewTestID,
            petId: pet.petId,
            title: pet.displayName,
            subtitle: t('settingsPets.detectedCodexPetsTileSubtitle'),
            selected: false,
            source: pet.source,
            pet: null,
            actions: pet.actions,
            onPress: pet.onPress,
        })),
    ];
}
