import * as React from 'react';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { DEFAULT_NOW_MS_INTERVAL_MS, readNowMs, subscribeToNowMs } from './nowMsClockStore';

export type UseNowMsOptions = Readonly<{
    /**
     * Cadence to use instead of `intervalMs` while the OS reduced-motion preference is on.
     *
     * The clock holds no reduced-motion policy of its own: a caller that wants a calmer tick asks
     * for one and names the cadence, and a caller that omits this keeps `intervalMs` in every
     * accessibility mode.
     */
    reducedMotionIntervalMs?: number;
}>;

/**
 * Returns the current time as a millisecond timestamp, ticking at the configured interval.
 *
 * Use for relative-time and elapsed-time displays (e.g. "5m ago", a running agent's `0:42`) that
 * should update without depending on unrelated state changes.
 *
 * Every consumer of a given interval shares one timer and one instant — see `nowMsClockStore` for
 * the bucket store and the runtime-active gating that stops the clock while the app is
 * backgrounded or the document is hidden.
 *
 * Default interval: 60_000 ms (one minute) — matches RelativeTimeText's display granularity.
 */
export function useNowMs(
    intervalMs: number = DEFAULT_NOW_MS_INTERVAL_MS,
    options?: UseNowMsOptions,
): number {
    const reducedMotion = useReducedMotionPreference();
    const reducedMotionIntervalMs = options?.reducedMotionIntervalMs;
    const resolvedIntervalMs = reducedMotion && reducedMotionIntervalMs != null
        ? reducedMotionIntervalMs
        : intervalMs;

    const subscribe = React.useCallback(
        (listener: () => void) => subscribeToNowMs(resolvedIntervalMs, listener),
        [resolvedIntervalMs],
    );
    const getSnapshot = React.useCallback(() => readNowMs(resolvedIntervalMs), [resolvedIntervalMs]);

    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
