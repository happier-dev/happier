/**
 * Regression test for the runOnJS commit-ordering race.
 *
 * Symptom (pre-fix): on spring completion the worklet calls `runOnJS(commit)` and
 * THEN immediately resets `progress.value = 0`. Because `runOnJS` is async, the
 * progress reset can land before React has rendered the new committed children —
 * for one frame the OLD content is at progress=0 (centered, no fade) while the
 * INCOMING content is also still mounted. Visually: a flash.
 *
 * Fix: the worklet must NOT reset progress. The reset must happen on the JS side
 * AFTER the React commit lands (via `useLayoutEffect` keyed on `displayedKey`).
 */

import * as React from 'react';
import { Text } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

const reanimatedControls = vi.hoisted(() => ({
    fireSpringCallback: false,
    progressResetsFromWorklet: 0,
    progressResetsFromJs: 0,
    lastSetterFromWorklet: false,
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
                    if (prop === 'value' && value === 0) {
                        if (reanimatedControls.lastSetterFromWorklet) {
                            reanimatedControls.progressResetsFromWorklet += 1;
                        } else {
                            reanimatedControls.progressResetsFromJs += 1;
                        }
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
    const cancelAnimation = () => {};
    const withSpring = <T,>(value: T, _config?: unknown, callback?: (finished?: boolean) => void) => {
        if (reanimatedControls.fireSpringCallback && callback) {
            reanimatedControls.lastSetterFromWorklet = true;
            try {
                callback(true);
            } finally {
                reanimatedControls.lastSetterFromWorklet = false;
            }
        }
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
    };
});

describe('SlideTransitionSwitch — commit ordering (no-flash invariant)', () => {
    it('does NOT reset progress.value=0 from inside the spring worklet (the reset must happen on the JS side after the React commit)', async () => {
        reanimatedControls.fireSpringCallback = true;
        reanimatedControls.progressResetsFromWorklet = 0;
        reanimatedControls.progressResetsFromJs = 0;

        const { SlideTransitionSwitch } = await import('./SlideTransitionSwitch');
        const screen = await renderScreen(
            <SlideTransitionSwitch contentKey="a" direction="forward" testID="switch">
                <Text testID="step-a">A</Text>
            </SlideTransitionSwitch>,
        );

        // Baseline reset counts after first mount (initial value=0 is not a "set").
        const baselineWorkletResets = reanimatedControls.progressResetsFromWorklet;
        const baselineJsResets = reanimatedControls.progressResetsFromJs;

        await screen.update(
            <SlideTransitionSwitch contentKey="b" direction="forward" testID="switch">
                <Text testID="step-b">B</Text>
            </SlideTransitionSwitch>,
        );

        // After the spring completes (callback fired immediately under the test mock),
        // the worklet must NOT have reset progress to 0. The reset is the JS side's
        // job — it happens AFTER React paints the new content. Otherwise: stale
        // content flashes for one frame.
        expect(reanimatedControls.progressResetsFromWorklet).toBe(baselineWorkletResets);
        // The JS-side reset must happen AT LEAST once (after the displayedKey commit).
        expect(reanimatedControls.progressResetsFromJs).toBeGreaterThan(baselineJsResets);

        // And the new content is rendered.
        expect(screen.findByTestId('step-b')).not.toBeNull();
        expect(screen.findByTestId('step-a')).toBeNull();
    });
});
