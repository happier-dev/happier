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
        createEncryptionFromAuthCredentials: vi.fn(),
        getRandomBytes: vi.fn((length: number) => new Uint8Array(length).fill(4)),
        serverFetch: vi.fn(),
        runtimeFetchWithServerReachability: vi.fn(),
        applySettingsFn: vi.fn((base: Record<string, unknown>, delta: Record<string, unknown>) => ({
            ...base,
            ...delta,
        })),
        settingsParse,
        persistenceValues: new Map<string, string>(),
        persistenceSet: vi.fn(),
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
        storageStoreState: {
            setSessionOrganizationLoading: vi.fn(),
            setSessionOrganizationError: vi.fn(),
            applySessionOrganizationSnapshot: vi.fn(),
            setSessionTagAssignmentsOptimistic: vi.fn(() => 'optimistic-tag-assignment'),
            commitSessionOrganizationOptimistic: vi.fn(),
            rollbackSessionOrganizationOptimistic: vi.fn(),
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

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: mocks.createEncryptionFromAuthCredentials,
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
    getServerProfileLegacyServerIds: () => ['localhost-52753'],
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
    loadPendingSettings: () => ({}),
    loadSettings: () => ({
        settings: { ...mocks.storageState.settings },
        version: mocks.storageState.settingsVersion,
    }),
    loadLocalSettings: () => ({}),
    loadPurchases: () => ({}),
    loadProfile: () => ({}),
    loadThemePreference: () => 'adaptive',
    loadSessionDrafts: () => ({}),
    loadSessionReviewCommentsDrafts: () => ({}),
    loadSessionActionDrafts: () => ({}),
    loadNewSessionDraft: () => null,
    loadSessionPermissionModes: () => ({}),
    loadSessionPermissionModeUpdatedAts: () => ({}),
    loadSessionLastViewed: () => ({}),
    loadSessionModelModes: () => ({}),
    loadSessionModelModeUpdatedAts: () => ({}),
    loadWorkspaceReviewCommentsDrafts: () => ({}),
    loadSessionMaterializedMaxSeqById: () => ({}),
    loadChangesCursor: () => null,
    loadLastChangesCursorByAccountId: () => ({}),
    loadDeviceAnalyticsId: () => null,
    saveSettings: vi.fn(),
    saveLocalSettings: vi.fn(),
    savePurchases: vi.fn(),
    saveProfile: vi.fn(),
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
    saveLastChangesCursorByAccountId: vi.fn(),
    savePendingSettings: vi.fn(),
    saveDeviceAnalyticsId: vi.fn(),
    clearPersistence: vi.fn(),
}));

