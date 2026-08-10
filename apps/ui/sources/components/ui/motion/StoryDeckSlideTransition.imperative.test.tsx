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
    fireSpringCallback: false,
    lastSpringConfig: null as unknown,
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
    const cancelAnimation = () => {};
    const withSpring = <T,>(value: T, config?: unknown, callback?: (finished?: boolean) => void) => {
        reanimatedControls.lastSpringConfig = config;
        if (reanimatedControls.fireSpringCallback && callback) callback(true);
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

type TestGesture = Readonly<{
    __config: Record<string, unknown>;
    __handlers: Record<string, (...args: unknown[]) => void>;
}>;

function findGestureChain(screen: { findByTestId: (id: string) => { props: { gesture: TestGesture } } | null }): TestGesture {
    const detector = screen.findByTestId('deck-gesture-detector');
    if (!detector) throw new Error('deck-gesture-detector not found');
    return detector.props.gesture;
}

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

describe('StoryDeckSlideTransition — imperative commit API', () => {
    it('exposes commitNext via ref that fires onCommitNext using the same spring config as a swipe-release', async () => {
        reanimatedControls.fireSpringCallback = true;
        reanimatedControls.lastSpringConfig = null;
        const onCommitNext = vi.fn();
        const onCommitPrevious = vi.fn();
        const { StoryDeckSlideTransition } = await import('./StoryDeckSlideTransition');

        const ref = React.createRef<{ commitNext: () => void; commitPrevious: () => void }>();
        const screen = await renderScreen(
            <StoryDeckSlideTransition
                ref={ref}
                activeIndex={1}
                itemCount={3}
                renderItem={renderItem}
                onCommitNext={onCommitNext}
                onCommitPrevious={onCommitPrevious}
                testID="deck"
            />,
        );

        const root = screen.findByTestId('deck-root');
        fireLayout(root, 320);

        // Trigger a swipe-commit first to capture the spring config used for swipes.
        const gesture = findGestureChain(screen as never);
        act(() => {
            gesture.__handlers.onUpdate?.({ translationX: -200 });
            gesture.__handlers.onEnd?.({ translationX: -200 });
        });
        const swipeSpringConfig = reanimatedControls.lastSpringConfig;
        reanimatedControls.lastSpringConfig = null;

        // Now imperatively call commitNext: must trigger onCommitNext with the same spring config.
        expect(ref.current).not.toBeNull();
        act(() => {
            ref.current!.commitNext();
        });

        expect(onCommitNext).toHaveBeenCalledTimes(2);
        expect(reanimatedControls.lastSpringConfig).toEqual(swipeSpringConfig);
    });

    it('exposes commitPrevious via ref that fires onCommitPrevious', async () => {
        reanimatedControls.fireSpringCallback = true;
        const onCommitNext = vi.fn();
        const onCommitPrevious = vi.fn();
        const { StoryDeckSlideTransition } = await import('./StoryDeckSlideTransition');

        const ref = React.createRef<{ commitNext: () => void; commitPrevious: () => void }>();
        const screen = await renderScreen(
            <StoryDeckSlideTransition
                ref={ref}
                activeIndex={1}
                itemCount={3}
                renderItem={renderItem}
                onCommitNext={onCommitNext}
                onCommitPrevious={onCommitPrevious}
                testID="deck"
            />,
        );

        const root = screen.findByTestId('deck-root');
        fireLayout(root, 320);

        act(() => {
            ref.current!.commitPrevious();
        });

        expect(onCommitPrevious).toHaveBeenCalledTimes(1);
        expect(onCommitNext).not.toHaveBeenCalled();
    });

    it('imperative commitNext at the last card is a no-op (no commit, no spring on stale layer)', async () => {
        reanimatedControls.fireSpringCallback = true;
        const onCommitNext = vi.fn();
        const { StoryDeckSlideTransition } = await import('./StoryDeckSlideTransition');

        const ref = React.createRef<{ commitNext: () => void; commitPrevious: () => void }>();
        const screen = await renderScreen(
            <StoryDeckSlideTransition
                ref={ref}
                activeIndex={2}
                itemCount={3}
                renderItem={renderItem}
                onCommitNext={onCommitNext}
                onCommitPrevious={() => {}}
                testID="deck"
            />,
        );
        const root = screen.findByTestId('deck-root');
        fireLayout(root, 320);

        act(() => {
            ref.current!.commitNext();
        });

        expect(onCommitNext).not.toHaveBeenCalled();
    });

    it('imperative commitPrevious at the first card is a no-op', async () => {
        reanimatedControls.fireSpringCallback = true;
        const onCommitPrevious = vi.fn();
        const { StoryDeckSlideTransition } = await import('./StoryDeckSlideTransition');

        const ref = React.createRef<{ commitNext: () => void; commitPrevious: () => void }>();
        const screen = await renderScreen(
            <StoryDeckSlideTransition
                ref={ref}
                activeIndex={0}
                itemCount={3}
                renderItem={renderItem}
                onCommitNext={() => {}}
                onCommitPrevious={onCommitPrevious}
                testID="deck"
            />,
        );
        const root = screen.findByTestId('deck-root');
        fireLayout(root, 320);

        act(() => {
            ref.current!.commitPrevious();
        });

        expect(onCommitPrevious).not.toHaveBeenCalled();
    });
});

describe('StoryDeckSlideTransition — reduced motion still commits', () => {
    it('snap-commits onCommitNext under reduced motion when a left-drag past threshold is released (no animation, but still advance)', async () => {
        reanimatedControls.fireSpringCallback = true;
        const onCommitNext = vi.fn();
        const onCommitPrevious = vi.fn();
        const { StoryDeckSlideTransition } = await import('./StoryDeckSlideTransition');
        const screen = await renderScreen(
            <StoryDeckSlideTransition
                activeIndex={1}
                itemCount={3}
                renderItem={renderItem}
                onCommitNext={onCommitNext}
                onCommitPrevious={onCommitPrevious}
                reducedMotion
                testID="deck"
            />,
        );

        const root = screen.findByTestId('deck-root');
        fireLayout(root, 320);

        const gesture = findGestureChain(screen as never);
        act(() => {
            gesture.__handlers.onEnd?.({ translationX: -200 });
        });

        expect(onCommitNext).toHaveBeenCalledTimes(1);
        expect(onCommitPrevious).not.toHaveBeenCalled();
    });

    it('snap-commits onCommitPrevious under reduced motion when right-drag past threshold released', async () => {
        reanimatedControls.fireSpringCallback = true;
        const onCommitNext = vi.fn();
        const onCommitPrevious = vi.fn();
        const { StoryDeckSlideTransition } = await import('./StoryDeckSlideTransition');
        const screen = await renderScreen(
            <StoryDeckSlideTransition
                activeIndex={1}
                itemCount={3}
                renderItem={renderItem}
                onCommitNext={onCommitNext}
                onCommitPrevious={onCommitPrevious}
                reducedMotion
                testID="deck"
            />,
        );

        const root = screen.findByTestId('deck-root');
        fireLayout(root, 320);

        const gesture = findGestureChain(screen as never);
        act(() => {
            gesture.__handlers.onEnd?.({ translationX: 200 });
        });

        expect(onCommitPrevious).toHaveBeenCalledTimes(1);
        expect(onCommitNext).not.toHaveBeenCalled();
    });
});

describe('StoryDeckSlideTransition — pan gesture activation/failure bounds', () => {
    it('configures activeOffsetX and failOffsetY so vertical drags propagate to nested vertical gestures', async () => {
        const { StoryDeckSlideTransition } = await import('./StoryDeckSlideTransition');
        const screen = await renderScreen(
            <StoryDeckSlideTransition
                activeIndex={0}
                itemCount={3}
                renderItem={renderItem}
                onCommitNext={() => {}}
                onCommitPrevious={() => {}}
                testID="deck"
            />,
        );
        const gesture = findGestureChain(screen as never);

        expect(gesture.__config.activeOffsetX).toEqual([-10, 10]);
        expect(gesture.__config.failOffsetY).toEqual([-10, 10]);
    });
});
