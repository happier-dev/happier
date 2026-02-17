import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        View: 'View',
        Text: 'Text',
        ScrollView: 'ScrollView',
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        ActivityIndicator: 'ActivityIndicator',
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                groupped: { background: '#fff' },
                text: '#111',
                textSecondary: '#666',
                header: { tint: '#111' },
                divider: '#ddd',
            },
        },
    }),
    StyleSheet: {
        create: (factory: any) => factory({
            colors: {
                groupped: { background: '#fff' },
                text: '#111',
                textSecondary: '#666',
                header: { tint: '#111' },
                divider: '#ddd',
            },
        }),
    },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/track', () => ({
    trackFriendsSearch: vi.fn(),
    trackFriendsProfileView: vi.fn(),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useAcceptedFriends: () => [],
    useFriendRequests: () => [],
    useRequestedFriends: () => [],
    useFeedItems: () => [],
    useFeedLoaded: () => true,
    useFriendsLoaded: () => true,
    useAllSessions: () => [],
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    storage: (selector: (state: { profile: { id: string } }) => unknown) => selector({ profile: { id: 'me' } }),
}));

vi.mock('@/components/ui/cards/UserCard', () => ({
    UserCard: 'UserCard',
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: 'Item',
}));

vi.mock('@/components/ui/feedback/UpdateBanner', () => ({
    UpdateBanner: 'UpdateBanner',
}));

vi.mock('@/components/account/RecoveryKeyReminderBanner', () => ({
    RecoveryKeyReminderBanner: 'RecoveryKeyReminderBanner',
}));

vi.mock('@/components/navigation/Header', () => ({
    Header: 'Header',
}));

vi.mock('@/components/inbox/cards/FeedItemCard', () => ({
    FeedItemCard: 'FeedItemCard',
}));

vi.mock('@/components/voice/surface/VoiceSurface', () => ({
    VoiceSurface: 'VoiceSurface',
}));

vi.mock('@/components/friends/RequireFriendsIdentityForFriends', () => ({
    RequireFriendsIdentityForFriends: ({ children }: any) => React.createElement('RequireFriendsIdentityForFriends', null, children),
}));

vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({ isReady: true }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => true,
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: {
        maxWidth: 960,
    },
}));

describe('InboxView voice placement', () => {
    it('does not render VoiceSurface in inbox content on tablet', async () => {
        const { InboxView } = await import('./InboxView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<InboxView />);
        });

        expect(tree!.root.findAllByType('VoiceSurface')).toHaveLength(0);
    });
});
