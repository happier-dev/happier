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
 */

import * as React from 'react';
import { Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { renderScreen } from '@/dev/testkit';

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

function fireOnLayout(node: { props: Record<string, unknown> }, height: number): void {
    const onLayout = node.props.onLayout as ((evt: unknown) => void) | undefined;
    if (typeof onLayout !== 'function') {
        throw new Error('expected onLayout on measure host');
    }
    act(() => {
        onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height } } });
    });
}

/**
 * The wrapper itself has `onLayout` (used to track the cap). Tests must
 * fire BOTH the wrapper's onLayout (so the cap + "from" snapshot are
 * recorded) AND the measure host's onLayout (so the incoming target is
 * resolved). Using a single helper keeps the test arrange phase concise.
 */
function fireWrapperAndMeasureLayout(
    screen: { findByTestId(id: string): unknown },
    rootTestId: string,
    height: number,
): void {
    const wrapper = screen.findByTestId(rootTestId);
    if (!wrapper) throw new Error(`expected wrapper testID ${rootTestId}`);
    fireOnLayout(wrapper as { props: Record<string, unknown> }, height);
    const measure = screen.findByTestId(`${rootTestId}:measure`);
    if (!measure) throw new Error(`expected measure testID ${rootTestId}:measure`);
    fireOnLayout(measure as { props: Record<string, unknown> }, height);
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

    it('animates height from the previous natural height to the incoming natural height when stepKey changes', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim">
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );

        // Wrapper + measure host both report 480 for step A so the
        // wrapper cap snapshot is populated and a future "from" snapshot
        // can be taken.
        fireWrapperAndMeasureLayout(screen, 'anim', 480);

        animationControls.timingCalls = [];

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim">
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );

        // Measure host now reports incoming step B's natural height.
        // (Wrapper's onLayout is suppressed while pinned, so we only need
        // the measure host's onLayout to drive the target resolution.)
        const measureB = screen.findByTestId('anim:measure');
        fireOnLayout(measureB as unknown as { props: Record<string, unknown> }, 280);

        // Animation should target the incoming natural height (280) — the
        // wrapper bridges from the pinned previous height (480) down to 280.
        const targets = animationControls.timingCalls.map((c) => c.to);
        expect(targets).toContain(280);
    });

    it('snaps height immediately when reducedMotion is true (no withTiming animation to the incoming height)', async () => {
        reducedMotionRef.value = true;
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim">
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        fireWrapperAndMeasureLayout(screen, 'anim', 480);
        animationControls.timingCalls = [];

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim">
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );
        const measureB = screen.findByTestId('anim:measure');
        fireOnLayout(measureB as unknown as { props: Record<string, unknown> }, 280);

        expect(animationControls.timingCalls.length).toBe(0);
    });

    it('releases pinned height back to auto after the height animation completes (deferred via release buffer)', async () => {
        vi.useFakeTimers();
        try {
            animationControls.fireTimingCallbackImmediately = true;
            const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
            const screen = await renderScreen(
                <SelectionListAnimatedHeight stepKey="step-a" testID="anim">
                    <View testID="step-a-content" style={{ height: 480 }} />
                </SelectionListAnimatedHeight>,
            );
            fireWrapperAndMeasureLayout(screen, 'anim', 480);

            await screen.update(
                <SelectionListAnimatedHeight stepKey="step-b" testID="anim">
                    <View testID="step-b-content" style={{ height: 280 }} />
                </SelectionListAnimatedHeight>,
            );
            const measureB = screen.findByTestId('anim:measure');
            fireOnLayout(measureB as unknown as { props: Record<string, unknown> }, 280);

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

    it('clamps the measure host to the wrapper\'s last-rendered height so naturally-tall content does not balloon the popover', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim">
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        // Wrapper renders at 480 (its parent's flex constraint clamped the
        // long content). The measure host should pick up that 480 as its
        // own maxHeight cap so a 2000px-natural step body would still
        // report at most 480 and the animation never overshoots the cap.
        fireOnLayout(
            screen.findByTestId('anim') as unknown as { props: Record<string, unknown> },
            480,
        );

        const measure = screen.findByTestId('anim:measure');
        expect(measure).not.toBeNull();
        const measureStyle = (measure as unknown as { props: { style?: unknown } }).props.style;
        const flat = Array.isArray(measureStyle)
            ? measureStyle.reduce<Record<string, unknown>>(
                (acc, s) => Object.assign(acc, s ?? {}),
                {},
            )
            : (measureStyle as Record<string, unknown> | undefined) ?? {};
        expect((flat as { maxHeight?: unknown }).maxHeight).toBe(480);
    });

    /**
     * RV-8 / FRESH-1 — the measure host previously rendered the FULL incoming
     * subtree as a hidden mirror, which duplicated every `testID` / `id` /
     * `aria-*` prop in the tree. That broke listbox identity (two
     * `data-testid="sl:listbox"` nodes, two option testIDs per row), polluted
     * accessibility (duplicate aria-labels), and risked test selector
     * collisions. The measure host now strips identity-bearing props from
     * the cloned mirror so duplication is impossible.
     */
    it('does not duplicate testID props when measureChildren contains identity-bearing nodes', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const visibleAndMirror = (
            <View testID="dup-target">
                <Text testID="dup-target-child">Hello</Text>
            </View>
        );
        const screen = await renderScreen(
            <SelectionListAnimatedHeight
                stepKey="step-a"
                testID="anim"
                measureChildren={visibleAndMirror}
            >
                {visibleAndMirror}
            </SelectionListAnimatedHeight>,
        );
        // Visible subtree contributes the testID exactly once. The hidden
        // measure host's clone must NOT also expose it.
        expect(screen.findAllByTestId('dup-target').length).toBe(1);
        expect(screen.findAllByTestId('dup-target-child').length).toBe(1);
    });

    it('strips nativeID and aria-* props from the measure-host mirror', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const visibleAndMirror = (
            <View
                testID="aria-target"
                nativeID="listbox-id"
                accessibilityRole="list"
                accessibilityLabel="Listbox"
                {...({ 'aria-label': 'Listbox', id: 'listbox-id', role: 'listbox' } as Record<string, unknown>)}
            >
                <Text>options</Text>
            </View>
        );
        const screen = await renderScreen(
            <SelectionListAnimatedHeight
                stepKey="step-a"
                testID="anim"
                measureChildren={visibleAndMirror}
            >
                {visibleAndMirror}
            </SelectionListAnimatedHeight>,
        );
        // The measure host wrapper itself owns its OWN testID (`anim:measure`).
        // The cloned mirror under it must contain ZERO copies of the inner
        // identity-bearing props — they are stripped to prevent duplicate
        // listbox/option ids in the live DOM.
        const measure = screen.findByTestId('anim:measure') as unknown as { findAll: (predicate: (n: { props: Record<string, unknown> }) => boolean) => Array<{ props: Record<string, unknown> }> };
        const matches = measure.findAll((n) => (
            n.props?.nativeID === 'listbox-id'
                || n.props?.id === 'listbox-id'
                || n.props?.role === 'listbox'
                || n.props?.accessibilityRole === 'list'
                || n.props?.['aria-label'] === 'Listbox'
                || n.props?.accessibilityLabel === 'Listbox'
        ));
        expect(matches.length).toBe(0);
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
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim">
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        fireWrapperAndMeasureLayout(screen, 'anim', 480);

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim">
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );
        const measureB = screen.findByTestId('anim:measure');
        fireOnLayout(measureB as unknown as { props: Record<string, unknown> }, 280);

        const cancelsBeforeUnmount = animationControls.cancelCount;
        await screen.update(<></>);
        expect(animationControls.cancelCount).toBeGreaterThan(cancelsBeforeUnmount);
    });

    it('does not call setState via late timing callback after unmount (no React warnings)', async () => {
        const { SelectionListAnimatedHeight } = await import('../SelectionListAnimatedHeight');
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim">
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        fireWrapperAndMeasureLayout(screen, 'anim', 480);

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim">
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );
        const measureB = screen.findByTestId('anim:measure');
        fireOnLayout(measureB as unknown as { props: Record<string, unknown> }, 280);

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
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim">
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        fireWrapperAndMeasureLayout(screen, 'anim', 480);

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim">
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );
        fireOnLayout(
            screen.findByTestId('anim:measure') as unknown as { props: Record<string, unknown> },
            280,
        );

        // Rapid second swap (simulating user clicking another step before
        // the first animation completed).
        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-c" testID="anim">
                <View testID="step-c-content" style={{ height: 360 }} />
            </SelectionListAnimatedHeight>,
        );
        fireOnLayout(
            screen.findByTestId('anim:measure') as unknown as { props: Record<string, unknown> },
            360,
        );

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
        const screen = await renderScreen(
            <SelectionListAnimatedHeight stepKey="step-a" testID="anim">
                <View testID="step-a-content" style={{ height: 480 }} />
            </SelectionListAnimatedHeight>,
        );
        fireWrapperAndMeasureLayout(screen, 'anim', 480);

        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-b" testID="anim">
                <View testID="step-b-content" style={{ height: 280 }} />
            </SelectionListAnimatedHeight>,
        );
        fireOnLayout(
            screen.findByTestId('anim:measure') as unknown as { props: Record<string, unknown> },
            280,
        );

        animationControls.timingCalls = [];

        // Second rapid swap before the previous animation completed.
        await screen.update(
            <SelectionListAnimatedHeight stepKey="step-c" testID="anim">
                <View testID="step-c-content" style={{ height: 360 }} />
            </SelectionListAnimatedHeight>,
        );
        fireOnLayout(
            screen.findByTestId('anim:measure') as unknown as { props: Record<string, unknown> },
            360,
        );

        // The latest withTiming target should be 360 (the new incoming).
        const targets = animationControls.timingCalls.map((c) => c.to);
        expect(targets[targets.length - 1]).toBe(360);
    });
});
