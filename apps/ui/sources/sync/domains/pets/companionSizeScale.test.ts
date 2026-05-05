import { describe, expect, it } from 'vitest';

import {
    PET_COMPANION_SIZE_SCALE_DEFAULT,
    normalizePetCompanionSizeScale,
    petCompanionSizeScaleToPercent,
    resolvePetCompanionSizeScaleFromTrackPosition,
} from './companionSizeScale';

describe('companionSizeScale', () => {
    it('normalizes companion size scale values to the supported stepped range', () => {
        expect(normalizePetCompanionSizeScale(null)).toBe(PET_COMPANION_SIZE_SCALE_DEFAULT);
        expect(normalizePetCompanionSizeScale(0)).toBe(0.75);
        expect(normalizePetCompanionSizeScale(0.77)).toBe(0.75);
        expect(normalizePetCompanionSizeScale(1.24)).toBe(1.25);
        expect(normalizePetCompanionSizeScale(99)).toBe(1.5);
    });

    it('resolves percent labels and track positions from the normalized scale range', () => {
        expect(petCompanionSizeScaleToPercent(1.25)).toBe(125);
        expect(resolvePetCompanionSizeScaleFromTrackPosition({
            locationX: 0,
            trackWidth: 200,
        })).toBe(0.75);
        expect(resolvePetCompanionSizeScaleFromTrackPosition({
            locationX: 200,
            trackWidth: 200,
        })).toBe(1.5);
    });
});
