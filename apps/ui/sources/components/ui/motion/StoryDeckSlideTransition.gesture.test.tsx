import * as React from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';
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
    const withSpring = <T,>(value: T, _config?: unknown, callback?: (finished?: boolean) => void) => {
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

describe('StoryDeckSlideTransition (carousel adapter)', () => {
    it('renders previous, current, and next slots when not at bounds', async () => {
        const { StoryDeckSlideTransition } = await import('./StoryDeckSlideTransition');
        const screen = await renderScreen(
            <StoryDeckSlideTransition
                activeIndex={1}
                itemCount={3}
                renderItem={renderItem}
                onCommitNext={() => {}}
                onCommitPrevious={() => {}}
                testID="deck"
            />,
        );

        expect(screen.findByTestId('card-0')).not.toBeNull();
        expect(screen.findByTestId('card-1')).not.toBeNull();
        expect(screen.findByTestId('card-2')).not.toBeNull();
    });

    it('omits the previous slot at activeIndex=0 (no fade toward an undefined layer)', async () => {
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

        expect(screen.findByTestId('deck-previous-layer')).toBeNull();
        expect(screen.findByTestId('deck-current-layer')).not.toBeNull();
        expect(screen.findByTestId('deck-next-layer')).not.toBeNull();
    });

    it('omits the next slot at the last index', async () => {
        const { StoryDeckSlideTransition } = await import('./StoryDeckSlideTransition');
        const screen = await renderScreen(
            <StoryDeckSlideTransition
                activeIndex={2}
                itemCount={3}
                renderItem={renderItem}
                onCommitNext={() => {}}
                onCommitPrevious={() => {}}
                testID="deck"
            />,
        );

        expect(screen.findByTestId('deck-next-layer')).toBeNull();
        expect(screen.findByTestId('deck-previous-layer')).not.toBeNull();
        expect(screen.findByTestId('deck-current-layer')).not.toBeNull();
    });

    it('fires onCommitNext when a left-drag past threshold is released', async () => {
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
                testID="deck"
            />,
        );

        const root = screen.findByTestId('deck-root');
        fireLayout(root, 320);

        const gesture = findGestureChain(screen as never);
        act(() => {
            gesture.__handlers.onUpdate?.({ translationX: -200 });
            gesture.__handlers.onEnd?.({ translationX: -200 });
        });

        expect(onCommitNext).toHaveBeenCalledTimes(1);
        expect(onCommitPrevious).not.toHaveBeenCalled();
    });

    it('fires onCommitPrevious when a right-drag past threshold is released', async () => {
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
                testID="deck"
            />,
        );

        const root = screen.findByTestId('deck-root');
        fireLayout(root, 320);

        const gesture = findGestureChain(screen as never);
        act(() => {
            gesture.__handlers.onUpdate?.({ translationX: 200 });
            gesture.__handlers.onEnd?.({ translationX: 200 });
        });

        expect(onCommitPrevious).toHaveBeenCalledTimes(1);
        expect(onCommitNext).not.toHaveBeenCalled();
    });

    it('does NOT commit on release within threshold', async () => {
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
                testID="deck"
            />,
        );

        const root = screen.findByTestId('deck-root');
        fireLayout(root, 320);

        // 30/320 = 0.094 → far below 0.4 threshold.
        const gesture = findGestureChain(screen as never);
        act(() => {
            gesture.__handlers.onUpdate?.({ translationX: 30 });
            gesture.__handlers.onEnd?.({ translationX: 30 });
        });

        expect(onCommitNext).not.toHaveBeenCalled();
        expect(onCommitPrevious).not.toHaveBeenCalled();
    });

    it('does NOT commit previous on first card even with right-drag past threshold (clamped to 0)', async () => {
        reanimatedControls.fireSpringCallback = true;
        const onCommitPrevious = vi.fn();
        const { StoryDeckSlideTransition } = await import('./StoryDeckSlideTransition');
        const screen = await renderScreen(
            <StoryDeckSlideTransition
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

        const gesture = findGestureChain(screen as never);
        act(() => {
            gesture.__handlers.onUpdate?.({ translationX: 250 });
            gesture.__handlers.onEnd?.({ translationX: 250 });
        });

        expect(onCommitPrevious).not.toHaveBeenCalled();
    });

    it('does NOT commit next on last card even with left-drag past threshold (clamped to 0)', async () => {
        reanimatedControls.fireSpringCallback = true;
        const onCommitNext = vi.fn();
        const { StoryDeckSlideTransition } = await import('./StoryDeckSlideTransition');
        const screen = await renderScreen(
            <StoryDeckSlideTransition
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

        const gesture = findGestureChain(screen as never);
        act(() => {
            gesture.__handlers.onUpdate?.({ translationX: -250 });
            gesture.__handlers.onEnd?.({ translationX: -250 });
        });

        expect(onCommitNext).not.toHaveBeenCalled();
    });
});
