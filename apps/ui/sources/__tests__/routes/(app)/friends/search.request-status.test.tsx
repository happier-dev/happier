import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installRouteRootCommonModuleMocks } from '../../routeRootTestHelpers';


(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installRouteRootCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
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
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: () => {} },
        }).module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: async () => {},
            },
        }).module;
    },
});

vi.mock('@/hooks/friends/useRequireFriendsEnabled', () => ({
    useRequireFriendsEnabled: () => true,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/track', () => ({
    trackFriendsConnect: () => {},
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

describe('SearchFriendsScreen', () => {
    it('updates the user row status after sending a friend request', async () => {
        const { default: SearchFriendsScreen } = await import('@/app/(app)/friends/search');
        const screen = await renderScreen(<SearchFriendsScreen />);

        const addFriendButton = screen.tree.findAllByType('TouchableOpacity')[0];
        expect(addFriendButton).toBeTruthy();
        await pressTestInstanceAsync(addFriendButton, 'friends.addFriend');

        // Expect the rendered status to reflect "requested" (sent).
        expect(screen.getTextContent()).toContain('friends.requestSent');
    });
});
