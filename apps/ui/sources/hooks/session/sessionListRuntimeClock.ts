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
 * subscriber can read the same timestamp, so placement and row indicators
 * cannot disagree about "now". Deadline-only surfaces are notified only for
 * their own freshness boundary, not for unrelated subscribers' wakes.
 */
export type SessionListRuntimeClock = Readonly<{
    getNowMs: () => number;
    subscribe: (listener: () => void) => () => void;
    subscribeWake: (token: object, listener: () => void) => () => void;
    requestWake: (token: object, wakeAtMs: number) => void;
    clearWake: (token: object) => void;
}>;

type ClockSubscription = Readonly<{ listener: () => void; wakeToken?: object }>;

export function createSessionListRuntimeClock(): SessionListRuntimeClock {
    let nowMs = Date.now();
    let needsIdleRefresh = true;
    const listeners = new Set<ClockSubscription>();
    const wakeRequests = new Map<object, { wakeAtMs: number | null; subscription?: ClockSubscription }>();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let scheduledWakeAtMs: number | null = null;

    function resolveEarliestWakeAtMs(): number | null {
        let earliest: number | null = null;
        for (const { wakeAtMs } of wakeRequests.values()) {
            if (wakeAtMs === null) continue;
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
        const due = new Set<ClockSubscription>();
        for (const [token, request] of wakeRequests) {
            if (request.wakeAtMs === null || request.wakeAtMs > nowMs) continue;
            if (request.subscription) {
                request.wakeAtMs = null;
                due.add(request.subscription);
            } else {
                wakeRequests.delete(token);
            }
        }
        // One subscription order and one canonical instant serve both kinds of
        // reader. Unrelated date leaves do not receive a callback/getSnapshot.
        for (const subscription of [...listeners]) {
            if (subscription.wakeToken === undefined || due.has(subscription)) subscription.listener();
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
        // JS timers overflow signed 32-bit delays to 1ms. Far-future label
        // boundaries must wait in platform-sized chunks, not spin or expire early.
        const delayMs = Math.min(2_147_483_647, Math.max(0, earliest - Date.now()));
        timeoutId = setTimeout(fire, delayMs);
    }

    function subscribeToClock(subscription: ClockSubscription): () => void {
        if (listeners.size === 0) {
            // Both global and local subscriptions count as active. The mount
            // read already refreshed nowMs; subscribing must not change it.
            needsIdleRefresh = false;
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            scheduledWakeAtMs = null;
            reschedule();
        }
        listeners.add(subscription);
        return () => {
            listeners.delete(subscription);
            if (listeners.size === 0) needsIdleRefresh = true;
        };
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
        subscribe: listener => subscribeToClock({ listener }),
        subscribeWake: (token, listener) => {
            const subscription: ClockSubscription = { listener, wakeToken: token };
            const request = wakeRequests.get(token) ?? { wakeAtMs: null, subscription };
            request.subscription = subscription;
            wakeRequests.set(token, request);
            const unsubscribe = subscribeToClock(subscription);
            return () => {
                unsubscribe();
                if (wakeRequests.get(token)?.subscription === subscription) wakeRequests.delete(token);
                reschedule();
            };
        },
        requestWake: (token: object, wakeAtMs: number) => {
            const request = wakeRequests.get(token);
            if (request?.wakeAtMs === wakeAtMs) return;
            if (request) request.wakeAtMs = wakeAtMs;
            else wakeRequests.set(token, { wakeAtMs });
            reschedule();
        },
        clearWake: (token: object) => {
            const request = wakeRequests.get(token);
            if (!request) return;
            if (request.subscription) request.wakeAtMs = null;
            else wakeRequests.delete(token);
            reschedule();
        },
    };
}

export const sessionListRuntimeClock: SessionListRuntimeClock = createSessionListRuntimeClock();

const noopSubscribe = () => () => {};

function useWakeToken(): object {
    const tokenRef = React.useRef<object | null>(null);
    if (tokenRef.current === null) tokenRef.current = {};
    return tokenRef.current;
}

/**
 * Read the shared session-list runtime timestamp.
 *
 * While `enabled` is false the consumer is not subscribed: it does not
 * re-render on clock ticks and simply keeps the value read at its last
 * render (used to freeze inactive session-list surfaces).
 * A shared wakeToken with useSessionListRuntimeWake limits notifications to
 * that consumer's deadline; omitted tokens retain the all-wakes read contract.
 */
export function useSessionListRuntimeNowMs(
    enabled = true,
    clock: SessionListRuntimeClock = sessionListRuntimeClock,
    wakeToken?: object,
): number {
    const subscribe = React.useCallback(
        (listener: () => void) => enabled
            ? wakeToken ? clock.subscribeWake(wakeToken, listener) : clock.subscribe(listener)
            : noopSubscribe(),
        [clock, enabled, wakeToken],
    );
    return React.useSyncExternalStore(subscribe, clock.getNowMs, clock.getNowMs);
}

/** Status-only surfaces need the shared instant at their own freshness boundary,
 * not a render for every relative-time or other surface's wake. Source changes
 * refresh the instant immediately; deadlines still use the single clock/timer. */
export function useSessionListRuntimeDeadlineNowMs(
    readNextRefreshAtMs: (nowMs: number) => number | null,
    enabled = true,
    clock: SessionListRuntimeClock = sessionListRuntimeClock,
    subscribeDeadlineChanges?: (listener: () => void) => () => void,
): number {
    const token = useWakeToken();
    const snapshot = React.useMemo(() => {
        let nowMs = Math.max(clock.getNowMs(), Date.now());
        let nextRefreshAtMs = readNextRefreshAtMs(nowMs);
        return {
            get: () => nowMs,
            advance: () => {
                nowMs = clock.getNowMs();
                nextRefreshAtMs = readNextRefreshAtMs(nowMs);
            },
            nextRefresh: () => nextRefreshAtMs,
            reconcile: () => { nextRefreshAtMs = readNextRefreshAtMs(Date.now()); },
        };
    }, [clock, enabled, readNextRefreshAtMs]);
    const subscribe = React.useCallback((listener: () => void) => {
        if (!enabled) return noopSubscribe();
        const stopClock = clock.subscribeWake(token, () => { snapshot.advance(); listener(); });
        const stopChanges = subscribeDeadlineChanges?.(() => {
            snapshot.reconcile();
            const deadline = snapshot.nextRefresh();
            if (deadline === null) clock.clearWake(token);
            else clock.requestWake(token, deadline);
        });
        return () => { stopClock(); stopChanges?.(); };
    }, [clock, enabled, snapshot, token, subscribeDeadlineChanges]);
    const nowMs = React.useSyncExternalStore(subscribe, snapshot.get, snapshot.get);
    useClockWake(snapshot.nextRefresh(), enabled, clock, token);
    return nowMs;
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
    wakeToken?: object,
): void {
    const ownedToken = useWakeToken();
    useClockWake(wakeAtMs, enabled, clock, wakeToken ?? ownedToken);
}

function useClockWake(wakeAtMs: number | null, enabled: boolean, clock: SessionListRuntimeClock, token: object): void {
    React.useEffect(() => {
        if (!enabled || wakeAtMs === null) return undefined;
        clock.requestWake(token, wakeAtMs);
        return () => {
            clock.clearWake(token);
        };
    }, [clock, enabled, token, wakeAtMs]);
}

export const SESSION_LIST_RELATIVE_TIME_CLOCK_INTERVAL_MS = 60_000;

/**
 * Read the shared timestamp that relative session-list labels ("5m ago") are
 * rendered from.
 *
 * Relative labels need the clock to advance on a cadence of its own, because
 * nothing in the store moves when a minute passes. That cadence is expressed
 * as a rolling wake request on the SAME clock every other session-list layer
 * reads, rather than as a timer of its own: a list of N rows then costs one
 * timer and renders one instant, instead of N timers each carrying their own
 * `Date.now()`. A tick requested by any other consumer also refreshes the
 * label and pushes this horizon forward, so a label is never more than one
 * cadence stale.
 *
 * While `enabled` is false the consumer neither subscribes nor requests a
 * wake, so an inactive or backgrounded surface stops the cadence instead of
 * ticking unobserved.
 */
export function useSessionListRelativeNowMs(
    enabled = true,
    clock: SessionListRuntimeClock = sessionListRuntimeClock,
): number {
    const nowMs = useSessionListRuntimeNowMs(enabled, clock);
    useSessionListRuntimeWake(
        enabled ? nowMs + SESSION_LIST_RELATIVE_TIME_CLOCK_INTERVAL_MS : null,
        enabled,
        clock,
    );
    return nowMs;
}
