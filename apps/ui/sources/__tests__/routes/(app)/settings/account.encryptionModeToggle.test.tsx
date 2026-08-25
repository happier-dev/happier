import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderSettingsView } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import {
    AccountEncryptionMigrateRequestSchema,
    computeAccountEncryptionMigrateKeyFingerprintV1,
    createAccountEncryptionMigrateRequestBindingDigestV1,
    sealSessionOwnerMetadataEnvelopeV1,
} from '@happier-dev/protocol';
import {
    invalidateAccountEncryptionModeCache,
} from '@/sync/api/account/apiAccountEncryptionMode';
import type {
    AccountEncryptionMigrationSessionRow,
} from '@/sync/ops/account/buildAccountEncryptionMigrationStorageDirectives';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import {
    resumeAccountEncryptionFirstKeyExternalAuth,
} from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';

import {
    createAccountFeaturesResponse,
    getRequestUrl,
    isFeaturesRequest,
} from './account.testHelpers';
import {
    installAccountSettingsRouteModuleMocks,
} from './accountSettingsRouteTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;


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

const fetchAccountEncryptionCurrentnessMock =
    vi.hoisted(() => vi.fn());
vi.mock(
    '@/sync/api/account/apiAccountEncryptionMode',
    async (importOriginal) => {
        const actual = await importOriginal<
            typeof import('@/sync/api/account/apiAccountEncryptionMode')
        >();
        return {
            ...actual,
            fetchAccountEncryptionCurrentness:
                fetchAccountEncryptionCurrentnessMock,
        };
    },
);

vi.mock('@/sync/sync', () => ({
    sync: {
        encryption: {
            decryptAutomationTemplateRaw: vi.fn(async () => null),
        },
        reconfigureSessionDraftRepositoryForAccountMode: vi.fn(),
    },
}));

vi.mock('@/sync/engine/machines/syncMachines', () => ({
    fetchMachineRows: vi.fn(async () => []),
}));

vi.mock('@/sync/api/account/apiKv', () => ({
    kvList: vi.fn(async () => ({ items: [], nextCursor: null })),
}));

vi.mock('@/sync/api/artifacts/apiArtifacts', () => ({
    fetchArtifacts: vi.fn(async () => []),
    fetchArtifact: vi.fn(),
}));

const fetchSessionInventoryMock =
    vi.hoisted(() => vi.fn<
        () => Promise<readonly AccountEncryptionMigrationSessionRow[]>
    >(async () => []));
vi.mock(
    '@/sync/ops/account/fetchAccountEncryptionMigrationSessionInventory',
    () => ({
        fetchAccountEncryptionMigrationSessionInventory:
            fetchSessionInventoryMock,
    }),
);
const fetchReviewCommentInventoryMock =
    vi.hoisted(() => vi.fn(async () => ({
        v: 1 as const,
        items: [],
    })));
vi.mock(
    '@/sync/domains/reviews/comments/accountEncryptionMigrationApi',
    () => ({
        fetchReviewCommentAccountEncryptionMigrationInventory:
            fetchReviewCommentInventoryMock,
    }),
);
const fetchSessionOrganizationInventoryMock =
    vi.hoisted(() => vi.fn(async () => ({
        version: 0,
        folders: [],
        tags: [],
        labels: [],
    })));
vi.mock(
    '@/sync/ops/account/fetchSessionOrganizationAccountEncryptionMigrationInventory',
    () => ({
        fetchSessionOrganizationAccountEncryptionMigrationInventory:
            fetchSessionOrganizationInventoryMock,
    }),
);

const buildContentKeyBindingMock = vi.hoisted(() => vi.fn(async () => ({
    contentPublicKey: Buffer.from(
        new Uint8Array(32).fill(4),
    ).toString('base64'),
    contentPublicKeySig: 'content-public-key-signature',
})));
vi.mock('@/auth/oauth/contentKeyBinding', () => ({
    buildContentKeyBinding: buildContentKeyBindingMock,
}));

