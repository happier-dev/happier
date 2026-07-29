import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { createAccountFeaturesResponse, getRequestUrl, isFeaturesRequest } from './account.testHelpers';
import { installAccountSettingsRouteModuleMocks } from './accountSettingsRouteTestHelpers';
import { createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';

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
    Ionicons: 'Ionicons',
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
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
                return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: ((key: string) => {
                    if (key === 'useProfiles') return false;
                    return null;
                }) as any,
                useLocalSetting: ((key: string) => {
                    if (key === 'settingsNavSidebarEnabled') return true;
                    if (key === 'settingsNavSidebarWidthPx') return 230;
                    if (key === 'settingsNavSidebarWidthBasisPx') return 1200;
                    if (key === 'uiFontScale') return 1;
                    if (key === 'devModeEnabled') return false;
                    return null;
                }) as any,
                useLocalSettingMutable: ((key: string) => {
                    if (key === 'settingsNavSidebarWidthPx') return [230, vi.fn()];
                    if (key === 'settingsNavSidebarWidthBasisPx') return [1200, vi.fn()];
                    return [null, vi.fn()];
                }) as any,
                useSettingMutable: createUseSettingMutableMockFromReader(() => [false, vi.fn()]),
                useProfile: () => ({
                    id: 'p',
                    timestamp: 0,
                    firstName: null,
                    lastName: null,
                    username: null,
                    avatar: null,
                    linkedProviders: [{
                        id: 'github',
                        login: 'octocat',
                        displayName: 'Octocat',
                        avatarUrl: null,
                        profileUrl: 'https://github.com/octocat',
                        showOnProfile: true,
                    }],
                    connectedServices: [],
                    connectedServicesV2: [
                        {
                            serviceId: 'openai-codex',
                            profiles: [{
                                profileId: 'work',
                                status: 'connected',
                                kind: 'oauth',
                                providerEmail: null,
                                providerAccountId: null,
                                expiresAt: null,
                                lastUsedAt: null,
                            }],
                        },
                        {
                            serviceId: 'anthropic',
                            profiles: [{
                                profileId: 'main',
                                status: 'connected',
                                kind: 'token',
                                providerEmail: null,
                                providerAccountId: null,
                                expiresAt: null,
                                lastUsedAt: null,
                            }],
                        },
                        {
                            serviceId: 'gemini',
                            profiles: [{
                                profileId: 'home',
                                status: 'connected',
                                kind: 'oauth',
                                providerEmail: null,
                                providerAccountId: null,
                                expiresAt: null,
                                lastUsedAt: null,
                            }],
                        },
                    ],
                }) as any,
            },
        });
    },
});

describe('Settings → Account desktop shell', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        standardCleanup();
        windowDimensions = { width: 1440, height: 900 };
    });

    it('renders the account route inside the desktop settings shell without crashing', async () => {
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

        const screen = await renderScreen(
            <SettingsShell>
                <AccountScreen />
            </SettingsShell>,
        );

        expect(screen.findByTestId('settings-sidebar')).toBeTruthy();
        expect(screen.findByTestId('settings-account-secret-key-item')).toBeTruthy();
        const text = screen.getTextContent();
        expect(text).not.toContain('connectedServices.serviceNames.openaiCodex');
        expect(text).not.toContain('connectedServices.serviceNames.anthropic');
        expect(text).not.toContain('connectedServices.serviceNames.gemini');
        expect(text).toContain('settings.connectedServices');
    });
});
