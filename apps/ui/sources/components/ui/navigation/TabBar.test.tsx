import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TabBar } from './TabBar';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const friendRequestsState = vi.hoisted(() => ({
    items: [] as Array<{ id: string }>,
}));

const inboxState = vi.hoisted(() => ({
    hasContent: false,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    });
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: '#fff',
                divider: '#ddd',
                text: '#111',
                textSecondary: '#777',
                status: { error: '#f00' },
                button: { primary: { tint: '#fff' } },
            },
        },
    });
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 960 },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/hooks/inbox/useInboxHasContent', () => ({
    useInboxHasContent: () => inboxState.hasContent,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useFriendRequests: (() => friendRequestsState.items) as typeof import('@/sync/domains/state/storage').useFriendRequests,
});
});

vi.mock('@/hooks/server/useFriendsEnabled', () => ({
    useFriendsEnabled: () => true,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

function findTab(tree: renderer.ReactTestRenderer, label: string) {
    return tree.root.find((node) => {
        if (String(node.type) !== 'Pressable') return false;
        return node.findAll((child) => String(child.type) === 'Text' && child.props.children === label).length > 0;
    });
}

function hasTextChild(node: renderer.ReactTestInstance, value: string) {
    return node.findAll((child) => String(child.type) === 'Text' && String(child.props.children) === value).length > 0;
}

function hasIndicatorDot(node: renderer.ReactTestInstance) {
    return node.findAll((child) => {
        if (String(child.type) !== 'View') return false;
        const style = child.props?.style ?? {};
        return style.width === 6 && style.height === 6;
    }).length > 0;
}

describe('TabBar', () => {
    beforeEach(() => {
        friendRequestsState.items = [];
        inboxState.hasContent = false;
    });

    it('shows friend request counts on the friends tab and a dot for inbox content', async () => {
        friendRequestsState.items = [{ id: 'fr-1' }, { id: 'fr-2' }];
        inboxState.hasContent = true;

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<TabBar activeTab="sessions" onTabPress={() => {}} />)).tree;

        const inboxTab = findTab(tree!, 'tabs.inbox');
        const friendsTab = findTab(tree!, 'tabs.friends');

        expect(hasTextChild(inboxTab, '2')).toBe(false);
        expect(hasIndicatorDot(inboxTab)).toBe(true);
        expect(hasTextChild(friendsTab, '2')).toBe(true);
    });
});
