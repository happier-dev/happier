import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let windowDimensions: { width: number; height: number } = { width: 1200, height: 800 };
const { routerMockRef, modalMockRef } = vi.hoisted(() => ({
    routerMockRef: { current: null as any },
    modalMockRef: { current: null as any },
}));

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                View: 'View',
                                Pressable: 'Pressable',
                                Dimensions: {
                                    get: () => ({ width: windowDimensions.width, height: windowDimensions.height, scale: 2, fontScale: 1 }),
                                },
                                useWindowDimensions: () => ({ width: windowDimensions.width, height: windowDimensions.height, scale: 2, fontScale: 1 }),
                            }
    );
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock();
    routerMockRef.current = routerMock;
    return routerMock.module;
});

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

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const modalMock = createModalModuleMock();
    modalMockRef.current = modalMock;
    return modalMock.module;
});

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

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSettingMutable: () => [false, vi.fn()],
            useProfile: () => ({
                id: 'p',
                timestamp: 0,
                firstName: null,
                lastName: null,
                username: null,
                avatar: null,
                linkedProviders: [],
                connectedServices: [],
                connectedServicesV2: [],
            }),
        },
    });
});

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
        routerMockRef.current?.spies.push.mockReset();
        routerMockRef.current?.spies.back.mockReset();
        routerMockRef.current?.spies.replace.mockReset();
        routerMockRef.current?.spies.setParams.mockReset();
        modalMockRef.current = null;
        standardCleanup();
    });

    it('shows one stable add-phone entry and routes to the phone-link flow on desktop web', async () => {
        windowDimensions = { width: 1200, height: 800 };
        vi.resetModules();
        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderScreen(<AccountScreen />);
        expect(screen.findByTestId('settings-account-add-your-phone')).toBeTruthy();

        screen.pressByTestId('settings-account-add-your-phone');

        expect(routerMockRef.current.spies.push).toHaveBeenCalledWith('/settings/add-phone');
    });

    it('hides "Add your phone" on phone-sized web', async () => {
        windowDimensions = { width: 360, height: 800 };
        vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' } as any);
        vi.resetModules();

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderScreen(<AccountScreen />);
        expect(screen.findByTestId('settings-account-add-your-phone')).toBeNull();
    });

    it('shows "Add your phone" on desktop-sized web even when the viewport is narrow', async () => {
        windowDimensions = { width: 480, height: 700 };
        vi.stubGlobal('navigator', { maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } as any);
        vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) } as any);
        vi.resetModules();

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderScreen(<AccountScreen />);
        expect(screen.findByTestId('settings-account-add-your-phone')).toBeTruthy();
    });
});
