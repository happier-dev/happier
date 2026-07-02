import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitForVisualUpdateWithTimeout } from './waitForVisualUpdateWithTimeout';

describe('waitForVisualUpdateWithTimeout', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('resolves as completed when the visual update settles before the timeout', async () => {
        vi.useFakeTimers();
        const outcome = waitForVisualUpdateWithTimeout({
            waitForNextVisualUpdate: () => Promise.resolve(),
            timeoutMs: 1_000,
        });
        await expect(outcome).resolves.toBe('completed');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('falls back to the timer when rAF is starved (background tab, E10)', async () => {
        vi.useFakeTimers();
        const neverSettlingVisualUpdate = () => new Promise<void>(() => {});

        let outcome: 'completed' | 'timed-out' | null = null;
        const pending = waitForVisualUpdateWithTimeout({
            waitForNextVisualUpdate: neverSettlingVisualUpdate,
            timeoutMs: 1_000,
        }).then((value) => {
            outcome = value;
        });

        await vi.advanceTimersByTimeAsync(999);
        expect(outcome).toBeNull();

        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(outcome).toBe('timed-out');
    });

    it('resolves as completed when the injected fn rejects instead of stalling callers', async () => {
        vi.useFakeTimers();
        const outcome = waitForVisualUpdateWithTimeout({
            waitForNextVisualUpdate: () => Promise.reject(new Error('raf backend gone')),
            timeoutMs: 1_000,
        });
        await expect(outcome).resolves.toBe('completed');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('resolves as completed when the injected fn throws synchronously', async () => {
        vi.useFakeTimers();
        const outcome = waitForVisualUpdateWithTimeout({
            waitForNextVisualUpdate: () => {
                throw new Error('boom');
            },
            timeoutMs: 1_000,
        });
        await expect(outcome).resolves.toBe('completed');
    });

    it('treats a non-finite or negative timeout as an immediate fallback (never unbounded)', async () => {
        vi.useFakeTimers();
        const neverSettlingVisualUpdate = () => new Promise<void>(() => {});

        const nan = waitForVisualUpdateWithTimeout({
            waitForNextVisualUpdate: neverSettlingVisualUpdate,
            timeoutMs: Number.NaN,
        });
        const negative = waitForVisualUpdateWithTimeout({
            waitForNextVisualUpdate: neverSettlingVisualUpdate,
            timeoutMs: -5,
        });
        await vi.advanceTimersByTimeAsync(0);
        await expect(nan).resolves.toBe('timed-out');
        await expect(negative).resolves.toBe('timed-out');
    });

    it('clears the fallback timer once the visual update wins the race', async () => {
        vi.useFakeTimers();
        let settle: (() => void) | null = null;
        const pending = waitForVisualUpdateWithTimeout({
            waitForNextVisualUpdate: () => new Promise<void>((resolve) => {
                settle = resolve;
            }),
            timeoutMs: 60_000,
        });
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(0);
        settle!();
        await expect(pending).resolves.toBe('completed');
        expect(vi.getTimerCount()).toBe(0);
    });
});
