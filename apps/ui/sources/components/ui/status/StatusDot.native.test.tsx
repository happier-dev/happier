import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

const nativeAnimatedState = vi.hoisted(() => ({
    loop: vi.fn((animation: unknown) => ({
        animation,
        start: vi.fn(),
        stop: vi.fn(),
    })),
    sequence: vi.fn((animations: readonly unknown[]) => ({ animations })),
    timing: vi.fn((value: unknown, config: unknown) => ({ value, config })),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Animated: {
            Value: class AnimatedValue {
                constructor(public readonly value: number) {}
                setValue() {}
            },
            View: 'NativeAnimatedView',
            loop: nativeAnimatedState.loop,
            sequence: nativeAnimatedState.sequence,
            timing: nativeAnimatedState.timing,
        },
        View: 'View',
        Platform: {
            OS: 'ios',
            select: (value: any) => value?.ios ?? value?.native ?? value?.default,
        },
    });
});

const useSharedValueSpy = vi.fn((value: number) => ({ value }));
const useAnimatedStyleSpy = vi.fn(() => ({ opacity: 1 }));

vi.mock('react-native-reanimated', () => ({
    default: { View: 'AnimatedView' },
    useAnimatedStyle: (factory: () => unknown) => {
        useAnimatedStyleSpy();
        return factory();
    },
    useSharedValue: (value: number) => useSharedValueSpy(value),
    withRepeat: (value: unknown) => value,
    withTiming: (value: unknown) => value,
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce((acc, item) => Object.assign(acc, flattenStyle(item)), {} as Record<string, unknown>);
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

describe('StatusDot (native)', () => {
    it('keeps the pulsing state visible while its animation is paused and resumes on demand', async () => {
        nativeAnimatedState.loop.mockClear();
        const { StatusDot } = await import('./StatusDot');
        const props = { color: 'orange', isPulsing: true, testID: 'status-dot' };
        const screen = await renderScreen(React.createElement(StatusDot, {
            ...props,
            animationEnabled: false,
        }));

        expect(screen.findHostByTestId('status-dot')).toBeTruthy();
        expect(nativeAnimatedState.loop).not.toHaveBeenCalled();

        await screen.update(React.createElement(StatusDot, { ...props, animationEnabled: true }));
        const loop = nativeAnimatedState.loop.mock.results.at(-1)?.value;
        expect(loop?.start).toHaveBeenCalledOnce();

        await screen.update(React.createElement(StatusDot, { ...props, animationEnabled: false }));
        expect(screen.findHostByTestId('status-dot')).toBeTruthy();
        expect(loop?.stop).toHaveBeenCalledOnce();
    });

    it('renders a plain View with no Reanimated hooks for a non-pulsing native dot', async () => {
        nativeAnimatedState.loop.mockClear();
        nativeAnimatedState.sequence.mockClear();
        nativeAnimatedState.timing.mockClear();
        useSharedValueSpy.mockClear();
        useAnimatedStyleSpy.mockClear();
        const { StatusDot } = await import('./StatusDot');

        const screen = await renderScreen(React.createElement(StatusDot, {
            color: 'green',
            isPulsing: false,
            size: 8,
            testID: 'status-dot',
        }));

        const dot = screen.findByTestId('status-dot');
        expect(dot).toBeTruthy();
        expect(dot?.type).toBe('View');
        expect(nativeAnimatedState.loop).not.toHaveBeenCalled();
        expect(nativeAnimatedState.sequence).not.toHaveBeenCalled();
        expect(nativeAnimatedState.timing).not.toHaveBeenCalled();
        expect(useSharedValueSpy).not.toHaveBeenCalled();
        expect(useAnimatedStyleSpy).not.toHaveBeenCalled();

        const style = flattenStyle(dot?.props.style);
        expect(style.width).toBe(8);
        expect(style.height).toBe(8);
        expect(style.borderRadius).toBe(4);
        expect(style.backgroundColor).toBe('green');
    });

    it('renders a native-driver Animated.View for a pulsing native dot without Reanimated hooks', async () => {
        nativeAnimatedState.loop.mockClear();
        nativeAnimatedState.sequence.mockClear();
        nativeAnimatedState.timing.mockClear();
        useSharedValueSpy.mockClear();
        useAnimatedStyleSpy.mockClear();
        const { StatusDot } = await import('./StatusDot');

        const screen = await renderScreen(React.createElement(StatusDot, {
            color: 'orange',
            isPulsing: true,
            size: 10,
            testID: 'status-dot',
        }));

        const dot = screen.findByTestId('status-dot');
        expect(dot).toBeTruthy();
        expect(dot?.type).toBe('NativeAnimatedView');
        expect(nativeAnimatedState.loop).toHaveBeenCalledTimes(1);
        expect(nativeAnimatedState.sequence).toHaveBeenCalledTimes(1);
        expect(nativeAnimatedState.timing).toHaveBeenCalledTimes(2);
        expect(nativeAnimatedState.timing.mock.calls[0]?.[1]).toEqual({
            duration: 1000,
            toValue: 0.3,
            useNativeDriver: true,
        });
        expect(nativeAnimatedState.timing.mock.calls[1]?.[1]).toEqual({
            duration: 1000,
            toValue: 1,
            useNativeDriver: true,
        });
        expect(useSharedValueSpy).not.toHaveBeenCalled();
        expect(useAnimatedStyleSpy).not.toHaveBeenCalled();

        const style = flattenStyle(dot?.props.style);
        expect(style.width).toBe(10);
        expect(style.height).toBe(10);
        expect(style.borderRadius).toBe(5);
        expect(style.backgroundColor).toBe('orange');
    });
});
