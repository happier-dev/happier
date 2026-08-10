import * as React from 'react';

/**
 * Whether a list may re-lay-out right now without moving content under the person reading it.
 *
 * The agent roster re-groups itself as agents finish, and a re-group is a real layout change: rows
 * above the reader's finger shift. Doing that mid-scroll or under a hovering cursor turns a press
 * into a mis-press, so the migration waits. This is the one owner of "waits for what" — the list
 * asks it, and the batch that is holding a migration subscribes so it can commit the moment the
 * list settles, with no render in between to notice.
 *
 * It is deliberately NOT React state. Scrolling produces a signal several times a second, and a
 * roster that re-rendered on each of them would cost far more than the reflow it is protecting.
 */

/**
 * How long after the last scroll event the list counts as still.
 *
 * A scroll has no end event on web, and momentum keeps producing events on native, so the honest
 * shape for both is "no scroll signal for a moment". Long enough to bridge the gap between two
 * momentum frames, short enough that the migration is not left visibly waiting.
 */
export const LIST_MOTION_SCROLL_IDLE_MS = 250;

/**
 * `scrollEventThrottle` for the host scroller.
 *
 * Only the FACT of scrolling matters here, never the offset, so this is deliberately far coarser
 * than the 16 ms a scroll-linked animation would need — ten signals a second is plenty to keep the
 * idle window open, at a tenth of the event traffic.
 */
export const LIST_MOTION_SCROLL_EVENT_THROTTLE_MS = 100;

export type ListMotionQuiet = Readonly<{
    /** True when a layout change now would not move content under a finger or cursor. */
    isQuiet: () => boolean;
    /** Called by the host scroller on every scroll event. Cheap: no state, no render. */
    reportScrollActivity: () => void;
    /** A pointer — mouse or finger — entered or left the list. */
    setPointerInside: (inside: boolean) => void;
    /**
     * Notified when the list becomes quiet again — the one transition a held batch is waiting for.
     *
     * Deliberately not "whenever quietness changes": a batch has nothing to do when the list goes
     * busy, and waking it there would be a wakeup per scroll flick and per hover for no decision.
     */
    subscribe: (listener: () => void) => () => void;
    /** Drops the idle timer and every listener. */
    dispose: () => void;
}>;

export function createListMotionQuiet(
    options?: Readonly<{ scrollIdleMs?: number }>,
): ListMotionQuiet {
    const scrollIdleMs = options?.scrollIdleMs ?? LIST_MOTION_SCROLL_IDLE_MS;
    const listeners = new Set<() => void>();
    let pointerInside = false;
    let scrollIdleTimer: ReturnType<typeof setTimeout> | null = null;

    const isQuiet = (): boolean => !pointerInside && scrollIdleTimer === null;

    /** Runs a state change and announces it only if the list just became quiet. */
    function settle(change: () => void): void {
        const wasQuiet = isQuiet();
        change();
        if (wasQuiet || !isQuiet()) return;
        for (const listener of [...listeners]) listener();
    }

    return Object.freeze({
        isQuiet,
        reportScrollActivity: () => {
            settle(() => {
                if (scrollIdleTimer !== null) clearTimeout(scrollIdleTimer);
                scrollIdleTimer = setTimeout(
                    () => settle(() => { scrollIdleTimer = null; }),
                    scrollIdleMs,
                );
            });
        },
        setPointerInside: (inside: boolean) => {
            // Only a transition is a change. A pointer moving between children re-fires enter on
            // some platforms, and re-running the gate there would be work for no decision.
            if (pointerInside === inside) return;
            settle(() => { pointerInside = inside; });
        },
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        dispose: () => {
            if (scrollIdleTimer !== null) {
                clearTimeout(scrollIdleTimer);
                scrollIdleTimer = null;
            }
            listeners.clear();
        },
    });
}

export type ListMotionQuietHandle = Readonly<{
    quiet: ListMotionQuiet;
    /**
     * Spread onto the scroller that owns the list.
     *
     * The list itself does not scroll — its hosts do (a scroller inside a scroller is unflickable
     * on a phone) — so the host is the only place that can report scrolling at all.
     */
    scrollProps: Readonly<{ onScroll: () => void; scrollEventThrottle: number }>;
}>;

/**
 * One quiet window per host, created once and disposed with it.
 *
 * A host that owns a scroller calls this and hands `quiet` to `AgentActivityList`; a host with no
 * scroller does not need to, because the list falls back to its own instance and still honours the
 * pointer half of the gate.
 */
export function useListMotionQuiet(): ListMotionQuietHandle {
    const handleRef = React.useRef<ListMotionQuietHandle | null>(null);
    if (handleRef.current === null) {
        const quiet = createListMotionQuiet();
        handleRef.current = Object.freeze({
            quiet,
            scrollProps: Object.freeze({
                onScroll: quiet.reportScrollActivity,
                scrollEventThrottle: LIST_MOTION_SCROLL_EVENT_THROTTLE_MS,
            }),
        });
    }

    const handle = handleRef.current;
    React.useEffect(() => () => handle.quiet.dispose(), [handle]);
    return handle;
}
