import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKeyedTimeoutScheduler } from './keyedTimeoutScheduler';

afterEach(() => {
    vi.useRealTimers();
});

describe('createKeyedTimeoutScheduler', () => {
    it('fires once per key and forgets the key before invoking the callback', () => {
        vi.useFakeTimers();
        const scheduler = createKeyedTimeoutScheduler();
        const fired: string[] = [];

        scheduler.schedule('a', 1_000, () => {
            fired.push('a');
            // Rescheduling from inside the callback must work: the key was
            // already released before the callback ran.
            scheduler.schedule('a', 1_000, () => fired.push('a2'));
        });

        vi.advanceTimersByTime(1_000);
        expect(fired).toEqual(['a']);
        vi.advanceTimersByTime(1_000);
        expect(fired).toEqual(['a', 'a2']);
    });

    it('replaces a pending timeout when the same key is rescheduled', () => {
        vi.useFakeTimers();
        const scheduler = createKeyedTimeoutScheduler();
        const fired: string[] = [];

        scheduler.schedule('a', 1_000, () => fired.push('first'));
        vi.advanceTimersByTime(500);
        scheduler.schedule('a', 1_000, () => fired.push('second'));
        vi.advanceTimersByTime(1_000);

        expect(fired).toEqual(['second']);
    });

    it('cancel drops a pending timeout and tolerates unknown keys', () => {
        vi.useFakeTimers();
        const scheduler = createKeyedTimeoutScheduler();
        const fired: string[] = [];

        scheduler.schedule('a', 1_000, () => fired.push('a'));
        scheduler.cancel('a');
        scheduler.cancel('missing');
        vi.advanceTimersByTime(2_000);

        expect(fired).toEqual([]);
    });

    it('tracks keys independently', () => {
        vi.useFakeTimers();
        const scheduler = createKeyedTimeoutScheduler();
        const fired: string[] = [];

        scheduler.schedule('a', 1_000, () => fired.push('a'));
        scheduler.schedule('b', 500, () => fired.push('b'));
        scheduler.cancel('a');
        vi.advanceTimersByTime(1_000);

        expect(fired).toEqual(['b']);
    });
});
