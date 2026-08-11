import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const getSessionSharesSpy = vi.fn(async (..._args: any[]) => []);
const getPublicShareSpy = vi.fn(async (..._args: any[]) => null);
const getFriendsListSpy = vi.fn(async (..._args: any[]) => []);
let routeHydrationState: 'available' | 'loading' | 'missing' = 'available';
let mockServerId: string | undefined;
const hydrateSpy = vi.fn((sessionId: string, _tag: string, options?: { serverId?: string }) =>
    routeHydrationState === 'available'
        ? { kind: 'available', sessionId, serverId: options?.serverId }
        : routeHydrationState === 'missing'
            ? { kind: 'missing', sessionId, serverId: options?.serverId, cause: 'not_found' }
            : { kind: 'loading', sessionId, serverId: options?.serverId, reason: 'cold' },
);

installSessionRouteCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            params: {
                id: 'session-1',
                serverId: mockServerId,
            },
        });
        return {
            ...routerMock.module,
            useLocalSearchParams: () => ({ id: 'session-1', serverId: mockServerId }),
        };
    },
    storageModule: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useIsDataReady: () => true,
            useSession: () => ({
                id: 'session-1',
                // Editors should not be allowed to manage sharing.
                accessLevel: 'edit',
            }),
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children }: { children?: React.ReactNode }) => React.createElement('Text', null, children),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, tag: string, options?: { serverId?: string }) =>
        hydrateSpy(sessionId, tag, options),
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

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback', { testID: 'session-invalid-link' }),
}));

describe('Session Sharing Screen permissions', () => {
    it('waits for session hydration before rendering sharing content', async () => {
        routeHydrationState = 'loading';
        mockServerId = 'server-b';
        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;

        const screen = await renderScreen(<Screen />);

        expect(screen.findByProps({ accessibilityRole: 'progressbar' })).toBeDefined();
        expect(getSessionSharesSpy).not.toHaveBeenCalled();
        expect(getPublicShareSpy).not.toHaveBeenCalled();
        expect(getFriendsListSpy).not.toHaveBeenCalled();
        expect(hydrateSpy).toHaveBeenCalledWith('session-1', 'SessionSharingRoute.ensureSessionVisible', { serverId: 'server-b' });
    });

    it('renders the unavailable fallback when route hydration resolves missing', async () => {
        routeHydrationState = 'missing';
        mockServerId = 'server-b';
        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;

        const screen = await renderScreen(<Screen />);

        expect(screen.findByTestId('session-invalid-link')).toBeTruthy();
        expect(getSessionSharesSpy).not.toHaveBeenCalled();
        expect(getPublicShareSpy).not.toHaveBeenCalled();
        expect(getFriendsListSpy).not.toHaveBeenCalled();
    });

    it('does not attempt to load or manage shares when user is not an admin', async () => {
        routeHydrationState = 'available';
        mockServerId = undefined;
        hydrateSpy.mockClear();
        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;

        await renderScreen(<Screen />);
        await act(async () => {});

        expect(getSessionSharesSpy).not.toHaveBeenCalled();
        expect(getPublicShareSpy).not.toHaveBeenCalled();
        expect(getFriendsListSpy).not.toHaveBeenCalled();
    });
});
