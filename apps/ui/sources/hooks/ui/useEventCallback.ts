import * as React from 'react';

/**
 * A callback with a STABLE identity that always invokes the latest closure.
 *
 * React's "useEvent" pattern: the returned function reference never changes
 * across renders, so passing it to a `React.memo` child does not break the
 * child's memoization — yet each invocation runs the freshest closure, so it
 * never captures stale props/state.
 *
 * Use this to stop parent-render churn from re-rendering an expensive memoized
 * child through callback-prop identity changes (e.g. `SessionView` → the 3k-line
 * `AgentInput`, whose `onSend`/`onAbort` would otherwise get a new identity on
 * every turn-state commit). It is for event handlers, not for values read during
 * render — the stable reference intentionally does not participate in effect or
 * memo dependency arrays.
 */
export function useEventCallback<Args extends unknown[], Return>(
    callback: (...args: Args) => Return,
): (...args: Args) => Return {
    const callbackRef = React.useRef(callback);

    // Keep the ref pointing at the latest closure. Layout effect so the update
    // is applied before any child effect that might call the handler in the
    // same commit.
    React.useLayoutEffect(() => {
        callbackRef.current = callback;
    });

    return React.useCallback((...args: Args): Return => callbackRef.current(...args), []);
}
