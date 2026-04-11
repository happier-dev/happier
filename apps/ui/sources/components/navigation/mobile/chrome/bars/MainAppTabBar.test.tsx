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
        };
    },
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 960 },
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
});
