import { z } from 'zod';

export const PET_COMPANION_POSITION_SCHEMA_VERSION = 1;
export const PET_COMPANION_POSITION_DEFAULT_NORMALIZED_X = 0.82;
export const PET_COMPANION_POSITION_DEFAULT_NORMALIZED_Y = 0.72;
export const PET_COMPANION_POSITION_DEFAULT_MARGIN_PT = 12;

export const PetCompanionSafeAreaInsetsSchema = z.object({
    top: z.number().min(0),
    right: z.number().min(0),
    bottom: z.number().min(0),
    left: z.number().min(0),
}).strip();

export const PetCompanionViewportMetricsSchema = z.object({
    width: z.number().min(0),
    height: z.number().min(0),
    margin: z.number().min(0),
    keyboardHeight: z.number().min(0),
    safeAreaInsets: PetCompanionSafeAreaInsetsSchema,
}).strip();

export const PetCompanionStoredPositionSchema = z.object({
    schemaVersion: z.literal(PET_COMPANION_POSITION_SCHEMA_VERSION),
    surface: z.literal('mobile-app-shell'),
    normalizedX: z.number().min(0).max(1),
    normalizedY: z.number().min(0).max(1),
    lastViewport: PetCompanionViewportMetricsSchema.nullable(),
}).strip();

export type PetCompanionSafeAreaInsets = z.infer<typeof PetCompanionSafeAreaInsetsSchema>;
export type PetCompanionViewportMetrics = z.infer<typeof PetCompanionViewportMetricsSchema>;
export type PetCompanionStoredPosition = z.infer<typeof PetCompanionStoredPositionSchema>;

export type PetCompanionPoint = Readonly<{
    x: number;
    y: number;
}>;

export type PetCompanionSize = Readonly<{
    width: number;
    height: number;
}>;

export type PetCompanionPositionBounds = Readonly<{
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}>;

export const PET_COMPANION_POSITION_DEFAULT: PetCompanionStoredPosition = Object.freeze({
    schemaVersion: PET_COMPANION_POSITION_SCHEMA_VERSION,
    surface: 'mobile-app-shell',
    normalizedX: PET_COMPANION_POSITION_DEFAULT_NORMALIZED_X,
    normalizedY: PET_COMPANION_POSITION_DEFAULT_NORMALIZED_Y,
    lastViewport: null,
});

function finiteNonNegative(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
}

export function resolvePetCompanionPositionBounds(params: Readonly<{
    viewport: PetCompanionViewportMetrics;
    petSize: PetCompanionSize;
}>): PetCompanionPositionBounds {
    const width = finiteNonNegative(params.viewport.width);
    const height = finiteNonNegative(params.viewport.height);
    const margin = finiteNonNegative(params.viewport.margin);
    const keyboardHeight = finiteNonNegative(params.viewport.keyboardHeight);
    const safeAreaInsets = params.viewport.safeAreaInsets;
    const petWidth = finiteNonNegative(params.petSize.width);
    const petHeight = finiteNonNegative(params.petSize.height);

    const minX = finiteNonNegative(safeAreaInsets.left) + margin;
    const maxX = Math.max(
        minX,
        width - finiteNonNegative(safeAreaInsets.right) - margin - petWidth,
    );
    const minY = finiteNonNegative(safeAreaInsets.top) + margin;
    const maxY = Math.max(
        minY,
        height - finiteNonNegative(safeAreaInsets.bottom) - keyboardHeight - margin - petHeight,
    );

    return { minX, maxX, minY, maxY };
}

export function denormalizePetCompanionPosition(
    position: Pick<PetCompanionStoredPosition, 'normalizedX' | 'normalizedY'>,
    bounds: PetCompanionPositionBounds,
): PetCompanionPoint {
    const normalizedX = clamp(position.normalizedX, 0, 1);
    const normalizedY = clamp(position.normalizedY, 0, 1);
    return {
        x: bounds.minX + ((bounds.maxX - bounds.minX) * normalizedX),
        y: bounds.minY + ((bounds.maxY - bounds.minY) * normalizedY),
    };
}

export function normalizePetCompanionPosition(
    point: PetCompanionPoint,
    bounds: PetCompanionPositionBounds,
): Readonly<{ normalizedX: number; normalizedY: number }> {
    const clampedX = clamp(point.x, bounds.minX, bounds.maxX);
    const clampedY = clamp(point.y, bounds.minY, bounds.maxY);
    const rangeX = bounds.maxX - bounds.minX;
    const rangeY = bounds.maxY - bounds.minY;

    return {
        normalizedX: rangeX > 0 ? (clampedX - bounds.minX) / rangeX : 0,
        normalizedY: rangeY > 0 ? (clampedY - bounds.minY) / rangeY : 0,
    };
}

export function createStoredPetCompanionPosition(params: Readonly<{
    surface: PetCompanionStoredPosition['surface'];
    point: PetCompanionPoint;
    bounds: PetCompanionPositionBounds;
    viewport: PetCompanionViewportMetrics;
}>): PetCompanionStoredPosition {
    const normalized = normalizePetCompanionPosition(params.point, params.bounds);
    return {
        schemaVersion: PET_COMPANION_POSITION_SCHEMA_VERSION,
        surface: params.surface,
        normalizedX: normalized.normalizedX,
        normalizedY: normalized.normalizedY,
        lastViewport: params.viewport,
    };
}

export function parsePetCompanionPosition(value: unknown): PetCompanionStoredPosition {
    const parsed = PetCompanionStoredPositionSchema.safeParse(value);
    return parsed.success ? parsed.data : PET_COMPANION_POSITION_DEFAULT;
}
