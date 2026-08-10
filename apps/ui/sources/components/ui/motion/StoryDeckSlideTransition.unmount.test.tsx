/**
 * RV-4 / F13.2 — Unmount cancellation for StoryDeckSlideTransition.
 *
 * If the component unmounts mid-transition, any in-flight spring must be
 * cancelled and any later spring callback that still fires must be a no-op
 * (no parent commit, no React state update warnings).
 */

import * as React from 'react';
import { Text, type LayoutChangeEvent } from 'react-native';
import { act } from 'react-test-renderer';
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
        // The slide springs carry an explicit reduced-motion policy (`slideTransitionTokens`
        // -> `motionSprings.resolveReduceMotionPolicy`), so the enum has to exist on the mock.
        ReduceMotion: { System: 'system', Always: 'always', Never: 'never' },
        cancelAnimation,
        runOnJS,
        useAnimatedProps,
        useAnimatedStyle,
        useSharedValue,
        withSpring,
    };
});

function fireLayout(view: { props: { onLayout?: (event: LayoutChangeEvent) => void } } | null, width: number): void {
    if (!view?.props?.onLayout) return;
    act(() => {
        view.props.onLayout?.({
            nativeEvent: { layout: { width, height: 240, x: 0, y: 0 } },
        } as LayoutChangeEvent);
    });
}

function renderItem(index: number, _role: 'previous' | 'current' | 'next'): React.ReactElement {
    return <Text testID={`card-${index}`}>{`card ${index}`}</Text>;
}

describe('StoryDeckSlideTransition — unmount cancellation (F13.2)', () => {
    it('cancels the in-flight spring on unmount and a late callback does not call onCommitNext', async () => {
        reanimatedControls.pendingCallbacks = [];
        reanimatedControls.cancelCount = 0;
        const onCommitNext = vi.fn();
        const onCommitPrevious = vi.fn();
        const { StoryDeckSlideTransition } = await import('./StoryDeckSlideTransition');

        const ref = React.createRef<{ commitNext: () => void; commitPrevious: () => void }>();
        const screen = await renderScreen(
            <StoryDeckSlideTransition
                ref={ref}
                activeIndex={1}
                itemCount={5}
                renderItem={renderItem}
                onCommitNext={onCommitNext}
                onCommitPrevious={onCommitPrevious}
                testID="deck"
            />,
        );

        const root = screen.findByTestId('deck-root');
        fireLayout(root, 320);

        // Start a transition (spring callback queued, NOT yet fired).
        act(() => {
            ref.current!.commitNext();
        });
        expect(reanimatedControls.pendingCallbacks).toHaveLength(1);
        const beforeUnmountCancelCount = reanimatedControls.cancelCount;

        // Unmount mid-transition.
        await screen.update(<></>);
        // The unmount cleanup should have called cancelAnimation at least once.
        expect(reanimatedControls.cancelCount).toBeGreaterThan(beforeUnmountCancelCount);

        // Now flush the late spring callback. Parent commit MUST NOT fire.
        act(() => {
            const cbs = reanimatedControls.pendingCallbacks.splice(0);
            for (const cb of cbs) cb();
        });

        expect(onCommitNext).not.toHaveBeenCalled();
        expect(onCommitPrevious).not.toHaveBeenCalled();
    });
});
