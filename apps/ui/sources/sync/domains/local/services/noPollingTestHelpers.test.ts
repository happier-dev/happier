import { describe, expect, it, vi } from 'vitest';

import { expectNoWallClockPolling } from './noPollingTestHelpers';

/**
 * G22: the guard this file tests replaced four source-text greps for `setInterval(`. A source grep
 * is trivially defeated by `setTimeout` recursion, so the replacement is only worth having if it
 * actually catches one. These cases pin exactly that: the guard must pass for a store that fetches
 * once on subscribe, and must fail for both spellings of a wall-clock poll — including the
 * `setTimeout` chain rescheduled from inside the fetch continuation, which is the shape a real
 * poll-by-accident takes.
 */
function createFakeStore(options: Readonly<{ poll?: 'none' | 'setInterval' | 'setTimeoutRecursion' }>) {
    const fetchSpy = vi.fn(async () => ({ ok: true }));

    function subscribe(): () => void {
        let stopped = false;
        let interval: ReturnType<typeof setInterval> | null = null;
        let timeout: ReturnType<typeof setTimeout> | null = null;

        const runFetch = (): Promise<unknown> => fetchSpy();

        void runFetch().then(() => {
            if (stopped) return;
            if (options.poll === 'setTimeoutRecursion') {
                const loop = (): void => {
                    timeout = setTimeout(() => {
                        if (stopped) return;
                        void runFetch().then(() => {
                            if (!stopped) loop();
                        });
                    }, 30_000);
                };
                loop();
            }
        });

        if (options.poll === 'setInterval') {
            interval = setInterval(() => {
                if (!stopped) void runFetch();
            }, 30_000);
        }

        return () => {
            stopped = true;
            if (interval) clearInterval(interval);
            if (timeout) clearTimeout(timeout);
        };
    }

    return { fetchSpy, subscribe };
}

describe('expectNoWallClockPolling', () => {
    it('passes for a store that fetches once on subscribe and never on a wall clock', async () => {
        const store = createFakeStore({ poll: 'none' });
        await expect(expectNoWallClockPolling(store)).resolves.toBeUndefined();
    });

    it('fails for a setInterval poll', async () => {
        const store = createFakeStore({ poll: 'setInterval' });
        await expect(expectNoWallClockPolling(store)).rejects.toThrow();
    });

    it('fails for a setTimeout recursion loop — the case the source grep could not see', async () => {
        const store = createFakeStore({ poll: 'setTimeoutRecursion' });
        await expect(expectNoWallClockPolling(store)).rejects.toThrow();
    });

    it('fails rather than passing vacuously when the store never fetches at all', async () => {
        await expect(expectNoWallClockPolling({
            subscribe: () => () => {},
            fetchSpy: vi.fn(),
        })).rejects.toThrow();
    });
});
