import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';

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
    return createUnistylesMock();
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

// Whichever loading indicator style the user picked, a running spinner on web is driven by a CSS
// animation somewhere in its subtree and a held one has none.
function findCssAnimatedNodes(node: { findAll: (predicate: (node: any) => boolean) => unknown[] }) {
    return node.findAll((child) => typeof child.type === 'string' && flattenStyle(child.props?.style).animationName != null);
}

describe('SessionRowAttentionIndicator', () => {
    it('uses a CSS-animated spinner for compact working indicators on web instead of React Native Web ActivityIndicator', async () => {
        const { SessionRowAttentionIndicator } = await import('./SessionRowAttentionIndicator');

        const screen = await renderScreen(
            <SessionRowAttentionIndicator
                indicator="working"
                sessionId="session-a"
                attentionState="working"
                workingMode="spinner"
            />,
        );

        expect(screen.findAllByType('ActivityIndicator' as never)).toHaveLength(0);
        const spinner = screen.findByTestId('session-row-attention-indicator-spinner-session-a');
        if (!spinner) {
            throw new Error('Expected CSS working spinner to render');
        }
        expect(findCssAnimatedNodes(spinner).length).toBeGreaterThan(0);
    });

    it('draws the working spinner at 16 px so it reads beside the row\'s agent icons', async () => {
        const { SessionRowAttentionIndicator } = await import('./SessionRowAttentionIndicator');
        const screen = await renderScreen(
            <SessionRowAttentionIndicator
                indicator="working"
                sessionId="session-size"
                attentionState="working"
                workingMode="spinner"
                animationEnabled={false}
            />,
        );

        const spinner = screen.findByTestId('session-row-attention-indicator-spinner-session-size');
        expect(flattenStyle(spinner?.props.style)).toMatchObject({ width: 16, height: 16 });
    });

    it('can render compact row indicators statically for mounted offscreen web rows', async () => {
        const { SessionRowAttentionIndicator } = await import('./SessionRowAttentionIndicator');

        const workingScreen = await renderScreen(
            <SessionRowAttentionIndicator
                indicator="working"
                sessionId="session-a"
                attentionState="working"
                workingMode="spinner"
                animationEnabled={false}
            />,
        );
        const spinner = workingScreen.findByTestId('session-row-attention-indicator-spinner-session-a');
        if (!spinner) {
            throw new Error('Expected CSS working spinner to render');
        }
        expect(findCssAnimatedNodes(spinner)).toHaveLength(0);

        const failedScreen = await renderScreen(
            <SessionRowAttentionIndicator
                indicator="failed"
                sessionId="session-b"
                attentionState="failed"
                animationEnabled={false}
            />,
        );
        const dot = failedScreen.findByTestId('session-row-attention-indicator-dot-session-b');
        if (!dot) {
            throw new Error('Expected status dot to render');
        }
        expect(flattenStyle(dot.props.style).animationName).toBeUndefined();
    });

    it.each(['spinner', 'pulse'] as const)('keeps the %s working mark and shows unread only at its center until read', async (workingMode) => {
        const { SessionRowAttentionIndicator } = await import('./SessionRowAttentionIndicator');
        const element = (hasUnreadMessages: boolean) => <SessionRowAttentionIndicator indicator="working" attentionState="working"
            sessionId="background-unread" hasUnreadMessages={hasUnreadMessages} workingMode={workingMode} workingSpinnerTone="neutral" animationEnabled={false} />;
        const screen = await renderScreen(element(true));
        const markColor = () => screen.tree.root.findAll(node =>
            typeof node.props.color === 'string' && /^session-row-attention-indicator-(spinner|dot)-/.test(node.props.testID ?? ''))[0]?.props.color;
        const normalColor = workingMode === 'spinner' ? lightTheme.colors.text.tertiary : lightTheme.colors.state.info.foreground;
        expect(markColor()).toBe(normalColor);
        expect(screen.findByTestId('session-row-unread-center-background-unread')).toBeTruthy();
        expect(screen.findByTestId('session-row-unread-indicator-background-unread')).toBeNull();
        await screen.update(element(false));
        expect(markColor()).toBe(normalColor);
        expect(screen.findByTestId('session-row-unread-center-background-unread')).toBeNull();
    });

});
