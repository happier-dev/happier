import { PET_ATLAS_V1 } from '@happier-dev/protocol';

import {
    PET_COMPANION_OVERLAY_PADDING_PX,
    PET_COMPANION_OVERLAY_SCALE,
    resolvePetCompanionOverlayMetrics,
    type PetCompanionOverlayMetrics,
} from '@/components/pets/render/petCompanionDisplayMetrics';

export const DESKTOP_PET_OVERLAY_SCALE = PET_COMPANION_OVERLAY_SCALE;
export const DESKTOP_PET_OVERLAY_PADDING_PX = PET_COMPANION_OVERLAY_PADDING_PX;
export const DESKTOP_PET_OVERLAY_PLACEMENT_PADDING_PX = 0;
export const DESKTOP_PET_OVERLAY_SPRITE_WIDTH = PET_ATLAS_V1.cellWidth * DESKTOP_PET_OVERLAY_SCALE;
export const DESKTOP_PET_OVERLAY_SPRITE_HEIGHT = PET_ATLAS_V1.cellHeight * DESKTOP_PET_OVERLAY_SCALE;
export const DESKTOP_PET_OVERLAY_WINDOW_WIDTH = Math.ceil(
    DESKTOP_PET_OVERLAY_SPRITE_WIDTH + (DESKTOP_PET_OVERLAY_PADDING_PX * 2),
);
export const DESKTOP_PET_OVERLAY_WINDOW_HEIGHT = Math.ceil(
    DESKTOP_PET_OVERLAY_SPRITE_HEIGHT + (DESKTOP_PET_OVERLAY_PADDING_PX * 2),
);
export const DESKTOP_PET_OVERLAY_EXPANDED_WINDOW_WIDTH = 356;
export const DESKTOP_PET_OVERLAY_EXPANDED_WINDOW_HEIGHT = 420;
export const DESKTOP_PET_OVERLAY_TRAY_WIDTH = 276;
export const DESKTOP_PET_OVERLAY_TRAY_MAX_HEIGHT = 232;
export const DESKTOP_PET_OVERLAY_EXPANDED_MASCOT_RIGHT_INSET_PX = 36;
export const DESKTOP_PET_OVERLAY_EXPANDED_MASCOT_BOTTOM_INSET_PX = 18;
export const DESKTOP_PET_OVERLAY_TRAY_GAP_PX = 8;
export const DESKTOP_PET_OVERLAY_CONTEXT_BOTTOM_GAP_PX = 2;
export const DESKTOP_PET_OVERLAY_CONTEXT_MASCOT_TOP_OVERLAP_PX = 20;

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
