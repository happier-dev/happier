import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());

const automationsSupportState = vi.hoisted(() => ({
    enabled: true,
}));

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        Platform: {
            ...(actual.Platform ?? {}),
            OS: 'ios',
        },
        View: 'View',
        Text: 'Text',
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                header: { tint: '#111' },
                groupped: { background: '#fff' },
                textSecondary: '#777',
                status: {
                    connected: '#0f0',
                    connecting: '#ff0',
                    disconnected: '#f00',
                    error: '#f00',
                    default: '#777',
                },
            },
        },
    }),
    StyleSheet: {
        create: (factory: any) => factory({
            colors: {
                header: { tint: '#111' },
                groupped: { background: '#fff' },
                textSecondary: '#777',
                status: {
                    connected: '#0f0',
                    connecting: '#ff0',
                    disconnected: '#f00',
                    error: '#f00',
                    default: '#777',
                },
            },
        }),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
    useSegments: () => [],
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/components/navigation/Header', () => ({
    Header: ({ headerLeft, headerRight, title }: any) =>
        React.createElement(
            'Header',
            null,
            headerLeft ? headerLeft() : null,
            title ?? null,
            headerRight ? headerRight() : null,
        ),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSocketStatus: () => ({ status: 'connected' }),
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: automationsSupportState.enabled }),
}));

function findPressableByLabel(tree: renderer.ReactTestRenderer, label: string) {
    return tree.root.find((node) => (node.type as unknown) === 'Pressable' && node.props.accessibilityLabel === label);
}

describe('HomeHeader automations button', () => {
    beforeEach(() => {
        routerPushSpy.mockReset();
        automationsSupportState.enabled = true;
    });

    it('shows automations button next to logo and navigates to automations', async () => {
        const { HomeHeader } = await import('./HomeHeader');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<HomeHeader />);
        });

        const button = findPressableByLabel(tree!, 'Open automations');
        await act(async () => {
            button.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/automations');
    });

    it('hides automations button when server reports automations disabled', async () => {
        automationsSupportState.enabled = false;
        const { HomeHeader } = await import('./HomeHeader');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<HomeHeader />);
        });

        expect(() => findPressableByLabel(tree!, 'Open automations')).toThrow();
    });
});
