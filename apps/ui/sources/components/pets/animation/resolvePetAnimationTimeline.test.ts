import { describe, expect, it } from 'vitest';

import { PET_ANIMATION_ROWS_V1 } from '@happier-dev/protocol/pets/constants';

import {
    PET_ACTION_LOOP_COUNT,
    PET_IDLE_DURATION_MULTIPLIER,
} from './petAnimationPlaybackConfig';
import { resolvePetAnimationTimeline, resolvePetStatePlayback } from './resolvePetAnimationTimeline';

function rowTotalDurationMs(state: string): number {
    const row = PET_ANIMATION_ROWS_V1.find((entry) => entry.state === state);
    if (!row) throw new Error(`Missing pet animation row for ${state}`);
    return row.durationsMs.reduce((sum, value) => sum + value, 0);
}

describe('resolvePetAnimationTimeline', () => {
    it('selects both v2 look rows and holds the requested direction without a clock', () => {
        for (const [lookDirection, row, frame] of [[0, 9, 0], [7, 9, 7], [8, 10, 0], [15, 10, 7]] as const) {
            const input = { state: 'idle', elapsedMs: 3000, reducedMotion: false, spriteVersionNumber: 2, lookDirection } as const;
            expect(resolvePetStatePlayback('idle', input)).toMatchObject({ row, stillFrame: frame });
            expect(resolvePetAnimationTimeline(input)).toMatchObject({ row, frame });
        }
    });

    it('uses a known neutral cell and otherwise returns idle frame zero, while v1 keeps its state pose', () => {
        const input = { state: 'waving', elapsedMs: 0, reducedMotion: true, spriteVersionNumber: 2, lookDirection: 'neutral' } as const;
        expect(resolvePetAnimationTimeline({ ...input, hasNeutralLookCell: true })).toMatchObject({ row: 0, frame: 6 });
        expect(resolvePetAnimationTimeline(input)).toMatchObject({ row: 0, frame: 0 });
        expect(resolvePetAnimationTimeline({ ...input, spriteVersionNumber: 1 })).toMatchObject({ row: 3, frame: 1 });
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

    // R11 review: a state has the same resting frame on a face and the companion.
    it('keeps reduced motion on the canonical requested state still frame', () => {
        expect(resolvePetAnimationTimeline({
            state: 'failed',
            elapsedMs: 20_000,
            reducedMotion: true,
        })).toMatchObject({ state: 'failed', row: 5, frame: 7 });
    });

    it('gives hosts one row timing and resting-frame contract for loops and one-shots', () => {
        for (const [state, stillFrame] of [['running', 1], ['waiting', 0], ['failed', 7], ['waving', 1], ['jumping', 0], ['idle', 0]] as const) {
            const playback = resolvePetStatePlayback(state);
            const row = PET_ANIMATION_ROWS_V1.find(entry => entry.state === state)!;
            expect(playback.frames.map(entry => entry.durationMs)).toEqual(row.durationsMs);
            expect(playback).toMatchObject({ row: row.row, stillFrame, repeat: ['running', 'waiting'].includes(state) ? 'loop' : 'once' });
            expect(resolvePetAnimationTimeline({ state, elapsedMs: 0, reducedMotion: true })).toMatchObject({ state, frame: playback.stillFrame });
            expect(playback.frames.map(entry => entry.frame)).toEqual(Array.from({ length: row.frames }, (_, index) => index));
        }
    });
});
