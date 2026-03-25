import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderSettingsView } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';

import {
    createAccountFeaturesResponse,
    getRequestUrl,
    isFeaturesRequest,
} from './account.testHelpers';
import {
    installAccountSettingsRouteModuleMocks,
} from './accountSettingsRouteTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

installAccountSettingsRouteModuleMocks();

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

const useAuthMock = vi.hoisted(() => vi.fn());
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => useAuthMock(),
}));

vi.mock('@/auth/oauth/contentKeyBinding', () => ({
    buildContentKeyBinding: async () => null,
}));

vi.mock('@/auth/flows/challenge', () => ({
    authChallenge: () => ({
        challenge: new Uint8Array(32).fill(1),
        signature: new Uint8Array(64).fill(2),
        publicKey: new Uint8Array(32).fill(3),
    }),
}));

function findEncryptionModeSwitch(screen: Awaited<ReturnType<typeof renderSettingsView>>) {
    return screen.findByTestId('settings-account-encryption-mode-switch');
}

function findEncryptionModeSwitches(screen: Awaited<ReturnType<typeof renderSettingsView>>) {
    return screen.findAllByTestId('settings-account-encryption-mode-switch');
}

function createReachabilityProbeResponse(): { ok: true; status: 200; json: () => Promise<{ ok: true }> } {
    return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
    };
}

