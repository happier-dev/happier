import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
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
    it('renders a plain View with no Reanimated hooks for a non-pulsing native dot', async () => {
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

        const style = flattenStyle(dot?.props.style);
        expect(style.width).toBe(8);
        expect(style.height).toBe(8);
        expect(style.borderRadius).toBe(4);
        expect(style.backgroundColor).toBe('green');
    });

    it('renders an Animated.View driven by Reanimated for a pulsing native dot', async () => {
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
        expect(dot?.type).toBe('AnimatedView');
        expect(useSharedValueSpy).toHaveBeenCalled();
        expect(useAnimatedStyleSpy).toHaveBeenCalled();

        const style = flattenStyle(dot?.props.style);
        expect(style.width).toBe(10);
        expect(style.height).toBe(10);
        expect(style.borderRadius).toBe(5);
        expect(style.backgroundColor).toBe('orange');
    });
});
