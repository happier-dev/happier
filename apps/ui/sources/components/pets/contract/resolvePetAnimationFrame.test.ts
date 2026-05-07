import { describe, expect, it } from 'vitest';

import {
    PET_ANIMATION_ROWS_V1,
    PET_ATLAS_V1,
} from '@happier-dev/protocol';

import { PET_IDLE_DURATION_MULTIPLIER } from '@/components/pets/animation/petAnimationPlaybackConfig';

import { resolvePetAnimationFrame } from './resolvePetAnimationFrame';

describe('resolvePetAnimationFrame', () => {
    it('derives the atlas row and loops through state frame durations', () => {
        const idle = PET_ANIMATION_ROWS_V1.find((row) => row.state === 'idle');
        expect(idle).toBeDefined();
        if (!idle) throw new Error('expected idle pet animation row');
        const firstDurationMs = idle.durationsMs[0];
        const totalDurationMs = idle.durationsMs.reduce((sum, value) => sum + value, 0);

        expect(resolvePetAnimationFrame({
            state: 'idle',
            elapsedMs: 0,
            reducedMotion: false,
        })).toEqual({
            state: 'idle',
            row: idle.row,
            frame: 0,
            cellWidth: PET_ATLAS_V1.cellWidth,
            cellHeight: PET_ATLAS_V1.cellHeight,
        });

        expect(resolvePetAnimationFrame({
            state: 'idle',
            elapsedMs: firstDurationMs * PET_IDLE_DURATION_MULTIPLIER,
            reducedMotion: false,
        })).toMatchObject({
            state: 'idle',
            row: idle.row,
            frame: 1,
        });

        expect(resolvePetAnimationFrame({
            state: 'idle',
            elapsedMs: (totalDurationMs * PET_IDLE_DURATION_MULTIPLIER) + 1,
            reducedMotion: false,
        })).toMatchObject({
            state: 'idle',
            row: idle.row,
            frame: 0,
        });
    });

    it('freezes animation on the requested row frame zero when reduced motion is enabled', () => {
        expect(resolvePetAnimationFrame({
            state: 'running',
            elapsedMs: 10_000,
            reducedMotion: true,
        })).toMatchObject({
            state: 'running',
            row: 7,
            frame: 0,
        });
    });
});
