import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Platform: {
            OS: 'web',
            select: (value: any) => value?.web ?? value?.default,
        },
    });
});

vi.mock('react-native-reanimated', () => ({
    default: { View: 'AnimatedView' },
    useAnimatedStyle: () => ({ opacity: 1 }),
    useSharedValue: (value: number) => ({ value }),
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

describe('StatusDot', () => {
    it('uses a CSS pulse on web instead of a Reanimated view', async () => {
        const { StatusDot } = await import('./StatusDot');
        const screen = await renderScreen(React.createElement(StatusDot, {
            color: 'red',
            isPulsing: true,
            size: 10,
        }));

        const dot = screen.findByType('View');
        expect(dot).toBeTruthy();
        expect(dot?.type).toBe('View');
        const style = flattenStyle(dot?.props.style);
        expect(style.animationName).toBe('happierStatusDotPulse');
        expect(style.animationTimingFunction).toBe('steps(6, end)');
    });

    it('can show a pulsing-state web dot without scheduling a CSS pulse animation', async () => {
        const { StatusDot } = await import('./StatusDot');
        const screen = await renderScreen(React.createElement(StatusDot, {
            color: 'red',
            isPulsing: true,
            animationEnabled: false,
            size: 10,
        }));

        const dot = screen.findByType('View');
        const style = flattenStyle(dot?.props.style);
        expect(style.animationName).toBeUndefined();
        expect(style.animationIterationCount).toBeUndefined();
        expect(style.backgroundColor).toBe('red');
    });
});
