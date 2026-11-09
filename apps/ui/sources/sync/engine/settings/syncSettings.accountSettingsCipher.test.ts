import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import {
    decryptSecretStringV1,
    deriveAccountMachineKeyFromRecoverySecret,
    deriveSettingsSecretsKeyV1,
    encryptSecretStringV1,
    openAccountScopedBlobCiphertext,
    sealAccountScopedBlobCiphertext,
    SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1,
} from '@happier-dev/protocol';

const mocks = vi.hoisted(() => {
    const settingsParse = vi.fn((value: unknown) => {
        const record =
            value && typeof value === 'object' && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : {};
        return {
            analyticsOptOut: false,
            ...record,
        };
    });

    return {
        getRandomBytes: vi.fn((length: number) => new Uint8Array(length).fill(4)),
        serverFetch: vi.fn(),
        serverProfileLegacyServerIds: ['localhost-52753'] as string[],
        applySettingsFn: vi.fn((base: Record<string, unknown>, delta: Record<string, unknown>) => ({
            ...base,
            ...delta,
        })),
        settingsParse,
        fetchSessionOrganizationSnapshot: vi.fn(async () => ({
            snapshot: {
                schemaVersion: 1,
                version: 0,
                pins: [],
                folders: [],
                folderAssignments: [],
                tags: [],
                tagAssignments: [],
                orderEntries: [],
                labels: [],
            },
        })),
        importLegacySessionOrganization: vi.fn(async () => {}),
        storageState: {
            settings: {
                analyticsOptOut: false,
            } as Record<string, unknown>,
            settingsVersion: 9,
            applySettings: vi.fn(),
            replaceSettings: vi.fn(),
            applySettingsForScope: vi.fn(),
            replaceSettingsForScope: vi.fn(),
            applySettingsLocal: vi.fn(),
        },
    };
});

vi.mock('@/track', () => ({
    tracking: null,
}));

vi.mock('@/utils/errors/errors', () => ({
    HappyError: class HappyError extends Error {
        constructor(message: string) {
            super(message);
        }
    },
}));

vi.mock('@/sync/domains/settings/settings', () => ({
    applySettings: mocks.applySettingsFn,
    settingsDefaults: { analyticsOptOut: false },
    settingsParse: mocks.settingsParse,
}));

vi.mock('@/sync/domains/settings/debugSettings', () => ({
    summarizeSettings: () => ({}),
    summarizeSettingsDelta: () => ({}),
    dbgSettings: () => {},
    isSettingsSyncDebugEnabled: () => false,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverUrl: 'http://127.0.0.1:3009' }),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getServerProfileLegacyServerIds: () => mocks.serverProfileLegacyServerIds,
}));

vi.mock('@/sync/api/session/sessionOrganizationApi', () => ({
    fetchSessionOrganizationSnapshot: mocks.fetchSessionOrganizationSnapshot,
}));

vi.mock('@/sync/ops/sessionOrganization/importLegacySessionOrganization', () => ({
    importLegacySessionOrganization: mocks.importLegacySessionOrganization,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
        getState: () => mocks.storageState,
    },
});
});

