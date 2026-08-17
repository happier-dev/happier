import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

const reducedMotionState = vi.hoisted(() => ({ current: false }));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionState.current,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
        Platform: {
            OS: 'web',
            select: (options: Record<string, unknown>) => options.web ?? options.default,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: {
                    secondary: 'theme-secondary-text',
                },
            },
        },
    });
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce((acc, item) => Object.assign(acc, flattenStyle(item)), {} as Record<string, unknown>);
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

describe('ActivitySpinner', () => {
    it('uses a CSS transform spinner on web instead of React Native Web ActivityIndicator', async () => {
        const { ActivitySpinner } = await import('./ActivitySpinner');
        const screen = await renderScreen(
            <ActivitySpinner testID="spinner" size={12} color="red" />,
        );

        expect(screen.findAllByType('ActivityIndicator' as never)).toHaveLength(0);
        const spinner = screen.findByTestId('spinner');
        if (!spinner) {
            throw new Error('Expected CSS spinner to render');
        }
        expect(spinner.props.accessibilityRole).toBe('progressbar');
        const style = flattenStyle(spinner.props.style);
        expect(style.animationName).toBe('happierActivitySpinnerSpin');
        expect(style.animationTimingFunction).toBe('steps(6, end)');
        expect(style.width).toBe(12);
        expect(style.borderColor).toBe('red');
    });

    it('uses the theme secondary text color and self-centers on web when no color is provided', async () => {
        const { ActivitySpinner } = await import('./ActivitySpinner');
        const screen = await renderScreen(
            <ActivitySpinner testID="spinner" size="small" />,
        );

        const spinner = screen.findByTestId('spinner');
        if (!spinner) {
            throw new Error('Expected CSS spinner to render');
        }
        const style = flattenStyle(spinner.props.style);
        expect(style.borderColor).toBe('theme-secondary-text');
        expect(style.animationTimingFunction).toBe('steps(6, end)');
        expect(style.alignSelf).toBe('center');
    });

    it('can render a static web spinner without scheduling a continuous CSS animation', async () => {
        const { ActivitySpinner } = await import('./ActivitySpinner');
        const screen = await renderScreen(
            <ActivitySpinner testID="spinner" size={12} animationEnabled={false} />,
        );

        const spinner = screen.findByTestId('spinner');
        if (!spinner) {
            throw new Error('Expected static CSS spinner to render');
        }
        const style = flattenStyle(spinner.props.style);
        expect(style.animationName).toBeUndefined();
        expect(style.animationIterationCount).toBeUndefined();
        expect(style.willChange).toBeUndefined();
        expect(style.opacity).toBe(1);
    });

    it('keeps the web spinner visible but static when the system prefers reduced motion', async () => {
        reducedMotionState.current = true;
        const { ActivitySpinner } = await import('./ActivitySpinner');
        const screen = await renderScreen(
            <ActivitySpinner testID="spinner" size={12} />,
        );

        const spinner = screen.findByTestId('spinner');
        if (!spinner) {
            throw new Error('Expected static CSS spinner to render');
        }
        const style = flattenStyle(spinner.props.style);
        expect(style.animationName).toBeUndefined();
        expect(style.animationIterationCount).toBeUndefined();
        expect(style.willChange).toBeUndefined();
        expect(style.opacity).toBe(1);
        reducedMotionState.current = false;
    });
});
