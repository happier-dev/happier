import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { t } from '@/text';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: () => {} }),
}));

vi.mock('@/hooks/inbox/useRequireInboxFriendsEnabled', () => ({
    useRequireInboxFriendsEnabled: () => true,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/track', () => ({
    trackFriendsConnect: () => {},
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: async () => {},
    },
}));

vi.mock('@/components/friends/RequireFriendsIdentityForFriends', () => ({
    RequireFriendsIdentityForFriends: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const hoisted = vi.hoisted(() => {
    const user = {
        id: 'u1',
        timestamp: 0,
        firstName: 'B',
        lastName: null,
        username: 'qa3b8089b',
        avatar: null,
        linkedProviders: [],
        connectedServices: [],
        status: 'none',
    };
    return { user };
});

vi.mock('@/hooks/search/useSearch', () => ({
    useSearch: () => ({
        results: [hoisted.user],
        isSearching: false,
        error: null,
    }),
}));

vi.mock('@/sync/api/social/apiFriends', () => ({
    searchUsersByUsername: async () => [hoisted.user],
    sendFriendRequest: async () => ({ ...hoisted.user, status: 'requested' }),
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: () => null,
}));

vi.mock('react-native', async () => {
    const stub: any = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        FlatList: ({ data, renderItem, ItemSeparatorComponent, keyExtractor }: any) => (
            <>
                {(data ?? []).map((item: any, index: number) => (
                    <React.Fragment key={keyExtractor ? keyExtractor(item, index) : String(item?.id ?? index)}>
                        {renderItem({ item, index })}
                        {ItemSeparatorComponent ? <ItemSeparatorComponent /> : null}
                    </React.Fragment>
                ))}
            </>
        ),
    };
});

function TextStub(props: { children?: React.ReactNode }) {
    return <>{props.children}</>;
}

describe('SearchFriendsScreen', () => {
    it('updates the user row status after sending a friend request', async () => {
        const { default: SearchFriendsScreen } = await import('./search');
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(<SearchFriendsScreen />);
        });

        // Press the "Add Friend" button.
        const buttons = tree!.root.findAll(
            (node) => (node.type as any) === 'TouchableOpacity' && typeof (node.props as any)?.onPress === 'function',
        );
        expect(buttons.length).toBeGreaterThan(0);

        await act(async () => {
            await buttons[0]!.props.onPress();
        });

        // Expect the rendered status to reflect "requested" (sent).
        expect(tree!.root.findAllByProps({ children: t('friends.requestSent') }).length).toBeGreaterThan(0);
    });
});
