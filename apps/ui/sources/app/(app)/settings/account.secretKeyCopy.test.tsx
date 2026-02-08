import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { storage } from '@/sync/storageStore';
import { profileDefaults } from '@/sync/profile';
import { formatSecretKeyForBackup } from '@/auth/secretKeyBackup';
import { createAccountFeaturesResponse, getRequestUrl, isFeaturesRequest } from './account.testHelpers';

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

vi.mock('@/auth/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: true,
        credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        logout: vi.fn(),
    }),
}));

const clipboardMocks = vi.hoisted(() => ({
    setStringAsync: vi.fn(async () => {}),
}));
vi.mock('expo-clipboard', () => clipboardMocks);

const modalMocks = vi.hoisted(() => ({
    show: vi.fn(),
    alert: vi.fn(),
    prompt: vi.fn(),
    confirm: vi.fn(),
}));
vi.mock('@/modal', () => ({ Modal: modalMocks }));

describe('Settings → Account (secret key copy)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('allows copying the secret key without revealing it', async () => {
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });

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

        clipboardMocks.setStringAsync.mockClear();
        modalMocks.alert.mockClear();

        const { default: AccountScreen } = await import('./account');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<AccountScreen />);
            });
            await act(async () => {});

            const secretKeyItems =
                tree?.root.findAll((n) => n.props?.title === 'Secret Key' && typeof n.props?.onPress === 'function') ?? [];
            expect(secretKeyItems.length).toBeGreaterThan(0);

            const secretKeyItem = secretKeyItems[0]!;
            expect(secretKeyItem.props.rightElement).toBeTruthy();
            expect(typeof secretKeyItem.props.rightElement.props?.onPress).toBe('function');

            await act(async () => {
                await secretKeyItem.props.rightElement.props.onPress();
            });

            const expected = formatSecretKeyForBackup('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
            expect(clipboardMocks.setStringAsync).toHaveBeenCalledWith(expected);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
