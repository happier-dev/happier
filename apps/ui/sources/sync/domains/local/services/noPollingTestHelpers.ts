import { expect, vi, type Mock } from 'vitest';

/**
 * G22: the local-services shared stores used to prove "no wall-clock poll" by reading their own
 * source text and asserting `expect(source).not.toContain('setInterval(')` — the exact
 * source-grep anti-pattern the harness work promised to remove. It is defeated by the most obvious
 * alternative spelling: a `setTimeout` that reschedules itself is a poll, contains no `setInterval(`,
 * and passed the guard.
 *
 * This asserts the behaviour instead. Under fake timers, `advanceTimersByTimeAsync` drains queued
 * timers *and* the microtasks between them, so a self-rescheduling `setTimeout` chain — including
 * one rescheduled from inside the fetch's own `.then` — runs to completion during the advance. Any
 * mechanism that re-fetches on a wall clock therefore shows up as extra calls on the fetch spy,
 * whichever timer primitive spells it.
 */
const DEFAULT_ADVANCE_MS = 10 * 60_000;

export async function expectNoWallClockPolling(input: Readonly<{
    /** Establishes the subscription under test and returns its unsubscribe. */
    subscribe: () => () => void;
    /** The store's fetch seam (`snapshotClient` / `statusClient`). */
    fetchSpy: Mock;
    advanceMs?: number;
}>): Promise<void> {
    vi.useFakeTimers();
    try {
        const unsubscribe = input.subscribe();
        try {
            // Settle the legitimate refCount 0->1 fetch.
            await vi.advanceTimersByTimeAsync(0);
            const afterInitialFetch = input.fetchSpy.mock.calls.length;
            // Guard against a vacuous pass: if the store never fetched at all, a later "no extra
            // fetch" assertion proves nothing about polling.
            expect(afterInitialFetch).toBeGreaterThan(0);

            await vi.advanceTimersByTimeAsync(input.advanceMs ?? DEFAULT_ADVANCE_MS);

            expect(input.fetchSpy.mock.calls.length).toBe(afterInitialFetch);
        } finally {
            unsubscribe();
        }
    } finally {
        vi.useRealTimers();
    }
}
