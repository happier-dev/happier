import { InteractionManager, Platform } from 'react-native';

export type RunAfterInteractionsWithFallbackOptions = Readonly<{
    /**
     * @deprecated Ignored. It configured the removed timeout fallback, and on
     * React Native 0.83.5 no delay can change when `fn` runs: the interaction
     * task is a microtask, so it always wins over any timer this could arm.
     * Retained only so the one remaining caller keeps compiling — drop the
     * argument in `@/components/ui/lists/ItemRowActions` (`closeThen`), then
     * delete this type and the parameter.
     */
    fallbackDelayMs?: number;
}>;

/**
 * Defers `fn` off the current synchronous block and returns a cancel function.
 *
 * What this actually schedules on React Native 0.83.5, the version this app
 * ships: `InteractionManager` is no longer an interaction queue.
 * `Libraries/Interaction/InteractionManager.js` exports the deprecated stub
 * unconditionally — RN 0.81's `disableInteractionManager` feature flag is gone
 * because there is no longer an implementation to switch back to — and the
 * stub's `runAfterInteractions` defers through `setImmediate`, which
 * `Libraries/Core/setUpTimers.js` shims onto `global.queueMicrotask`
 * (`Libraries/Core/Timers/immediateShim.js`).
 *
 * So on native this is a microtask: `fn` runs at the microtask checkpoint of
 * the current JS task, before any timer and without yielding a frame to the
 * renderer. It does not wait for touches, scrolls or animations, and it cannot
 * fail to run. Treat it as "off the current synchronous block", not as "after
 * the UI has settled" — nothing here protects an animation.
 *
 * On web there is no InteractionManager, so we yield one macrotask instead.
 *
 * The timeout fallback this helper is named for (a 2s default plus an
 * `EXPO_PUBLIC_HAPPIER_RUN_AFTER_INTERACTIONS_FALLBACK_MS` knob) existed to
 * escape an interaction queue that could stall behind a long gesture. That
 * queue no longer exists and a microtask always beats a timer, so the timeout
 * could never be the thing that ran `fn`; it was removed rather than left as an
 * unobservable fallback. The `catch` below is not that fallback: it covers a
 * `react-native` boundary that exposes no `InteractionManager` at all, which is
 * reachable under partial test doubles.
 */
export function runAfterInteractionsWithFallback(
    fn: () => void,
    _options?: RunAfterInteractionsWithFallbackOptions,
): () => void {
    if (Platform.OS === 'web') {
        let cancelled = false;
        const handle = setTimeout(() => {
            if (cancelled) return;
            fn();
        }, 0);
        return () => {
            cancelled = true;
            clearTimeout(handle);
        };
    }

    let didRun = false;
    const runOnce = () => {
        if (didRun) return;
        didRun = true;
        fn();
    };

    try {
        const task = InteractionManager.runAfterInteractions(runOnce);
        return () => {
            // Also latch `didRun`: a task double whose `cancel` is a no-op
            // (`@/dev/reactNativeStub` ships one) must not run after cancel.
            didRun = true;
            task.cancel();
        };
    } catch {
        const immediate = setTimeout(runOnce, 0);
        return () => {
            didRun = true;
            clearTimeout(immediate);
        };
    }
}
