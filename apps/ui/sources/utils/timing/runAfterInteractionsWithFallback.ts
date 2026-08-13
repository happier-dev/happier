import { InteractionManager, Platform } from 'react-native';

/**
 * Defers `fn` off the current render/commit, and returns a canceller.
 *
 * The two platforms schedule differently on purpose:
 *
 * - **Web** yields a real macrotask (`setTimeout(fn, 0)`), so the browser can lay out and paint the
 *   current commit before `fn` runs.
 * - **Native does NOT defer past the current JS task.** Under React Native 0.81 with the New
 *   Architecture, `ReactNativeFeatureFlags.disableInteractionManager` defaults to `true`, so
 *   `InteractionManager` is `InteractionManagerStub`; the stub ignores interactions entirely and
 *   resolves through `setImmediate`, which bridgeless RN polyfills onto `global.queueMicrotask`.
 *   The callback therefore runs at the current task's microtask checkpoint — sooner than
 *   `setTimeout(fn, 0)`, and before the app ever yields to layout or paint.
 *
 * Two consequences worth knowing before reaching for this helper on native:
 *
 * 1. It cannot be starved. There is no interaction queue to wait on, so the "saturated JS thread
 *    starves InteractionManager" hazard the old timeout fallback guarded against is unreachable —
 *    and a timeout could never have won the race against a microtask anyway. That dead fallback and
 *    its `EXPO_PUBLIC_HAPPIER_RUN_AFTER_INTERACTIONS_FALLBACK_MS` knob have been removed. The one
 *    observation that would invalidate this: `disableInteractionManager` flipping to `false` (an RN
 *    upgrade or an explicit feature-flag override), which restores the real queue and with it the
 *    starvation hazard — revisit this helper if that changes.
 * 2. It does not relieve a busy frame. Work moved here still lands inside the same JS task, so it
 *    does not make an expensive open/navigation corridor paint any sooner. If you need native work
 *    to land after paint, schedule it explicitly (`requestAnimationFrame`, a real timer, or a
 *    dedicated frame gate) rather than assuming this helper does it.
 *
 * The remaining native fallback covers only an environment where `InteractionManager` is missing or
 * throws; there it degrades to a real macrotask so the callback still runs.
 */
export function runAfterInteractionsWithFallback(fn: () => void): () => void {
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

    let settled = false;
    const runOnce = () => {
        if (settled) return;
        settled = true;
        fn();
    };

    try {
        const task = InteractionManager.runAfterInteractions(runOnce);
        return () => {
            settled = true;
            task.cancel();
        };
    } catch {
        const handle = setTimeout(runOnce, 0);
        return () => {
            settled = true;
            clearTimeout(handle);
        };
    }
}
