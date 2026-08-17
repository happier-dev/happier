import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const friendRequestsState = vi.hoisted(() => ({
    items: [] as Array<{ id: string }>,
}));

const inboxState = vi.hoisted(() => ({
    hasContent: false,
}));

const sessionsAttentionState = vi.hoisted(() => ({
    hasAttention: false,
}));
const expoImageState = vi.hoisted(() => ({
    image: 'Image' as unknown,
}));

const badgeSettingsState = vi.hoisted(() => ({
    friends: true,
    inbox: true,
    sessions: true,
    showLabels: true,
}));

installNavigationCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        });
    },
    storage: async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
        return {
            ...actual,
            useFriendRequests: (() => friendRequestsState.items) as typeof import('@/sync/domains/state/storage').useFriendRequests,
            useSetting: ((key: string) => {
                if (key === 'tabBarFriendsBadgeEnabled') return badgeSettingsState.friends;
                if (key === 'tabBarInboxBadgeEnabled') return badgeSettingsState.inbox;
                if (key === 'tabBarSessionsBadgeEnabled') return badgeSettingsState.sessions;
                if (key === 'tabBarShowLabels') return badgeSettingsState.showLabels;
                if (key === 'tabBarSize') return 'regular';
                return undefined;
            }) as typeof import('@/sync/domains/state/storage').useSetting,
        };
    },
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('expo-image', () => ({
    get Image() {
        return expoImageState.image;
    },
}));

vi.mock('expo-blur', () => ({
    BlurView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('BlurView', props, children),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 960 },
    useLayoutMaxWidth: () => 960,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 960 }),
}));

vi.mock('@/hooks/inbox/useInboxHasContent', () => ({
    useInboxHasContent: () => inboxState.hasContent,
}));

vi.mock('@/hooks/session/useSessionsHaveAttention', () => ({
    useSessionsHaveAttention: () => sessionsAttentionState.hasAttention,
}));

