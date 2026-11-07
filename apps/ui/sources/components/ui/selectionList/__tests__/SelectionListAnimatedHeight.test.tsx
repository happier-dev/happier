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
 * R1 — the incoming natural height arrives as the `measuredContentHeight`
 * prop. This component used to read it from a hidden mirror of the body that
 * it rendered itself, while `SelectionList` rendered a second mirror of the
 * same subtree for the popover's own height; the measurement now has one
 * owner. `undefined` means the owner has no measurement for THIS `stepKey`
 * yet, which is how a pin is kept from resolving against the outgoing step's
 * height.
 */

import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

afterEach(() => act(() => setReducedMotionPreferenceOverride(null)));

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
    setReducedMotionPreferenceOverride(false);
});

function fireOnLayout(node: { props: Record<string, unknown> }, height: number): void {
    const onLayout = node.props.onLayout as ((evt: unknown) => void) | undefined;
    if (typeof onLayout !== 'function') {
        throw new Error('expected onLayout on the animated wrapper');
    }
    act(() => {
        onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height } } });
    });
}

/**
 * The wrapper's own onLayout records the natural height used BOTH as the
 * "from" snapshot for the next transition AND as the upper bound on its
 * target. Every transition test needs it fired for the outgoing step.
 */
function fireWrapperLayout(
    screen: { findByTestId(id: string): unknown },
    rootTestId: string,
    height: number,
): void {
    const wrapper = screen.findByTestId(rootTestId);
    if (!wrapper) throw new Error(`expected wrapper testID ${rootTestId}`);
    fireOnLayout(wrapper as { props: Record<string, unknown> }, height);
}

/** The wrapper's explicit height, or undefined when it follows natural layout. */
function wrapperHeight(screen: { findByTestId(id: string): unknown }, rootTestId: string): unknown {
    const wrapper = screen.findByTestId(rootTestId) as { props: { style?: unknown } } | null;
    if (!wrapper) throw new Error(`expected wrapper testID ${rootTestId}`);
    const style = wrapper.props.style;
    const flat = Array.isArray(style)
        ? style.reduce<Record<string, unknown>>((acc, s) => Object.assign(acc, s ?? {}), {})
        : (style as Record<string, unknown> | undefined) ?? {};
    return flat.height;
}

