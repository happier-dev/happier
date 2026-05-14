/**
 * RV-4 / F13.2 — Unmount cancellation for SlideTransitionSwitch.
 *
 * If the switch unmounts mid-transition, its in-flight spring must be
 * cancelled and the late `runOnJS(commitInFlightTarget)` callback must NOT
 * call setState on the unmounted component.
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
    pendingCallbacks: [] as Array<() => void>,
    cancelCount: 0,
}));

vi.mock('react-native-reanimated', async () => {
    const ReactModule = await import('react');
    type SharedValue<T> = { value: T };
    const useSharedValue = <T,>(initial: T): SharedValue<T> => {
        const ref = ReactModule.useRef<SharedValue<T> | null>(null);
        if (!ref.current) ref.current = { value: initial };
        return ref.current;
    };
    const useAnimatedStyle = <T,>(factory: () => T): T => factory();
    const useAnimatedProps = <T,>(factory: () => T): T => factory();
    const runOnJS = <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) => fn;
    const cancelAnimation = () => {
        reanimatedControls.cancelCount += 1;
    };
    const withSpring = <T,>(value: T, _config?: unknown, callback?: (finished?: boolean) => void) => {
        if (callback) {
            reanimatedControls.pendingCallbacks.push(() => callback(true));
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

describe('SlideTransitionSwitch — unmount cancellation (F13.2)', () => {
    it('cancels the in-flight spring on unmount and a late callback does not throw or warn', async () => {
        reanimatedControls.pendingCallbacks = [];
        reanimatedControls.cancelCount = 0;
        const { SlideTransitionSwitch } = await import('./SlideTransitionSwitch');

        const screen = await renderScreen(
            <SlideTransitionSwitch contentKey="a" direction="forward" testID="switch">
                <Text testID="step-a">A</Text>
            </SlideTransitionSwitch>,
        );

        // Trigger a transition (callback queued, not fired).
        await screen.update(
            <SlideTransitionSwitch contentKey="b" direction="forward" testID="switch">
                <Text testID="step-b">B</Text>
            </SlideTransitionSwitch>,
        );
        expect(reanimatedControls.pendingCallbacks.length).toBeGreaterThan(0);
        const beforeUnmountCancel = reanimatedControls.cancelCount;

        // Spy on console.error so React state-on-unmounted warnings would fail
        // the test if they fired.
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        // Unmount.
        await screen.update(<></>);
        expect(reanimatedControls.cancelCount).toBeGreaterThan(beforeUnmountCancel);

        // Flush the late callback after unmount — must not throw or warn.
        expect(() => {
            const cbs = reanimatedControls.pendingCallbacks.splice(0);
            for (const cb of cbs) cb();
        }).not.toThrow();

        // No React "setState on unmounted" / "act" warnings should have fired
        // as a result of the late callback.
        expect(errorSpy).not.toHaveBeenCalled();

        errorSpy.mockRestore();
    });
});
