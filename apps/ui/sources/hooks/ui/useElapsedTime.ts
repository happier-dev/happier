import { useNowMs } from '@/hooks/time/useNowMs';

const ELAPSED_TICK_MS = 1_000;

/**
 * Whole seconds elapsed since a timestamp, advancing once a second.
 *
 * The contract is the number; the timer behind it is not. This used to own a `setInterval` per
 * consumer, which on a streaming transcript meant one timer, one state update and one render per
 * running tool card, all computing the same instant — and all of them still running while the app
 * was backgrounded. It now reads the shared per-cadence clock, so every consumer costs one
 * subscriber on one timer that stops when the runtime is inactive and catches up on return.
 *
 * A `null` date still subscribes, because a hook cannot subscribe conditionally. That is the whole
 * cost of the shared clock here, it is one subscriber on an already-running bucket, and no caller
 * passes `null` in a steady state.
 */
export function useElapsedTime(date: Date | number | null | undefined): number {
    const nowMs = useNowMs(ELAPSED_TICK_MS);

    if (date == null) return 0;
    const startedAtMs = date instanceof Date ? date.getTime() : date;
    if (!Number.isFinite(startedAtMs)) return 0;

    return Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
}
