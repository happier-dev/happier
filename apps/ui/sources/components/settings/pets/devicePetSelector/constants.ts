import type { BuiltInPetId } from '@/components/pets/builtIns/builtInPetRegistry';
import type { TranslationKeyNoParams } from '@/text/i18n';

export const DEVICE_PET_TILE_GAP = 10;
export const DEVICE_PET_GRID_HORIZONTAL_PADDING = 10;
export const DEVICE_PET_PREVIEW_SCALE = 0.5;
export const DEVICE_PET_PREVIEW_WIDTH = 112;
export const DEVICE_PET_PREVIEW_HEIGHT = 116;

export const BUILT_IN_PET_SUBTITLE_KEYS = {
    blink: 'settingsPets.builtInBlinkSubtitle',
    fury: 'settingsPets.builtInFurySubtitle',
    milo: 'settingsPets.builtInMiloSubtitle',
    oli: 'settingsPets.builtInOliSubtitle',
    titi: 'settingsPets.builtInTitiSubtitle',
} satisfies Record<BuiltInPetId, TranslationKeyNoParams>;
