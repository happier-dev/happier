import React from 'react';

/**
 * Single shared runtime clock for the session-list surface.
 *
 * Group placement, working retention, and per-row working indicators all
 * derive time-gated state from a `nowMs` timestamp. Historically each layer
 * kept its own timer (list-level clock, one clock per row, `Date.now()` at
 * store commit), so the layers crossed freshness boundaries in different
 * render cycles and disagreed about whether a session was "working".
 *
 * This store is the canonical owner of that timestamp: consumers subscribe to
 * one `nowMs` value and register the wake time they need; the clock keeps a
 * single timer at the earliest requested wake. When it fires, every
 * subscriber re-renders in the same batched React commit with the same
 * timestamp, so placement and row indicators can never disagree about "now".
 */
export type SessionListRuntimeClock = Readonly<{
    getNowMs: () => number;
    subscribe: (listener: () => void) => () => void;
    requestWake: (token: object, wakeAtMs: number) => void;
    clearWake: (token: object) => void;
}>;

export function createSessionListRuntimeClock(): SessionListRuntimeClock {
    let nowMs = Date.now();
    let needsIdleRefresh = true;
    const listeners = new Set<() => void>();
    const wakeAtMsByToken = new Map<object, number>();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let scheduledWakeAtMs: number | null = null;

    function resolveEarliestWakeAtMs(): number | null {
        let earliest: number | null = null;
        for (const wakeAtMs of wakeAtMsByToken.values()) {
            earliest = earliest === null ? wakeAtMs : Math.min(earliest, wakeAtMs);
        }
        return earliest;
    }

    function fire(): void {
        timeoutId = null;
        scheduledWakeAtMs = null;
        nowMs = Date.now();
        // Wake requests are one-shot: consumers recompute their next horizon
        // from the new nowMs and re-register. Dropping satisfied requests here
        // prevents a stale past-time request from re-firing in a tight loop.
        for (const [token, wakeAtMs] of wakeAtMsByToken) {
            if (wakeAtMs <= nowMs) wakeAtMsByToken.delete(token);
        }
        for (const listener of [...listeners]) {
            listener();
        }
        reschedule();
    }

    function reschedule(): void {
        const earliest = resolveEarliestWakeAtMs();
        if (earliest === scheduledWakeAtMs) return;
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        scheduledWakeAtMs = earliest;
        if (earliest === null) return;
        const delayMs = Math.max(0, earliest - Date.now());
        timeoutId = setTimeout(fire, delayMs);
    }

    return {
        getNowMs: () => {
            // While no surface is subscribed the timestamp can go arbitrarily
            // stale. The first read after an idle period refreshes it ON THE
            // READ PATH so the mount render and the subsequent subscription
            // observe the SAME value — refreshing at subscribe time instead
            // would change the snapshot between render and subscription and
            // force a nondeterministic extra render (flaky by millisecond
            // boundaries).
            if (needsIdleRefresh && listeners.size === 0) {
                nowMs = Date.now();
                needsIdleRefresh = false;
            }
            return nowMs;
        },
        subscribe: (listener: () => void) => {
            if (listeners.size === 0) {
                // First subscriber after an idle period: drop any stale
                // schedule left over from the previous surface. nowMs itself
                // was already refreshed by the mount render's read.
                needsIdleRefresh = false;
                if (timeoutId !== null) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
                scheduledWakeAtMs = null;
                reschedule();
            }
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0) {
                    needsIdleRefresh = true;
                }
            };
        },
        requestWake: (token: object, wakeAtMs: number) => {
            if (wakeAtMsByToken.get(token) === wakeAtMs) return;
            wakeAtMsByToken.set(token, wakeAtMs);
            reschedule();
        },
        clearWake: (token: object) => {
            if (!wakeAtMsByToken.delete(token)) return;
            reschedule();
        },
    };
}

export const sessionListRuntimeClock: SessionListRuntimeClock = createSessionListRuntimeClock();

const noopSubscribe = () => () => {};

/**
 * Read the shared session-list runtime timestamp.
 *
 * While `enabled` is false the consumer is not subscribed: it does not
 * re-render on clock ticks and simply keeps the value read at its last
 * render (used to freeze inactive session-list surfaces).
 */
export function useSessionListRuntimeNowMs(
    enabled = true,
    clock: SessionListRuntimeClock = sessionListRuntimeClock,
): number {
    const subscribe = React.useCallback(
        (listener: () => void) => (enabled ? clock.subscribe(listener) : noopSubscribe()),
        [clock, enabled],
    );
    return React.useSyncExternalStore(subscribe, clock.getNowMs, clock.getNowMs);
}

/**
 * Register the next moment this consumer needs the shared clock to advance
 * (e.g. the earliest runtime-freshness expiry of the sessions it renders).
 * Requests are one-shot; re-register after each tick with the new horizon.
 */
export function useSessionListRuntimeWake(
    wakeAtMs: number | null,
    enabled = true,
    clock: SessionListRuntimeClock = sessionListRuntimeClock,
): void {
    const tokenRef = React.useRef<object | null>(null);
    if (tokenRef.current === null) tokenRef.current = {};
    React.useEffect(() => {
        if (!enabled || wakeAtMs === null) return undefined;
        const token = tokenRef.current as object;
        clock.requestWake(token, wakeAtMs);
        return () => {
            clock.clearWake(token);
        };
    }, [clock, enabled, wakeAtMs]);
}
