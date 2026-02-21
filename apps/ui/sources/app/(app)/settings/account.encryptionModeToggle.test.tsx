import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';

import {
    createAccountFeaturesResponse,
    getRequestUrl,
    isFeaturesRequest,
} from './account.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

const useFeatureEnabledMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => useFeatureEnabledMock(featureId),
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

describe('Settings → Account (encryption mode toggle)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('does not fetch account encryption mode when the feature gate is disabled', async () => {
        useFeatureEnabledMock.mockReturnValue(false);
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });

        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getRequestUrl(input);
            if (isFeaturesRequest(url)) {
                return {
                    ok: true,
                    json: async () => createAccountFeaturesResponse({ encryptionAccountOptOutEnabled: false }),
                };
            }
            throw new Error(`Unexpected fetch: ${url} (${init?.method ?? 'GET'})`);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { default: AccountScreen } = await import('./account');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<AccountScreen />);
            });
            await act(async () => {});

            const encryptionItems =
                tree?.root.findAll(
                    (node) =>
                        node?.props?.rightElement?.props?.testID === 'settings-account-encryption-mode-switch' &&
                        typeof node?.props?.rightElement?.props?.onValueChange === 'function',
                ) ?? [];
            expect(encryptionItems).toHaveLength(0);
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('fetches + updates account encryption mode when enabled', async () => {
        useFeatureEnabledMock.mockReturnValue(true);
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });

        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getRequestUrl(input);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (isFeaturesRequest(url)) {
                return {
                    ok: true,
                    json: async () => createAccountFeaturesResponse({ encryptionAccountOptOutEnabled: true }),
                };
            }
            if (url.endsWith('/v1/account/encryption') && method === 'GET') {
                return {
                    ok: true,
                    json: async () => ({ mode: 'e2ee', updatedAt: 1 }),
                };
            }
            if (url.endsWith('/v1/account/encryption') && method === 'PATCH') {
                const body = init?.body ? JSON.parse(String(init.body)) : null;
                expect(body).toEqual({ mode: 'plain' });
                return {
                    ok: true,
                    json: async () => ({ mode: 'plain', updatedAt: 2 }),
                };
            }
            throw new Error(`Unexpected fetch: ${url} (${method})`);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { default: AccountScreen } = await import('./account');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<AccountScreen />);
            });
            await act(async () => {});

            const encryptionItems =
                tree?.root.findAll(
                    (node) =>
                        node?.props?.rightElement?.props?.testID === 'settings-account-encryption-mode-switch' &&
                        typeof node?.props?.rightElement?.props?.onValueChange === 'function',
                ) ?? [];
            expect(encryptionItems).toHaveLength(1);

            await act(async () => {
                encryptionItems[0]!.props.rightElement.props.onValueChange(false);
            });

            const seen = fetchMock.mock.calls.map((call) => [getRequestUrl(call[0]), (call[1]?.method ?? 'GET').toUpperCase()]);
            expect(seen).toEqual(
                expect.arrayContaining([
                    [expect.stringContaining('/v1/account/encryption'), 'GET'],
                    [expect.stringContaining('/v1/account/encryption'), 'PATCH'],
                ]),
            );
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('shows an error alert when updating account encryption mode fails', async () => {
        useFeatureEnabledMock.mockReturnValue(true);
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });

        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getRequestUrl(input);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (isFeaturesRequest(url)) {
                return {
                    ok: true,
                    json: async () => createAccountFeaturesResponse({ encryptionAccountOptOutEnabled: true }),
                };
            }
            if (url.endsWith('/v1/account/encryption') && method === 'GET') {
                return {
                    ok: true,
                    json: async () => ({ mode: 'e2ee', updatedAt: 1 }),
                };
            }
            if (url.endsWith('/v1/account/encryption') && method === 'PATCH') {
                return {
                    ok: false,
                    status: 404,
                    json: async () => ({ error: 'not-found' }),
                };
            }
            throw new Error(`Unexpected fetch: ${url} (${method})`);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { Modal } = await import('@/modal');
        const alertSpy = vi.spyOn(Modal, 'alert').mockResolvedValue();

        const { default: AccountScreen } = await import('./account');

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<AccountScreen />);
            });
            await act(async () => {});

            const encryptionItems =
                tree?.root.findAll(
                    (node) =>
                        node?.props?.rightElement?.props?.testID === 'settings-account-encryption-mode-switch' &&
                        typeof node?.props?.rightElement?.props?.onValueChange === 'function',
                ) ?? [];
            expect(encryptionItems).toHaveLength(1);

            await act(async () => {
                await encryptionItems[0]!.props.rightElement.props.onValueChange(false);
            });

            expect(alertSpy).toHaveBeenCalledWith(
                expect.any(String),
                expect.stringContaining('Encryption opt-out is not enabled on this server'),
            );
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
