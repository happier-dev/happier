import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let windowDimensions: { width: number; height: number } = { width: 1200, height: 800 };

vi.mock('react-native-reanimated', () => ({}));

installSessionSettingsEntryModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            Dimensions: {
                get: () => ({ width: windowDimensions.width, height: windowDimensions.height, scale: 2, fontScale: 1 }),
            },
            useWindowDimensions: () => ({
                width: windowDimensions.width,
                height: windowDimensions.height,
                scale: 2,
                fontScale: 1,
            }),
        });
    },
    storageModule: async (importOriginal) => {
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
    },
});

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
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

describe('Settings → Account (grouping)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        resetSessionSettingsEntryState();
        standardCleanup();
    });

    it('shows one stable add-phone entry and routes to the phone-link flow on desktop web', async () => {
        windowDimensions = { width: 1200, height: 800 };
        vi.resetModules();
        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderScreen(<AccountScreen />);
        expect(screen.findByTestId('settings-account-add-your-phone')).toBeTruthy();

        screen.pressByTestId('settings-account-add-your-phone');

        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/settings/add-phone');
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
