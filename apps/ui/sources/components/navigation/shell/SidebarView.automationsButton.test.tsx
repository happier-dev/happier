import React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());

const automationsSupportState = vi.hoisted(() => ({
    enabled: true,
}));

const friendRequestsState = vi.hoisted(() => ({
    items: [] as Array<{ id: string }>,
}));

const inboxState = vi.hoisted(() => ({
    hasContent: false,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: vi.fn(),
            confirm: vi.fn(),
            prompt: vi.fn(),
        },
    }).module;
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            Platform: {
                                                OS: 'ios',
                                            },
                                            View: 'View',
                                            Text: 'Text',
                                            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                                            useWindowDimensions: () => ({ width: 1200, height: 800 }),
                                        }
    );
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            dark: false,
            colors: {
                header: { tint: '#111' },
                groupped: { background: '#fff' },
                divider: '#ddd',
                surface: '#fff',
                shadow: { color: '#000' },
                text: '#111',
                textSecondary: '#777',
                fab: { background: '#000' },
                status: { error: '#f00' },
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { push: routerPushSpy },
    });
    return routerMock.module;
});

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 56,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        useSocketStatus: () => ({ status: 'connected', lastError: null }),
        useFriendRequests: () => friendRequestsState.items,
        useSetting: () => false,
        useSyncError: () => null,
        useRealtimeStatus: () => 'disconnected',
    });
});

vi.mock('@/hooks/inbox/useInboxHasContent', () => ({
    useInboxHasContent: () => inboxState.hasContent,
}));

vi.mock('@/hooks/server/useFriendsEnabled', () => ({
    useFriendsEnabled: () => true,
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: automationsSupportState.enabled }),
}));

const featureEnabledState: Record<string, boolean> = {
    voice: false,
    'inbox.global': true,
    'actions.approvals': false,
};

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledState[featureId] === true,
}));

vi.mock('@/sync/runtime/appVariant', () => ({
    resolveVisibleAppEnvironmentBadge: () => null,
}));

vi.mock('@/config', () => ({
    config: { variant: 'prod' },
}));

vi.mock('@/sync/domains/server/serverContext', () => ({
    isStackContext: () => false,
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    isUsingCustomServer: () => false,
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/components/ui/buttons/FABWide', () => ({
    FABWide: (props: any) => React.createElement('FABWide', props),
}));

vi.mock('@/components/voice/surface/VoiceSurface', () => ({
    VoiceSurface: 'VoiceSurface',
}));

vi.mock('@/components/ui/popover', () => ({
    PopoverBoundaryProvider: ({ children }: any) => React.createElement('PopoverBoundaryProvider', null, children),
}));

vi.mock('@/components/navigation/ConnectionStatusControl', () => ({
    ConnectionStatusControl: 'ConnectionStatusControl',
}));

vi.mock('./MainView', () => ({
    MainView: 'MainView',
}));

function hasIndicatorDot(node: ReactTestInstance) {
    return node.findAll((child: ReactTestInstance) => {
        if (String(child.type) !== 'View') return false;
        const style = child.props?.style ?? {};
        return style.width === 6 && style.height === 6;
    }).length > 0;
}

function flattenStyle(style: unknown) {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, item) => {
            if (item && typeof item === 'object') {
                Object.assign(acc, item as Record<string, unknown>);
            }
            return acc;
        }, {});
    }
    return style ?? {};
}

describe('SidebarView header automations button', () => {
    beforeEach(() => {
        routerPushSpy.mockReset();
        automationsSupportState.enabled = true;
        featureEnabledState.voice = false;
        friendRequestsState.items = [];
        inboxState.hasContent = false;
    });

    it('navigates to home when logo is pressed', async () => {
        const { SidebarView } = await import('./SidebarView');

        const screen = await renderScreen(<SidebarView />);
        const button = screen.findByProps({ accessibilityLabel: 'common.home' });
        await act(async () => {
            await pressTestInstanceAsync(button);
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/');
    });

    it('does not render automations button in header', async () => {
        const { SidebarView } = await import('./SidebarView');
        const screen = await renderScreen(<SidebarView />);

        expect(() => screen.findByProps({ accessibilityLabel: 'automations.openA11y' })).toThrow();
    });

    it('does not render the wide FAB button in the sidebar', async () => {
        const { SidebarView } = await import('./SidebarView');
        const screen = await renderScreen(<SidebarView />);

        expect(screen.findAllByType('FABWide')).toHaveLength(0);
    });

    it('does not render VoiceSurface when voice is disabled', async () => {
        const { SidebarView } = await import('./SidebarView');
        const screen = await renderScreen(<SidebarView />);

        expect(screen.findAllByType('VoiceSurface')).toHaveLength(0);
    });

    it('renders VoiceSurface when voice is enabled', async () => {
        featureEnabledState.voice = true;
        const { SidebarView } = await import('./SidebarView');
        const screen = await renderScreen(<SidebarView />);

        expect(screen.findAllByType('VoiceSurface')).toHaveLength(1);
    });

    it('shows friend request counts on the friends button and only a dot on inbox', async () => {
        friendRequestsState.items = [{ id: 'fr-1' }, { id: 'fr-2' }];
        inboxState.hasContent = true;
        const { SidebarView } = await import('./SidebarView');
        const screen = await renderScreen(<SidebarView />);

        const inboxButton = screen.findByTestId('sidebar-inbox-button');
        const friendsButton = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', '2');

        expect(inboxButton).toBeTruthy();
        expect(friendsButton).toBeTruthy();
        expect(findTestInstanceByTypeContainingText(inboxButton!, 'Text', '2')).toBeUndefined();
        expect(hasIndicatorDot(inboxButton!)).toBe(true);
        expect(findTestInstanceByTypeContainingText(friendsButton!, 'Text', '2')).toBeTruthy();
    });

    it('constrains the server status row to the shrinking title column before the header icons', async () => {
        const { SidebarView } = await import('./SidebarView');

        const screen = await renderScreen(<SidebarView />);
        const control = screen.findByType('ConnectionStatusControl' as any);
        expect(control.props.variant).toBe('sidebar');

        const wrapper = control.parent;
        expect(flattenStyle(wrapper?.props.style)).toMatchObject({
            alignSelf: 'stretch',
            flexShrink: 1,
            maxWidth: '100%',
            minWidth: 0,
        });
    });
});