vi.mock('@/sync/domains/state/persistence', () => ({
    getPersistenceStorage: () => ({
        getString: () => undefined,
        set: vi.fn(),
        delete: vi.fn(),
        getAllKeys: () => [],
    }),
    loadPendingSettings: () => ({}),
    loadSettings: () => ({
        settings: { ...mocks.storageState.settings },
        version: mocks.storageState.settingsVersion,
    }),
    loadLocalSettings: () => ({}),
    loadPurchases: () => ({}),
    loadProfile: () => ({}),
    loadThemePreference: () => 'adaptive',
    loadLocalPetSourcesBySourceKey: () => ({}),
    loadSessionDrafts: () => ({}),
    loadSessionReviewCommentsDrafts: () => ({}),
    loadWorkspaceReviewCommentsDrafts: () => ({}),
    loadSessionActionDrafts: () => ({}),
    loadNewSessionDraft: () => null,
    loadSessionPermissionModes: () => ({}),
    loadSessionPermissionModeUpdatedAts: () => ({}),
    loadSessionLastViewed: () => ({}),
    loadSessionModelModes: () => ({}),
    loadSessionModelModeUpdatedAts: () => ({}),
    loadSessionMaterializedMaxSeqById: () => ({}),
    loadChangesCursor: () => null,
    loadLastChangesCursorByAccountId: () => ({}),
    loadDeviceAnalyticsId: () => null,
    saveSettings: vi.fn(),
    saveLocalSettings: vi.fn(),
    savePurchases: vi.fn(),
    saveProfile: vi.fn(),
    saveLocalPetSourcesBySourceKey: vi.fn(),
    saveSessionDrafts: vi.fn(),
    saveSessionReviewCommentsDrafts: vi.fn(),
    saveWorkspaceReviewCommentsDrafts: vi.fn(),
    saveSessionActionDrafts: vi.fn(),
    saveNewSessionDraft: vi.fn(),
    clearNewSessionDraft: vi.fn(),
    saveSessionPermissionModes: vi.fn(),
    saveSessionPermissionModeUpdatedAts: vi.fn(),
    saveSessionLastViewed: vi.fn(),
    saveSessionModelModes: vi.fn(),
    saveSessionModelModeUpdatedAts: vi.fn(),
    saveSessionMaterializedMaxSeqById: vi.fn(),
    saveChangesCursor: vi.fn(),
    pruneStaleInstanceChangesCursors: vi.fn(),
    saveLastChangesCursorByAccountId: vi.fn(),
    savePendingSettings: vi.fn(),
    saveDeviceAnalyticsId: vi.fn(),
    clearPersistence: vi.fn(),
}));

vi.mock('@/sync/encryption/secretSettings', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/encryption/secretSettings')>();
    return {
        ...actual,
        sealSecretsDeep: (value: unknown) => value,
        unsealSecretsDeep: (value: unknown) => value,
    };
});

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
}));

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes: mocks.getRandomBytes,
}));

import { syncSettings } from './syncSettings';

const credentials: AuthCredentials = {
    token: 'token',
    encryption: {
        publicKey: 'public',
        machineKey: 'machine',
    },
};

const TEST_MACHINE_KEY = new Uint8Array(32).fill(11);

