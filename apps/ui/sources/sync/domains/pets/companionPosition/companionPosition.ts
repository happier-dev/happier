import { z } from 'zod/mini';
import { createPersistentUiState } from '@/sync/domains/state/persistentUiState';

export const PET_COMPANION_POSITION_SCHEMA_VERSION = 1;
export const PET_COMPANION_POSITION_DEFAULT_NORMALIZED_X = 0.82;
export const PET_COMPANION_POSITION_DEFAULT_NORMALIZED_Y = 0.72;
export const PET_COMPANION_POSITION_DEFAULT_MARGIN_PT = 12;

export const PetCompanionSafeAreaInsetsSchema = z.object({
    top: z.number().check(z.minimum(0)),
    right: z.number().check(z.minimum(0)),
    bottom: z.number().check(z.minimum(0)),
    left: z.number().check(z.minimum(0)),
});

export const PetCompanionViewportMetricsSchema = z.object({
    width: z.number().check(z.minimum(0)),
    height: z.number().check(z.minimum(0)),
    margin: z.number().check(z.minimum(0)),
    keyboardHeight: z.number().check(z.minimum(0)),
    safeAreaInsets: PetCompanionSafeAreaInsetsSchema,
});

export const PetCompanionStoredPositionSchema = z.object({
    schemaVersion: z.literal(PET_COMPANION_POSITION_SCHEMA_VERSION),
    surface: z.literal('mobile-app-shell'),
    normalizedX: z.number().check(z.minimum(0), z.maximum(1)),
    normalizedY: z.number().check(z.minimum(0), z.maximum(1)),
    lastViewport: z.nullable(PetCompanionViewportMetricsSchema),
});

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

export const petCompanionPositionState = createPersistentUiState('pet-companion-position-v1', parsePetCompanionPosition);

/** Hydration imports the old device setting before its carrier can be retired. */
export function migratePetCompanionPositionFromSettings(input: unknown): unknown {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    const stored = input as Record<string, unknown>;
    if (!Object.hasOwn(stored, 'petsCompanionPosition')) return input;
    // Strict admission preserves opaque source/destination bytes on refusal; a
    // tolerant presentation default must never authorize deleting their source.
    const position = PetCompanionStoredPositionSchema.parse(stored.petsCompanionPosition);
    if (petCompanionPositionState.readStrict(position.surface, value => PetCompanionStoredPositionSchema.parse(value)) === undefined) {
        petCompanionPositionState.set(position.surface, position);
    }
    const { petsCompanionPosition: _legacyPosition, ...retained } = stored;
    return retained;
}
