export type DesktopOverlayCornerRadii = Readonly<{
    topRadius: number;
    bottomRadius: number;
}>;

export const DESKTOP_OVERLAY_CLOSED_CORNERS: DesktopOverlayCornerRadii = {
    topRadius: 6,
    bottomRadius: 14,
};

export const DESKTOP_OVERLAY_OPEN_CORNERS: DesktopOverlayCornerRadii = {
    topRadius: 19,
    bottomRadius: 24,
};

function clampProgress(progress: number): number {
    if (!Number.isFinite(progress)) return 0;
    return Math.min(1, Math.max(0, progress));
}

function interpolateNumber(from: number, to: number, progress: number): number {
    return from + (to - from) * progress;
}

export function interpolateDesktopOverlayCorners(progress: number): DesktopOverlayCornerRadii {
    const clampedProgress = clampProgress(progress);
    return {
        topRadius: interpolateNumber(
            DESKTOP_OVERLAY_CLOSED_CORNERS.topRadius,
            DESKTOP_OVERLAY_OPEN_CORNERS.topRadius,
            clampedProgress,
        ),
        bottomRadius: interpolateNumber(
            DESKTOP_OVERLAY_CLOSED_CORNERS.bottomRadius,
            DESKTOP_OVERLAY_OPEN_CORNERS.bottomRadius,
            clampedProgress,
        ),
    };
}