describe('SelectionListAnimatedHeight', () => {
    it('does not mount a measure mirror of its children', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredContentHeight={480}>
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        // The measurement belongs to the orchestrator. A mirror here is a
        // second mount of the whole body subtree per open (R1).
        expect(screen.findByTestId('anim:measure')).toBeNull();
        expect(screen.findAllByTestId('step-a-content').length).toBe(1);
    });

    it('animates height from the previous natural height to the incoming natural height when stepKey changes', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredContentHeight={480}>
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );

        // Wrapper reports 480 for step A so the "from" snapshot is populated.
        fireWrapperLayout(screen, 'anim', 480);

        animationControls.timingCalls = [];

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim" measuredContentHeight={280}>
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );

        // Animation should target the incoming natural height (280) — the
        // wrapper bridges from the pinned previous height (480) down to 280.
        const targets = animationControls.timingCalls.map((c) => c.to);
        expect(targets).toContain(280);
    });

    it('holds the pin without a target until the owner publishes a measurement for the new step', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredContentHeight={480}>
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        fireWrapperLayout(screen, 'anim', 480);
        animationControls.timingCalls = [];

        // The owner withholds its height while the measurement it holds still
        // belongs to the OUTGOING step. Nothing may animate on that.
        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim" measuredContentHeight={undefined}>
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );
        expect(animationControls.timingCalls.length).toBe(0);

        // The measurement for step B lands.
        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim" measuredContentHeight={280}>
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );
        expect(animationControls.timingCalls.map((c) => c.to)).toContain(280);
    });

    it('does not animate when the measurement changes outside a step transition', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredContentHeight={480}>
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        fireWrapperLayout(screen, 'anim', 480);
        animationControls.timingCalls = [];

        // Same step, taller body (a dynamic section resolved). Natural layout
        // owns this; the wrapper must not pin or animate.
        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredContentHeight={560}>
                <View testID="step-a-content" style={{ height: 560 }} />
            </SelectionListAnimatedHeight>,
        );

        expect(animationControls.timingCalls.length).toBe(0);
    });

    it('snaps to the incoming height and releases the pin at once when reduced motion is on', async () => {
        setReducedMotionPreferenceOverride(true);
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredContentHeight={480}>
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        fireWrapperLayout(screen, 'anim', 480);
        animationControls.timingCalls = [];

        animationControls.sharedValueWrites = [];

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim" measuredContentHeight={280}>
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );

        expect(animationControls.timingCalls.length).toBe(0);
        expect(animationControls.sharedValueWrites.at(-1)?.value).toBe(280);
        const height = wrapperHeight(screen, 'anim');
        expect(height === undefined || height === 'auto').toBe(true);
    });

    it('releases pinned height back to auto after the height animation completes (deferred via release buffer)', async () => {
        vi.useFakeTimers();
        try {
            animationControls.fireTimingCallbackImmediately = true;
            const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
            const screen = await renderScreen(
                <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredContentHeight={480}>
                    <View testID="step-a-content" style={{ height: 480 }} />
                </SelectionListAnimatedHeight>,
            );
            fireWrapperLayout(screen, 'anim', 480);

            await screen.update(
                <SelectionListAnimatedHeight stepKey="step-b" testID="anim" measuredContentHeight={280}>
                    <View testID="step-b-content" style={{ height: 280 }} />
                </SelectionListAnimatedHeight>,
            );

            // The timing callback fired immediately, but pin release is
            // intentionally deferred via a setTimeout buffer so the
            // SlideTransitionSwitch's own spring + popover-surface
            // measurement can catch up. Advance fake timers past the
            // RELEASE_BUFFER_MS (set to 280ms in production) so the unpin
            // commits in this test.
            await act(async () => {
                vi.advanceTimersByTime(400);
            });

            // Released means an explicit 'auto': on web Reanimated writes the pinned height
            // straight to the element, so a style that merely omits it leaves the last
            // pinned value in place and clips the step that follows (R88 Sharing card).
            expect(wrapperHeight(screen, 'anim')).toBe('auto');
        } finally {
            vi.useRealTimers();
        }
    });

    it('clamps the incoming height to the wrapper\'s last-rendered height so naturally-tall content does not balloon the popover', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredContentHeight={480}>
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        // Wrapper renders at 480 (its parent's flex constraint clamped the
        // long content). A 2000px-natural incoming body must still animate to
        // at most 480 — the height the popover surface will actually paint.
        fireWrapperLayout(screen, 'anim', 480);
        animationControls.timingCalls = [];

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim" measuredContentHeight={2000}>
                <View testID="step-b-content" style={{ height: 2000 }} />
            </SelectionListAnimatedHeight>,
        );

        const targets = animationControls.timingCalls.map((c) => c.to);
        expect(targets).toContain(480);
        expect(targets).not.toContain(2000);
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
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredContentHeight={480}>
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        fireWrapperLayout(screen, 'anim', 480);

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim" measuredContentHeight={280}>
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );

        const cancelsBeforeUnmount = animationControls.cancelCount;
        await screen.update(<></>);
        expect(animationControls.cancelCount).toBeGreaterThan(cancelsBeforeUnmount);
    });

    it.each([
        ['one transition', ['step-b']],
        ['a transition interrupted by a second one', ['step-b', 'step-c']],
    ] as const)('schedules no pin release from a timing callback that lands after unmount (%s)', async (_name, nextSteps) => {
        vi.useFakeTimers();
        try {
            const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
            const screen = await renderScreen(
                <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredContentHeight={480}>
                    <View testID="step-a-content" style={{ height: 480 }} />
                </SelectionListAnimatedHeight>,
            );
            fireWrapperLayout(screen, 'anim', 480);
            for (const [index, stepKey] of nextSteps.entries()) {
                await screen.update(
                    <SelectionListAnimatedHeight stepKey={stepKey} testID="anim" measuredContentHeight={280 + index * 80}>
                        <View testID={`${stepKey}-content`} />
                    </SelectionListAnimatedHeight>,
                );
            }
            expect(animationControls.pendingTimingCallbacks.length).toBe(nextSteps.length);

            // Unmount BEFORE the queued timing callbacks land.
            await screen.update(<></>);
            const timersAfterUnmount = vi.getTimerCount();
            for (const callback of animationControls.pendingTimingCallbacks.splice(0)) callback();

            // A late callback that still scheduled the deferred release would
            // add its timer here and later set state on the unmounted wrapper.
            expect(vi.getTimerCount()).toBe(timersAfterUnmount);
        } finally {
            vi.useRealTimers();
        }
    });

    it('handles a rapid second stepKey change cleanly (no stale pinned height)', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim" measuredContentHeight={480}>
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        fireWrapperLayout(screen, 'anim', 480);

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim" measuredContentHeight={280}>
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );

        animationControls.timingCalls = [];

        // Second rapid swap before the previous animation completed.
        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-c" testID="anim" measuredContentHeight={360}>
                <View testID="step-c-content" style={{ height: 360 }} />
            </SelectionListAnimatedHeight>,
        );

        // The latest withTiming target should be 360 (the new incoming).
        const targets = animationControls.timingCalls.map((c) => c.to);
        expect(targets[targets.length - 1]).toBe(360);
    });
});
