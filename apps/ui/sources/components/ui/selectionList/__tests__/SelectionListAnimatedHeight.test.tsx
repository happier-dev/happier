/**
 * RUX-14 — animated popover height during step transitions.
 *
 * The OUTER popover container's height was snapping to the incoming step's
 * height only AFTER the SlideTransitionSwitch settled. Visually:
 *  - tall step (~480px) crossfades into short step (~280px)
 *  - inner content slides smoothly
 *  - container stays at 480px throughout the slide, then ABRUPTLY collapses to 280px
 *
 * Fix: wrap the SlideTransitionSwitch in `SelectionListAnimatedHeight`, an
 * Animated.View that pins the container height during step transitions and
 * animates from `previousNaturalHeight` → `incomingNaturalHeight` in lockstep
 * with the slide. After settling, height returns to `auto` so subsequent
 * dynamic content updates flow naturally.
 *
 * Reduced motion: skip the height animation; snap directly to incoming.
 *
 * The incoming natural height is NOT measured here — the orchestrator owns the
 * single offscreen measure host and publishes the height to an external store
 * that this component subscribes to while pinned. These tests drive that store
 * the way the orchestrator does: it still describes the OUTGOING step across a
 * swap, and the incoming height lands only when the mirror re-measures.
 */

import * as React from 'react';
import { Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import {
    createSelectionListMeasuredBodyHeightStore,
    type SelectionListMeasuredBodyHeightStore,
} from '../selectionListMeasuredBodyHeight';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const reducedMotionRef = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionRef.value,
}));

const animationControls = vi.hoisted(() => ({
    fireTimingCallbackImmediately: false,
    timingCalls: [] as Array<{ to: number }>,
    sharedValueWrites: [] as Array<{ value: number | string }>,
    pendingTimingCallbacks: [] as Array<() => void>,
    cancelCount: 0,
}));

vi.mock('react-native-reanimated', async () => {
    const ReactModule = await import('react');
    type SharedValue<T> = { value: T };
    const useSharedValue = <T,>(initial: T): SharedValue<T> => {
        const ref = ReactModule.useRef<SharedValue<T> | null>(null);
        if (!ref.current) {
            const inner = { value: initial };
            const proxy = new Proxy(inner, {
                set(target, prop, value) {
                    if (prop === 'value') {
                        animationControls.sharedValueWrites.push({ value });
                    }
                    (target as Record<string | symbol, unknown>)[prop as string] = value;
                    return true;
                },
            }) as SharedValue<T>;
            ref.current = proxy;
        }
        return ref.current;
    };
    const useAnimatedStyle = <T,>(factory: () => T): T => factory();
    const useAnimatedProps = <T,>(factory: () => T): T => factory();
    const runOnJS = <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) => fn;
    const cancelAnimation = () => {
        animationControls.cancelCount += 1;
    };
    const withTiming = <T,>(value: T, _config?: unknown, callback?: (finished?: boolean) => void) => {
        if (typeof value === 'number') {
            animationControls.timingCalls.push({ to: value });
        }
        if (animationControls.fireTimingCallbackImmediately && callback) {
            callback(true);
        } else if (callback) {
            animationControls.pendingTimingCallbacks.push(() => callback(true));
        }
        return value;
    };
    const withSpring = <T,>(value: T, _config?: unknown, callback?: (finished?: boolean) => void) => {
        if (animationControls.fireTimingCallbackImmediately && callback) callback(true);
        return value;
    };
    const Animated = {
        View: 'Animated.View',
        ScrollView: 'Animated.ScrollView',
        Text: 'Animated.Text',
        createAnimatedComponent: (component: unknown) => component,
    };
    return {
        __esModule: true,
        default: Animated,
        ...Animated,
        cancelAnimation,
        runOnJS,
        useAnimatedProps,
        useAnimatedStyle,
        useSharedValue,
        withSpring,
        withTiming,
    };
});

beforeEach(() => {
    animationControls.fireTimingCallbackImmediately = false;
    animationControls.timingCalls = [];
    animationControls.sharedValueWrites = [];
    animationControls.pendingTimingCallbacks = [];
    animationControls.cancelCount = 0;
    reducedMotionRef.value = false;
});

/**
 * The wrapper's own onLayout records the rendered height — the "from"
 * snapshot for the next transition AND the upper clamp on its target.
 */
function fireWrapperLayout(
    screen: { findByTestId(id: string): unknown },
    rootTestId: string,
    height: number,
): void {
    const wrapper = screen.findByTestId(rootTestId) as { props: Record<string, unknown> } | null;
    if (!wrapper) throw new Error(`expected wrapper testID ${rootTestId}`);
    const onLayout = wrapper.props.onLayout as ((evt: unknown) => void) | undefined;
    if (typeof onLayout !== 'function') {
        throw new Error('expected onLayout on the animated wrapper');
    }
    act(() => {
        onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height } } });
    });
}

/**
 * The orchestrator's measure mirror re-measures the incoming step and
 * publishes its natural height. That can start (or, under reduced motion,
 * finish) the height animation, so it runs inside `act`.
 */
