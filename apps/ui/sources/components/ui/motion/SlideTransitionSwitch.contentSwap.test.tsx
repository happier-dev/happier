import * as React from 'react';
import { Text } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

// Use a configurable spring stub so individual tests can choose whether to
// fire the completion callback (committing the in-flight target) or not.
const springControls = vi.hoisted(() => ({
    fireCallbackImmediately: false,
    fireTimingCallbackImmediately: false,
    deferRunOnJS: false,
    pendingRunOnJS: [] as Array<() => void>,
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
    const runOnJS = <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) => (
        (...args: TArgs): TResult => {
            if (!springControls.deferRunOnJS) return fn(...args);
            springControls.pendingRunOnJS.push(() => {
                fn(...args);
            });
            return undefined as TResult;
        }
    );
    const cancelAnimation = () => {};
    const withSpring = <T,>(value: T, _config?: unknown, callback?: (finished?: boolean) => void) => {
        if (springControls.fireCallbackImmediately && callback) callback(true);
        return value;
    };
    const withTiming = <T,>(value: T, _config?: unknown, callback?: (finished?: boolean) => void) => {
        if (springControls.fireTimingCallbackImmediately && callback) callback(true);
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

describe('SlideTransitionSwitch (discrete adapter)', () => {
    afterEach(() => {
        springControls.fireCallbackImmediately = false;
        springControls.fireTimingCallbackImmediately = false;
        springControls.deferRunOnJS = false;
        springControls.pendingRunOnJS = [];
    });

    it('mounts only the current slot when no transition is active', async () => {
        springControls.fireCallbackImmediately = false;
        const { SlideTransitionSwitch } = await import('./SlideTransitionSwitch');
        const screen = await renderScreen(
            <SlideTransitionSwitch contentKey="a" direction="forward" testID="switch">
                <Text testID="step-a">A</Text>
            </SlideTransitionSwitch>,
        );

        expect(screen.findByTestId('switch-current-layer')).not.toBeNull();
        expect(screen.findByTestId('switch-next-layer')).toBeNull();
        expect(screen.findByTestId('switch-previous-layer')).toBeNull();
        expect(screen.findByTestId('step-a')).not.toBeNull();
    });

    it('does not schedule a second render for a fresh equivalent child while idle', async () => {
        springControls.fireCallbackImmediately = false;
        const onRender = vi.fn();
        const { SlideTransitionSwitch } = await import('./SlideTransitionSwitch');
        const screen = await renderScreen(
            <React.Profiler id="idle-switch" onRender={onRender}>
                <SlideTransitionSwitch contentKey="a" direction="forward" testID="switch">
                    <Text testID="step-a">A</Text>
                </SlideTransitionSwitch>
            </React.Profiler>,
        );
        const commitsBeforeEquivalentUpdate = onRender.mock.calls.length;

        await screen.update(
            <React.Profiler id="idle-switch" onRender={onRender}>
                <SlideTransitionSwitch contentKey="a" direction="forward" testID="switch">
                    <Text testID="step-a">A</Text>
                </SlideTransitionSwitch>
            </React.Profiler>,
        );

        expect(onRender.mock.calls.length - commitsBeforeEquivalentUpdate).toBe(1);
        expect(screen.findByTestId('step-a')).not.toBeNull();
    });

    it('keeps outgoing children mounted while a forward transition is in flight', async () => {
        springControls.fireCallbackImmediately = false;
        const { SlideTransitionSwitch } = await import('./SlideTransitionSwitch');
        const screen = await renderScreen(
            <SlideTransitionSwitch contentKey="a" direction="forward" testID="switch">
                <Text testID="step-a">A</Text>
            </SlideTransitionSwitch>,
        );

        await screen.update(
            <SlideTransitionSwitch contentKey="b" direction="forward" testID="switch">
                <Text testID="step-b">B</Text>
            </SlideTransitionSwitch>,
        );

        // During the in-flight transition: outgoing (A) is current, incoming (B) is next.
        expect(screen.findByTestId('step-a')).not.toBeNull();
        expect(screen.findByTestId('step-b')).not.toBeNull();
        expect(screen.findByTestId('switch-next-layer')).not.toBeNull();
        expect(screen.findByTestId('switch-previous-layer')).toBeNull();
    });

    it('places incoming content in the previous slot for backward transitions', async () => {
        springControls.fireCallbackImmediately = false;
        const { SlideTransitionSwitch } = await import('./SlideTransitionSwitch');
        const screen = await renderScreen(
            <SlideTransitionSwitch contentKey="a" direction="forward" testID="switch">
                <Text testID="step-a">A</Text>
            </SlideTransitionSwitch>,
        );

        await screen.update(
            <SlideTransitionSwitch contentKey="b" direction="backward" testID="switch">
                <Text testID="step-b">B</Text>
            </SlideTransitionSwitch>,
        );

        expect(screen.findByTestId('switch-previous-layer')).not.toBeNull();
        expect(screen.findByTestId('switch-next-layer')).toBeNull();
        expect(screen.findByTestId('step-a')).not.toBeNull();
        expect(screen.findByTestId('step-b')).not.toBeNull();
    });

    it('commits the new key once the spring completes (outgoing unmounts)', async () => {
        springControls.fireCallbackImmediately = true;
        const { SlideTransitionSwitch } = await import('./SlideTransitionSwitch');
        const screen = await renderScreen(
            <SlideTransitionSwitch contentKey="a" direction="forward" testID="switch">
                <Text testID="step-a">A</Text>
            </SlideTransitionSwitch>,
        );

        await screen.update(
            <SlideTransitionSwitch contentKey="b" direction="forward" testID="switch">
                <Text testID="step-b">B</Text>
            </SlideTransitionSwitch>,
        );

        expect(screen.findByTestId('switch-current-layer')).not.toBeNull();
        expect(screen.findByTestId('switch-next-layer')).toBeNull();
        expect(screen.findByTestId('switch-previous-layer')).toBeNull();
        expect(screen.findByTestId('step-b')).not.toBeNull();
        expect(screen.findByTestId('step-a')).toBeNull();
    });

    it('commits replace direction synchronously without a spring', async () => {
        springControls.fireCallbackImmediately = false;
        const { SlideTransitionSwitch } = await import('./SlideTransitionSwitch');
        const screen = await renderScreen(
            <SlideTransitionSwitch contentKey="a" direction="forward" testID="switch">
                <Text testID="step-a">A</Text>
            </SlideTransitionSwitch>,
        );

        await screen.update(
            <SlideTransitionSwitch contentKey="b" direction="replace" testID="switch">
                <Text testID="step-b">B</Text>
            </SlideTransitionSwitch>,
        );

        // Replace path: instant commit, single layer, no outgoing.
        expect(screen.findByTestId('switch-next-layer')).toBeNull();
        expect(screen.findByTestId('switch-previous-layer')).toBeNull();
        expect(screen.findByTestId('step-a')).toBeNull();
        expect(screen.findByTestId('step-b')).not.toBeNull();
    });

    it('crossfades outgoing and incoming layers when reducedMotion is true', async () => {
        springControls.fireCallbackImmediately = false;
        springControls.fireTimingCallbackImmediately = false;
        const { SlideTransitionSwitch } = await import('./SlideTransitionSwitch');
        const screen = await renderScreen(
            <SlideTransitionSwitch contentKey="a" direction="forward" reducedMotion testID="switch">
                <Text testID="step-a">A</Text>
            </SlideTransitionSwitch>,
        );

        await screen.update(
            <SlideTransitionSwitch contentKey="b" direction="forward" reducedMotion testID="switch">
                <Text testID="step-b">B</Text>
            </SlideTransitionSwitch>,
        );

        expect(screen.findByTestId('switch-next-layer')).not.toBeNull();
        expect(screen.findByTestId('switch-previous-layer')).toBeNull();
        expect(screen.findByTestId('step-a')).not.toBeNull();
        expect(screen.findByTestId('step-b')).not.toBeNull();
    });

    it('commits reducedMotion content after the crossfade timing completes', async () => {
        springControls.fireCallbackImmediately = false;
        springControls.fireTimingCallbackImmediately = true;
        const { SlideTransitionSwitch } = await import('./SlideTransitionSwitch');
        const screen = await renderScreen(
            <SlideTransitionSwitch contentKey="a" direction="forward" reducedMotion testID="switch">
                <Text testID="step-a">A</Text>
            </SlideTransitionSwitch>,
        );

        await screen.update(
            <SlideTransitionSwitch contentKey="b" direction="forward" reducedMotion testID="switch">
                <Text testID="step-b">B</Text>
            </SlideTransitionSwitch>,
        );

        expect(screen.findByTestId('switch-next-layer')).toBeNull();
        expect(screen.findByTestId('switch-previous-layer')).toBeNull();
        expect(screen.findByTestId('step-a')).toBeNull();
        expect(screen.findByTestId('step-b')).not.toBeNull();
    });

    it('enables blur by default for soft preset step transitions', async () => {
        springControls.fireCallbackImmediately = false;
        springControls.fireTimingCallbackImmediately = false;
        const { SlideTransitionSwitch } = await import('./SlideTransitionSwitch');
        const screen = await renderScreen(
            <SlideTransitionSwitch contentKey="a" direction="forward" preset="soft" testID="switch">
                <Text testID="step-a">A</Text>
            </SlideTransitionSwitch>,
        );

        await screen.update(
            <SlideTransitionSwitch contentKey="b" direction="forward" preset="soft" testID="switch">
                <Text testID="step-b">B</Text>
            </SlideTransitionSwitch>,
        );

        expect(screen.findByTestId('switch-current-blur')).not.toBeNull();
        expect(screen.findByTestId('switch-next-blur')).not.toBeNull();
    });

    it('settles to the latest content after rapid back-to-back key changes', async () => {
        // Rapid keys without firing the callback would leave the first transition
        // in flight when the second one starts. The interrupt rule must snap-commit
        // the previous in-flight target and start fresh, ending up rendering 'c'
        // in the current slot eventually. Even with the spring callback wired so
        // each spring completes, the final content must always be the latest.
        springControls.fireCallbackImmediately = true;
        const { SlideTransitionSwitch } = await import('./SlideTransitionSwitch');
        const screen = await renderScreen(
            <SlideTransitionSwitch contentKey="a" direction="forward" testID="switch">
                <Text testID="step-a">A</Text>
            </SlideTransitionSwitch>,
        );

        await screen.update(
            <SlideTransitionSwitch contentKey="b" direction="forward" testID="switch">
                <Text testID="step-b">B</Text>
            </SlideTransitionSwitch>,
        );
        await screen.update(
            <SlideTransitionSwitch contentKey="c" direction="forward" testID="switch">
                <Text testID="step-c">C</Text>
            </SlideTransitionSwitch>,
        );

        // After all springs settle, only the latest content is visible.
        expect(screen.findByTestId('step-c')).not.toBeNull();
        expect(screen.findByTestId('step-a')).toBeNull();
        expect(screen.findByTestId('step-b')).toBeNull();
        expect(screen.findByTestId('switch-next-layer')).toBeNull();
        expect(screen.findByTestId('switch-previous-layer')).toBeNull();
    });

    it('keeps the in-flight transition running and refreshes incoming content on same-key updates', async () => {
        // Start transition a → b. While in flight (callback NOT fired), update children
        // for the same key b. The incoming layer should reflect the latest children
        // (B v2) rather than the original B v1. Then trigger another distinct key
        // change (c) so the interrupt rule snap-commits the in-flight target — and the
        // committed content must be B v2 (the latest), not B v1.
        springControls.fireCallbackImmediately = false;
        const { SlideTransitionSwitch } = await import('./SlideTransitionSwitch');
        const screen = await renderScreen(
            <SlideTransitionSwitch contentKey="a" direction="forward" testID="switch">
                <Text testID="step-a">A</Text>
            </SlideTransitionSwitch>,
        );
        await screen.update(
            <SlideTransitionSwitch contentKey="b" direction="forward" testID="switch">
                <Text testID="step-b-v1">B v1</Text>
            </SlideTransitionSwitch>,
        );
        // Same-key update: incoming children change from B v1 to B v2 mid-flight.
        await screen.update(
            <SlideTransitionSwitch contentKey="b" direction="forward" testID="switch">
                <Text testID="step-b-v2">B v2</Text>
            </SlideTransitionSwitch>,
        );

        // V2 is in the next slot (incoming layer reflects the latest children).
        expect(screen.findByTestId('step-b-v2')).not.toBeNull();
        expect(screen.findByTestId('step-b-v1')).toBeNull();
        expect(screen.findByTestId('switch-next-layer')).not.toBeNull();
        expect(screen.findByTestId('step-a')).not.toBeNull();

        // Trigger a fresh transition to 'c' — interrupt rule snap-commits the in-flight
        // target (which must be B v2, not B v1) and starts a new spring for c.
        await screen.update(
            <SlideTransitionSwitch contentKey="c" direction="forward" testID="switch">
                <Text testID="step-c">C</Text>
            </SlideTransitionSwitch>,
        );
        // After the snap-commit, displayed key/children = (b, B v2). The new spring
        // for c is in flight (callback not firing). So `current` slot = B v2 (the
        // snap-committed outgoing) and `next` slot = C (the new incoming).
        expect(screen.findByTestId('step-b-v2')).not.toBeNull();
        expect(screen.findByTestId('step-b-v1')).toBeNull();
        expect(screen.findByTestId('step-a')).toBeNull();
        expect(screen.findByTestId('step-c')).not.toBeNull();
    });

    it('ignores a stale queued completion after a newer transition starts', async () => {
        springControls.fireCallbackImmediately = true;
        springControls.deferRunOnJS = true;
        const { SlideTransitionSwitch } = await import('./SlideTransitionSwitch');
        const screen = await renderScreen(
            <SlideTransitionSwitch contentKey="a" direction="forward" testID="switch">
                <Text testID="step-a">A</Text>
            </SlideTransitionSwitch>,
        );

        await screen.update(
            <SlideTransitionSwitch contentKey="b" direction="forward" testID="switch">
                <Text testID="step-b">B</Text>
            </SlideTransitionSwitch>,
        );
        await screen.update(
            <SlideTransitionSwitch contentKey="c" direction="forward" testID="switch">
                <Text testID="step-c">C</Text>
            </SlideTransitionSwitch>,
        );

        expect(springControls.pendingRunOnJS).toHaveLength(2);

        await act(async () => {
            springControls.pendingRunOnJS.shift()?.();
        });

        expect(screen.findByTestId('step-b')).not.toBeNull();
        expect(screen.findByTestId('step-c')).not.toBeNull();
        expect(screen.findByTestId('switch-next-layer')).not.toBeNull();

        await act(async () => {
            for (const callback of springControls.pendingRunOnJS.splice(0)) callback();
        });

        expect(screen.findByTestId('step-b')).toBeNull();
        expect(screen.findByTestId('step-c')).not.toBeNull();
        expect(screen.findByTestId('switch-next-layer')).toBeNull();
    });
});
