/**
 * RV-4 / F13.1 — In-flight guard for StoryDeckSlideTransition.
 *
 * Two rapid `commitNext()` calls before the first spring callback fires must
 * NOT both enqueue a parent commit. The second call while a transition is in
 * flight is ignored; once the spring completes the parent's `advanceToNext`
 * advances by exactly one slide.
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
    // Capture the spring callback so the test can fire it manually after
    // queuing a second commit. Returns the target value so progress.value
    // ends up at the requested target; do NOT auto-fire.
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

type TestGesture = Readonly<{
    __handlers: Record<string, (...args: unknown[]) => void>;
}>;

function findGestureChain(screen: { findByTestId: (id: string) => { props: { gesture: TestGesture } } | null }): TestGesture {
    const detector = screen.findByTestId('deck-gesture-detector');
    if (!detector) throw new Error('deck-gesture-detector not found');
    return detector.props.gesture;
}

describe('StoryDeckSlideTransition — in-flight guard (F13.1)', () => {
    it('ignores a second commitNext while a spring is in flight, then commits exactly once when the spring settles', async () => {
        reanimatedControls.pendingCallbacks = [];
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

        expect(ref.current).not.toBeNull();
        // Two rapid imperative commits before the first spring callback fires.
        act(() => {
            ref.current!.commitNext();
            ref.current!.commitNext();
        });

        // Only ONE spring callback should be pending — the second commit is
        // ignored because a spring is already in flight.
        expect(reanimatedControls.pendingCallbacks).toHaveLength(1);

        // Settle the spring; parent advance fires exactly once.
        act(() => {
            const callbacks = reanimatedControls.pendingCallbacks.splice(0);
            for (const cb of callbacks) cb();
        });

        expect(onCommitNext).toHaveBeenCalledTimes(1);
        expect(onCommitPrevious).not.toHaveBeenCalled();
    });

    it('ignores a second commitPrevious while a previous-spring is in flight', async () => {
        reanimatedControls.pendingCallbacks = [];
        const onCommitNext = vi.fn();
        const onCommitPrevious = vi.fn();
        const { StoryDeckSlideTransition } = await import('./StoryDeckSlideTransition');

        const ref = React.createRef<{ commitNext: () => void; commitPrevious: () => void }>();
        const screen = await renderScreen(
            <StoryDeckSlideTransition
                ref={ref}
                activeIndex={2}
                itemCount={5}
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
            ref.current!.commitPrevious();
        });

        expect(reanimatedControls.pendingCallbacks).toHaveLength(1);

        act(() => {
            const callbacks = reanimatedControls.pendingCallbacks.splice(0);
            for (const cb of callbacks) cb();
        });

        expect(onCommitPrevious).toHaveBeenCalledTimes(1);
        expect(onCommitNext).not.toHaveBeenCalled();
    });

    it('ignores below-threshold gesture releases while a commit spring is in flight', async () => {
        reanimatedControls.pendingCallbacks = [];
        const onCommitNext = vi.fn();
        const { StoryDeckSlideTransition } = await import('./StoryDeckSlideTransition');

        const ref = React.createRef<{ commitNext: () => void; commitPrevious: () => void }>();
        const screen = await renderScreen(
            <StoryDeckSlideTransition
                ref={ref}
                activeIndex={1}
                itemCount={5}
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
        expect(reanimatedControls.pendingCallbacks).toHaveLength(1);

        const gesture = findGestureChain(screen as never);
        act(() => {
            gesture.__handlers.onEnd?.({ translationX: 20 });
        });

        expect(reanimatedControls.pendingCallbacks).toHaveLength(1);
    });

    it('accepts a fresh commit AFTER the in-flight spring has fully settled', async () => {
        reanimatedControls.pendingCallbacks = [];
        const onCommitNext = vi.fn();
        const { StoryDeckSlideTransition } = await import('./StoryDeckSlideTransition');

        // Use a controlled wrapper so we can advance activeIndex when the parent
        // commit fires (mirrors StoryDeckSurface's functional setState pattern).
        function Harness(): React.ReactElement {
            const [activeIndex, setActiveIndex] = React.useState(1);
            const advance = React.useCallback(() => {
                onCommitNext();
                setActiveIndex((current) => Math.min(current + 1, 4));
            }, []);
            const ref = React.useRef<{ commitNext: () => void; commitPrevious: () => void }>(null);
            (Harness as unknown as { __ref: typeof ref }).__ref = ref;
            return (
                <StoryDeckSlideTransition
                    ref={ref}
                    activeIndex={activeIndex}
                    itemCount={5}
                    renderItem={renderItem}
                    onCommitNext={advance}
                    onCommitPrevious={() => {}}
                    testID="deck"
                />
            );
        }

        const screen = await renderScreen(<Harness />);
        const ref = (Harness as unknown as { __ref: React.RefObject<{
            commitNext: () => void;
            commitPrevious: () => void;
        }> }).__ref;
        const root = screen.findByTestId('deck-root');
        fireLayout(root, 320);

        // First commit (in flight).
        act(() => {
            ref.current!.commitNext();
        });
        expect(reanimatedControls.pendingCallbacks).toHaveLength(1);
        // Settle.
        act(() => {
            const cbs = reanimatedControls.pendingCallbacks.splice(0);
            for (const cb of cbs) cb();
        });
        expect(onCommitNext).toHaveBeenCalledTimes(1);

        // A second commit AFTER settle is accepted (a new spring is queued).
        act(() => {
            ref.current!.commitNext();
        });
        expect(reanimatedControls.pendingCallbacks).toHaveLength(1);
        act(() => {
            const cbs = reanimatedControls.pendingCallbacks.splice(0);
            for (const cb of cbs) cb();
        });

        expect(onCommitNext).toHaveBeenCalledTimes(2);
    });
});
