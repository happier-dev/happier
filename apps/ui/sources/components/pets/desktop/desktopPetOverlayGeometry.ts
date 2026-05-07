import { PET_ATLAS_V1 } from '@happier-dev/protocol';

import {
    PET_COMPANION_OVERLAY_PADDING_PX,
    PET_COMPANION_OVERLAY_SCALE,
    resolvePetCompanionOverlayMetrics,
    type PetCompanionOverlayMetrics,
} from '@/components/pets/render/petCompanionDisplayMetrics';

export const DESKTOP_PET_OVERLAY_SCALE = PET_COMPANION_OVERLAY_SCALE;
export const DESKTOP_PET_OVERLAY_PADDING_PX = PET_COMPANION_OVERLAY_PADDING_PX;
export const DESKTOP_PET_OVERLAY_SPRITE_WIDTH = PET_ATLAS_V1.cellWidth * DESKTOP_PET_OVERLAY_SCALE;
export const DESKTOP_PET_OVERLAY_SPRITE_HEIGHT = PET_ATLAS_V1.cellHeight * DESKTOP_PET_OVERLAY_SCALE;
export const DESKTOP_PET_OVERLAY_WINDOW_WIDTH = Math.ceil(
    DESKTOP_PET_OVERLAY_SPRITE_WIDTH + (DESKTOP_PET_OVERLAY_PADDING_PX * 2),
);
export const DESKTOP_PET_OVERLAY_WINDOW_HEIGHT = Math.ceil(
    DESKTOP_PET_OVERLAY_SPRITE_HEIGHT + (DESKTOP_PET_OVERLAY_PADDING_PX * 2),
);
export const DESKTOP_PET_OVERLAY_EXPANDED_WINDOW_WIDTH = 356;
export const DESKTOP_PET_OVERLAY_EXPANDED_WINDOW_HEIGHT = 320;
export const DESKTOP_PET_OVERLAY_TRAY_WIDTH = 276;
export const DESKTOP_PET_OVERLAY_TRAY_MAX_HEIGHT = 132;

export type DesktopPetOverlayGeometry = PetCompanionOverlayMetrics & Readonly<{
    expandedWindowWidth: number;
    expandedWindowHeight: number;
}>;

export function resolveDesktopPetOverlayGeometry(sizeScale: unknown): DesktopPetOverlayGeometry {
    const metrics = resolvePetCompanionOverlayMetrics(sizeScale);
    const widthDelta = metrics.windowWidth - DESKTOP_PET_OVERLAY_WINDOW_WIDTH;
    const heightDelta = metrics.windowHeight - DESKTOP_PET_OVERLAY_WINDOW_HEIGHT;

    return {
        ...metrics,
        expandedWindowWidth: DESKTOP_PET_OVERLAY_EXPANDED_WINDOW_WIDTH + Math.max(0, widthDelta),
        expandedWindowHeight: DESKTOP_PET_OVERLAY_EXPANDED_WINDOW_HEIGHT + Math.max(0, heightDelta),
    };
}