vi.mock('@/hooks/server/useFriendsEnabled', () => ({
    useFriendsEnabled: () => true,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

function hasTextChild(node: renderer.ReactTestInstance, value: string) {
    return node.findAllByType('Text' as never).some((child) => String(child.props.children) === value);
}

function hasIndicatorDot(node: renderer.ReactTestInstance) {
    return node.findAll((child) => {
        if (String(child.type) !== 'View') return false;
        const style = child.props?.style ?? {};
        return style.width === 6 && style.height === 6;
    }).length > 0;
}

describe('MainAppTabBar', () => {
    beforeEach(() => {
        friendRequestsState.items = [];
        inboxState.hasContent = false;
        sessionsAttentionState.hasAttention = false;
        expoImageState.image = 'Image';
        badgeSettingsState.friends = true;
        badgeSettingsState.inbox = true;
        badgeSettingsState.sessions = true;
        badgeSettingsState.showLabels = true;
        vi.resetModules();
    });

    it('exposes localized tab semantics and selected state when visual labels are hidden', async () => {
        badgeSettingsState.showLabels = false;
        friendRequestsState.items = [{ id: 'fr-1' }, { id: 'fr-2' }];
        inboxState.hasContent = true;
        sessionsAttentionState.hasAttention = true;
        const { MainAppTabBar } = await import('./MainAppTabBar');

        const screen = await renderScreen(
            <MainAppTabBar activeTab="sessions" onTabPress={() => {}} />,
        );

        expect(screen.tree.findAll((node) => node.props.accessibilityRole === 'tablist')).toHaveLength(1);

        const expectedTabs = [
            ['settings', 'tabs.settings', false],
            ['friends', 'tabs.friends', false],
            ['projects', 'tabs.projects', false],
            ['sessions', 'tabs.sessions', true],
            ['inbox', 'tabs.inbox', false],
        ] as const;

        for (const [id, label, selected] of expectedTabs) {
            const tab = screen.findByTestId(`tabbar-tab-${id}`);
            expect(tab?.props.accessibilityRole).toBe('tab');
            expect(tab?.props.accessibilityLabel).toBe(label);
            expect(tab?.props.accessibilityState).toEqual({ selected });
            expect(tab?.props['aria-selected']).toBe(selected);
            expect(tab && hasTextChild(tab, label)).toBe(false);
        }
    });

    it('supplements RNW tab activation for Space without double-handling Enter or pointer presses', async () => {
        const onTabPress = vi.fn();
        const { MainAppTabBar } = await import('./MainAppTabBar');
        const screen = await renderScreen(
            <MainAppTabBar activeTab="sessions" onTabPress={onTabPress} />,
        );
        const projectsTab = screen.findByTestId('tabbar-tab-projects');
        const preventDefault = vi.fn();

        expect(projectsTab?.props.onKeyDown).toEqual(expect.any(Function));
        projectsTab?.props.onKeyDown({
            key: ' ',
            nativeEvent: { key: ' ' },
            preventDefault,
        });
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(onTabPress).toHaveBeenCalledOnce();
        expect(onTabPress).toHaveBeenLastCalledWith('projects');

        projectsTab?.props.onKeyDown({
            key: 'Enter',
            nativeEvent: { key: 'Enter' },
            preventDefault,
        });
        expect(onTabPress).toHaveBeenCalledOnce();

        projectsTab?.props.onPress();
        expect(onTabPress).toHaveBeenCalledTimes(2);
        expect(onTabPress).toHaveBeenLastCalledWith('projects');

        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        (Platform as { OS: string }).OS = 'ios';
        try {
            const nativeScreen = await renderScreen(
                <MainAppTabBar activeTab="sessions" onTabPress={onTabPress} />,
            );
            expect(nativeScreen.findByTestId('tabbar-tab-projects')?.props.onKeyDown).toBeUndefined();
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });

    it('hides tab badges when disabled in settings', async () => {
        friendRequestsState.items = [{ id: 'fr-1' }, { id: 'fr-2' }];
        inboxState.hasContent = true;
        sessionsAttentionState.hasAttention = true;
        badgeSettingsState.friends = false;
        badgeSettingsState.inbox = false;
        badgeSettingsState.sessions = false;
        const { MainAppTabBar } = await import('./MainAppTabBar');

        const tree = (await renderScreen(<MainAppTabBar activeTab="sessions" onTabPress={() => {}} />)).tree;

        const tabs = tree.findAll((node) => typeof node.props?.onPress === 'function');
        const allTextNodes = tree.findAllByType('Text' as never);
        expect(tabs.some((tab) => hasIndicatorDot(tab))).toBe(false);
        expect(allTextNodes.some((node) => String(node.props.children) === '2')).toBe(false);
    });

    it('renders tabs in settings, friends, projects, sessions, inbox order', async () => {
        const { MainAppTabBar } = await import('./MainAppTabBar');

        const tree = (await renderScreen(<MainAppTabBar activeTab="sessions" onTabPress={() => {}} />)).tree;

        const tabIds = Array.from(new Set(
            tree.findAll((node) => typeof node.props?.testID === 'string' && node.props.testID.startsWith('tabbar-tab-'))
                .map((node) => String(node.props.testID).replace('tabbar-tab-', '')),
        ));

        expect(tabIds).toEqual(['settings', 'friends', 'projects', 'sessions', 'inbox']);
    });

    it('shows friend request counts on the friends tab and a dot for inbox content', async () => {
        friendRequestsState.items = [{ id: 'fr-1' }, { id: 'fr-2' }];
        inboxState.hasContent = true;
        const { MainAppTabBar } = await import('./MainAppTabBar');

        const tree = (await renderScreen(<MainAppTabBar activeTab="sessions" onTabPress={() => {}} />)).tree;

        const tabs = tree.findAll((node) => typeof node.props?.onPress === 'function');
        const inboxTab = tabs.find((tab) => hasIndicatorDot(tab));
        const allTextNodes = tree.findAllByType('Text' as never);

        expect(inboxTab).toBeTruthy();
        expect(allTextNodes.some((node) => String(node.props.children) === '2')).toBe(true);
        expect(hasIndicatorDot(inboxTab!)).toBe(true);
        expect(hasTextChild(inboxTab!, '2')).toBe(false);
    });

    it('shows a dot on the sessions tab when sessions need attention', async () => {
        sessionsAttentionState.hasAttention = true;
        const { MainAppTabBar } = await import('./MainAppTabBar');

        const tree = (await renderScreen(<MainAppTabBar activeTab="inbox" onTabPress={() => {}} />)).tree;

        const sessionsTab = tree
            .findAll((node) => typeof node.props?.testID === 'string' && node.props.testID === 'tabbar-tab-sessions')[0];

        expect(sessionsTab).toBeTruthy();
        expect(hasIndicatorDot(sessionsTab!)).toBe(true);
    });

    it('renders without crashing when expo-image omits Image', async () => {
        expoImageState.image = undefined;
        const { MainAppTabBar } = await import('./MainAppTabBar');

        await expect(
            renderScreen(<MainAppTabBar activeTab="sessions" onTabPress={() => {}} />),
        ).resolves.toBeTruthy();
    });
});
