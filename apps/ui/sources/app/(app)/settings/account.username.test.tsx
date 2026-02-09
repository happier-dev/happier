import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { createAccountFeaturesResponse, getRequestUrl, isFeaturesRequest, isUsernameRequest } from './account.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
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

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: true,
        credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        logout: vi.fn(),
    }),
}));

vi.mock('@/hooks/server/useInboxFriendsEnabled', () => ({
    useInboxFriendsEnabled: () => true,
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

describe('Settings → Account (username)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('shows a Username item and saves it when friendsAllowUsername is enabled', async () => {
        vi.resetModules();
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });

        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getRequestUrl(input);
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

        const { Modal } = await import('@/modal');
        const promptSpy = vi.spyOn(Modal, 'prompt').mockResolvedValue('alice');

        const { default: AccountScreen } = await import('./account');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<AccountScreen />);
            });
            let items: renderer.ReactTestInstance[] = [];
            for (let attempt = 0; attempt < 5; attempt += 1) {
                await act(async () => {});
                items =
                    tree?.root.findAll(
                        (node) => node.props?.title === 'Username' && typeof node.props?.onPress === 'function',
                    ) ?? [];
                if (items.length > 0) break;
            }
            expect(items.length).toBeGreaterThan(0);
            const firstItem = items[0];
            if (!firstItem || typeof firstItem.props?.onPress !== 'function') {
                throw new Error('Expected Username row onPress handler');
            }

            await act(async () => {
                await firstItem.props.onPress();
            });

            expect(promptSpy).toHaveBeenCalled();
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining('/v1/account/username'),
                expect.objectContaining({ method: 'POST' }),
            );
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
