import { describe, expect, it } from 'vitest';

import {
    PET_COMPANION_POSITION_DEFAULT,
    PET_COMPANION_POSITION_SCHEMA_VERSION,
    createStoredPetCompanionPosition,
    denormalizePetCompanionPosition,
    normalizePetCompanionPosition,
    parsePetCompanionPosition,
    resolvePetCompanionPositionBounds,
} from './companionPosition';

describe('pet companion position persistence', () => {
    const viewport = {
        width: 390,
        height: 844,
        margin: 12,
        keyboardHeight: 300,
        safeAreaInsets: { top: 59, right: 0, bottom: 34, left: 0 },
    } as const;
    const petSize = { width: 96, height: 104 } as const;

    it('derives safe-area and keyboard-aware top-left bounds for native app-shell movement', () => {
        expect(resolvePetCompanionPositionBounds({ viewport, petSize })).toEqual({
            minX: 12,
            maxX: 282,
            minY: 71,
            maxY: 394,
        });
    });

    it('roundtrips absolute points through normalized storage without making pixels canonical', () => {
        const bounds = resolvePetCompanionPositionBounds({ viewport, petSize });
        const stored = createStoredPetCompanionPosition({
            surface: 'mobile-app-shell',
            point: { x: 282, y: 71 },
            bounds,
            viewport,
        });

        expect(stored).toEqual({
            schemaVersion: PET_COMPANION_POSITION_SCHEMA_VERSION,
            surface: 'mobile-app-shell',
            normalizedX: 1,
            normalizedY: 0,
            lastViewport: viewport,
        });
        expect(denormalizePetCompanionPosition(stored, bounds)).toEqual({ x: 282, y: 71 });
        expect(normalizePetCompanionPosition({ x: 999, y: -100 }, bounds)).toEqual({
            normalizedX: 1,
            normalizedY: 0,
        });
    });

    it('falls back to the versioned default when persisted data is missing or malformed', () => {
        expect(parsePetCompanionPosition(undefined)).toEqual(PET_COMPANION_POSITION_DEFAULT);
        expect(parsePetCompanionPosition({
            schemaVersion: 1,
            surface: 'mobile-app-shell',
            normalizedX: Number.NaN,
            normalizedY: 0.5,
            lastViewport: null,
        })).toEqual(PET_COMPANION_POSITION_DEFAULT);
    });
});
