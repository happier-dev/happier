import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
let windowDimensions: { width: number; height: number } = { width: 1200, height: 800 };

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    Dimensions: {
        get: () => ({ width: windowDimensions.width, height: windowDimensions.height, scale: 2, fontScale: 1 }),
    },
    useWindowDimensions: () => ({ width: windowDimensions.width, height: windowDimensions.height, scale: 2, fontScale: 1 }),
    Platform: {
        OS: 'web',
        select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
    },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy, back: vi.fn() }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: 'Switch',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                accent: { blue: 'blue', orange: 'orange' },
                textSecondary: '#666',
                surface: '#fff',
                text: '#000',
                switch: {
                    track: { inactive: '#999', active: '#0a0' },
                    thumb: { inactive: '#fff', active: '#fff' },
                },
            },
        },
    }),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(async () => {}),
        confirm: vi.fn(async () => false),
        prompt: vi.fn(async () => null),
    },
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: true,
        credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        logout: vi.fn(),
    }),
}));

vi.mock('@/hooks/auth/useConnectAccount', () => ({
    useConnectAccount: () => ({ connectAccount: vi.fn(), isLoading: false }),
}));

vi.mock('@/sync/sync', () => ({
    sync: { anonID: 'anon', serverID: 'server' },
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: () => [false, vi.fn()],
    useProfile: () => ({
        id: 'p',
        firstName: null,
        lastName: null,
        username: null,
        avatar: null,
        linkedProviders: [],
        connectedServices: [],
    }),
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    storage: () => vi.fn(),
}));

vi.mock('@/sync/domains/profiles/profile', () => ({
    getDisplayName: () => null,
}));

vi.mock('@/hooks/server/useFriendsEnabled', () => ({
    useFriendsEnabled: () => false,
}));

vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({ isLoadingFeatures: false, gate: { gateVariant: 'disabled' } }),
}));

vi.mock('@/components/account/ProviderIdentityItems', () => ({
    ProviderIdentityItems: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

describe('Settings → Account (grouping)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('renders "Add your phone" outside the Account Information group', async () => {
        windowDimensions = { width: 1200, height: 800 };
        vi.resetModules();
        const { default: AccountScreen } = await import('@/app/(app)/settings/account');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<AccountScreen />);
            });

            const groups = tree?.root.findAllByType('ItemGroup') ?? [];
            const infoGroup = groups.find((g) => g.props?.title === 'settingsAccount.accountInformation');
            expect(infoGroup).toBeTruthy();

            const addPhoneInInfo =
                infoGroup?.findAll(
                    (n) => (n.type as unknown) === 'Item' && n.props?.testID === 'settings-account-add-your-phone',
                ) ?? [];
            expect(addPhoneInInfo).toHaveLength(0);

            const allAddPhoneItems =
                tree?.root.findAll(
                    (n) => (n.type as unknown) === 'Item' && n.props?.testID === 'settings-account-add-your-phone',
                ) ?? [];
            expect(allAddPhoneItems).toHaveLength(1);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('hides "Add your phone" on phone-sized web', async () => {
        windowDimensions = { width: 360, height: 800 };
        vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' } as any);
        vi.resetModules();

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<AccountScreen />);
            });

            const allAddPhoneItems =
                tree?.root.findAll(
                    (n) => (n.type as unknown) === 'Item' && n.props?.testID === 'settings-account-add-your-phone',
                ) ?? [];
            expect(allAddPhoneItems).toHaveLength(0);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('shows "Add your phone" on desktop-sized web even when the viewport is narrow', async () => {
        windowDimensions = { width: 480, height: 700 };
        vi.stubGlobal('navigator', { maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } as any);
        vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) } as any);
        vi.resetModules();

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<AccountScreen />);
            });

            const allAddPhoneItems =
                tree?.root.findAll(
                    (n) => (n.type as unknown) === 'Item' && n.props?.testID === 'settings-account-add-your-phone',
                ) ?? [];
            expect(allAddPhoneItems).toHaveLength(1);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
