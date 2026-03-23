import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { formatSecretKeyForBackup } from '@/auth/recovery/secretKeyBackup';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { createAccountFeaturesResponse, getRequestUrl, isFeaturesRequest } from './account.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { push: vi.fn(), back: vi.fn() },
    });
    return routerMock.module;
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
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: modalMocks,
    }).module;
});

describe('Settings → Account (secret key copy)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        standardCleanup();
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

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderScreen(<AccountScreen />);
        const secretKeyItem = screen.findByTestId('settings-account-secret-key-item');
        const copyButton = screen.findByTestId('settings-account-secret-key-copy');

        expect(secretKeyItem).toBeTruthy();
        expect(copyButton).toBeTruthy();

        await act(async () => {
            await copyButton!.props.onPress();
        });

        const expected = formatSecretKeyForBackup('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
        expect(clipboardMocks.setStringAsync).toHaveBeenCalledWith(expected);
    });
});
