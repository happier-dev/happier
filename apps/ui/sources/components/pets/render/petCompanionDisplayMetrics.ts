import { PET_ATLAS_V1 } from '@happier-dev/protocol';

import { normalizePetCompanionSizeScale } from '@/sync/domains/pets/companionSizeScale';

export const PET_COMPANION_OVERLAY_SPRITE_WIDTH = 92;
export const PET_COMPANION_OVERLAY_SCALE = PET_COMPANION_OVERLAY_SPRITE_WIDTH / PET_ATLAS_V1.cellWidth;
export const PET_COMPANION_OVERLAY_PADDING_PX = 12;

export type PetCompanionOverlayMetrics = Readonly<{
    sizeScale: number;
    scale: number;
    spriteWidth: number;
    spriteHeight: number;
    windowWidth: number;
    windowHeight: number;
}>;

export function resolvePetCompanionOverlayMetrics(sizeScale: unknown): PetCompanionOverlayMetrics {
    const resolvedSizeScale = normalizePetCompanionSizeScale(sizeScale);
    const scale = PET_COMPANION_OVERLAY_SCALE * resolvedSizeScale;
    const spriteWidth = PET_ATLAS_V1.cellWidth * scale;
    const spriteHeight = PET_ATLAS_V1.cellHeight * scale;

    return {
        sizeScale: resolvedSizeScale,
        scale,
        spriteWidth,
        spriteHeight,
        windowWidth: Math.ceil(spriteWidth + (PET_COMPANION_OVERLAY_PADDING_PX * 2)),
        windowHeight: Math.ceil(spriteHeight + (PET_COMPANION_OVERLAY_PADDING_PX * 2)),
    };
}
