import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { createAccountFeaturesResponse, getRequestUrl, isFeaturesRequest, isUsernameRequest } from './account.testHelpers';
import {
    getAccountSettingsRouteModalMockRef,
    getAccountSettingsRouteRouterMockRef,
    installAccountSettingsRouteModuleMocks,
} from './accountSettingsRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));
installAccountSettingsRouteModuleMocks();

const routerMockRef = getAccountSettingsRouteRouterMockRef();
const modalMockRef = getAccountSettingsRouteModalMockRef();

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
        logout: vi.fn(),
    }),
}));

vi.mock('@/hooks/auth/useConnectAccount', () => ({
    useConnectAccount: () => ({
        connectAccount: vi.fn(),
        isLoading: false,
    }),
}));

vi.mock('@/hooks/server/useFriendsEnabled', () => ({
    useFriendsEnabled: () => true,
}));

vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({
        isReady: false,
        isLoadingFeatures: false,
        reason: 'needsUsername',
        requiredProviderId: null,
        requiredProviderDisplayName: null,
        requiredProviderConnected: false,
        requiredProviderLogin: null,
        gate: { isReady: false, gateVariant: 'username' },
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/components/account/ProviderIdentityItems', () => ({
    ProviderIdentityItems: () => null,
}));

describe('Settings → Account (username)', () => {
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

    it('shows a Username item and saves it when friendsAllowUsername is enabled', async () => {
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });

        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getRequestUrl(input);
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({}),
                } as unknown as Response;
            }
            if (isFeaturesRequest(url)) {
                return {
                    ok: true,
                    json: async () => createAccountFeaturesResponse(),
                };
            }
            if (isUsernameRequest(url)) {
                return {
                    ok: true,
                    json: async () => ({ username: 'alice' }),
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        await import('@/modal');
        modalMockRef.current.spies.prompt.mockResolvedValue('alice');

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderSettingsView(<AccountScreen />);
        expect(screen.findRowByTitle('profile.username')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('profile.username');
        });

        expect(modalMockRef.current.spies.prompt).toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('/v1/account/username'),
            expect.objectContaining({ method: 'POST' }),
        );
    }, 40_000);
});
