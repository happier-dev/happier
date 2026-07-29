import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

const reducedMotionState = vi.hoisted(() => ({ reads: 0, value: false }));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => {
        reducedMotionState.reads += 1;
        return reducedMotionState.value;
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const loop = vi.fn((animation: { start?: () => void; stop?: () => void }) => ({
        start: vi.fn(() => animation.start?.()),
        stop: vi.fn(() => animation.stop?.()),
    }));
    const sequence = vi.fn((animations: readonly unknown[]) => ({
        start: vi.fn(),
        stop: vi.fn(),
        animations,
    }));
    const timing = vi.fn((value: unknown, config: unknown) => ({
        start: vi.fn(),
        stop: vi.fn(),
        value,
        config,
    }));
    return createReactNativeWebMock({
        Animated: {
            Value: vi.fn(function Value(this: { value: number }, value: number) {
                this.value = value;
            }),
            View: 'NativeAnimatedView',
            loop,
            sequence,
            timing,
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
    __esModule: true,
    default: { View: 'ReanimatedView' },
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
    it('renders a plain View with no Reanimated hooks for a non-pulsing native dot', async () => {
        reducedMotionState.reads = 0;
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
        expect(useSharedValueSpy).not.toHaveBeenCalled();
        expect(useAnimatedStyleSpy).not.toHaveBeenCalled();
        expect(reducedMotionState.reads).toBe(0);

        const style = flattenStyle(dot?.props.style);
        expect(style.width).toBe(8);
        expect(style.height).toBe(8);
        expect(style.borderRadius).toBe(4);
        expect(style.backgroundColor).toBe('green');
    });

    it('accepts a semantic accessibility label for color-only status dots', async () => {
        const { StatusDot } = await import('./StatusDot');

        const screen = await renderScreen(React.createElement(StatusDot, {
            color: 'green',
            accessibilityLabel: 'Service running',
            testID: 'status-dot',
        }));

        const dot = screen.findByTestId('status-dot');
        expect(dot?.props.accessibilityRole).toBe('image');
        expect(dot?.props.accessibilityLabel).toBe('Service running');
    });

    it('renders a React Native Animated.View for a pulsing native dot', async () => {
        useSharedValueSpy.mockClear();
        useAnimatedStyleSpy.mockClear();
        const { StatusDot } = await import('./StatusDot');
        const { Animated } = await import('react-native');

        const screen = await renderScreen(React.createElement(StatusDot, {
            color: 'orange',
            isPulsing: true,
            size: 10,
            testID: 'status-dot',
        }));

        const dot = screen.findByTestId('status-dot');
        expect(dot).toBeTruthy();
        expect(dot?.type).toBe('NativeAnimatedView');
        expect(useSharedValueSpy).not.toHaveBeenCalled();
        expect(useAnimatedStyleSpy).not.toHaveBeenCalled();
        expect(Animated.timing).toHaveBeenCalledWith(expect.anything(), {
            toValue: 0.3,
            duration: 1000,
            useNativeDriver: true,
        });
        expect(Animated.timing).toHaveBeenCalledWith(expect.anything(), {
            toValue: 1,
            duration: 1000,
            useNativeDriver: true,
        });
        expect(Animated.sequence).toHaveBeenCalled();
        expect(Animated.loop).toHaveBeenCalled();

        const style = flattenStyle(dot?.props.style);
        expect(style.width).toBe(10);
        expect(style.height).toBe(10);
        expect(style.borderRadius).toBe(5);
        expect(style.backgroundColor).toBe('orange');
    });

    it('renders a static semantic native status without starting a loop when reduced motion is enabled', async () => {
        reducedMotionState.value = true;
        const { StatusDot } = await import('./StatusDot');
        const { Animated } = await import('react-native');
        vi.mocked(Animated.loop).mockClear();
        vi.mocked(Animated.sequence).mockClear();
        vi.mocked(Animated.timing).mockClear();

        const screen = await renderScreen(React.createElement(StatusDot, {
            color: 'orange',
            isPulsing: true,
            accessibilityLabel: 'Agent working',
            testID: 'status-dot',
        }));

        const dot = screen.findByTestId('status-dot');
        expect(dot?.type).toBe('View');
        expect(dot?.props.accessibilityRole).toBe('image');
        expect(dot?.props.accessibilityLabel).toBe('Agent working');
        expect(Animated.loop).not.toHaveBeenCalled();
        expect(Animated.sequence).not.toHaveBeenCalled();
        expect(Animated.timing).not.toHaveBeenCalled();

        reducedMotionState.value = false;
    });
});
