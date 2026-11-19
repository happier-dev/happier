import * as React from 'react';

import { subscribeToNowMs } from './nowMsClockStore';

/** Subscribe only while the presented countdown can change. All deadlines share the clock. */
export function useDeadlineSeconds(
    deadlineMs: number | null,
    presented: boolean,
    nowMs: () => number = Date.now,
    adaptive = true,
): number {
    const readSeconds = React.useCallback(() => deadlineMs === null
        ? 0
        : Math.max(0, Math.ceil((deadlineMs - nowMs()) / 1_000)), [deadlineMs, nowMs]);
    const secondsBeforeSubscribe = readSeconds();
    const cadenceMs = adaptive && secondsBeforeSubscribe > 60 ? 60_000 : 1_000;
    const subscribe = React.useCallback((notify: () => void) => {
        if (!presented || readSeconds() === 0) return () => {};
        const stop = subscribeToNowMs(cadenceMs, () => {
            notify();
            if (readSeconds() === 0) stop();
        });
        return stop;
    }, [presented, readSeconds, cadenceMs]);
    return React.useSyncExternalStore(subscribe, readSeconds, readSeconds);
}
