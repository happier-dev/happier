import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import {
    ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION,
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
            settingsVersion: 7,
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

// The restore owner exercises Account Settings semantics only; generated
// Voice manifest validation has its own producer tests and build lane.
vi.mock('@/voice/registry/generatedBundledVoiceEntries', () => ({
    BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS: Object.freeze([]),
    BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS: Object.freeze([]),
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
    projectRuntimeAccountSettings: <T,>(settings: T): T => settings,
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

import { restoreAccountSettingsFromHistorySnapshot } from './accountSettingsHistoryRestore';

const credentials: AuthCredentials = {
    token: 'token',
    encryption: {
        publicKey: 'public',
        machineKey: 'machine',
    },
};

const TEST_MACHINE_KEY = new Uint8Array(32).fill(11);

const ENCRYPTION_STUB = {
    getContentPrivateKey: () => TEST_MACHINE_KEY,
} as unknown as Encryption;

/** Legacy entity root (classification `legacy`) must survive restore unchanged. */
const LATEST_BASELINE = {
    sessionTmuxSessionName: 'new-name',
    profiles: [{ id: 'profile-current' }],
    pinnedSessionKeysV1: ['retired-root'],
    schemaVersion: 2,
};

/** An older snapshot: preferences moved, legacy root older, retired roots gone. */
const HISTORY_SNAPSHOT = {
    sessionTmuxSessionName: 'old-name',
    preferredLanguage: 'de',
    profiles: [{ id: 'profile-ancient' }],
};

/** preference restore + legacy carry + retired strip + current schemaVersion. */
const MERGED_BASELINE = {
    sessionTmuxSessionName: 'old-name',
    preferredLanguage: 'de',
    profiles: [{ id: 'profile-current' }],
    schemaVersion: ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION,
};

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('classification-aware account settings history restore', () => {
    beforeEach(() => {
        invalidateAccountEncryptionModeCache();
        mocks.serverFetch.mockReset();
        mocks.runtimeFetchWithServerReachability.mockReset();
        mocks.applySettingsFn.mockClear();
        mocks.settingsParse.mockClear();
        mocks.getRandomBytes.mockClear();
        mocks.persistenceValues.clear();
        mocks.persistenceSet.mockClear();
        mocks.storageState.settings = {
            analyticsOptOut: false,
        };
        mocks.storageState.settingsVersion = 7;
        mocks.storageState.applySettings.mockClear();
        mocks.storageState.replaceSettings.mockClear();
        mocks.storageState.applySettingsForScope.mockClear();
        mocks.storageState.replaceSettingsForScope.mockClear();
        mocks.storageState.applySettingsLocal.mockClear();
    });

    it('merges the recorded snapshot into the latest baseline under current classification and CASes it in plain mode', async () => {
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') {
                return jsonResponse({ mode: 'plain', updatedAt: Date.now() });
            }
            if (path === '/v2/account/settings' && (init?.method ?? 'GET') === 'GET') {
                return jsonResponse({ content: { t: 'plain', v: LATEST_BASELINE }, version: 7 });
            }
            if (path === '/v2/account/settings/history/3') {
                return jsonResponse({
                    content: { t: 'plain', v: HISTORY_SNAPSHOT },
                    version: 3,
                    createdAt: '2026-01-01T00:00:00.000Z',
                });
            }
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                return jsonResponse({ success: true, version: 8 });
            }
            throw new Error(`Unexpected settings request: ${path} ${String(init?.method)}`);
        });

        await expect(restoreAccountSettingsFromHistorySnapshot({
            credentials,
            encryption: null,
            historyVersion: 3,
            expectedSettingsVersion: 7,
        })).resolves.toEqual({ status: 'applied', settingsVersion: 8 });

        const post = mocks.serverFetch.mock.calls.find(
            ([url, init]) => url === '/v2/account/settings' && init?.method === 'POST',
        );
        expect(post).toBeTruthy();
        const body = JSON.parse(String(post?.[1]?.body ?? 'null')) as {
            content: { t: string; v: unknown };
            expectedVersion: number;
        };
        expect(body).toEqual({ content: { t: 'plain', v: MERGED_BASELINE }, expectedVersion: 7 });
        expect(mocks.storageState.applySettings).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionTmuxSessionName: 'old-name',
                preferredLanguage: 'de',
            }),
            8,
        );
    });

    it('skips the ordinary CAS write when the classification merge is unchanged', async () => {
        const same = {
            sessionTmuxSessionName: 'same',
            schemaVersion: ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION,
        };
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') {
                return jsonResponse({ mode: 'plain', updatedAt: Date.now() });
            }
            if (path === '/v2/account/settings' && (init?.method ?? 'GET') === 'GET') {
                return jsonResponse({ content: { t: 'plain', v: same }, version: 7 });
            }
            if (path === '/v2/account/settings/history/3') {
                return jsonResponse({
                    content: { t: 'plain', v: same },
                    version: 3,
                    createdAt: '2026-01-01T00:00:00.000Z',
                });
            }
            throw new Error(`Unexpected settings request: ${path} ${String(init?.method)}`);
        });

        await expect(restoreAccountSettingsFromHistorySnapshot({
            credentials,
            encryption: null,
            historyVersion: 3,
            expectedSettingsVersion: 7,
        })).resolves.toEqual({ status: 'unchanged', settingsVersion: 7 });
        expect(mocks.serverFetch.mock.calls.filter(([, init]) => init?.method === 'POST'))
            .toHaveLength(0);
    });

    it('reports a typed conflict after a version move and never replays the restore', async () => {
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') {
                return jsonResponse({ mode: 'plain', updatedAt: Date.now() });
            }
            if (path === '/v2/account/settings' && (init?.method ?? 'GET') === 'GET') {
                return jsonResponse({ content: { t: 'plain', v: LATEST_BASELINE }, version: 7 });
            }
            if (path === '/v2/account/settings/history/3') {
                return jsonResponse({
                    content: { t: 'plain', v: HISTORY_SNAPSHOT },
                    version: 3,
                    createdAt: '2026-01-01T00:00:00.000Z',
                });
            }
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                return jsonResponse({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: 9,
                    currentContent: { t: 'plain', v: LATEST_BASELINE },
                });
            }
            throw new Error(`Unexpected settings request: ${path} ${String(init?.method)}`);
        });

        await expect(restoreAccountSettingsFromHistorySnapshot({
            credentials,
            encryption: null,
            historyVersion: 3,
            expectedSettingsVersion: 7,
        })).resolves.toEqual({ status: 'conflict', currentSettingsVersion: 9 });

        expect(mocks.serverFetch.mock.calls.filter(([, init]) => init?.method === 'POST'))
            .toHaveLength(1);
    });

    it('opens a plain-recorded snapshot on an e2ee account and reseals the merged document to the current mode', async () => {
        const latestCiphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: LATEST_BASELINE,
            randomBytes: mocks.getRandomBytes,
        });
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') {
                return jsonResponse({ mode: 'e2ee', updatedAt: Date.now() });
            }
            if (path === '/v2/account/settings' && (init?.method ?? 'GET') === 'GET') {
                return jsonResponse({ content: { t: 'encrypted', c: latestCiphertext }, version: 7 });
            }
            // Recorded before the Account switched to E2EE: the stored snapshot is plain.
            if (path === '/v2/account/settings/history/3') {
                return jsonResponse({
                    content: { t: 'plain', v: HISTORY_SNAPSHOT },
                    version: 3,
                    createdAt: '2026-01-01T00:00:00.000Z',
                });
            }
            if (path === '/v2/account/settings' && init?.method === 'POST') {
                return jsonResponse({ success: true, version: 8 });
            }
            throw new Error(`Unexpected settings request: ${path} ${String(init?.method)}`);
        });

        await expect(restoreAccountSettingsFromHistorySnapshot({
            credentials,
            encryption: ENCRYPTION_STUB,
            historyVersion: 3,
            expectedSettingsVersion: 7,
        })).resolves.toEqual({ status: 'applied', settingsVersion: 8 });

        const post = mocks.serverFetch.mock.calls.find(
            ([url, init]) => url === '/v2/account/settings' && init?.method === 'POST',
        );
        const body = JSON.parse(String(post?.[1]?.body ?? 'null')) as {
            content: { t: string; c: string };
            expectedVersion: number;
        };
        expect(body.expectedVersion).toBe(7);
        expect(body.content.t).toBe('encrypted');
        const opened = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            ciphertext: body.content.c,
        });
        expect(opened?.value).toEqual(MERGED_BASELINE);
    });

    it('fails typed without writing when a historical preference cannot satisfy its current schema', async () => {
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') {
                return jsonResponse({ mode: 'plain', updatedAt: Date.now() });
            }
            if (path === '/v2/account/settings/history/3') {
                return jsonResponse({
                    content: { t: 'plain', v: { preferredLanguage: 42 } },
                    version: 3,
                    createdAt: '2026-01-01T00:00:00.000Z',
                });
            }
            if (path === '/v2/account/settings' && (init?.method ?? 'GET') === 'GET') {
                return jsonResponse({ content: { t: 'plain', v: LATEST_BASELINE }, version: 7 });
            }
            throw new Error(`Unexpected settings request: ${path} ${String(init?.method)}`);
        });

        await expect(restoreAccountSettingsFromHistorySnapshot({
            credentials,
            encryption: null,
            historyVersion: 3,
            expectedSettingsVersion: 7,
        })).rejects.toMatchObject({
            name: 'AccountSettingsHistoryRestoreInvalidError',
            reason: 'invalidValue',
        });
        expect(mocks.serverFetch.mock.calls.filter(([, init]) => init?.method === 'POST'))
            .toHaveLength(0);
    });
});
