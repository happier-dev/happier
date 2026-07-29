import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { createAccountFeaturesResponse, getRequestUrl, isFeaturesRequest } from './account.testHelpers';
import { installAccountSettingsRouteModuleMocks } from './accountSettingsRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let windowDimensions: { width: number; height: number } = { width: 1440, height: 900 };


vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Pressable: 'Pressable',
        PanResponder: {
            create: () => ({ panHandlers: {} }),
        },
        useWindowDimensions: () => ({
            width: windowDimensions.width,
            height: windowDimensions.height,
            scale: 2,
            fontScale: 1,
        }),
        Dimensions: {
            get: () => ({
                width: windowDimensions.width,
                height: windowDimensions.height,
                scale: 2,
                fontScale: 1,
            }),
        },
        Platform: {
            OS: 'web',
            select: (options: any) => (options && 'default' in options ? options.default : undefined),
        },
    });
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: true,
        credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        logout: vi.fn(),
        refreshFromActiveServer: vi.fn(async () => {}),
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

vi.mock('@/sync/domains/state/storageStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/state/storageStore')>();
    return {
        ...actual,
        storage: () => vi.fn(),
    };
});

vi.mock('@/sync/domains/profiles/profile', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/profiles/profile')>();
    return {
        ...actual,
        getDisplayName: () => null,
    };
});

vi.mock('@/hooks/server/useFriendsEnabled', () => ({
    useFriendsEnabled: () => false,
}));

vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({ isLoadingFeatures: false, gate: { gateVariant: 'disabled' } }),
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('expo-camera', () => ({
    useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
    CameraView: {
        isModernBarcodeScannerAvailable: false,
        onModernBarcodeScanned: () => ({ remove: () => {} }),
        launchScanner: () => {},
        dismissScanner: async () => {},
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: undefined,
}));

installAccountSettingsRouteModuleMocks({
    routerModule: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: () => '/settings/account',
            router: {
                push: vi.fn(),
                back: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
});

describe('Settings → Account (vector icons missing)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        standardCleanup();
        windowDimensions = { width: 1440, height: 900 };
    });

    it('does not crash when @expo/vector-icons exports Ionicons as undefined', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = getRequestUrl(input);
            if (isFeaturesRequest(url)) {
                return {
                    ok: true,
                    json: async () => createAccountFeaturesResponse(),
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { SettingsShell } = await import('@/components/settings/shell/SettingsShell');
        const { default: AccountScreen } = await import('@/app/(app)/settings/account');

        const renderPromise = renderScreen(
            <SettingsShell>
                <AccountScreen />
            </SettingsShell>,
        );

        await expect(renderPromise).resolves.toBeTruthy();
    });
});
