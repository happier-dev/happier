import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Instrumented scroll owner. `mounts` counts how many times a ScrollView was
 * created; `offset` models the scroll position that lives on the instance and is
 * therefore lost whenever the instance is replaced.
 */
const scrollOwner = vi.hoisted(() => ({
    mounts: 0,
    unmounts: 0,
    offset: 0,
}));

const friendRequestStore = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    const state = { items: [] as { id: string; username: string; status: string }[] };
    return {
        state,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        emit: () => {
            for (const listener of listeners) listener();
        },
    };
});

const emptyStorageState = vi.hoisted(() => ({
    settings: { workspacePathDisplayModeV1: 'name' },
    sessions: {},
    sessionMessages: {},
    sessionListRowsByServerId: {},
    ordinarySessionListMembershipByServerId: {},
    sessionListIndexByServerId: {},
    concurrentSessionListCacheByServerId: {},
    isDataReady: true,
}));

installNavigationShellCommonModuleMocks({
    reactNative: async () => {
        const ReactModule = await import('react');
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            ScrollView: ({ children, ...props }: any) => {
                ReactModule.useEffect(() => {
                    scrollOwner.mounts += 1;
                    // A freshly created scroll container always starts at the top.
                    scrollOwner.offset = 0;
                    return () => {
                        scrollOwner.unmounts += 1;
                    };
                }, []);
                return ReactModule.createElement('ScrollView', props, children);
            },
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
            ActivityIndicator: 'ActivityIndicator',
        });
    },
    storage: async () => {
        const ReactModule = await import('react');
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        const storage = Object.assign(
            (selector: (value: typeof emptyStorageState) => unknown) => selector(emptyStorageState),
            { getState: () => emptyStorageState },
        );
        return createStorageModuleStub({
            useArtifacts: () => [],
            useFriendRequests: () => ReactModule.useSyncExternalStore(
                friendRequestStore.subscribe,
                () => friendRequestStore.state.items,
            ),
            useRequestedFriends: () => [],
            useFeedItems: () => [],
            useFeedLoaded: () => true,
            useFriendsLoaded: () => true,
            useAllSessions: () => [],
            useAllSessionsForAttention: () => [],
            useAllSessionListAttentionRows: () => [],
            storage,
            getStorage: () => storage,
        });
    },
});

vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('@/track', () => ({ trackFriendsProfileView: vi.fn() }));
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: any) => React.createElement('ItemGroup', { title }, children),
}));
vi.mock('@/components/ui/lists/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ui/cards/UserCard', () => ({ UserCard: 'UserCard' }));
vi.mock('@/components/account/RecoveryKeyReminderBanner', () => ({
    RecoveryKeyReminderBanner: 'RecoveryKeyReminderBanner',
}));
vi.mock('@/components/navigation/Header', () => ({ Header: 'Header' }));
vi.mock('@/components/inbox/cards/ApprovalInboxCard', () => ({ ApprovalInboxCard: 'ApprovalInboxCard' }));
vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({ isReady: true }),
}));
vi.mock('@/hooks/server/useFriendsEnabled', () => ({ useFriendsEnabled: () => true }));
vi.mock('@/utils/platform/responsive', () => ({ useIsTablet: () => false }));
vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 960 },
    useLayoutMaxWidthStyle: () => ({ maxWidth: 960 }),
    useLayoutMaxWidth: () => 960,
}));

async function setFriendRequests(items: { id: string; username: string; status: string }[]): Promise<void> {
    await act(async () => {
        friendRequestStore.state.items = items;
        friendRequestStore.emit();
    });
}

function countScrollViews(tree: renderer.ReactTestRenderer): number {
    return tree.root.findAll((node) => String(node.type) === 'ScrollView').length;
}

describe('InboxView scroll owner stability', () => {
    beforeEach(() => {
        scrollOwner.mounts = 0;
        scrollOwner.unmounts = 0;
        scrollOwner.offset = 0;
        friendRequestStore.state.items = [{ id: 'friend-1', username: 'friend', status: 'pending' }];
    });

    it('keeps one scroll container across a populated -> caught-up -> populated cycle', async () => {
        const { InboxView } = await import('./InboxView');

        const tree = (await renderScreen(<InboxView />)).tree;
        expect(countScrollViews(tree)).toBe(1);
        expect(scrollOwner.mounts).toBe(1);

        // The user scrolled; that position lives on the scroll container instance.
        scrollOwner.offset = 240;

        await setFriendRequests([]);
        expect(countScrollViews(tree)).toBe(1);

        await setFriendRequests([{ id: 'friend-1', username: 'friend', status: 'pending' }]);

        expect(scrollOwner.mounts).toBe(1);
        expect(scrollOwner.unmounts).toBe(0);
        expect(scrollOwner.offset).toBe(240);
    });

    it('renders the caught-up state as content inside the scroll container', async () => {
        const { InboxView } = await import('./InboxView');

        friendRequestStore.state.items = [];
        const rendered = await renderScreen(<InboxView />);
        const tree = rendered.tree;

        const scrollView = tree.root.find((node) => String(node.type) === 'ScrollView');
        const emptyCopy = scrollView
            .findAll((node) => String(node.type) === 'Text')
            .map((node) => String(node.props.children ?? ''));
        expect(emptyCopy).toContain('inbox.emptyTitle');
        expect(emptyCopy).toContain('inbox.emptyDescription');
    });
});