function publishMeasuredHeight(
    store: SelectionListMeasuredBodyHeightStore,
    stepKey: string,
    height: number,
): void {
    act(() => {
        store.publish(stepKey, height);
    });
}

/** A store that has already measured `step-a` at 480, as the mirror would. */
function makeStoreMeasuredAtStepA(): SelectionListMeasuredBodyHeightStore {
    const store = createSelectionListMeasuredBodyHeightStore();
    store.publish('step-a', 480);
    return store;
}

describe('SelectionListAnimatedHeight', () => {
    it('renders children inside an animated wrapper', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim">
                <Text testID="step-a-content">Step A</Text>
            </SelectionListAnimatedHeight>,
        );
        expect(screen.findByTestId('anim')).not.toBeNull();
        expect(screen.findByTestId('step-a-content')).not.toBeNull();
    });

    it('does not mount a measure mirror of its children (the orchestrator owns the single measure host)', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim">
                <Text testID="step-a-content">Step A</Text>
            </SelectionListAnimatedHeight>,
        );
        expect(screen.findAllByTestId('anim:measure').length).toBe(0);
        expect(screen.findAllByTestId('step-a-content').length).toBe(1);
    });

    it('animates height from the previous natural height to the incoming natural height when stepKey changes', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const store = makeStoreMeasuredAtStepA();
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredHeights={store}>
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );

        // Wrapper reports 480 for step A so a "from" snapshot exists.
        fireWrapperLayout(screen, 'anim', 480);
        animationControls.timingCalls = [];

        // Step swap: the mirror still describes step A, so there is nothing to
        // animate to yet.
        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim" measuredHeights={store}>
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );
        expect(animationControls.timingCalls.length).toBe(0);

        publishMeasuredHeight(store, 'step-b', 280);

        // Animation should target the incoming natural height (280) — the
        // wrapper bridges from the pinned previous height (480) down to 280.
        const targets = animationControls.timingCalls.map((c) => c.to);
        expect(targets).toContain(280);
    });

    it('snaps height immediately when reducedMotion is true (no withTiming animation to the incoming height)', async () => {
        reducedMotionRef.value = true;
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const store = makeStoreMeasuredAtStepA();
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredHeights={store}>
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        fireWrapperLayout(screen, 'anim', 480);
        animationControls.timingCalls = [];

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim" measuredHeights={store}>
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );
        publishMeasuredHeight(store, 'step-b', 280);

        expect(animationControls.timingCalls.length).toBe(0);
        expect(animationControls.sharedValueWrites.map((w) => w.value)).toContain(280);
    });

    it('releases pinned height back to auto after the height animation completes (deferred via release buffer)', async () => {
        vi.useFakeTimers();
        try {
            animationControls.fireTimingCallbackImmediately = true;
            const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
            const store = makeStoreMeasuredAtStepA();
            const screen = await renderScreen(
                <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredHeights={store}>
                    <View testID="step-a-content" style={{ height: 480 }} />
                </SelectionListAnimatedHeight>,
            );
            fireWrapperLayout(screen, 'anim', 480);

            await screen.update(
                <SelectionListAnimatedHeight stepKey="step-b" testID="anim" measuredHeights={store}>
                    <View testID="step-b-content" style={{ height: 280 }} />
                </SelectionListAnimatedHeight>,
            );
            publishMeasuredHeight(store, 'step-b', 280);

            // The timing callback fired immediately, but pin release is
            // intentionally deferred via a setTimeout buffer so the
            // SlideTransitionSwitch's own spring + popover-surface
            // measurement can catch up. Advance fake timers past the
            // RELEASE_BUFFER_MS (set to 280ms in production) so the unpin
            // commits in this test.
            await act(async () => {
                vi.advanceTimersByTime(400);
            });

            const wrapper = screen.findByTestId('anim');
            expect(wrapper).not.toBeNull();
            const style = (wrapper as unknown as { props: { style?: unknown } }).props.style;
            const flat = Array.isArray(style)
                ? style.reduce<Record<string, unknown>>((acc, s) => Object.assign(acc, s ?? {}), {})
                : (style as Record<string, unknown> | undefined) ?? {};
            // 'height' may be omitted entirely OR may be the string 'auto'.
            const height = (flat as { height?: unknown }).height;
            expect(height === undefined || height === 'auto').toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('clamps the incoming target to the wrapper\'s last-rendered height so naturally-tall content does not balloon the popover', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const store = makeStoreMeasuredAtStepA();
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredHeights={store}>
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        // Wrapper renders at 480 (its parent's flex constraint clamped the
        // long content). A 2000px-natural incoming step must still animate to
        // at most 480 so the popover never overshoots what it can paint.
        fireWrapperLayout(screen, 'anim', 480);
        animationControls.timingCalls = [];

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim" measuredHeights={store}>
                <View testID="step-b-content" style={{ height: 2000 }} />
            </SelectionListAnimatedHeight>,
        );
        publishMeasuredHeight(store, 'step-b', 2000);

        const targets = animationControls.timingCalls.map((c) => c.to);
        expect(targets).not.toContain(2000);
        expect(targets[targets.length - 1]).toBe(480);
    });

    /**
     * RV-8 / FRESH-2 — the height animator previously left the in-flight
     * `withTiming` running after unmount and the deferred-release setTimeout
     * + completion callback could call `setPinned(false)` on the unmounted
     * component. The fix mirrors the SlideTransitionSwitch RV-4 pattern:
     * `cancelAnimation(animatedHeight)` in unmount cleanup AND an
     * `isMountedRef` so any late `runOnJS(scheduleDeferredRelease)` /
     * `releasePin` calls become no-ops.
     */
    it('cancels the in-flight height animation on unmount', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const store = makeStoreMeasuredAtStepA();
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredHeights={store}>
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        fireWrapperLayout(screen, 'anim', 480);

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim" measuredHeights={store}>
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );
        publishMeasuredHeight(store, 'step-b', 280);

        const cancelsBeforeUnmount = animationControls.cancelCount;
        await screen.update(<></>);
        expect(animationControls.cancelCount).toBeGreaterThan(cancelsBeforeUnmount);
    });

    it('does not call setState via late timing callback after unmount (no React warnings)', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const store = makeStoreMeasuredAtStepA();
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredHeights={store}>
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        fireWrapperLayout(screen, 'anim', 480);

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim" measuredHeights={store}>
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );
        publishMeasuredHeight(store, 'step-b', 280);

        expect(animationControls.pendingTimingCallbacks.length).toBeGreaterThan(0);

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            // Unmount BEFORE flushing the queued timing callback.
            await screen.update(<></>);

            // Now flush the late callbacks: must not throw, must not warn.
            expect(() => {
                const cbs = animationControls.pendingTimingCallbacks.splice(0);
                for (const cb of cbs) cb();
            }).not.toThrow();

            expect(errorSpy).not.toHaveBeenCalled();
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('does not call setState after unmount when a second animation is interrupted by the unmount', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const store = makeStoreMeasuredAtStepA();
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredHeights={store}>
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        fireWrapperLayout(screen, 'anim', 480);

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim" measuredHeights={store}>
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );
        publishMeasuredHeight(store, 'step-b', 280);

        // Rapid second swap (simulating user clicking another step before
        // the first animation completed).
        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-c" testID="anim" measuredHeights={store}>
                <View testID="step-c-content" style={{ height: 360 }} />
            </SelectionListAnimatedHeight>,
        );
        publishMeasuredHeight(store, 'step-c', 360);

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await screen.update(<></>);
            // Flush ALL late callbacks (from both animations).
            expect(() => {
                const cbs = animationControls.pendingTimingCallbacks.splice(0);
                for (const cb of cbs) cb();
            }).not.toThrow();
            expect(errorSpy).not.toHaveBeenCalled();
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('handles a rapid second stepKey change cleanly (no stale pinned height)', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const store = makeStoreMeasuredAtStepA();
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredHeights={store}>
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        fireWrapperLayout(screen, 'anim', 480);

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim" measuredHeights={store}>
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );
        publishMeasuredHeight(store, 'step-b', 280);

        animationControls.timingCalls = [];

        // Second rapid swap before the previous animation completed.
        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-c" testID="anim" measuredHeights={store}>
                <View testID="step-c-content" style={{ height: 360 }} />
            </SelectionListAnimatedHeight>,
        );
        publishMeasuredHeight(store, 'step-c', 360);

        // The latest withTiming target should be 360 (the new incoming).
        const targets = animationControls.timingCalls.map((c) => c.to);
        expect(targets[targets.length - 1]).toBe(360);
    });

    /**
     * The measurement is tagged with the step it describes. A stale report for
     * the OUTGOING step arriving mid-swap must not become the target — that is
     * the whole reason the store is keyed rather than a bare number.
     */
    it('ignores a measurement published for the outgoing step during a swap', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const store = makeStoreMeasuredAtStepA();
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredHeights={store}>
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        fireWrapperLayout(screen, 'anim', 480);

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim" measuredHeights={store}>
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );
        animationControls.timingCalls = [];

        // The outgoing step re-measures (its rows settled) — not our target.
        publishMeasuredHeight(store, 'step-a', 420);
        expect(animationControls.timingCalls.length).toBe(0);

        publishMeasuredHeight(store, 'step-b', 280);
        expect(animationControls.timingCalls.map((c) => c.to)).toEqual([280]);
    });

    /**
     * The mirror re-lays out while the transition runs (rows settle, fonts
     * resolve, a scrollbar appears), often by a fraction of a pixel. Restarting
     * `withTiming` on that jitter re-bases the animation mid-flight and stalls
     * the visible height. The store swallows changes under its epsilon, the
     * same window the popover height gate uses on the same layout event.
     */
    it('does not restart the height animation for sub-pixel mirror jitter', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const store = makeStoreMeasuredAtStepA();
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredHeights={store}>
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        fireWrapperLayout(screen, 'anim', 480);

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim" measuredHeights={store}>
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );
        animationControls.timingCalls = [];

        publishMeasuredHeight(store, 'step-b', 280);
        publishMeasuredHeight(store, 'step-b', 280.4);

        expect(animationControls.timingCalls.map((c) => c.to)).toEqual([280]);
    });
});