vi.mock('@/auth/flows/challenge', () => ({
    deriveAccountSigningPublicKey: () =>
        new Uint8Array(32).fill(3),
    signAccountPayload: () => new Uint8Array(64).fill(2),
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

const PINNED_SIGNING_KEY_FINGERPRINT =
    computeAccountEncryptionMigrateKeyFingerprintV1(
        new Uint8Array(32).fill(3),
    );
const PINNED_CONTENT_KEY_FINGERPRINT =
    computeAccountEncryptionMigrateKeyFingerprintV1(
        new Uint8Array(32).fill(4),
    );
const PINNED_CONTENT_PUBLIC_KEY = Buffer.from(
    new Uint8Array(32).fill(4),
).toString('base64');

describe('Settings → Account (encryption mode toggle)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        invalidateAccountEncryptionModeCache();
        fetchAccountEncryptionCurrentnessMock.mockReset();
        buildContentKeyBindingMock.mockReset();
        buildContentKeyBindingMock.mockResolvedValue({
            contentPublicKey: PINNED_CONTENT_PUBLIC_KEY,
            contentPublicKeySig: 'content-public-key-signature',
        });
        fetchSessionInventoryMock.mockReset();
        fetchSessionInventoryMock.mockResolvedValue([]);
        fetchReviewCommentInventoryMock.mockReset();
        fetchReviewCommentInventoryMock.mockResolvedValue({
            v: 1,
            items: [],
        });
        fetchSessionOrganizationInventoryMock.mockReset();
        fetchSessionOrganizationInventoryMock.mockResolvedValue({
            version: 0,
            folders: [],
            tags: [],
            labels: [],
        });
    });

    it('does not fetch account encryption mode when the feature gate is disabled', async () => {
        useFeatureEnabledMock.mockReturnValue(false);
        useAuthMock.mockReturnValue({
            isAuthenticated: true,
            credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
            logout: vi.fn(),
            login: vi.fn(),
        });
        storage.getState().applyProfile({
            ...profileDefaults,
            id: 'account-1',
            linkedProviders: [],
            username: null,
        });

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

    it('replaces retained Account E2EE credentials before exposing an authoritative plaintext mode on mount', async () => {
        useFeatureEnabledMock.mockReturnValue(true);
        const loginWithCredentials = vi.fn(async () => ({
            kind: 'completed' as const,
        }));
        useAuthMock.mockReturnValue({
            isAuthenticated: true,
            credentials: {
                token: 't',
                encryption: {
                    publicKey: 'public-key',
                    machineKey: 'machine-key',
                },
            },
            logout: vi.fn(),
            login: vi.fn(),
            loginWithCredentials,
        });
        storage.getState().applyProfile({
            ...profileDefaults,
            id: 'account-1',
            linkedProviders: [],
            username: null,
        });

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
            throw new Error(`Unexpected fetch: ${url} (${method})`);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');

        let screen: Awaited<ReturnType<typeof renderSettingsView>> | undefined;
        try {
            screen = await renderSettingsView(<AccountScreen />);
            await vi.waitFor(() => {
                expect(loginWithCredentials).toHaveBeenCalledWith({
                    token: 't',
                });
            });
            expect(findEncryptionModeSwitch(screen)?.props.value).toBe(false);
        } finally {
            await screen?.unmount();
        }
    });

    it('fails visibly without exposing plaintext mode when custody blocks mount-time credential replacement', async () => {
        useFeatureEnabledMock.mockReturnValue(true);
        const loginWithCredentials = vi.fn(async () => ({
            kind: 'recovery_failed' as const,
        }));
        useAuthMock.mockReturnValue({
            isAuthenticated: true,
            credentials: {
                token: 't',
                secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            },
            logout: vi.fn(),
            login: vi.fn(),
            loginWithCredentials,
        });
        storage.getState().applyProfile({
            ...profileDefaults,
            id: 'account-1',
            linkedProviders: [],
            username: null,
        });

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
            throw new Error(`Unexpected fetch: ${url} (${method})`);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { Modal } = await import('@/modal');
        const alertSpy = vi.spyOn(Modal, 'alertAsync').mockResolvedValue();
        const { default: AccountScreen } = await import('@/app/(app)/settings/account');

        let screen: Awaited<ReturnType<typeof renderSettingsView>> | undefined;
        try {
            screen = await renderSettingsView(<AccountScreen />);
            await vi.waitFor(() => {
                expect(alertSpy).toHaveBeenCalledWith(
                    'common.error',
                    'settingsAccount.encryptionUpdateFailed',
                );
            });
            const encryptionSwitch = findEncryptionModeSwitch(screen);
            expect(encryptionSwitch?.props.disabled).toBe(true);
            expect(encryptionSwitch?.props.value).toBe(true);
        } finally {
            await screen?.unmount();
        }
    });

    it('replaces E2EE credentials with token-only credentials after disabling encryption', async () => {
        fetchAccountEncryptionCurrentnessMock.mockResolvedValue({
            mode: 'e2ee',
            version: 4,
            signingKeyFingerprint: 'aemk1_signing',
            contentKeyFingerprint: 'aemk1_content',
            updatedAt: 1,
        });
        useFeatureEnabledMock.mockReturnValue(true);
        const loginWithCredentials = vi.fn(async () => ({
            kind: 'completed' as const,
        }));
        useAuthMock.mockReturnValue({
            isAuthenticated: true,
            credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
            logout: vi.fn(),
            login: vi.fn(),
            loginWithCredentials,
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
            if (url.endsWith('/v1/account/encryption/currentness') && method === 'GET') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        mode: 'e2ee',
                        version: 4,
                        signingKeyFingerprint: 'aemk1_signing',
                        contentKeyFingerprint: 'aemk1_content',
                        updatedAt: 1,
                    }),
                };
            }
            if (url.endsWith('/v1/account/encryption/migrate') && method === 'POST') {
                const body = init?.body ? JSON.parse(String(init.body)) : null;
                expect(body).toEqual(expect.objectContaining({
                    toMode: 'plain',
                    expectedAccountVersion: 4,
                    expectedSigningKeyFingerprint: 'aemk1_signing',
                    expectedContentKeyFingerprint: 'aemk1_content',
                    expectedSettingsVersion: 7,
                    settingsContent: expect.objectContaining({ t: 'plain' }),
                    connectedServices: { action: 'assert_empty' },
                    automations: { action: 'assert_empty' },
                }));
                expect(body.sessions).toEqual({
                    action: 'assert_empty',
                });
                return {
                    ok: true,
                    json: async () => ({
                        success: true,
                        mode: 'plain',
                        accountVersion: 5,
                        settingsVersion: 8,
                    }),
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
            expect(seen).toContainEqual([expect.stringContaining('/v1/account/encryption'), 'GET']);
            expect(seen).toContainEqual([expect.stringContaining('/v1/account/encryption/migrate'), 'POST']);
            expect(fetchSessionInventoryMock).toHaveBeenCalledWith({
                token: 't',
            });
            expect(loginWithCredentials).toHaveBeenCalledTimes(1);
            expect(loginWithCredentials).toHaveBeenCalledWith({
                token: 't',
            });
        } finally {
            await screen?.unmount();
        }
    });

    it('converges retained E2EE credentials on retry after the server migration committed but the first credential replacement failed', async () => {
        fetchAccountEncryptionCurrentnessMock
            .mockResolvedValueOnce({
                mode: 'e2ee',
                version: 4,
                signingKeyFingerprint: 'aemk1_signing',
                contentKeyFingerprint: 'aemk1_content',
                updatedAt: 1,
            })
            .mockResolvedValueOnce({
                mode: 'plain',
                version: 5,
                signingKeyFingerprint: null,
                contentKeyFingerprint: null,
                updatedAt: 2,
            });
        useFeatureEnabledMock.mockReturnValue(true);
        const loginWithCredentials = vi.fn()
            .mockRejectedValueOnce(
                new Error('credential storage unavailable'),
            )
            .mockResolvedValueOnce({ kind: 'completed' as const });
        useAuthMock.mockReturnValue({
            isAuthenticated: true,
            credentials: {
                token: 't',
                secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            },
            logout: vi.fn(),
            login: vi.fn(),
            loginWithCredentials,
        });
        storage.getState().applyProfile({
            ...profileDefaults,
            id: 'account-1',
            linkedProviders: [],
            username: null,
        });
        storage.getState().replaceSettings(
            { analyticsOptOut: false } as any,
            7,
        );

        let accountMode: 'e2ee' | 'plain' = 'e2ee';
        let migrationRequests = 0;
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
                    json: async () => ({ mode: accountMode, updatedAt: 1 }),
                };
            }
            if (url.endsWith('/v1/account/encryption/migrate') && method === 'POST') {
                migrationRequests += 1;
                accountMode = 'plain';
                return {
                    ok: true,
                    json: async () => ({
                        success: true,
                        mode: 'plain',
                        accountVersion: 5,
                        settingsVersion: 8,
                    }),
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
            await vi.waitFor(() => {
                expect(findEncryptionModeSwitch(screen!)?.props.disabled).toBe(false);
            });

            await act(async () => {
                await findEncryptionModeSwitch(screen!)?.props.onValueChange(false);
            });
            expect(loginWithCredentials).toHaveBeenCalledTimes(1);
            expect(alertSpy).toHaveBeenCalledTimes(1);
            expect(migrationRequests).toBe(1);

            await act(async () => {
                await findEncryptionModeSwitch(screen!)?.props.onValueChange(false);
            });

            expect(loginWithCredentials).toHaveBeenCalledTimes(2);
            expect(loginWithCredentials).toHaveBeenLastCalledWith({
                token: 't',
            });
            expect(migrationRequests).toBe(1);
            expect(findEncryptionModeSwitch(screen)?.props.value).toBe(false);
            expect(alertSpy).toHaveBeenCalledTimes(1);
        } finally {
            await screen?.unmount();
        }
    });

    it('aborts before POST when Session owner material is unavailable', async () => {
        fetchAccountEncryptionCurrentnessMock.mockResolvedValue({
            mode: 'e2ee',
            version: 4,
            signingKeyFingerprint: 'aemk1_signing',
            contentKeyFingerprint: 'aemk1_content',
            updatedAt: 1,
        });
        useFeatureEnabledMock.mockReturnValue(true);
        useAuthMock.mockReturnValue({
            isAuthenticated: true,
            credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
            logout: vi.fn(),
            login: vi.fn(),
        });
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });
        storage.getState().replaceSettings({ analyticsOptOut: false } as any, 7);
        fetchSessionInventoryMock.mockResolvedValueOnce([{
            id: 'session-locked',
            metadataLayoutVersion: 1,
            metadataVersion: 7,
            agentStateVersion: 8,
            ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
                material: {
                    type: 'legacy',
                    secret: new Uint8Array(32).fill(7),
                },
                ownerMetadata: { v: 1 },
                randomBytes: (length) =>
                    new Uint8Array(length).fill(9),
            }),
        }]);

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
            if (url.endsWith('/v1/account/encryption/currentness') && method === 'GET') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        mode: 'e2ee',
                        version: 4,
                        signingKeyFingerprint: 'aemk1_signing',
                        contentKeyFingerprint: 'aemk1_content',
                        updatedAt: 1,
                    }),
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
                'common.error',
                'settingsAccount.encryptionUpdateFailed',
            );
            expect(fetchMock.mock.calls.some((call) =>
                getRequestUrl(call[0]).endsWith(
                    '/v1/account/encryption/migrate',
                )
                && (call[1]?.method ?? 'GET').toUpperCase() === 'POST'
            )).toBe(false);
        } finally {
            await screen?.unmount();
        }
    });

    it('emits the request-bound body only for a restored pinned Account key', async () => {
        fetchAccountEncryptionCurrentnessMock.mockResolvedValue({
            mode: 'plain',
            version: 4,
            signingKeyFingerprint:
                PINNED_SIGNING_KEY_FINGERPRINT,
            contentKeyFingerprint:
                PINNED_CONTENT_KEY_FINGERPRINT,
            updatedAt: 1,
        });
        useFeatureEnabledMock.mockReturnValue(true);
        const loginSpy = vi.fn(async () => {});
        useAuthMock.mockReturnValue({
            isAuthenticated: true,
            credentials: {
                token: 't',
                secret: Buffer.from(
                    new Uint8Array(32).fill(9),
                ).toString('base64url'),
            },
            logout: vi.fn(),
            login: loginSpy,
            loginWithCredentials: vi.fn(async () => ({
                kind: 'completed' as const,
            })),
        });
        storage.getState().applyProfile({
            ...profileDefaults,
            id: 'account-1',
            linkedProviders: [],
            username: null,
        });
        storage.getState().replaceSettings({ analyticsOptOut: false } as any, 7);
        fetchSessionInventoryMock.mockResolvedValueOnce([{
            id: 'session-active',
            metadataLayoutVersion: 1,
            metadataVersion: 7,
            agentStateVersion: 8,
            ownerMetadata: { t: 'plain', v: { v: 1 } },
        }]);

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
            if (url.endsWith('/v1/account/encryption/currentness') && method === 'GET') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        mode: 'plain',
                        version: 4,
                        signingKeyFingerprint: null,
                        contentKeyFingerprint: null,
                        updatedAt: 1,
                    }),
                };
            }
            if (url.endsWith('/v1/account/encryption/migrate') && method === 'POST') {
                const body = init?.body ? JSON.parse(String(init.body)) : null;
                expect(body).toEqual(expect.objectContaining({
                    toMode: 'e2ee',
                    expectedAccountVersion: 4,
                    expectedSigningKeyFingerprint:
                        PINNED_SIGNING_KEY_FINGERPRINT,
                    expectedContentKeyFingerprint:
                        PINNED_CONTENT_KEY_FINGERPRINT,
                    expectedSettingsVersion: 7,
                    settingsContent: expect.objectContaining({ t: 'encrypted' }),
                    connectedServices: { action: 'assert_empty' },
                    automations: { action: 'assert_empty' },
                    keyProof: expect.objectContaining({
                        v: 1,
                        publicKey: expect.any(String),
                        signature: expect.any(String),
                        contentPublicKey:
                            PINNED_CONTENT_PUBLIC_KEY,
                        contentPublicKeySig: 'content-public-key-signature',
                    }),
                }));
                expect(body.keyProof).not.toHaveProperty('challenge');
                expect(body.sessions).toMatchObject({
                    action: 'migrate',
                    items: [{
                        sessionId: 'session-active',
                        expectedMetadataLayoutVersion: 1,
                        expectedMetadataVersion: 7,
                        expectedAgentStateVersion: 8,
                        expectedOwnerMetadata: {
                            t: 'plain',
                            v: { v: 1 },
                        },
                        ownerMetadata: { t: 'encrypted' },
                    }],
                });
                return {
                    ok: true,
                    json: async () => ({
                        success: true,
                        mode: 'e2ee',
                        accountVersion: 5,
                        settingsVersion: 8,
                    }),
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
            expect(alertSpy).not.toHaveBeenCalled();
        } finally {
            await screen?.unmount();
        }
    });

    it('aborts before the migration request when e2ee content-key binding construction fails', async () => {
        fetchAccountEncryptionCurrentnessMock.mockResolvedValue({
            mode: 'plain',
            version: 4,
            signingKeyFingerprint:
                PINNED_SIGNING_KEY_FINGERPRINT,
            contentKeyFingerprint:
                PINNED_CONTENT_KEY_FINGERPRINT,
            updatedAt: 1,
        });
        useFeatureEnabledMock.mockReturnValue(true);
        buildContentKeyBindingMock.mockRejectedValueOnce(new Error('binding unavailable'));
        useAuthMock.mockReturnValue({
            isAuthenticated: true,
            credentials: {
                token: 't',
                secret: Buffer.from(
                    new Uint8Array(32).fill(9),
                ).toString('base64url'),
            },
            logout: vi.fn(),
            login: vi.fn(),
            loginWithCredentials: vi.fn(async () => ({
                kind: 'completed' as const,
            })),
        });
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });
        storage.getState().replaceSettings({ analyticsOptOut: false } as any, 7);

        const { Modal } = await import('@/modal');
        const alertSpy = vi.spyOn(Modal, 'alertAsync').mockResolvedValue();
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = getRequestUrl(input);
            const method = (init?.method ?? 'GET').toUpperCase();
            if (url.endsWith('/health') && method === 'GET') return createReachabilityProbeResponse();
            if (url.endsWith('/v1/auth/ping') && method === 'GET') return createReachabilityProbeResponse();
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
            if (url.endsWith('/v1/account/encryption/currentness') && method === 'GET') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        mode: 'plain',
                        version: 4,
                        signingKeyFingerprint: null,
                        contentKeyFingerprint: null,
                        updatedAt: 1,
                    }),
                };
            }
            if (url.endsWith('/v1/account/encryption/migrate') && method === 'POST') {
                throw new Error('migration request must not be sent');
            }
            throw new Error(`Unexpected fetch: ${url} (${method})`);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        let screen: Awaited<ReturnType<typeof renderSettingsView>> | undefined;
        try {
            screen = await renderSettingsView(<AccountScreen />);
            await act(async () => {});
            await vi.waitFor(() => {
                expect(
                    findEncryptionModeSwitch(screen!)?.props.disabled,
                ).toBe(false);
            });
            const encryptionSwitch =
                findEncryptionModeSwitch(screen);
            expect(encryptionSwitch).toBeTruthy();
            await act(async () => {
                await encryptionSwitch?.props.onValueChange(true);
            });

            expect(fetchMock.mock.calls.some(([input, init]) =>
                getRequestUrl(input).endsWith('/v1/account/encryption/migrate')
                && (init?.method ?? 'GET').toUpperCase() === 'POST',
            )).toBe(false);
            expect(buildContentKeyBindingMock).toHaveBeenCalledTimes(1);
            expect(alertSpy).toHaveBeenCalled();
        } finally {
            await screen?.unmount();
        }
    });

    it('replays retained mTLS custody after credential persistence fails without issuing a second challenge', async () => {
        fetchAccountEncryptionCurrentnessMock.mockResolvedValue({
            mode: 'plain',
            version: 4,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 1,
        });
        useFeatureEnabledMock.mockReturnValue(true);
        const loginSpy = vi.fn(async () => {});
        const loginWithCredentialsSpy = vi.fn()
            .mockRejectedValueOnce(
                new Error('credential storage unavailable'),
            )
            .mockResolvedValueOnce({ kind: 'completed' });
        useAuthMock.mockReturnValue({
            isAuthenticated: true,
            credentials: { token: 't' },
            logout: vi.fn(),
            login: loginSpy,
            loginWithCredentials: loginWithCredentialsSpy,
        });
        storage.getState().applyProfile({
            ...profileDefaults,
            id: 'account-1',
            linkedProviders: [{
                id: 'mtls',
                login: 'certificate-user',
                displayName: 'Certificate user',
                avatarUrl: null,
                profileUrl: null,
                showOnProfile: false,
            }],
            username: null,
        });
        await TokenStorage.clearPendingExternalAuth();
        storage.getState().replaceSettings({ analyticsOptOut: false } as any, 7);

        const { Modal } = await import('@/modal');
        const alertSpy = vi.spyOn(Modal, 'alertAsync').mockResolvedValue();

        const migrationRequestBodies: string[] = [];
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
                const base = createAccountFeaturesResponse({
                    encryptionAccountOptOutEnabled: true,
                });
                return {
                    ok: true,
                    json: async () => ({
                        ...base,
                        features: {
                            ...base.features,
                            auth: {
                                ...base.features.auth,
                                mtls: { enabled: true },
                            },
                        },
                        capabilities: {
                            ...base.capabilities,
                            auth: {
                                ...base.capabilities.auth,
                                login: {
                                    ...base.capabilities.auth.login,
                                    methods: [{
                                        id: 'mtls',
                                        enabled: true,
                                    }],
                                },
                            },
                        },
                    }),
                };
            }
            if (url.endsWith('/v1/account/encryption') && method === 'GET') {
                return {
                    ok: true,
                    json: async () => ({ mode: 'plain', updatedAt: 1 }),
                };
            }
            if (url.endsWith('/v1/account/encryption/currentness') && method === 'GET') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        mode: 'plain',
                        version: 4,
                        signingKeyFingerprint: null,
                        contentKeyFingerprint: null,
                        updatedAt: 1,
                    }),
                };
            }
            if (url.endsWith('/v1/auth/mtls') && method === 'POST') {
                expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
                expect(JSON.parse(String(init?.body))).toMatchObject({
                    purpose: 'account_encryption_first_key',
                    proofHash: expect.stringMatching(/^[a-f0-9]{64}$/),
                    requestDigest: expect.stringMatching(/^aemrb1_/),
                });
                return {
                    ok: true,
                    json: async () => ({
                        success: true,
                        pending: 'mtls-pending',
                    }),
                };
            }
            if (url.endsWith('/v1/account/encryption/migrate') && method === 'POST') {
                expect(
                    loginWithCredentialsSpy,
                ).toHaveBeenCalledTimes(
                    migrationRequestBodies.length,
                );
                const body = String(init?.body);
                migrationRequestBodies.push(body);
                expect(JSON.parse(body)).toMatchObject({
                    toMode: 'e2ee',
                    expectedSigningKeyFingerprint: null,
                    expectedContentKeyFingerprint: null,
                    externalAuthProof: {
                        provider: 'mtls',
                        pending: 'mtls-pending',
                        proof: expect.any(String),
                    },
                });
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        success: true,
                        mode: 'e2ee',
                        accountVersion: 5,
                        settingsVersion: 8,
                    }),
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

            await vi.waitFor(() => {
                expect(
                    findEncryptionModeSwitch(screen!)?.props.disabled,
                ).toBe(false);
            });
            const encryptionSwitch = findEncryptionModeSwitch(screen);
            expect(encryptionSwitch).toBeTruthy();

            await act(async () => {
                await encryptionSwitch?.props.onValueChange(true);
            });

            expect(fetchMock.mock.calls.filter(([input, init]) =>
                getRequestUrl(input).endsWith('/v1/auth/mtls')
                && (init?.method ?? 'GET').toUpperCase() === 'POST',
            )).toHaveLength(1);
            expect(fetchMock.mock.calls.filter(([input, init]) =>
                getRequestUrl(input).endsWith(
                    '/v1/account/encryption/migrate',
                )
                && (init?.method ?? 'GET').toUpperCase() === 'POST',
            )).toHaveLength(1);
            expect(loginWithCredentialsSpy).toHaveBeenCalledTimes(1);
            expect(alertSpy).toHaveBeenCalledTimes(1);

            await act(async () => {
                await encryptionSwitch?.props.onValueChange(true);
            });

            expect(loginSpy).not.toHaveBeenCalled();
            expect(fetchMock.mock.calls.filter(([input, init]) =>
                getRequestUrl(input).endsWith('/v1/auth/mtls')
                && (init?.method ?? 'GET').toUpperCase() === 'POST',
            )).toHaveLength(1);
            expect(fetchMock.mock.calls.filter(([input, init]) =>
                getRequestUrl(input).endsWith(
                    '/v1/account/encryption/migrate',
                )
                && (init?.method ?? 'GET').toUpperCase() === 'POST',
            )).toHaveLength(2);
            expect(migrationRequestBodies).toHaveLength(2);
            expect(migrationRequestBodies[1]).toBe(
                migrationRequestBodies[0],
            );
            expect(loginWithCredentialsSpy).toHaveBeenLastCalledWith({
                token: 't',
                secret: expect.any(String),
            }, {
                firstKeyRecoveryAuthorization:
                    expect.objectContaining({ token: 't' }),
            });
            expect(loginWithCredentialsSpy).toHaveBeenCalledTimes(2);
            expect(alertSpy).toHaveBeenCalledTimes(1);
        } finally {
            await screen?.unmount();
        }
    });

    it('automatically resumes retained OAuth custody after authoritative E2EE hydration', async () => {
        fetchAccountEncryptionCurrentnessMock.mockResolvedValue({
            mode: 'e2ee',
            version: 5,
            signingKeyFingerprint:
                PINNED_SIGNING_KEY_FINGERPRINT,
            contentKeyFingerprint:
                PINNED_CONTENT_KEY_FINGERPRINT,
            updatedAt: 2,
        });
        useFeatureEnabledMock.mockReturnValue(true);
        const loginWithCredentialsSpy = vi.fn()
            .mockRejectedValueOnce(
                new Error('credential storage unavailable'),
            )
            .mockResolvedValueOnce({ kind: 'completed' });
        useAuthMock.mockReturnValue({
            isAuthenticated: true,
            credentials: { token: 't' },
            logout: vi.fn(),
            login: vi.fn(),
            loginWithCredentials: loginWithCredentialsSpy,
        });
        storage.getState().applyProfile({
            ...profileDefaults,
            id: 'account-1',
            linkedProviders: [{
                id: 'github',
                login: 'octocat',
                displayName: 'Octocat',
                avatarUrl: null,
                profileUrl: null,
                showOnProfile: false,
            }],
            username: null,
        });
        await TokenStorage.clearPendingExternalAuth();
        storage.getState().replaceSettings(
            { analyticsOptOut: false } as any,
            7,
        );

        const seed = new Uint8Array(32).fill(9);
        const secret = Buffer.from(seed).toString('base64url');
        const request =
            AccountEncryptionMigrateRequestSchema.parse({
                toMode: 'e2ee',
                expectedAccountVersion: 4,
                expectedSigningKeyFingerprint: null,
                expectedContentKeyFingerprint: null,
                expectedSettingsVersion: 7,
                settingsContent: {
                    t: 'encrypted',
                    c: 'ciphertext',
                },
                connectedServices: { action: 'assert_empty' },
                automations: { action: 'assert_empty' },
                machines: { action: 'assert_empty' },
                todos: { action: 'assert_empty' },
                artifacts: { action: 'assert_empty' },
                sessions: { action: 'assert_empty' },
                reviewComments: { action: 'assert_empty' },
                sessionOrganization: { action: 'assert_empty' },
                pets: { action: 'assert_empty' },
                keyProof: {
                    v: 1,
                    publicKey: Buffer.from(
                        new Uint8Array(32).fill(3),
                    ).toString('base64'),
                    contentPublicKey:
                        PINNED_CONTENT_PUBLIC_KEY,
                    contentPublicKeySig:
                        'content-public-key-signature',
                    signature: Buffer.from(
                        new Uint8Array(64).fill(2),
                    ).toString('base64'),
                },
            });
        const createdAt = Date.now();
        await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'oauth-proof',
            secret,
            serverId: 'api.happier.dev',
            serverUrl: 'https://api.happier.dev',
            returnTo: '/settings/account',
            accountEncryptionFirstKey: {
                accountId: 'account-1',
                requestDigest:
                    createAccountEncryptionMigrateRequestBindingDigestV1({
                        request,
                        accountId: 'account-1',
                        sourceMode: 'plain',
                    }),
                requestJson: JSON.stringify(request),
                createdAt,
                expiresAt: createdAt + 10 * 60 * 1000,
            },
        });

        const migrationRequestBodies: string[] = [];
        const fetchMock = vi.fn(async (
            input: RequestInfo | URL,
            init?: RequestInit,
        ) => {
            const url = getRequestUrl(input);
            const method =
                (init?.method ?? 'GET').toUpperCase();
            if (url.endsWith('/health') && method === 'GET') {
                return createReachabilityProbeResponse();
            }
            if (
                url.endsWith('/v1/auth/ping')
                && method === 'GET'
            ) {
                return createReachabilityProbeResponse();
            }
            if (isFeaturesRequest(url)) {
                return {
                    ok: true,
                    json: async () =>
                        createAccountFeaturesResponse({
                            encryptionAccountOptOutEnabled:
                                true,
                        }),
                };
            }
            if (
                url.endsWith('/v1/account/encryption')
                && method === 'GET'
            ) {
                return {
                    ok: true,
                    json: async () => ({
                        mode: 'e2ee',
                        updatedAt: 2,
                    }),
                };
            }
            if (
                url.endsWith(
                    '/v1/account/encryption/migrate',
                )
                && method === 'POST'
            ) {
                const body = String(init?.body);
                migrationRequestBodies.push(body);
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        success: true,
                        mode: 'e2ee',
                        accountVersion: 5,
                        settingsVersion: 8,
                    }),
                };
            }
            throw new Error(
                `Unexpected fetch: ${url} (${method})`,
            );
        });
        vi.stubGlobal(
            'fetch',
            fetchMock as unknown as typeof fetch,
        );

        await expect(
            resumeAccountEncryptionFirstKeyExternalAuth({
                provider: 'github',
                pending: 'oauth-pending',
                currentCredentials: { token: 't' },
                persistCredentials:
                    loginWithCredentialsSpy,
            }),
        ).rejects.toThrow(
            'credential storage unavailable',
        );
        expect(migrationRequestBodies).toHaveLength(1);

        const { Modal } = await import('@/modal');
        const alertSpy =
            vi.spyOn(Modal, 'alertAsync').mockResolvedValue();
        const { default: AccountScreen } =
            await import('@/app/(app)/settings/account');
        let screen:
            | Awaited<ReturnType<typeof renderSettingsView>>
            | undefined;
        try {
            screen =
                await renderSettingsView(<AccountScreen />);
            await vi.waitFor(() => {
                expect(
                    loginWithCredentialsSpy,
                ).toHaveBeenCalledTimes(2);
            });

            expect(migrationRequestBodies).toHaveLength(2);
            expect(migrationRequestBodies[1]).toBe(
                migrationRequestBodies[0],
            );
            expect(fetchMock.mock.calls.some(
                ([input]) => {
                    const url = getRequestUrl(input);
                    return (
                        url.includes('/v1/auth/mtls')
                        || url.includes(
                            '/v1/auth/external/',
                        )
                    );
                },
            )).toBe(false);
            await vi.waitFor(async () => {
                await expect(
                    TokenStorage
                        .readPendingExternalAuthState(),
                ).resolves.toEqual({
                    value: null,
                    serverMismatch: false,
                });
            });
            expect(alertSpy).not.toHaveBeenCalled();
        } finally {
            await screen?.unmount();
        }
    });
});