vi.mock('@/sync/domains/state/persistenceStorage', () => ({
    getPersistenceStorage: () => ({
        getString: (key: string) => mocks.persistenceValues.get(key),
        set: (key: string, value: string) => {
            mocks.persistenceSet(key, value);
            mocks.persistenceValues.set(key, value);
        },
        delete: (key: string) => {
            mocks.persistenceValues.delete(key);
        },
        getAllKeys: () => [...mocks.persistenceValues.keys()],
    }),
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

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: mocks.runtimeFetchWithServerReachability,
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => ({
        getState: () => mocks.storageStoreState,
    }),
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
        mocks.runtimeFetchWithServerReachability.mockReset();
        mocks.applySettingsFn.mockClear();
        mocks.settingsParse.mockClear();
        mocks.createEncryptionFromAuthCredentials.mockReset();
        mocks.createEncryptionFromAuthCredentials.mockResolvedValue({
            getContentPrivateKey: () => TEST_MACHINE_KEY,
        });
        mocks.getRandomBytes.mockClear();
        mocks.persistenceValues.clear();
        mocks.persistenceSet.mockClear();
        mocks.storageState.settings = {
            analyticsOptOut: false,
        };
        mocks.storageState.settingsVersion = 9;
        mocks.storageState.applySettings.mockReset();
        mocks.storageState.replaceSettings.mockReset();
        mocks.storageState.applySettingsForScope.mockReset();
        mocks.storageState.replaceSettingsForScope.mockReset();
        mocks.storageState.applySettingsLocal.mockReset();
        mocks.storageStoreState.setSessionOrganizationLoading.mockReset();
        mocks.storageStoreState.setSessionOrganizationError.mockReset();
        mocks.storageStoreState.applySessionOrganizationSnapshot.mockReset();
        mocks.storageStoreState.setSessionTagAssignmentsOptimistic.mockReset();
        mocks.storageStoreState.setSessionTagAssignmentsOptimistic.mockReturnValue('optimistic-tag-assignment');
        mocks.storageStoreState.commitSessionOrganizationOptimistic.mockReset();
        mocks.storageStoreState.rollbackSessionOrganizationOptimistic.mockReset();
    });

    it('recomputes a functional account-settings mutation after a CAS conflict', async () => {
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
        } as unknown as Encryption;
        const initialCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                providerSettingsV1: {
                    schemaVersion: 1,
                    connections: [{ id: 'pc-a' }],
                    machineGrants: [{ machineId: 'revoked', connectionId: 'pc-a' }],
                },
            },
            randomBytes: mocks.getRandomBytes,
        });
        const concurrentCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                providerSettingsV1: {
                    schemaVersion: 1,
                    connections: [{ id: 'pc-a' }],
                    machineGrants: [{ machineId: 'revoked', connectionId: 'pc-a' }],
                    manualModelsByConnectionId: { 'pc-a': [{ id: 'concurrent/model', addedAt: 9 }] },
                },
            },
            randomBytes: mocks.getRandomBytes,
        });
        mocks.serverFetch
            .mockResolvedValueOnce(new Response(JSON.stringify({ mode: 'e2ee', updatedAt: Date.now() }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                content: { t: 'encrypted', c: initialCiphertext }, version: 4,
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                success: false,
                error: 'version-mismatch',
                currentVersion: 5,
                currentContent: { t: 'encrypted', c: concurrentCiphertext },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, version: 6 }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            }));

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
            serverSettingsMutation: (raw) => {
                const provider = raw.providerSettingsV1 as Record<string, unknown>;
                return {
                    ...raw,
                    providerSettingsV1: { ...provider, machineGrants: [] },
                };
            },
        });

        const postBodies = mocks.serverFetch.mock.calls
            .filter((call) => call[1]?.method === 'POST')
            .map((call) => JSON.parse(String(call[1]?.body)) as { content: { c: string }; expectedVersion: number });
        expect(postBodies.map((body) => body.expectedVersion)).toEqual([4, 5]);
        const committed = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            ciphertext: postBodies[1]!.content.c,
        })?.value as Record<string, any>;
        expect(committed.providerSettingsV1.machineGrants).toEqual([]);
        expect(committed.providerSettingsV1.manualModelsByConnectionId).toEqual({
            'pc-a': [{ id: 'concurrent/model', addedAt: 9 }],
        });
    });

    it('preserves canonical Voice settings and diagnostics across a crash-recovered sparse delta and CAS retry', async () => {
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
        } as unknown as Encryption;
        const initialDiagnostics = {
            v: 1,
            enabled: true,
            consentVersion: 1,
            captureSttInput: true,
            captureTtsOutput: false,
            maxAgeMs: 12 * 60 * 60 * 1_000,
            maxFiles: 7,
            maxBytes: 4 * 1024 * 1024,
            maxDurationMs: 60_000,
        } as const;
        const concurrentDiagnostics = {
            ...initialDiagnostics,
            maxFiles: 8,
        } as const;
        const canonicalVoice = {
            providerId: 'realtime_codex',
            providers: {
                realtime_codex: {
                    schemaVersion: 2,
                    config: {
                        globalConnectedServices: {
                            v: 1,
                            bindingsByServiceId: {
                                'openai-codex': {
                                    source: 'connected',
                                    selection: 'profile',
                                    profileId: 'codex-work-profile',
                                },
                            },
                        },
                    },
                },
            },
        } as const;
        const initialCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                voiceDiagnosticsV1: initialDiagnostics,
                voiceSettingsV1: canonicalVoice,
                voice: { assistantLanguage: 'en' },
            },
            randomBytes: mocks.getRandomBytes,
        });
        const concurrentCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: {
                voiceDiagnosticsV1: concurrentDiagnostics,
                voiceSettingsV1: canonicalVoice,
                voice: { assistantLanguage: 'fr' },
            },
            randomBytes: mocks.getRandomBytes,
        });
        mocks.serverFetch
            .mockResolvedValueOnce(new Response(JSON.stringify({ mode: 'e2ee', updatedAt: Date.now() }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                content: { t: 'encrypted', c: initialCiphertext }, version: 4,
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                success: false,
                error: 'version-mismatch',
                currentVersion: 5,
                currentContent: { t: 'encrypted', c: concurrentCiphertext },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, version: 6 }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            }));

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            // Historical crash-recovered pending shape from before the top-level owner existed.
            pendingSettings: {
                voice: { assistantLanguage: 'de' },
            } as unknown as Parameters<typeof syncSettings>[0]['pendingSettings'],
            clearPendingSettings: vi.fn(),
        });

        const committed = mocks.serverFetch.mock.calls
            .filter((call) => call[1]?.method === 'POST')
            .map((call) => {
                const body = JSON.parse(String(call[1]?.body)) as { content: { c: string } };
                return openAccountScopedBlobCiphertext({
                    kind: 'account_settings',
                    material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
                    ciphertext: body.content.c,
                })?.value as Record<string, unknown>;
            });

        expect(committed).toHaveLength(2);
        expect(committed[0]?.voiceDiagnosticsV1).toEqual(initialDiagnostics);
        expect(committed[1]?.voiceDiagnosticsV1).toEqual(concurrentDiagnostics);
        expect(committed[1]?.voiceSettingsV1).toMatchObject({
            providerId: 'realtime_codex',
            assistantLanguage: 'de',
            providers: canonicalVoice.providers,
        });
        expect(committed[1]?.voice).toEqual(expect.objectContaining({ assistantLanguage: 'de' }));
        expect(committed[1]?.voice).not.toHaveProperty('diagnostics');
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
                new Response(JSON.stringify({ content: { t: 'encrypted', c: serverCiphertext }, version: 9 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
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

        expect(mocks.serverFetch).toHaveBeenCalled();
        const [url, init] = mocks.serverFetch.mock.calls[0];
        expect(url).toBe('/v1/account/encryption');
        expect(init?.method).toBe('GET');

        const [url2, init2] = mocks.serverFetch.mock.calls[1];
        expect(url2).toBe('/v2/account/settings');
        expect(init2?.method ?? 'GET').toBe('GET');

        const [url3, init3] = mocks.serverFetch.mock.calls[2];
        expect(url3).toBe('/v2/account/settings');
        expect(init3?.method).toBe('POST');
        expect(typeof init3?.body).toBe('string');

        const body = JSON.parse(String(init3?.body)) as { content?: { t?: unknown; c?: unknown } };
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
            }),
        );

        expect((encryptionStub.encryptRaw as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('preserves raw server fields not touched by a pending setting', async () => {
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
                profiles: 'malformed-known-field',
                futureServerOnly: { keep: true },
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
                new Response(JSON.stringify({ content: { t: 'encrypted', c: serverCiphertext }, version: 15 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 16 }), {
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

        const post = mocks.serverFetch.mock.calls.find(
            ([url, init]) => url === '/v2/account/settings' && init?.method === 'POST',
        );
        expect(post).toBeTruthy();
        const body = JSON.parse(String(post?.[1]?.body ?? 'null')) as { content?: { t?: unknown; c?: unknown } };
        const opened = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            ciphertext: String(body.content?.c ?? ''),
        });
        expect(opened?.value).toEqual(expect.objectContaining({
            profiles: 'malformed-known-field',
            futureServerOnly: { keep: true },
            claudeLocalPermissionBridgeEnabled: true,
        }));
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

    it('imports legacy session organization settings and strips them from account settings storage', async () => {
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
                workspaceLabelsV1: {
                    'server:srv_identity:workspaces': 'Legacy Workspace',
                },
            },
            randomBytes: mocks.getRandomBytes,
        });
        const emptySnapshot = {
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
        };

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
            );
        mocks.runtimeFetchWithServerReachability
            .mockResolvedValueOnce(
                new Response(JSON.stringify(emptySnapshot), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({
                    imported: {
                        pins: 2,
                        folders: 0,
                        tags: 2,
                        orderEntries: 4,
                        labels: 1,
                    },
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify(emptySnapshot), {
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
        expect(mocks.runtimeFetchWithServerReachability.mock.calls.map(([params]) => [
            String(params.url).replace('http://127.0.0.1:3009', ''),
            params.init?.method ?? 'GET',
        ])).toEqual([
            [
                '/v2/session-organization?includeFolders=true&includeTags=true&includeLabels=true&includeAllFolderAssignments=true&includeAllTagAssignments=true',
                'GET',
            ],
            ['/v2/session-organization/import', 'POST'],
            [
                '/v2/session-organization?includeFolders=true&includeTags=true&includeLabels=true&includeAllTagAssignments=true',
                'GET',
            ],
        ]);
        const importCall = mocks.runtimeFetchWithServerReachability.mock.calls.find(([params]) => {
            return String(params.url).endsWith('/v2/session-organization/import');
        });
        expect(importCall).toBeTruthy();
        const importBody = JSON.parse(String(importCall?.[0].init?.body ?? 'null'));
        expect(importBody.pins).toEqual([
            { sessionId: 'session-a', sortKey: '00000001' },
            { sessionId: 'session-b', sortKey: '00000002' },
        ]);
        expect(importBody.tags).toEqual([
            {
                tagId: 'legacy-tag',
                tagKey: 'legacy-tag',
                sortKey: '00000001',
                display: expect.objectContaining({ t: 'encrypted' }),
            },
            {
                tagId: 'identity-tag',
                tagKey: 'identity-tag',
                sortKey: '00000002',
                display: expect.objectContaining({ t: 'encrypted' }),
            },
        ]);
        expect(importBody.tagAssignments).toEqual([
            { sessionId: 'session-a', tagIds: ['legacy-tag'] },
            { sessionId: 'session-b', tagIds: ['identity-tag'] },
        ]);
        expect(importBody.orderEntries).toEqual(expect.arrayContaining([
            {
                scopeKind: 'group',
                scopeKey: 'server:srv_identity:active:project:p1',
                itemKind: 'session',
                itemKey: 'session-a',
                sortKey: '00000001',
            },
            {
                scopeKind: 'group',
                scopeKey: 'server:srv_identity:active:project:p2',
                itemKind: 'session',
                itemKey: 'session-c',
                sortKey: '00000001',
            },
            {
                scopeKind: 'pinned',
                scopeKey: 'pins',
                itemKind: 'session',
                itemKey: 'session-a',
                sortKey: '00000001',
            },
            {
                scopeKind: 'workspace',
                scopeKey: 'srv_identity',
                itemKind: 'workspace',
                itemKey: 'legacy',
                sortKey: '00000001',
            },
        ]));
        expect(importBody.labels).toEqual([
            {
                labelKind: 'workspace',
                scopeKey: 'server:srv_identity:workspaces',
                display: expect.objectContaining({ t: 'encrypted' }),
            },
        ]);
        expect(mocks.persistenceSet.mock.calls).toEqual([
            [expect.stringMatching(/^session-organization:legacy-import:v1:/), '1'],
        ]);
        expect(mocks.storageStoreState.applySessionOrganizationSnapshot).toHaveBeenCalledWith(
            'srv_identity',
            emptySnapshot.snapshot,
            expect.objectContaining({
                includeFolders: true,
                includeTags: true,
                includeLabels: true,
                includeAllTagAssignments: true,
            }),
        );

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
        const postedSettings = opened?.value as Record<string, unknown> | undefined;
        expect(postedSettings).toEqual(expect.objectContaining({ analyticsOptOut: false }));
        expect(postedSettings?.pinnedSessionKeysV1).toBeUndefined();
        expect(postedSettings?.sessionTagsV1).toBeUndefined();
        expect(postedSettings?.sessionListGroupOrderV1).toBeUndefined();
        expect(postedSettings?.sessionWorkspaceOrderV1).toBeUndefined();
        expect(postedSettings?.sessionFoldersV1).toBeUndefined();
        expect(postedSettings?.workspaceLabelsV1).toBeUndefined();
        expect(postedSettings?.serverSelectionGroups).toBeUndefined();
        expect(mocks.storageState.applySettingsForScope).toHaveBeenLastCalledWith(
            { serverId: 'srv_identity', accountId: 'account-a' },
            expect.any(Object),
            expect.any(Number),
        );
        const appliedSettings = mocks.storageState.applySettingsForScope.mock.calls[
            mocks.storageState.applySettingsForScope.mock.calls.length - 1
        ]?.[1] as Record<string, unknown>;
        expect(appliedSettings.pinnedSessionKeysV1).toBeUndefined();
        expect(appliedSettings.sessionTagsV1).toBeUndefined();
        expect(appliedSettings.sessionListGroupOrderV1).toBeUndefined();
        expect(appliedSettings.sessionWorkspaceOrderV1).toBeUndefined();
        expect(appliedSettings.sessionFoldersV1).toBeUndefined();
        expect(appliedSettings.workspaceLabelsV1).toBeUndefined();
    });

    it('preserves other-server legacy organization settings while cleaning the imported scope', async () => {
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
                pinnedSessionKeysV1: ['localhost-52753:session-a', 'other-server:session-b'],
                sessionFoldersV1: {
                    v: 1,
                    folders: [
                        {
                            id: 'folder-current',
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 'localhost-52753',
                                machineId: 'machine-a',
                                rootPath: '/repo',
                            },
                            parentId: null,
                            name: 'Current',
                            createdAt: 1,
                            updatedAt: 1,
                        },
                        {
                            id: 'folder-other',
                            workspace: {
                                t: 'workspaceScope',
                                serverId: 'other-server',
                                machineId: 'machine-b',
                                rootPath: '/other',
                            },
                            parentId: null,
                            name: 'Other',
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    ],
                },
                sessionTagsV1: {
                    'localhost-52753:session-a': ['current-tag'],
                    'other-server:session-b': ['other-tag'],
                },
                sessionListGroupOrderV1: {
                    'pinned-v1': ['localhost-52753:session-a', 'other-server:session-b', 'folder:folder-current'],
                    'server:localhost-52753:active:project:p1': ['localhost-52753:session-a'],
                    'server:other-server:active:project:p2': ['other-server:session-b'],
                },
                sessionWorkspaceOrderV1: {
                    'server:localhost-52753:workspaces': ['workspace:/repo'],
                    'server:other-server:workspaces': ['workspace:/other'],
                },
                workspaceLabelsV1: {
                    'server:localhost-52753:workspaces': 'Current Workspace',
                    'server:other-server:workspaces': 'Other Workspace',
                },
            },
            randomBytes: mocks.getRandomBytes,
        });
        const emptySnapshot = {
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
        };

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ mode: 'e2ee', updatedAt: Date.now() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: fetchedCiphertext }, version: 41 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 42 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );
        mocks.runtimeFetchWithServerReachability
            .mockResolvedValueOnce(
                new Response(JSON.stringify(emptySnapshot), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({
                    imported: {
                        pins: 1,
                        folders: 1,
                        tags: 1,
                        orderEntries: 4,
                        labels: 1,
                    },
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify(emptySnapshot), {
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

        const cleanupBody = JSON.parse(String(mocks.serverFetch.mock.calls[2]?.[1]?.body)) as {
            content?: { t?: unknown; c?: unknown };
        };
        const openedCleanup = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            ciphertext: String(cleanupBody.content?.c ?? ''),
        });

        expect(openedCleanup?.value).toEqual(expect.objectContaining({
            analyticsOptOut: false,
            pinnedSessionKeysV1: ['other-server:session-b'],
            sessionFoldersV1: {
                v: 1,
                folders: [
                    {
                        id: 'folder-other',
                        workspace: {
                            t: 'workspaceScope',
                            serverId: 'other-server',
                            machineId: 'machine-b',
                            rootPath: '/other',
                        },
                        parentId: null,
                        name: 'Other',
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
            sessionTagsV1: {
                'other-server:session-b': ['other-tag'],
            },
            sessionListGroupOrderV1: {
                'pinned-v1': ['other-server:session-b'],
                'server:other-server:active:project:p2': ['other-server:session-b'],
            },
            sessionWorkspaceOrderV1: {
                'server:other-server:workspaces': ['workspace:/other'],
            },
            workspaceLabelsV1: {
                'server:other-server:workspaces': 'Other Workspace',
            },
        }));
    });

    it('applies an already-imported session organization snapshot before marking legacy settings consumed', async () => {
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
                pinnedSessionKeysV1: ['srv_identity:session-a'],
            },
            randomBytes: mocks.getRandomBytes,
        });
        const existingSnapshot = {
            schemaVersion: 1,
            version: 4,
            pins: [{
                sessionId: 'session-a',
                sortKey: '00000001',
                pinnedAt: 123,
            }],
            folders: [],
            folderAssignments: [],
            tags: [],
            tagAssignments: [],
            orderEntries: [],
            labels: [],
        };

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ mode: 'e2ee', updatedAt: Date.now() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: fetchedCiphertext }, version: 51 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 52 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );
        mocks.runtimeFetchWithServerReachability.mockResolvedValueOnce(
            new Response(JSON.stringify({ snapshot: existingSnapshot }), {
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

        expect(mocks.runtimeFetchWithServerReachability.mock.calls.map(([params]) => [
            String(params.url).replace('http://127.0.0.1:3009', ''),
            params.init?.method ?? 'GET',
        ])).toEqual([
            [
                '/v2/session-organization?includeFolders=true&includeTags=true&includeLabels=true&includeAllFolderAssignments=true&includeAllTagAssignments=true',
                'GET',
            ],
        ]);
        expect(mocks.storageStoreState.applySessionOrganizationSnapshot).toHaveBeenCalledWith(
            'srv_identity',
            existingSnapshot,
            expect.objectContaining({
                includeFolders: true,
                includeTags: true,
                includeLabels: true,
                includeAllTagAssignments: true,
            }),
        );
        expect(mocks.persistenceSet.mock.calls).toEqual([
            [expect.stringMatching(/^session-organization:legacy-import:v1:/), '1'],
        ]);
    });

    it('imports legacy-only pending organization settings before clearing pending storage', async () => {
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
            decryptRaw: vi.fn(async () => {
                throw new Error('decryptRaw should not be used for canonical account settings ciphertext');
            }),
        } as unknown as Encryption;
        const serverCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: { analyticsOptOut: false },
            randomBytes: mocks.getRandomBytes,
        });
        const emptySnapshot = {
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
        };
        const clearPendingSettings = vi.fn();

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ mode: 'e2ee', updatedAt: Date.now() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ content: { t: 'encrypted', c: serverCiphertext }, version: 21 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );
        mocks.runtimeFetchWithServerReachability
            .mockResolvedValueOnce(
                new Response(JSON.stringify(emptySnapshot), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({
                    imported: {
                        pins: 1,
                        folders: 0,
                        tags: 0,
                        orderEntries: 0,
                        labels: 0,
                    },
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify(emptySnapshot), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            settingsScope: { serverId: 'srv_identity', accountId: 'account-a' },
            pendingSettings: {
                pinnedSessionKeysV1: ['srv_identity:pending-session'],
            } as any,
            clearPendingSettings,
        });

        expect(mocks.serverFetch.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET'])).toEqual([
            ['/v1/account/encryption', 'GET'],
            ['/v2/account/settings', 'GET'],
        ]);
        const importCall = mocks.runtimeFetchWithServerReachability.mock.calls.find(([params]) => {
            return String(params.url).endsWith('/v2/session-organization/import');
        });
        expect(importCall).toBeTruthy();
        const importBody = JSON.parse(String(importCall?.[0].init?.body ?? 'null'));
        expect(importBody.pins).toEqual([
            { sessionId: 'pending-session', sortKey: '00000001' },
        ]);
        expect(clearPendingSettings).toHaveBeenCalledWith({});
    });

    it('keeps pending legacy organization settings when mixed pending import fails', async () => {
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
            decryptRaw: vi.fn(async () => {
                throw new Error('decryptRaw should not be used for canonical account settings ciphertext');
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
                new Response(JSON.stringify({ content: { t: 'encrypted', c: serverCiphertext }, version: 31 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, version: 32 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );
        mocks.runtimeFetchWithServerReachability.mockResolvedValueOnce(
            new Response(JSON.stringify({ error: 'temporary' }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' },
            }),
        );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            settingsScope: { serverId: 'srv_identity', accountId: 'account-a' },
            pendingSettings: {
                claudeLocalPermissionBridgeEnabled: true,
                pinnedSessionKeysV1: ['srv_identity:pending-session'],
            } as any,
            clearPendingSettings,
        });

        expect(mocks.runtimeFetchWithServerReachability).toHaveBeenCalledTimes(1);
        expect(clearPendingSettings).toHaveBeenCalledWith({
            pinnedSessionKeysV1: ['srv_identity:pending-session'],
        });
        expect(mocks.persistenceSet).not.toHaveBeenCalled();
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
        ]);
        expect(mocks.runtimeFetchWithServerReachability).not.toHaveBeenCalled();
        expect(mocks.persistenceSet.mock.calls).toEqual([
            [expect.stringMatching(/^session-organization:legacy-import:v1:/), '1'],
        ]);
        expect(mocks.storageState.applySettingsForScope).toHaveBeenLastCalledWith(
            { serverId: 'localhost-52753', accountId: 'account-a' },
            expect.any(Object),
            12,
        );
        const appliedHostSettings = mocks.storageState.applySettingsForScope.mock.calls[
            mocks.storageState.applySettingsForScope.mock.calls.length - 1
        ]?.[1] as Record<string, unknown>;
        expect(appliedHostSettings.sessionListGroupOrderV1).toEqual({
            'server:192.168.1.115-52753:active:project:p2': ['192.168.1.115-52753:session-c'],
        });
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
});
