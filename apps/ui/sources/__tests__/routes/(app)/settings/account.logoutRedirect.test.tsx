import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';

import { createAccountFeaturesResponse, getRequestUrl, isFeaturesRequest } from './account.testHelpers';
import {
    getAccountSettingsRouteModalMockRef,
    getAccountSettingsRouteRouterMockRef,
    installAccountSettingsRouteModuleMocks,
} from './accountSettingsRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;


const logoutMock = vi.hoisted(() => vi.fn(async () => {}));

installAccountSettingsRouteModuleMocks({
    modalModule: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            confirmResult: true,
        }).module;
    },
});

vi.mock('expo-camera', () => ({
    useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
    CameraView: {
        isModernBarcodeScannerAvailable: false,
        onModernBarcodeScanned: () => ({ remove: () => {} }),
        launchScanner: () => {},
        dismissScanner: async () => {},
    },
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: true,
        credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        logout: logoutMock,
    }),
}));

vi.mock('@/hooks/auth/useConnectAccount', () => ({
    useConnectAccount: () => ({
        connectAccount: vi.fn(),
        isLoading: false,
    }),
}));

vi.mock('@/hooks/server/useFriendsEnabled', () => ({
    useFriendsEnabled: () => false,
}));

vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({
        isReady: true,
        isLoadingFeatures: false,
        reason: null,
        requiredProviderId: null,
        requiredProviderDisplayName: null,
        requiredProviderConnected: false,
        requiredProviderLogin: null,
        gate: { isReady: true, gateVariant: 'none' },
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/components/account/ProviderIdentityItems', () => ({
    ProviderIdentityItems: () => null,
}));

const routerMockRef = getAccountSettingsRouteRouterMockRef();
const modalMockRef = getAccountSettingsRouteModalMockRef();

describe('Settings → Account logout redirect', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        logoutMock.mockClear();
        routerMockRef.current?.spies.push.mockReset();
        routerMockRef.current?.spies.back.mockReset();
        routerMockRef.current?.spies.replace.mockReset();
        routerMockRef.current?.spies.setParams.mockReset();
        modalMockRef.current = null;
        standardCleanup();
    });

    it('routes to the unauthenticated welcome screen before tearing down auth state', async () => {
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });
        let resolveLogout!: () => void;
        logoutMock.mockImplementationOnce(async () => new Promise<void>((resolve) => {
            resolveLogout = resolve;
        }));

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

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderSettingsView(<AccountScreen />);

        const logoutRow = screen.findRowByTitle('settingsAccount.logout');
        expect(logoutRow?.props.testID).toBe('settings-account-logout');

        let pendingLogoutPress: Promise<void> | undefined;
        await act(async () => {
            pendingLogoutPress = logoutRow?.props.onPress?.();
            await Promise.resolve();
        });

        expect(routerMockRef.current.spies.replace).toHaveBeenCalledWith('/');
        expect(logoutMock).toHaveBeenCalledTimes(1);

        resolveLogout();
        await act(async () => {
            await pendingLogoutPress;
        });
    });
});