describe('Settings → Account (encryption mode toggle)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('does not fetch account encryption mode when the feature gate is disabled', async () => {
        useFeatureEnabledMock.mockReturnValue(false);
        useAuthMock.mockReturnValue({
            isAuthenticated: true,
            credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
            logout: vi.fn(),
            login: vi.fn(),
        });
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });

        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getRequestUrl(input);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (url.endsWith('/health') && method === 'GET') {
                return createReachabilityProbeResponse();
            }
            if (url.endsWith('/v1/auth/ping') && method === 'GET') {
                return createReachabilityProbeResponse();
            }
            if (isFeaturesRequest(url)) {
                return {
                    ok: true,
                    json: async () => createAccountFeaturesResponse({ encryptionAccountOptOutEnabled: false }),
                };
            }
            throw new Error(`Unexpected fetch: ${url} (${method})`);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');

        let screen: Awaited<ReturnType<typeof renderSettingsView>> | undefined;
        try {
            screen = await renderSettingsView(<AccountScreen />);
            await act(async () => {});

            expect(findEncryptionModeSwitches(screen)).toHaveLength(0);
        } finally {
            await screen?.unmount();
        }
    });

    it('fetches + updates account encryption mode when enabled', async () => {
        useFeatureEnabledMock.mockReturnValue(true);
        useAuthMock.mockReturnValue({
            isAuthenticated: true,
            credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
            logout: vi.fn(),
            login: vi.fn(),
        });
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });
        storage.getState().replaceSettings({ analyticsOptOut: false } as any, 7);

        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getRequestUrl(input);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (url.endsWith('/health') && method === 'GET') {
                return createReachabilityProbeResponse();
            }
            if (url.endsWith('/v1/auth/ping') && method === 'GET') {
                return createReachabilityProbeResponse();
            }
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
            if (url.endsWith('/v1/account/encryption/migrate') && method === 'POST') {
                const body = init?.body ? JSON.parse(String(init.body)) : null;
                expect(body).toEqual(expect.objectContaining({
                    toMode: 'plain',
                    expectedSettingsVersion: 7,
                    settingsContent: expect.objectContaining({ t: 'plain' }),
                    connectedServices: { action: 'assert_empty' },
                    automations: { action: 'assert_empty' },
                }));
                return {
                    ok: true,
                    json: async () => ({ success: true, mode: 'plain', settingsVersion: 8 }),
                };
            }
            throw new Error(`Unexpected fetch: ${url} (${method})`);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');

        let screen: Awaited<ReturnType<typeof renderSettingsView>> | undefined;
        try {
            screen = await renderSettingsView(<AccountScreen />);
            await act(async () => {});

            const encryptionSwitch = findEncryptionModeSwitch(screen);
            expect(encryptionSwitch).toBeTruthy();

            await act(async () => {
                await encryptionSwitch?.props.onValueChange(false);
            });

            const seen = fetchMock.mock.calls.map((call) => [getRequestUrl(call[0]), (call[1]?.method ?? 'GET').toUpperCase()]);
            expect(seen).toEqual(
                expect.arrayContaining([
                    [expect.stringContaining('/v1/account/encryption'), 'GET'],
                    [expect.stringContaining('/v1/account/encryption/migrate'), 'POST'],
                ]),
            );
        } finally {
            await screen?.unmount();
        }
    });

    it('shows an error alert when updating account encryption mode fails', async () => {
        useFeatureEnabledMock.mockReturnValue(true);
        useAuthMock.mockReturnValue({
            isAuthenticated: true,
            credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
            logout: vi.fn(),
            login: vi.fn(),
        });
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });
        storage.getState().replaceSettings({ analyticsOptOut: false } as any, 7);

        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getRequestUrl(input);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (url.endsWith('/health') && method === 'GET') {
                return createReachabilityProbeResponse();
            }
            if (url.endsWith('/v1/auth/ping') && method === 'GET') {
                return createReachabilityProbeResponse();
            }
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
            if (url.endsWith('/v1/account/encryption/migrate') && method === 'POST') {
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
        const alertSpy = vi.spyOn(Modal, 'alertAsync').mockResolvedValue();

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');

        let screen: Awaited<ReturnType<typeof renderSettingsView>> | undefined;
        try {
            screen = await renderSettingsView(<AccountScreen />);
            await act(async () => {});

            const encryptionSwitch = findEncryptionModeSwitch(screen);
            expect(encryptionSwitch).toBeTruthy();

            await act(async () => {
                await encryptionSwitch?.props.onValueChange(false);
            });

            expect(alertSpy).toHaveBeenCalledWith(
                expect.any(String),
                expect.stringContaining('Encryption opt-out is not enabled on this server'),
            );
        } finally {
            await screen?.unmount();
        }
    });

    it('enables e2ee on keyless credentials by generating a secret and migrating', async () => {
        useFeatureEnabledMock.mockReturnValue(true);
        const loginSpy = vi.fn(async () => {});
        useAuthMock.mockReturnValue({
            isAuthenticated: true,
            credentials: { token: 't', encryption: { publicKey: 'pk', machineKey: Buffer.from(new Uint8Array(32).fill(4)).toString('base64') } },
            logout: vi.fn(),
            login: loginSpy,
        });
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });
        storage.getState().replaceSettings({ analyticsOptOut: false } as any, 7);

        const { Modal } = await import('@/modal');
        const alertSpy = vi.spyOn(Modal, 'alertAsync').mockResolvedValue();

        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getRequestUrl(input);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (url.endsWith('/health') && method === 'GET') {
                return createReachabilityProbeResponse();
            }
            if (url.endsWith('/v1/auth/ping') && method === 'GET') {
                return createReachabilityProbeResponse();
            }
            if (isFeaturesRequest(url)) {
                return {
                    ok: true,
                    json: async () => createAccountFeaturesResponse({ encryptionAccountOptOutEnabled: true }),
                };
            }
            if (url.endsWith('/v1/account/encryption') && method === 'GET') {
                return {
                    ok: true,
                    json: async () => ({ mode: 'plain', updatedAt: 1 }),
                };
            }
            if (url.endsWith('/v1/account/encryption/migrate') && method === 'POST') {
                const body = init?.body ? JSON.parse(String(init.body)) : null;
                expect(body).toEqual(expect.objectContaining({
                    toMode: 'e2ee',
                    expectedSettingsVersion: 7,
                    settingsContent: expect.objectContaining({ t: 'encrypted' }),
                    connectedServices: { action: 'assert_empty' },
                    automations: { action: 'assert_empty' },
                    keyProof: expect.objectContaining({
                        publicKey: expect.any(String),
                        challenge: expect.any(String),
                        signature: expect.any(String),
                    }),
                }));
                return {
                    ok: true,
                    json: async () => ({ success: true, mode: 'e2ee', settingsVersion: 8 }),
                };
            }
            throw new Error(`Unexpected fetch: ${url} (${method})`);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');

        let screen: Awaited<ReturnType<typeof renderSettingsView>> | undefined;
        try {
            screen = await renderSettingsView(<AccountScreen />);
            await act(async () => {});

            const encryptionSwitch = findEncryptionModeSwitch(screen);
            expect(encryptionSwitch).toBeTruthy();

            await act(async () => {
                await encryptionSwitch?.props.onValueChange(true);
            });

            expect(loginSpy).toHaveBeenCalledWith('t', expect.any(String));
            expect(alertSpy).toHaveBeenCalled();
        } finally {
            await screen?.unmount();
        }
    });

    it('shows a restore-required message when enabling e2ee fails with invalid params on keyless credentials', async () => {
        useFeatureEnabledMock.mockReturnValue(true);
        const loginSpy = vi.fn(async () => {});
        useAuthMock.mockReturnValue({
            isAuthenticated: true,
            credentials: { token: 't', encryption: { publicKey: 'pk', machineKey: Buffer.from(new Uint8Array(32).fill(4)).toString('base64') } },
            logout: vi.fn(),
            login: loginSpy,
        });
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });
        storage.getState().replaceSettings({ analyticsOptOut: false } as any, 7);

        const { Modal } = await import('@/modal');
        const alertSpy = vi.spyOn(Modal, 'alertAsync').mockResolvedValue();

        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getRequestUrl(input);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (url.endsWith('/health') && method === 'GET') {
                return createReachabilityProbeResponse();
            }
            if (url.endsWith('/v1/auth/ping') && method === 'GET') {
                return createReachabilityProbeResponse();
            }
            if (isFeaturesRequest(url)) {
                return {
                    ok: true,
                    json: async () => createAccountFeaturesResponse({ encryptionAccountOptOutEnabled: true }),
                };
            }
            if (url.endsWith('/v1/account/encryption') && method === 'GET') {
                return {
                    ok: true,
                    json: async () => ({ mode: 'plain', updatedAt: 1 }),
                };
            }
            if (url.endsWith('/v1/account/encryption/migrate') && method === 'POST') {
                return {
                    ok: false,
                    status: 400,
                    json: async () => ({ error: 'invalid-params', reason: 'restore_required' }),
                };
            }
            throw new Error(`Unexpected fetch: ${url} (${method})`);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');

        let screen: Awaited<ReturnType<typeof renderSettingsView>> | undefined;
        try {
            screen = await renderSettingsView(<AccountScreen />);
            await act(async () => {});

            const encryptionSwitch = findEncryptionModeSwitch(screen);
            expect(encryptionSwitch).toBeTruthy();

            await act(async () => {
                await encryptionSwitch?.props.onValueChange(true);
            });

            expect(loginSpy).not.toHaveBeenCalled();
            expect(alertSpy).toHaveBeenCalledWith(
                'settingsAccount.restoreRequiredTitle',
                'settingsAccount.restoreRequiredBody',
                expect.arrayContaining([
                    expect.objectContaining({ text: 'navigation.restoreWithSecretKey' }),
                    expect.objectContaining({ text: 'connect.lostAccessConfirmButton' }),
                ]),
            );
        } finally {
            await screen?.unmount();
        }
    });
});
