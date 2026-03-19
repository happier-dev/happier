import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const getSessionSharesSpy = vi.fn(async (..._args: any[]) => []);
const getPublicShareSpy = vi.fn(async (..._args: any[]) => null);
const getFriendsListSpy = vi.fn(async (..._args: any[]) => []);
let sessionHydrated = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#eee',
                textSecondary: '#aaa',
            },
        },
    }),
}));

vi.mock('expo-router', () => ({
    Stack: {
        Screen: () => null,
    },
    useLocalSearchParams: () => ({ id: 'session-1' }),
    useRouter: () => ({ push: vi.fn() }),
}));

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

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useIsDataReady: () => true,
    useSession: () => ({
        id: 'session-1',
        // Editors should not be allowed to manage sharing.
        accessLevel: 'edit',
    }),
}));

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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });

        expect(tree!.root.findByType('ActivityIndicator' as any)).toBeDefined();
        expect(getSessionSharesSpy).not.toHaveBeenCalled();
        expect(getPublicShareSpy).not.toHaveBeenCalled();
        expect(getFriendsListSpy).not.toHaveBeenCalled();
    });

    it('does not attempt to load or manage shares when user is not an admin', async () => {
        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;

        await act(async () => {
            renderer.create(<Screen />);
        });
        await act(async () => {});

        expect(getSessionSharesSpy).not.toHaveBeenCalled();
        expect(getPublicShareSpy).not.toHaveBeenCalled();
        expect(getFriendsListSpy).not.toHaveBeenCalled();
    });
});