describe('syncSettings account settings ciphertext', () => {
    beforeEach(() => {
        invalidateAccountEncryptionModeCache();
        mocks.serverFetch.mockReset();
        mocks.applySettingsFn.mockClear();
        mocks.settingsParse.mockClear();
        mocks.fetchSessionOrganizationSnapshot.mockClear();
        mocks.importLegacySessionOrganization.mockClear();
        mocks.getRandomBytes.mockClear();
        mocks.serverProfileLegacyServerIds = ['localhost-52753'];
        mocks.storageState.settings = {
            analyticsOptOut: false,
        };
        mocks.storageState.settingsVersion = 9;
        mocks.storageState.applySettings.mockReset();
        mocks.storageState.replaceSettings.mockReset();
        mocks.storageState.applySettingsForScope.mockReset();
        mocks.storageState.replaceSettingsForScope.mockReset();
        mocks.storageState.applySettingsLocal.mockReset();
    });

    it('refuses plaintext Account settings when the trusted local client pin requires E2EE', async () => {
        mocks.storageState.settings = {
            analyticsOptOut: false,
            clientEncryptionRequirementLocalV1: 'require_e2ee',
            clientEncryptionRequirementV1: 'follow_account',
        };
        mocks.serverFetch
            .mockResolvedValueOnce(new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                content: { t: 'plain', v: { analyticsOptOut: false } },
                version: 10,
            }), { status: 200 }));

        await expect(syncSettings({
            credentials,
            encryption: { getContentPrivateKey: () => TEST_MACHINE_KEY } as unknown as Encryption,
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
        })).rejects.toMatchObject({ code: 'CLIENT_E2EE_REQUIRED' });
        expect(mocks.storageState.applySettings).not.toHaveBeenCalled();
    });

    it('POSTs settings as a canonical account_scoped_v1 ciphertext (no encryptRaw)', async () => {
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
            decryptRaw: vi.fn(async () => null),
            encryptRaw: vi.fn(async () => {
                throw new Error('encryptRaw should not be used for account settings');
            }),
        } as unknown as Encryption;
        const serverCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                analyticsOptOut: false,
                untouchedRawField: { preserved: true },
                featureToggles: { 'sessions.lineageAppearancePresets': true },
                sessionLineageAppearancePresetsV1: { future: 'keep', child: { avatarStyle: 'gradient' } },
            },
            randomBytes: mocks.getRandomBytes,
        });

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ mode: 'e2ee', updatedAt: Date.now() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: serverCiphertext }, version: 12 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 13 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: { claudeLocalPermissionBridgeEnabled: true } as any,
            clearPendingSettings: vi.fn(),
        });

        const calls = mocks.serverFetch.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET']);
        expect(calls).toEqual([
            ['/v1/account/encryption', 'GET'],
            ['/v2/account/settings', 'GET'],
            ['/v2/account/settings', 'POST'],
        ]);

        const [, init2] = mocks.serverFetch.mock.calls[2];
        expect(typeof init2?.body).toBe('string');

        const body = JSON.parse(String(init2?.body)) as {
            content?: { t?: unknown; c?: unknown };
            expectedVersion?: unknown;
        };
        expect(body.expectedVersion).toBe(12);
        expect(body.content?.t).toBe('encrypted');
        expect(typeof body.content?.c).toBe('string');

        const opened = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            ciphertext: body.content!.c as string,
        });
        expect(opened?.format).toBe('account_scoped_v1');
        expect(opened?.value).toEqual(
            expect.objectContaining({
                analyticsOptOut: false,
                claudeLocalPermissionBridgeEnabled: true,
                untouchedRawField: { preserved: true },
                featureToggles: { 'sessions.lineageAppearancePresets': true },
                sessionLineageAppearancePresetsV1: { future: 'keep', child: { avatarStyle: 'gradient' } },
            }),
        );

        expect((encryptionStub.encryptRaw as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('preserves malformed known server fields when pending touches another setting', async () => {
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
            decryptRaw: vi.fn(async () => null),
            encryptRaw: vi.fn(async () => {
                throw new Error('encryptRaw should not be used for account settings');
            }),
        } as unknown as Encryption;
        const serverCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                analyticsOptOut: false,
                profiles: 'malformed-profiles-field',
            },
            randomBytes: mocks.getRandomBytes,
        });

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ mode: 'e2ee', updatedAt: Date.now() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: serverCiphertext }, version: 12 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 13 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: { analyticsOptOut: true } as any,
            clearPendingSettings: vi.fn(),
        });

        const [, init] = mocks.serverFetch.mock.calls[2];
        const body = JSON.parse(String(init?.body)) as { content?: { c?: unknown } };
        const opened = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            ciphertext: String(body.content?.c ?? ''),
        });

        expect(opened?.value).toEqual(
            expect.objectContaining({
                analyticsOptOut: true,
                profiles: 'malformed-profiles-field',
            }),
        );
    });

    it('skips POST when pending merge is semantically equal to the fetched server settings', async () => {
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
            decryptRaw: vi.fn(async () => null),
            encryptRaw: vi.fn(async () => {
                throw new Error('encryptRaw should not be used for account settings');
            }),
        } as unknown as Encryption;
        const serverCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: { analyticsOptOut: false },
            randomBytes: mocks.getRandomBytes,
        });
        const clearPendingSettings = vi.fn();

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ mode: 'e2ee', updatedAt: Date.now() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: serverCiphertext }, version: 12 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: { analyticsOptOut: false } as any,
            clearPendingSettings,
        });

        expect(mocks.serverFetch.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET'])).toEqual([
            ['/v1/account/encryption', 'GET'],
            ['/v2/account/settings', 'GET'],
        ]);
        expect(clearPendingSettings).toHaveBeenCalledWith({});
    });

    it('does not POST or clear pending settings when fetched encrypted settings cannot be opened', async () => {
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
            decryptRaw: vi.fn(async () => null),
            encryptRaw: vi.fn(async () => {
                throw new Error('encryptRaw should not be used for account settings');
            }),
        } as unknown as Encryption;
        const clearPendingSettings = vi.fn();

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ mode: 'e2ee', updatedAt: Date.now() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: 'not-openable' }, version: 12 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await expect(syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: { analyticsOptOut: true } as any,
            clearPendingSettings,
        })).rejects.toThrow(/decrypt|open|settings/i);

        expect(mocks.serverFetch.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET'])).toEqual([
            ['/v1/account/encryption', 'GET'],
            ['/v2/account/settings', 'GET'],
        ]);
        expect(clearPendingSettings).not.toHaveBeenCalled();
    });

    it('prefers protocol decryption for canonical ciphertext (no decryptRaw)', async () => {
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
            decryptRaw: vi.fn(async () => {
                throw new Error('decryptRaw should not be used for canonical account_scoped_v1 ciphertext');
            }),
        } as unknown as Encryption;

        const ciphertext = (await import('@happier-dev/protocol')).sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: { analyticsOptOut: true },
            randomBytes: mocks.getRandomBytes,
        });

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ mode: 'e2ee', updatedAt: Date.now() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
            new Response(JSON.stringify({ content: { t: 'encrypted', c: ciphertext }, version: 12 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
        });

        expect((encryptionStub.decryptRaw as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        expect(mocks.storageState.applySettings).toHaveBeenCalledWith(
            expect.objectContaining({ analyticsOptOut: true }),
            12,
        );
    });

    it('falls back to v1 settings POST when v2 settings is not supported (e2ee)', async () => {
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
            decryptRaw: vi.fn(async () => null),
            encryptRaw: vi.fn(async () => {
                throw new Error('encryptRaw should not be used for account settings');
            }),
        } as unknown as Encryption;

        mocks.serverFetch
            // GET /v1/account/encryption
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ mode: 'e2ee', updatedAt: Date.now() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            // GET /v2/account/settings -> 404 (old server)
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }))
            // GET /v1/account/settings -> empty
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ settings: null, settingsVersion: 8 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            // POST /v1/account/settings -> success
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 10 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: { claudeLocalPermissionBridgeEnabled: true } as any,
            clearPendingSettings: vi.fn(),
        });

        const calls = mocks.serverFetch.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET']);
        expect(calls).toEqual([
            ['/v1/account/encryption', 'GET'],
            ['/v2/account/settings', 'GET'],
            ['/v1/account/settings', 'GET'],
            ['/v1/account/settings', 'POST'],
        ]);

        const [, initV1] = mocks.serverFetch.mock.calls[3];
        expect(initV1?.method).toBe('POST');
        const body = JSON.parse(String(initV1?.body)) as { settings?: unknown; expectedVersion?: unknown };
        expect(typeof body.settings).toBe('string');
        expect(body.expectedVersion).toBe(8);
    });

    it('retries a version mismatch from currentContent while preserving raw fields', async () => {
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
            decryptRaw: vi.fn(async () => null),
            encryptRaw: vi.fn(async () => {
                throw new Error('encryptRaw should not be used for account settings');
            }),
        } as unknown as Encryption;
        const firstServerCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: { analyticsOptOut: false, firstOnlyRaw: 'preserve-first' },
            randomBytes: mocks.getRandomBytes,
        });
        const currentCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: { analyticsOptOut: false, currentOnlyRaw: 'preserve-current' },
            randomBytes: mocks.getRandomBytes,
        });

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ mode: 'e2ee', updatedAt: Date.now() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: firstServerCiphertext }, version: 12 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: 14,
                    currentContent: { t: 'encrypted', c: currentCiphertext },
                }), {
                    status: 409,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 15 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: { analyticsOptOut: true } as any,
            clearPendingSettings: vi.fn(),
        });

        const retryBody = JSON.parse(String(mocks.serverFetch.mock.calls[3]?.[1]?.body)) as {
            content?: { c?: unknown };
            expectedVersion?: unknown;
        };
        expect(retryBody.expectedVersion).toBe(14);
        const opened = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            ciphertext: String(retryBody.content?.c ?? ''),
        });
        expect(opened?.value).toEqual(
            expect.objectContaining({
                analyticsOptOut: true,
                currentOnlyRaw: 'preserve-current',
            }),
        );
        expect((opened?.value as Record<string, unknown>)?.firstOnlyRaw).toBeUndefined();
    });

    it('does not churn POSTs for already-sealed settings secrets during passive sync', async () => {
        const settingsSecretsKey = deriveSettingsSecretsKeyV1(TEST_MACHINE_KEY);
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
            decryptRaw: vi.fn(async () => {
                throw new Error('decryptRaw should not be used for canonical account settings ciphertext');
            }),
        } as unknown as Encryption;
        const encryptedSecret = encryptSecretStringV1(
            'sk-canonical',
            settingsSecretsKey,
            mocks.getRandomBytes,
        );
        const fetchedCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                analyticsOptOut: false,
                secrets: [
                    {
                        id: 'sec1',
                        name: 'Canonical Secret',
                        kind: 'apiKey',
                        encryptedValue: { _isSecretValue: true, encryptedValue: encryptedSecret },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
            randomBytes: mocks.getRandomBytes,
        });

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ mode: 'e2ee', updatedAt: Date.now() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: fetchedCiphertext }, version: 12 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 13 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: {},
            settingsSecretsKey,
            settingsSecretsReadKeys: [settingsSecretsKey],
            clearPendingSettings: vi.fn(),
        });

        expect(mocks.serverFetch.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET'])).toEqual([
            ['/v1/account/encryption', 'GET'],
            ['/v2/account/settings', 'GET'],
        ]);
        expect((encryptionStub.decryptRaw as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('migrates legacy server ids nested inside fetched account settings', async () => {
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
            decryptRaw: vi.fn(async () => {
                throw new Error('decryptRaw should not be used for canonical account settings ciphertext');
            }),
        } as unknown as Encryption;
        const fetchedCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                analyticsOptOut: false,
                pinnedSessionKeysV1: ['localhost-52753:session-a', 'srv_identity:session-b'],
                sessionTagsV1: {
                    'localhost-52753:session-a': ['legacy-tag'],
                    'srv_identity:session-b': ['identity-tag'],
                },
                sessionListGroupOrderV1: {
                    'server:localhost-52753:active:project:p1': ['localhost-52753:session-a'],
                    'server:192.168.1.115-52753:active:project:p2': ['192.168.1.115-52753:session-c'],
                    'pinned-v1': ['localhost-52753:session-a'],
                },
                sessionWorkspaceOrderV1: {
                    'server:localhost-52753:workspaces': ['workspace:legacy'],
                },
                serverSelectionGroups: [{
                    id: 'group-a',
                    name: 'Group A',
                    serverIds: ['localhost-52753', '192.168.1.115-52753', 'srv_identity'],
                    presentation: 'grouped',
                }],
            },
            randomBytes: mocks.getRandomBytes,
        });

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ mode: 'e2ee', updatedAt: Date.now() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: fetchedCiphertext }, version: 12 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 13 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            settingsScope: { serverId: 'srv_identity', accountId: 'account-a' },
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
        });

        expect(mocks.serverFetch.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET'])).toEqual([
            ['/v1/account/encryption', 'GET'],
            ['/v2/account/settings', 'GET'],
            ['/v2/account/settings', 'POST'],
        ]);

        const migrateBody = JSON.parse(String(mocks.serverFetch.mock.calls[2]?.[1]?.body)) as {
            content?: { t?: unknown; c?: unknown };
            expectedVersion?: unknown;
        };
        expect(migrateBody.expectedVersion).toBe(12);
        const opened = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            ciphertext: String(migrateBody.content?.c ?? ''),
        });
        expect(opened?.value).toEqual({
            analyticsOptOut: false,
            sessionRoleProfilesV1: {
                v: 1,
                instructionsByRole: {},
                customRoles: [SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1],
            },
        });
        expect(mocks.fetchSessionOrganizationSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            credentials,
            serverUrl: 'http://127.0.0.1:3009',
        }));
        expect(mocks.importLegacySessionOrganization).toHaveBeenCalledWith(expect.objectContaining({
            credentials,
            serverId: 'srv_identity',
            serverUrl: 'http://127.0.0.1:3009',
            request: expect.objectContaining({
                pins: [
                    { sessionId: 'session-a', sortKey: '00000001' },
                    { sessionId: 'session-b', sortKey: '00000002' },
                ],
                tagAssignments: [
                    { sessionId: 'session-a', tagIds: ['legacy-tag'] },
                    { sessionId: 'session-b', tagIds: ['identity-tag'] },
                ],
            }),
        }));
        expect(mocks.storageState.applySettingsForScope).toHaveBeenLastCalledWith(
            { serverId: 'srv_identity', accountId: 'account-a' },
            expect.objectContaining({
                analyticsOptOut: false,
                pinnedSessionKeysV1: ['srv_identity:session-a', 'srv_identity:session-b'],
                sessionTagsV1: {
                    'srv_identity:session-a': ['legacy-tag'],
                    'srv_identity:session-b': ['identity-tag'],
                },
            }),
            13,
        );
    });

    it('reports imported legacy pinned session ids to the sync orchestrator', async () => {
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
            decryptRaw: vi.fn(async () => {
                throw new Error('plain settings should not decrypt ciphertext');
            }),
        } as unknown as Encryption;
        const onLegacySessionOrganizationImported = vi.fn();

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ mode: 'plain', updatedAt: Date.now() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({
                    content: {
                        t: 'plain',
                        v: {
                            analyticsOptOut: false,
                            pinnedSessionKeysV1: ['srv_identity:session-a', 'srv_identity:session-b'],
                        },
                    },
                    version: 12,
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 13 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await (syncSettings as unknown as (params: Parameters<typeof syncSettings>[0] & {
            onLegacySessionOrganizationImported?: typeof onLegacySessionOrganizationImported;
        }) => Promise<void>)({
            credentials,
            encryption: encryptionStub,
            settingsScope: { serverId: 'srv_identity', accountId: 'account-a' },
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
            onLegacySessionOrganizationImported,
        });

        expect(mocks.importLegacySessionOrganization).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                pins: [
                    { sessionId: 'session-a', sortKey: '00000001' },
                    { sessionId: 'session-b', sortKey: '00000002' },
                ],
            }),
        }));
        expect(onLegacySessionOrganizationImported).toHaveBeenCalledWith({
            pinnedSessionIds: ['session-a', 'session-b'],
        });
    });

    it('migrates payload-discovered server ids even when profile legacy aliases are absent', async () => {
        mocks.serverProfileLegacyServerIds = [];
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
            decryptRaw: vi.fn(async () => {
                throw new Error('decryptRaw should not be used for canonical account settings ciphertext');
            }),
        } as unknown as Encryption;
        const fetchedCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                pinnedSessionKeysV1: ['127.0.0.1-52753:session-a'],
                sessionTagsV1: {
                    '127.0.0.1-52753:session-a': ['local-tag'],
                },
                serverSelectionGroups: [{
                    id: 'group-a',
                    name: 'Group A',
                    serverIds: ['127.0.0.1-52753'],
                    presentation: 'grouped',
                }],
            },
            randomBytes: mocks.getRandomBytes,
        });

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ mode: 'e2ee', updatedAt: Date.now() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: fetchedCiphertext }, version: 21 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 22 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            settingsScope: { serverId: 'srv_identity', accountId: 'account-a' },
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
        });

        expect(mocks.serverFetch.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET'])).toEqual([
            ['/v1/account/encryption', 'GET'],
            ['/v2/account/settings', 'GET'],
            ['/v2/account/settings', 'POST'],
        ]);
        const migrateBody = JSON.parse(String(mocks.serverFetch.mock.calls[2]?.[1]?.body)) as {
            content?: { t?: unknown; c?: unknown };
            expectedVersion?: unknown;
        };
        expect(migrateBody.expectedVersion).toBe(21);
        const opened = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            ciphertext: String(migrateBody.content?.c ?? ''),
        });
        expect(opened?.value).toEqual({
            sessionRoleProfilesV1: {
                v: 1,
                instructionsByRole: {},
                customRoles: [SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1],
            },
        });
        expect(mocks.importLegacySessionOrganization).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'srv_identity',
            request: expect.objectContaining({
                pins: [{ sessionId: 'session-a', sortKey: '00000001' }],
                tagAssignments: [{ sessionId: 'session-a', tagIds: ['local-tag'] }],
            }),
        }));
    });

    it('does not rewrite payload-discovered aliases when the active scope is still host-derived', async () => {
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
            decryptRaw: vi.fn(async () => {
                throw new Error('decryptRaw should not be used for canonical account settings ciphertext');
            }),
        } as unknown as Encryption;
        const fetchedCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                analyticsOptOut: false,
                sessionListGroupOrderV1: {
                    'server:192.168.1.115-52753:active:project:p2': ['192.168.1.115-52753:session-c'],
                },
            },
            randomBytes: mocks.getRandomBytes,
        });

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ mode: 'e2ee', updatedAt: Date.now() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: fetchedCiphertext }, version: 12 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 13 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            settingsScope: { serverId: 'localhost-52753', accountId: 'account-a' },
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
        });

        expect(mocks.serverFetch.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET'])).toEqual([
            ['/v1/account/encryption', 'GET'],
            ['/v2/account/settings', 'GET'],
            ['/v2/account/settings', 'POST'],
        ]);
        expect(mocks.storageState.applySettingsForScope).toHaveBeenLastCalledWith(
            { serverId: 'localhost-52753', accountId: 'account-a' },
            expect.objectContaining({
                analyticsOptOut: false,
                sessionListGroupOrderV1: {
                    'server:192.168.1.115-52753:active:project:p2': ['192.168.1.115-52753:session-c'],
                },
            }),
            13,
        );
    });

    it('migrates legacy-sealed saved secrets to canonical machine-key sealing after fetch', async () => {
        const recoverySecret = new Uint8Array(32).fill(6);
        const machineKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);
        const legacySettingsKey = deriveSettingsSecretsKeyV1(recoverySecret);
        const canonicalSettingsKey = deriveSettingsSecretsKeyV1(machineKey);
        const legacyCredentials: AuthCredentials = {
            token: 'token',
            secret: Buffer.from(recoverySecret).toString('base64url'),
        } as any;

        const encryptionStub = {
            getContentPrivateKey: () => machineKey,
            decryptRaw: vi.fn(async () => {
                throw new Error('decryptRaw should not be used for canonical account settings ciphertext');
            }),
        } as unknown as Encryption;

        const legacyEncryptedSecret = encryptSecretStringV1(
            'sk-legacy',
            legacySettingsKey,
            mocks.getRandomBytes,
        );
        const fetchedCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey },
            payload: {
                analyticsOptOut: true,
                secrets: [
                    {
                        id: 'sec1',
                        name: 'Legacy Secret',
                        kind: 'apiKey',
                        encryptedValue: { _isSecretValue: true, encryptedValue: legacyEncryptedSecret },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
            randomBytes: mocks.getRandomBytes,
        });

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ mode: 'e2ee', updatedAt: Date.now() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: fetchedCiphertext }, version: 12 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 13 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials: legacyCredentials,
            encryption: encryptionStub,
            pendingSettings: {},
            settingsSecretsKey: canonicalSettingsKey,
            settingsSecretsReadKeys: [canonicalSettingsKey, legacySettingsKey],
            clearPendingSettings: vi.fn(),
        });

        expect(mocks.serverFetch).toHaveBeenCalledTimes(3);
        expect(mocks.serverFetch.mock.calls[2]?.[0]).toBe('/v2/account/settings');
        expect(mocks.serverFetch.mock.calls[2]?.[1]?.method).toBe('POST');

        const migrateBody = JSON.parse(String(mocks.serverFetch.mock.calls[2]?.[1]?.body)) as {
            content?: { t?: unknown; c?: unknown };
            expectedVersion?: unknown;
        };
        expect(migrateBody.expectedVersion).toBe(12);
        expect(migrateBody.content?.t).toBe('encrypted');

        const opened = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey },
            ciphertext: String(migrateBody.content?.c ?? ''),
        });
        const migratedSecret = ((opened?.value as any)?.secrets?.[0]?.encryptedValue?.encryptedValue);
        expect(decryptSecretStringV1(migratedSecret, canonicalSettingsKey)).toBe('sk-legacy');
    });

    it('issues the account-settings GET without waiting for the encryption-mode response', async () => {
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
            decryptRaw: vi.fn(async () => null),
            encryptRaw: vi.fn(async () => {
                throw new Error('encryptRaw should not be used for account settings');
            }),
        } as unknown as Encryption;

        let releaseEncryptionMode: () => void = () => {};
        const encryptionModeGate = new Promise<void>((resolve) => {
            releaseEncryptionMode = resolve;
        });

        mocks.serverFetch.mockImplementation(async (path: string) => {
            if (path === '/v1/account/encryption') {
                await encryptionModeGate;
                return new Response(JSON.stringify({ mode: 'e2ee', updatedAt: Date.now() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (path === '/v2/account/settings') {
                return new Response(JSON.stringify({ content: null, version: 12 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            throw new Error(`Unexpected path ${path}`);
        });

        const syncPromise = syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
        });

        // The settings read must already be in flight while the encryption-mode read is still open:
        // the mode decides how the fetched document is opened, never which document is read.
        await vi.waitFor(() => {
            expect(mocks.serverFetch.mock.calls.map((call) => call[0])).toContain('/v2/account/settings');
        });

        releaseEncryptionMode();
        await syncPromise;

        expect(mocks.serverFetch.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET'])).toEqual([
            ['/v1/account/encryption', 'GET'],
            ['/v2/account/settings', 'GET'],
        ]);
    });
});
