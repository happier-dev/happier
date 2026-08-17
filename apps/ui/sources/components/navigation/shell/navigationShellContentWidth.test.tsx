import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { CONTENT_WIDTH_PX_BY_MODE } from '@/components/ui/layout/contentWidthMode';
import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Instrumented scroll owner: the width preference must reach the scroll
 * container without replacing it, so the user keeps their scroll position.
 */
const scrollOwner = vi.hoisted(() => ({ mounts: 0 }));

/** Reactive stand-in for the persisted `uiContentWidthMode` local setting. */
const contentWidthSetting = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    const state = { mode: 'compact' as 'compact' | 'medium' | 'full' };
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

const storageState = vi.hoisted(() => ({
    sessionMessages: {},
    profile: { id: 'me' },
    localSettings: { uiContentWidthMode: 'compact' as string },
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
            (selector: (value: typeof storageState) => unknown) => selector(storageState),
            { getState: () => storageState },
        );
        return createStorageModuleStub({
            useArtifacts: () => [],
            useAcceptedFriends: () => [],
            useFriendRequests: () => [],
            useRequestedFriends: () => [],
            useFeedItems: () => [],
            useFeedLoaded: () => true,
            useFriendsLoaded: () => true,
            useAllSessions: () => [],
            useAllSessionsForAttention: () => [],
            useAllSessionListAttentionRows: () => [],
            useLocalSetting: ((key: string) => {
                const mode = ReactModule.useSyncExternalStore(
                    contentWidthSetting.subscribe,
                    () => contentWidthSetting.state.mode,
                );
                return key === 'uiContentWidthMode' ? mode : undefined;
            }) as any,
            storage,
            getStorage: () => storage,
        });
    },
});

vi.mock('@/sync/domains/state/storageStore', () => {
    const storage = Object.assign(
        (selector: (value: typeof storageState) => unknown) => selector(storageState),
        { getState: () => storageState },
    );
    return { storage, getStorage: () => storage };
});

vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('@/track', () => ({ trackFriendsProfileView: vi.fn(), trackFriendsSearch: vi.fn() }));
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
vi.mock('@/components/inbox/cards/FeedItemCard', () => ({ FeedItemCard: 'FeedItemCard' }));
vi.mock('@/components/inbox/cards/ApprovalInboxCard', () => ({ ApprovalInboxCard: 'ApprovalInboxCard' }));
vi.mock('@/components/friends/RequireFriendsIdentityForFriends', () => ({
    RequireFriendsIdentityForFriends: ({ children }: any) => children,
}));
vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({ isReady: true }),
}));
vi.mock('@/hooks/server/useFriendsEnabled', () => ({ useFriendsEnabled: () => false }));
vi.mock('@/utils/platform/responsive', () => ({ useIsTablet: () => false }));

function readScrollContentMaxWidth(tree: renderer.ReactTestRenderer): unknown {
    const scrollView = tree.root.find((node) => String(node.type) === 'ScrollView');
    const style = scrollView.props.contentContainerStyle;
    const flattened = Array.isArray(style)
        ? Object.assign({}, ...style.filter(Boolean))
        : (style ?? {});
    return flattened.maxWidth;
}

async function setContentWidthMode(mode: 'compact' | 'medium' | 'full'): Promise<void> {
    await act(async () => {
        contentWidthSetting.state.mode = mode;
        storageState.localSettings.uiContentWidthMode = mode;
        contentWidthSetting.emit();
    });
}

describe('navigation shell surfaces follow the content-width setting', () => {
    beforeEach(() => {
        scrollOwner.mounts = 0;
        contentWidthSetting.state.mode = 'compact';
        storageState.localSettings.uiContentWidthMode = 'compact';
    });

    it('applies a changed content-width preference to the Inbox without remounting the scroll owner', async () => {
        const { InboxView } = await import('./InboxView');

        const tree = (await renderScreen(<InboxView />)).tree;
        expect(readScrollContentMaxWidth(tree)).toBe(CONTENT_WIDTH_PX_BY_MODE.compact);
        expect(scrollOwner.mounts).toBe(1);

        await setContentWidthMode('medium');
        expect(readScrollContentMaxWidth(tree)).toBe(CONTENT_WIDTH_PX_BY_MODE.medium);

        await setContentWidthMode('full');
        expect(readScrollContentMaxWidth(tree)).toBe(Number.POSITIVE_INFINITY);

        // The preference must reach the container in place, not by replacing it.
        expect(scrollOwner.mounts).toBe(1);
    });

    it('applies a changed content-width preference to Friends without remounting the scroll owner', async () => {
        const { FriendsView } = await import('./FriendsView');

        const tree = (await renderScreen(<FriendsView />)).tree;
        expect(readScrollContentMaxWidth(tree)).toBe(CONTENT_WIDTH_PX_BY_MODE.compact);
        expect(scrollOwner.mounts).toBe(1);

        await setContentWidthMode('medium');
        expect(readScrollContentMaxWidth(tree)).toBe(CONTENT_WIDTH_PX_BY_MODE.medium);

        expect(scrollOwner.mounts).toBe(1);
    });
});
