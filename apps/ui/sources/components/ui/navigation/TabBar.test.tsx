import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TabBar } from './TabBar';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const friendRequestsState = vi.hoisted(() => ({
    items: [] as Array<{ id: string }>,
}));

const inboxState = vi.hoisted(() => ({
    hasContent: false,
}));

vi.mock('react-native', () => ({
    View: 'View',
    Platform: { OS: 'web' },
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
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
    }),
    StyleSheet: {
        create: (input: any) => {
            const theme = {
                colors: {
                    surface: '#fff',
                    divider: '#ddd',
                    text: '#111',
                    textSecondary: '#777',
                    status: { error: '#f00' },
                    button: { primary: { tint: '#fff' } },
                },
            };
            return typeof input === 'function' ? input(theme) : input;
        },
    },
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

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

vi.mock('@/sync/domains/state/storage', () => ({
    useFriendRequests: () => friendRequestsState.items,
}));

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
        await act(async () => {
            tree = renderer.create(
                <TabBar activeTab="sessions" onTabPress={() => {}} />,
            );
        });

        const inboxTab = findTab(tree!, 'tabs.inbox');
        const friendsTab = findTab(tree!, 'tabs.friends');

        expect(hasTextChild(inboxTab, '2')).toBe(false);
        expect(hasIndicatorDot(inboxTab)).toBe(true);
        expect(hasTextChild(friendsTab, '2')).toBe(true);
    });
});
