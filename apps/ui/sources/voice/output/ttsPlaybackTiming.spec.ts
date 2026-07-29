import { describe, expect, it } from 'vitest';

import { createTtsPlaybackClock } from './ttsPlaybackTiming';

describe('createTtsPlaybackClock', () => {
    it('reports unknown (MAX_SAFE_INTEGER) played-ms before speaking starts', () => {
        const clock = createTtsPlaybackClock(() => 1_000);
        expect(clock.isStarted()).toBe(false);
        expect(clock.playedMs()).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('measures confirmed-played duration from the speaking start', () => {
        let now = 1_000;
        const clock = createTtsPlaybackClock(() => now);
        clock.markStarted();
        expect(clock.isStarted()).toBe(true);
        now = 1_750;
        expect(clock.playedMs()).toBe(750);
        // Explicit `at` overrides the clock for deterministic interrupt timing.
        expect(clock.playedMs(2_500)).toBe(1_500);
    });

    it('never returns a negative played-ms when the clock runs backwards', () => {
        const clock = createTtsPlaybackClock(() => 5_000);
        clock.markStarted(5_000);
        expect(clock.playedMs(4_000)).toBe(0);
    });

    it('returns to unknown after reset', () => {
        let now = 0;
        const clock = createTtsPlaybackClock(() => now);
        clock.markStarted();
        now = 500;
        expect(clock.playedMs()).toBe(500);
        clock.reset();
        expect(clock.isStarted()).toBe(false);
        expect(clock.playedMs()).toBe(Number.MAX_SAFE_INTEGER);
    });
});
