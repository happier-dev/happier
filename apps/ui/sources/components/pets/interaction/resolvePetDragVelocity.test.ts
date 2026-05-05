import { describe, expect, it } from 'vitest';

import { resolvePetDragVelocity } from './resolvePetDragVelocity';
import {
    PET_VELOCITY_MAX_MAGNITUDE_PX_PER_S,
    PET_VELOCITY_MIN_MAGNITUDE_PX_PER_S,
    PET_VELOCITY_MIN_SPAN_MS,
    PET_VELOCITY_SAMPLE_WINDOW_MS,
} from './petPointerDragConfig';

describe('resolvePetDragVelocity', () => {
    it('ignores releases below the minimum velocity magnitude', () => {
        expect(resolvePetDragVelocity([
            { x: 0, y: 0, timeMs: 0 },
            { x: 10, y: 0, timeMs: PET_VELOCITY_SAMPLE_WINDOW_MS },
        ])).toBeNull();
    });

    it('requires samples at least the configured span apart', () => {
        expect(resolvePetDragVelocity([
            { x: 0, y: 0, timeMs: 0 },
            { x: 100, y: 0, timeMs: PET_VELOCITY_MIN_SPAN_MS - 1 },
        ])).toBeNull();
    });

    it('caps release velocity magnitude while preserving direction', () => {
        const velocity = resolvePetDragVelocity([
            { x: 0, y: 0, timeMs: 0 },
            { x: 500, y: 0, timeMs: 50 },
        ]);

        expect(velocity).not.toBeNull();
        expect(Math.hypot(velocity?.x ?? 0, velocity?.y ?? 0)).toBe(PET_VELOCITY_MAX_MAGNITUDE_PX_PER_S);
        expect(velocity?.x).toBeGreaterThan(PET_VELOCITY_MIN_MAGNITUDE_PX_PER_S);
        expect(velocity?.y).toBe(0);
    });
});
