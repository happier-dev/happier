import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

const reducedMotionState = vi.hoisted(() => ({ reads: 0, value: false }));
const hostViewedState = vi.hoisted(() => ({ reads: 0, value: true }));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => {
        reducedMotionState.reads += 1;
        return reducedMotionState.value;
    },
}));

vi.mock('@/utils/runtime/useHostActivelyViewed', () => ({
    useHostActivelyViewed: () => {
        hostViewedState.reads += 1;
        return hostViewedState.value;
    },
}));

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
        reducedMotionState.reads = 0;
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
        expect(reducedMotionState.reads).toBe(0);
    });

    it('stops pulsing while the host is not being viewed', async () => {
        hostViewedState.value = false;
        const { StatusDot } = await import('./StatusDot');
        const screen = await renderScreen(React.createElement(StatusDot, {
            color: 'red',
            isPulsing: true,
            size: 10,
            testID: 'status-dot',
        }));

        const dot = screen.findByTestId('status-dot');
        const style = flattenStyle(dot?.props.style);
        // The dot keeps its pulsing colour and size — only the animation stops.
        expect(style.backgroundColor).toBe('red');
        expect(style.width).toBe(10);
        expect(style.animationName).toBeUndefined();
        expect(style.animationIterationCount).toBeUndefined();

        hostViewedState.value = true;
    });

    it('does not subscribe to host visibility on the static path', async () => {
        hostViewedState.reads = 0;
        const { StatusDot } = await import('./StatusDot');
        await renderScreen(React.createElement(StatusDot, {
            color: 'red',
            isPulsing: false,
            size: 10,
        }));

        expect(hostViewedState.reads).toBe(0);
    });

    it('renders a static semantic web status when reduced motion is enabled', async () => {
        reducedMotionState.value = true;
        const { StatusDot } = await import('./StatusDot');
        const screen = await renderScreen(React.createElement(StatusDot, {
            color: 'red',
            isPulsing: true,
            accessibilityLabel: 'Agent working',
            testID: 'status-dot',
        }));

        const dot = screen.findByTestId('status-dot');
        const style = flattenStyle(dot?.props.style);
        expect(dot?.type).toBe('View');
        expect(dot?.props.accessibilityRole).toBe('image');
        expect(dot?.props.accessibilityLabel).toBe('Agent working');
        expect(style.animationName).toBeUndefined();
        expect(style.animationIterationCount).toBeUndefined();

        reducedMotionState.value = false;
    });
});
