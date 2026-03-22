import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, findTestInstanceByTypeContainingText, renderScreen } from '@/dev/testkit';
import { t } from '@/text';


(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { push: () => {} },
    });
    return routerMock.module;
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

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: async () => {},
        },
    }).module;
});

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
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
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
                }
    );
});

function TextStub(props: { children?: React.ReactNode }) {
    return <>{props.children}</>;
}

describe('SearchFriendsScreen', () => {
    it('updates the user row status after sending a friend request', async () => {
        const { default: SearchFriendsScreen } = await import('@/app/(app)/friends/search');
        const screen = await renderScreen(<SearchFriendsScreen />);

        const addFriendButton = findTestInstanceByTypeContainingText(screen.tree, 'TouchableOpacity', t('friends.addFriend'));
        expect(addFriendButton).toBeTruthy();
        await pressTestInstanceAsync(addFriendButton, t('friends.addFriend'));

        // Expect the rendered status to reflect "requested" (sent).
        expect(screen.getTextContent()).toContain(t('friends.requestSent'));
    });
});
