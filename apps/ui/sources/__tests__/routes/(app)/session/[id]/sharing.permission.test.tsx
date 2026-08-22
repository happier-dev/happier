import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const getSessionSharesSpy = vi.fn(async (..._args: any[]) => []);
const getPublicShareSpy = vi.fn(async (..._args: any[]) => null);
const getFriendsListSpy = vi.fn(async (..._args: any[]) => []);
let routeHydrationState: SessionRouteHydrationState = { kind: 'available', sessionId: 'session-1' };
let isDataReady = true;
let accessLevel: 'admin' | 'edit' | null = 'edit';

installSessionRouteCommonModuleMocks({
    storageModule: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useIsDataReady: () => isDataReady,
            useSession: () => ({
                id: 'session-1',
                // Editors should not be allowed to manage sharing.
                accessLevel,
            }),
        });
    },
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

vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({
    ActivitySpinner: (props: Record<string, unknown>) => React.createElement('ActivitySpinner', props),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => ({
        ...routeHydrationState,
        sessionId,
    }),
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

vi.mock('@/sync/api/social/createSessionSocialRequest', () => ({
    getSessionFriendsList: (...args: any[]) => getFriendsListSpy(...args),
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

vi.mock('expo-crypto', () => ({
    getRandomBytes: () => new Uint8Array(12),
}));

describe('Session Sharing Screen permissions', () => {
    beforeEach(() => {
        routeHydrationState = { kind: 'available', sessionId: 'session-1' };
        isDataReady = true;
        accessLevel = 'edit';
        getSessionSharesSpy.mockClear();
        getPublicShareSpy.mockClear();
        getFriendsListSpy.mockClear();
    });

    it('waits for session hydration before rendering sharing content', async () => {
        routeHydrationState = { kind: 'loading', sessionId: 'session-1', reason: 'store-miss' };
        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;

        const screen = await renderScreen(<Screen />);

        expect(screen.findByType('ActivitySpinner' as any)).toBeDefined();
        expect(getSessionSharesSpy).not.toHaveBeenCalled();
        expect(getPublicShareSpy).not.toHaveBeenCalled();
        expect(getFriendsListSpy).not.toHaveBeenCalled();
    });

    it('waits for route hydration while retrying before rendering sharing content', async () => {
        routeHydrationState = { kind: 'retrying', sessionId: 'session-1', cause: 'server_unavailable' };
        accessLevel = 'admin';
        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;

        const screen = await renderScreen(<Screen />);

        expect(screen.findByType('ActivitySpinner' as any)).toBeDefined();
        expect(getSessionSharesSpy).not.toHaveBeenCalled();
        expect(getPublicShareSpy).not.toHaveBeenCalled();
        expect(getFriendsListSpy).not.toHaveBeenCalled();
    });

    it('renders terminal fallback when route hydration is missing', async () => {
        routeHydrationState = { kind: 'missing', sessionId: 'session-1', cause: 'not_found' };
        accessLevel = 'admin';
        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;

        const screen = await renderScreen(<Screen />);

        expect(screen.findByProps({ testID: 'session-invalid-link' })).toBeDefined();
        expect(getSessionSharesSpy).not.toHaveBeenCalled();
        expect(getPublicShareSpy).not.toHaveBeenCalled();
        expect(getFriendsListSpy).not.toHaveBeenCalled();
    });

    it('renders sharing content after route hydration is available when global data is not ready', async () => {
        isDataReady = false;
        accessLevel = 'admin';
        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;

        await renderScreen(<Screen />);
        await act(async () => {});

        expect(getSessionSharesSpy).toHaveBeenCalled();
        expect(getPublicShareSpy).toHaveBeenCalled();
        expect(getFriendsListSpy).toHaveBeenCalledWith(expect.any(Object), 'session-1');
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
