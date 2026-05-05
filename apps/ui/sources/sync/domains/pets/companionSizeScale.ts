export const PET_COMPANION_SIZE_SCALE_MIN = 0.75;
export const PET_COMPANION_SIZE_SCALE_DEFAULT = 1;
export const PET_COMPANION_SIZE_SCALE_MAX = 1.5;
export const PET_COMPANION_SIZE_SCALE_STEP = 0.05;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function normalizePetCompanionSizeScale(value: unknown): number {
    const raw = typeof value === 'number' && Number.isFinite(value)
        ? value
        : PET_COMPANION_SIZE_SCALE_DEFAULT;
    const clamped = clamp(raw, PET_COMPANION_SIZE_SCALE_MIN, PET_COMPANION_SIZE_SCALE_MAX);
    const snapped =
        PET_COMPANION_SIZE_SCALE_MIN
        + Math.round((clamped - PET_COMPANION_SIZE_SCALE_MIN) / PET_COMPANION_SIZE_SCALE_STEP)
        * PET_COMPANION_SIZE_SCALE_STEP;
    return Number(clamp(snapped, PET_COMPANION_SIZE_SCALE_MIN, PET_COMPANION_SIZE_SCALE_MAX).toFixed(2));
}

export function petCompanionSizeScaleToPercent(value: unknown): number {
    return Math.round(normalizePetCompanionSizeScale(value) * 100);
}

export function resolvePetCompanionSizeScaleFromTrackPosition(params: Readonly<{
    locationX: number;
    trackWidth: number;
}>): number {
    const trackWidth = Number.isFinite(params.trackWidth) && params.trackWidth > 0
        ? params.trackWidth
        : 1;
    const progress = clamp(params.locationX / trackWidth, 0, 1);
    const raw =
        PET_COMPANION_SIZE_SCALE_MIN
        + progress * (PET_COMPANION_SIZE_SCALE_MAX - PET_COMPANION_SIZE_SCALE_MIN);
    return normalizePetCompanionSizeScale(raw);
}
