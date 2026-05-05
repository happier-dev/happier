import { describe, expect, it } from 'vitest';

import { PET_ANIMATION_ROWS_V1 } from '@happier-dev/protocol';

import {
    PET_ACTION_LOOP_COUNT,
    PET_IDLE_DURATION_MULTIPLIER,
} from './petAnimationPlaybackConfig';
import { resolvePetAnimationTimeline } from './resolvePetAnimationTimeline';

function rowTotalDurationMs(state: string): number {
    const row = PET_ANIMATION_ROWS_V1.find((entry) => entry.state === state);
    if (!row) throw new Error(`Missing pet animation row for ${state}`);
    return row.durationsMs.reduce((sum, value) => sum + value, 0);
}

describe('resolvePetAnimationTimeline', () => {
    it('pins the authoritative idle row durations', () => {
        const idle = PET_ANIMATION_ROWS_V1.find((entry) => entry.state === 'idle');

        expect(idle?.durationsMs).toEqual([280, 110, 110, 140, 140, 320]);
    });

    it('applies the idle duration multiplier only to idle playback', () => {
        const idle = PET_ANIMATION_ROWS_V1.find((entry) => entry.state === 'idle');
        const firstIdleDurationMs = idle?.durationsMs[0] ?? 0;

        expect(resolvePetAnimationTimeline({
            state: 'idle',
            elapsedMs: (firstIdleDurationMs * PET_IDLE_DURATION_MULTIPLIER) - 1,
            reducedMotion: false,
        })).toMatchObject({ state: 'idle', frame: 0 });

        expect(resolvePetAnimationTimeline({
            state: 'idle',
            elapsedMs: firstIdleDurationMs * PET_IDLE_DURATION_MULTIPLIER,
            reducedMotion: false,
        })).toMatchObject({ state: 'idle', frame: 1 });
    });

    it('returns non-idle actions to idle after the configured loop count', () => {
        const actionDurationMs = rowTotalDurationMs('jumping');

        expect(resolvePetAnimationTimeline({
            state: 'jumping',
            elapsedMs: (actionDurationMs * PET_ACTION_LOOP_COUNT) - 1,
            reducedMotion: false,
        }).state).toBe('jumping');

        expect(resolvePetAnimationTimeline({
            state: 'jumping',
            elapsedMs: actionDurationMs * PET_ACTION_LOOP_COUNT,
            reducedMotion: false,
        })).toMatchObject({ state: 'idle', row: 0, frame: 0 });
    });

    it('keeps reduced motion on the requested state still frame', () => {
        expect(resolvePetAnimationTimeline({
            state: 'failed',
            elapsedMs: 20_000,
            reducedMotion: true,
        })).toMatchObject({ state: 'failed', row: 5, frame: 0 });
    });
});
