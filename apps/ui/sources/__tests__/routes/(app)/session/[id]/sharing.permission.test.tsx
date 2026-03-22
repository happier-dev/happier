import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const getSessionSharesSpy = vi.fn(async (..._args: any[]) => []);
const getPublicShareSpy = vi.fn(async (..._args: any[]) => null);
const getFriendsListSpy = vi.fn(async (..._args: any[]) => []);
let sessionHydrated = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            View: 'View',
                                            Text: 'Text',
                                            ActivityIndicator: 'ActivityIndicator',
                                        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: '#eee',
                textSecondary: '#aaa',
            },
        },
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { push: vi.fn() },
        params: { id: 'session-1' },
    });
    return expoRouterMock.module;
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children }: { children?: React.ReactNode }) => React.createElement('Text', null, children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useIsDataReady: () => true,
    useSession: () => ({
        id: 'session-1',
        // Editors should not be allowed to manage sharing.
        accessLevel: 'edit',
    }),
});
});

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: () => sessionHydrated,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        getCredentials: () => ({ token: 'test' }),
    },
}));

vi.mock('@/sync/api/social/apiSharing', () => ({
    getSessionShares: (...args: any[]) => getSessionSharesSpy(...args),
    createSessionShare: vi.fn(),
    updateSessionShare: vi.fn(),
    deleteSessionShare: vi.fn(),
    getPublicShare: (...args: any[]) => getPublicShareSpy(...args),
    createPublicShare: vi.fn(),
    deletePublicShare: vi.fn(),
}));

vi.mock('@/sync/api/social/apiFriends', () => ({
    getFriendsList: (...args: any[]) => getFriendsListSpy(...args),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: () => null,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: () => null,
}));

vi.mock('@/components/sessions/sharing', () => ({
    FriendSelector: () => null,
    PublicLinkDialog: () => null,
    SessionShareDialog: () => null,
}));

describe('Session Sharing Screen permissions', () => {
    it('waits for session hydration before rendering sharing content', async () => {
        sessionHydrated = false;
        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;

        const screen = await renderScreen(<Screen />);

        expect(screen.findByType('ActivityIndicator' as any)).toBeDefined();
        expect(getSessionSharesSpy).not.toHaveBeenCalled();
        expect(getPublicShareSpy).not.toHaveBeenCalled();
        expect(getFriendsListSpy).not.toHaveBeenCalled();
    });

    it('does not attempt to load or manage shares when user is not an admin', async () => {
        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;

        await renderScreen(<Screen />);
        await act(async () => {});

        expect(getSessionSharesSpy).not.toHaveBeenCalled();
        expect(getPublicShareSpy).not.toHaveBeenCalled();
        expect(getFriendsListSpy).not.toHaveBeenCalled();
    });
});
