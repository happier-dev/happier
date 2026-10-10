import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import {
    ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION,
    openAccountScopedBlobCiphertext,
    sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';

const mocks = vi.hoisted(() => {
    return {
        getRandomBytes: vi.fn((length: number) => new Uint8Array(length).fill(4)),
        serverFetch: vi.fn(),
        createServerFetchAtEndpoint: vi.fn(),
        activeLifetime: {
            scope: { serverId: 'server-a', accountId: 'account-a' },
            current: true,
            retireCallback: null as (() => void) | null,
        },
        runtimeFetchWithServerReachability: vi.fn(),
        persistenceValues: new Map<string, string>(),
        persistenceSet: vi.fn(),
        transferControl: { status: 'absent' } as unknown,
        analyticsOptIn: vi.fn(),
        analyticsOptOut: vi.fn(),
        realSettingsState: null as (() => unknown) | null,
        storageState: {
            settings: {
                analyticsOptOut: false,
            } as Record<string, unknown>,
            settingsVersion: 7,
            settingsScope: { serverId: 'server-a', accountId: 'account-a' } as {
                serverId: string;
                accountId: string;
            } | null,
            applySettings: vi.fn(),
            applySettingsForScope: vi.fn(),
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
    // PostHog is an external telemetry boundary; Settings decisions remain real.
    tracking: { optIn: mocks.analyticsOptIn, optOut: mocks.analyticsOptOut },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key, translateLoose: (key: string) => key });
});

// Language application is a presentation side effect, not the Settings storage contract.
vi.mock('@/text/i18n', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return { ...createTextModuleMock({ translate: (key: string) => key, translateLoose: (key: string) => key }),
        areTranslationsReadyForSettings: () => true, preloadTranslationsForSettings: async () => {} };
});

vi.mock('@/utils/errors/errors', () => ({
    HappyError: class HappyError extends Error {
        constructor(message: string) {
            super(message);
        }
    },
}));

vi.mock('@/sync/domains/settings/debugSettings', () => ({
    summarizeSettings: () => ({}),
    summarizeSettingsDelta: () => ({}),
    dbgSettings: () => {},
    isSettingsSyncDebugEnabled: () => false,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'server-a',
        serverUrl: 'http://127.0.0.1:3009',
        generation: 1,
    }),
    getActiveServerHomeCarrier: () => null,
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => ({
        scope: mocks.activeLifetime.scope,
        isCurrent: () => mocks.activeLifetime.current,
        onRetire: (callback: () => void) => {
            mocks.activeLifetime.retireCallback = callback;
            return { dispose: () => { mocks.activeLifetime.retireCallback = null; } };
        },
    }),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getServerProfileById: () => null,
    getServerProfileLegacyServerIds: () => ['localhost-52753'],
    resolveServerProfileScopeId: () => '',
    listServerProfiles: () => [{ id: 'server-a', serverUrl: 'http://127.0.0.1:3009', name: 'A' }],
    loadHomeViewState: () => null,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => mocks.realSettingsState?.() ?? mocks.storageState,
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

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
    createServerFetchAtEndpoint: mocks.createServerFetchAtEndpoint,
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

import { normalizeAccountSettingsHistoryAfterTransfer, purgeAccountSettingsHistoryVersions, restoreAccountSettingsFromHistorySnapshot } from './accountSettingsHistoryRestore';
import { createSettingsDomain } from '@/sync/store/domains/settings';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { loadAccountSettings, saveAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { applyCrashReportsOptOut } from '@/utils/system/sentry';
import { encodeBase64 } from '@/encryption/base64';

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
const SETTINGS_SCOPE = { serverId: 'server-a', accountId: 'account-a' } as const;

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
    beforeEach(async () => {
        await TokenStorage.setCredentialsForServerUrl('http://127.0.0.1:3009', { serverId: 'server-a' }, credentials);
        invalidateAccountEncryptionModeCache();
        mocks.serverFetch.mockReset();
        mocks.createServerFetchAtEndpoint.mockReset();
        mocks.transferControl = { status: 'absent' };
        mocks.createServerFetchAtEndpoint.mockImplementation(() => async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/entity-rows/profiles/transfer') return jsonResponse(mocks.transferControl);
            if (path === '/v1/account/entity-rows/prompt-library') return jsonResponse({}, 404);
            return await mocks.serverFetch(path, init);
        });
        mocks.activeLifetime.scope = SETTINGS_SCOPE;
        mocks.activeLifetime.current = true;
        mocks.activeLifetime.retireCallback = null;
        mocks.realSettingsState = null;
        mocks.runtimeFetchWithServerReachability.mockReset();
        mocks.getRandomBytes.mockClear();
        mocks.persistenceValues.clear();
        mocks.persistenceSet.mockClear();
        mocks.analyticsOptIn.mockClear();
        mocks.analyticsOptOut.mockClear();
        mocks.storageState.settings = {
            analyticsOptOut: false,
        };
        mocks.storageState.settingsVersion = 7;
        mocks.storageState.settingsScope = SETTINGS_SCOPE;
        mocks.storageState.applySettings.mockClear();
        mocks.storageState.applySettingsForScope.mockClear();
        mocks.storageState.applySettingsLocal.mockClear();
    });

    it('normalizes transferred history roots without altering retained preferences or future fields', async () => {
        mocks.transferControl = { status: 'present', revision: 2, content: { t: 'plain', v: {
            v: 1, phase: 'active', sourceSettingsVersion: 6, migratedLogicalRevision: 1, inventory: [],
        } } };
        const historical = { t: 'plain', v: { profiles: [{ id: 'old' }], preferredLanguage: 'de', futureSetting: { keep: true } } };
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption/currentness') return jsonResponse({ mode: 'plain', version: 2, settingsVersion: 7,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            if (path === '/v2/account/settings/history') return jsonResponse({ snapshots: [{ version: 6,
                createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 100 }] });
            if (path === '/v2/account/settings/history/6') return jsonResponse({ content: historical, version: 6,
                createdAt: '2026-01-01T00:00:00.000Z' });
            if (path === '/v2/account/settings/history/6/mutate' && init?.method === 'POST') return jsonResponse({ status: 'applied' });
            throw new Error(`Unexpected request ${path}`);
        });
        await expect(normalizeAccountSettingsHistoryAfterTransfer({ credentials, encryption: null, settingsScope: SETTINGS_SCOPE,
            destinationAuthority: { activeTransferredRoots: ['profiles'] } })).resolves.toEqual({ status: 'complete' });
        const post = mocks.serverFetch.mock.calls.find(([path]) => path === '/v2/account/settings/history/6/mutate');
        expect(JSON.parse(String(post?.[1]?.body))).toEqual({ expectedSettingsVersion: 7,
            expectedProfileTransferRevision: 2,
            expectedEncryptionCurrentness: { mode: 'plain', signingKeyFingerprint: null, contentKeyFingerprint: null },
            expectedContent: historical, operation: { kind: 'normalize', removedRoots: ['profiles', 'secretBindingsByProfileId'],
                transferredProfileIds: [],
                content: { t: 'plain', v: { preferredLanguage: 'de', futureSetting: { keep: true } } } } });
    });

    it('purges only the explicitly addressed version without opening unreadable history', async () => {
        mocks.serverFetch.mockImplementation(async (path: string) => {
            if (path === '/v1/account/encryption/currentness') return jsonResponse({ mode: 'plain', version: 2, settingsVersion: 7,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            if (path === '/v2/account/settings/history/6/mutate') return jsonResponse({ status: 'applied' });
            throw new Error(`Unexpected request ${path}`);
        });
        expect(await purgeAccountSettingsHistoryVersions({ credentials, settingsScope: SETTINGS_SCOPE, versions: [6] }))
            .toEqual({ status: 'complete' });
        const post = mocks.serverFetch.mock.calls.find(([path]) => path === '/v2/account/settings/history/6/mutate');
        expect(JSON.parse(String(post?.[1]?.body))).toEqual({ expectedSettingsVersion: 7, expectedProfileTransferRevision: 'absent',
            expectedEncryptionCurrentness: { mode: 'plain', signingKeyFingerprint: null, contentKeyFingerprint: null },
            operation: { kind: 'purge' } });
    });

    it('leaves the inventoried versions pending when the source-cleanup control changed before history normalization', async () => {
        mocks.transferControl = { status: 'present', revision: 2, content: { t: 'plain', v: {
            v: 1, phase: 'active', sourceSettingsVersion: 6, migratedLogicalRevision: 1, inventory: [],
        } } };
        mocks.serverFetch.mockImplementation(async (path: string) => {
            if (path === '/v1/account/encryption/currentness') return jsonResponse({ mode: 'plain', version: 2, settingsVersion: 7,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            if (path === '/v2/account/settings/history') return jsonResponse({ snapshots: [{ version: 6,
                createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 100 }] });
            if (path === '/v2/account/settings/history/6') return jsonResponse({ content: { t: 'plain', v: { profiles: [{ id: 'old' }] } },
                version: 6, createdAt: '2026-01-01T00:00:00.000Z' });
            if (path === '/v2/account/settings/history/6/mutate') return jsonResponse({ status: 'applied' });
            throw new Error(`Unexpected request ${path}`);
        });
        const params = { credentials, encryption: null, settingsScope: SETTINGS_SCOPE,
            destinationAuthority: { activeTransferredRoots: ['profiles'] }, expectedProfileTransferRevision: 1 };
        expect(await normalizeAccountSettingsHistoryAfterTransfer(params)).toEqual({ status: 'cleanup-pending', versions: [6] });
        expect(mocks.serverFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    });

    it('leaves an unopenable exact encrypted version cleanup-pending without purging history', async () => {
        mocks.transferControl = { status: 'present', revision: 2, content: { t: 'plain', v: {
            v: 1, phase: 'active', sourceSettingsVersion: 6, migratedLogicalRevision: 1, inventory: [],
        } } };
        mocks.serverFetch.mockImplementation(async (path: string) => {
            if (path === '/v1/account/encryption/currentness') return jsonResponse({ mode: 'plain', version: 2, settingsVersion: 7,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            if (path === '/v2/account/settings/history') return jsonResponse({ snapshots: [{ version: 6,
                createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'encrypted', byteLength: 100 }] });
            if (path === '/v2/account/settings/history/6') return jsonResponse({ content: { t: 'encrypted', c: 'locked' }, version: 6,
                createdAt: '2026-01-01T00:00:00.000Z' });
            throw new Error(`Unexpected request ${path}`);
        });
        await expect(normalizeAccountSettingsHistoryAfterTransfer({ credentials, encryption: null, settingsScope: SETTINGS_SCOPE,
            destinationAuthority: { activeTransferredRoots: ['profiles'] } })).resolves.toEqual({ status: 'cleanup-pending', versions: [6] });
        expect(mocks.serverFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    });

    it('keeps an unknown credential entry byte-for-byte and reports its exact version pending after partial cleanup', async () => {
        const migrated = { id: 'migrated', name: 'Old', kind: 'apiKey', encryptedValue: { _isSecretValue: true, value: 'old-fixture' }, createdAt: 1, updatedAt: 1 };
        const unknown = { ...migrated, future: true };
        mocks.serverFetch.mockImplementation(async (path: string) => {
            if (path === '/v1/account/encryption/currentness') return jsonResponse({ mode: 'plain', version: 2, settingsVersion: 7,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            if (path === '/v2/account/settings/history') return jsonResponse({ snapshots: [{ version: 6,
                createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 100 }] });
            if (path === '/v2/account/settings/history/6') return jsonResponse({ content: { t: 'plain', v: { secrets: [migrated, unknown] } },
                version: 6, createdAt: '2026-01-01T00:00:00.000Z' });
            if (path === '/v2/account/settings/history/6/mutate') return jsonResponse({ status: 'applied' });
            throw new Error(`Unexpected request ${path}`);
        });
        expect(await normalizeAccountSettingsHistoryAfterTransfer({ credentials, encryption: null, settingsScope: SETTINGS_SCOPE,
            destinationAuthority: { activeTransferredRoots: [], savedSecretTransfers: [{ savedSecretId: 'migrated', resourceId: 'resource', expectedRevision: 1 }] } }))
            .toEqual({ status: 'cleanup-pending', versions: [6] });
        const post = mocks.serverFetch.mock.calls.find(([path]) => path === '/v2/account/settings/history/6/mutate');
        expect(JSON.parse(String(post?.[1]?.body)).operation.content).toEqual({ t: 'plain', v: { secrets: [unknown] } });
    });

    it('reseals a readable recorded encrypted snapshot even after the Account became plain', async () => {
        mocks.transferControl = { status: 'present', revision: 2, content: { t: 'plain', v: {
            v: 1, phase: 'active', sourceSettingsVersion: 6, migratedLogicalRevision: 1, inventory: [],
        } } };
        const material = { type: 'dataKey' as const, machineKey: TEST_MACHINE_KEY };
        const recorded = { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material,
            payload: { profiles: [{ id: 'old' }], futureSetting: { keep: true } }, randomBytes: mocks.getRandomBytes }) };
        mocks.serverFetch.mockImplementation(async (path: string) => {
            if (path === '/v1/account/encryption/currentness') return jsonResponse({ mode: 'plain', version: 2, settingsVersion: 7,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            if (path === '/v2/account/settings/history') return jsonResponse({ snapshots: [{ version: 6,
                createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'encrypted', byteLength: 100 }] });
            if (path === '/v2/account/settings/history/6') return jsonResponse({ content: recorded, version: 6,
                createdAt: '2026-01-01T00:00:00.000Z' });
            if (path === '/v2/account/settings/history/6/mutate') return jsonResponse({ status: 'applied' });
            throw new Error(`Unexpected request ${path}`);
        });
        expect(await normalizeAccountSettingsHistoryAfterTransfer({ credentials, encryption: ENCRYPTION_STUB,
            settingsScope: SETTINGS_SCOPE, destinationAuthority: { activeTransferredRoots: ['profiles'] } })).toEqual({ status: 'complete' });
        const post = mocks.serverFetch.mock.calls.find(([path]) => path === '/v2/account/settings/history/6/mutate');
        const body = JSON.parse(String(post?.[1]?.body));
        expect(body.operation.content.t).toBe('encrypted');
        expect(body.expectedContent).toEqual(recorded);
        expect(openAccountScopedBlobCiphertext({ kind: 'account_settings', material, ciphertext: body.operation.content.c })?.value)
            .toEqual({ futureSetting: { keep: true } });
    });

    it('reports a concurrently retained new version cleanup-pending without sweeping it', async () => {
        let listReads = 0;
        mocks.serverFetch.mockImplementation(async (path: string) => {
            if (path === '/v1/account/encryption/currentness') return jsonResponse({ mode: 'plain', version: 2, settingsVersion: 7,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            if (path === '/v2/account/settings/history') return jsonResponse({ snapshots: (++listReads === 1 ? [6] : [6, 7]).map(version => ({
                version, createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 10,
            })) });
            if (path === '/v2/account/settings/history/6') return jsonResponse({ content: { t: 'plain', v: { preferredLanguage: 'de' } },
                version: 6, createdAt: '2026-01-01T00:00:00.000Z' });
            throw new Error(`Unexpected request ${path}`);
        });
        expect(await normalizeAccountSettingsHistoryAfterTransfer({ credentials, encryption: null,
            settingsScope: SETTINGS_SCOPE, destinationAuthority: { activeTransferredRoots: [] } }))
            .toEqual({ status: 'cleanup-pending', versions: [7] });
        expect(mocks.serverFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    });

    it('normalizes recorded Plain Profile residue with an exact inherited identity from the client-opened current E2EE control', async () => {
        const inheritedProfileId = `  retained-${'x'.repeat(260)}  `;
        const encryptedCredentials: AuthCredentials = { token: credentials.token,
            encryption: { publicKey: 'public', machineKey: encodeBase64(TEST_MACHINE_KEY) } };
        await TokenStorage.setCredentialsForServerUrl('http://127.0.0.1:3009', { serverId: 'server-a' }, encryptedCredentials);
        mocks.transferControl = { status: 'present', revision: 2, content: { t: 'encrypted',
            c: sealAccountScopedBlobCiphertext({ kind: 'account_profile_transfer', material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
                payload: { v: 1, phase: 'active', sourceSettingsVersion: 6, migratedLogicalRevision: 1,
                    inventory: [{ kind: 'account_row', id: inheritedProfileId, revision: 1 }] }, randomBytes: mocks.getRandomBytes }) } };
        const recorded = { t: 'plain', v: { profiles: [{ id: inheritedProfileId }], profileEnabledById: { [inheritedProfileId]: false, anthropic: true },
            promptStacksV1: { v: 1, surfaces: { profilesById: { [inheritedProfileId]: {} }, other: { keep: true } } } } };
        mocks.serverFetch.mockImplementation(async (path: string) => {
            if (path === '/v1/account/encryption/currentness') return jsonResponse({ mode: 'e2ee', version: 2, settingsVersion: 7,
                signingKeyFingerprint: 'signing-key', contentKeyFingerprint: 'content-key', updatedAt: 1 });
            if (path === '/v2/account/settings/history') return jsonResponse({ snapshots: [{ version: 6,
                createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 100 }] });
            if (path === '/v2/account/settings/history/6') return jsonResponse({ content: recorded, version: 6,
                createdAt: '2026-01-01T00:00:00.000Z' });
            if (path === '/v2/account/settings/history/6/mutate') return jsonResponse({ status: 'applied' });
            throw new Error(`Unexpected request ${path}`);
        });
        expect(await normalizeAccountSettingsHistoryAfterTransfer({ credentials: encryptedCredentials, encryption: ENCRYPTION_STUB,
            settingsScope: SETTINGS_SCOPE, destinationAuthority: { activeTransferredRoots: ['profiles'] } })).toEqual({ status: 'complete' });
        const post = mocks.serverFetch.mock.calls.find(([path]) => path === '/v2/account/settings/history/6/mutate');
        expect(JSON.parse(String(post?.[1]?.body)).operation).toEqual({ kind: 'normalize',
            removedRoots: ['profiles', 'secretBindingsByProfileId'], transferredProfileIds: [inheritedProfileId], content: { t: 'plain', v: {
                profileEnabledById: { anthropic: true }, promptStacksV1: { v: 1, surfaces: { other: { keep: true } } },
            } } });
    });

    it('refuses a restore whose captured transfer revision moved without replaying the old roots', async () => {
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') return jsonResponse({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings/history/3') return jsonResponse({ content: { t: 'plain', v: HISTORY_SNAPSHOT },
                version: 3, createdAt: '2026-01-01T00:00:00.000Z' });
            if (path === '/v2/account/settings' && init?.method === 'POST') return jsonResponse({
                success: false, error: 'profile-transfer-mismatch', currentProfileTransferRevision: 2,
            });
            if (path === '/v2/account/settings') return jsonResponse({ content: { t: 'plain', v: LATEST_BASELINE }, version: 7 });
            throw new Error(`Unexpected request ${path}`);
        });
        expect(await restoreAccountSettingsFromHistorySnapshot({ credentials, encryption: null, settingsScope: SETTINGS_SCOPE,
            historyVersion: 3, expectedSettingsVersion: 7 })).toEqual({ status: 'conflict', currentSettingsVersion: 7 });
        expect(mocks.serverFetch.mock.calls.filter(([path, init]) => path === '/v2/account/settings' && init?.method === 'POST')).toHaveLength(1);
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
            settingsScope: SETTINGS_SCOPE,
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
        expect(body).toEqual({ content: { t: 'plain', v: MERGED_BASELINE }, expectedVersion: 7, expectedProfileTransferRevision: 'absent' });
        expect(mocks.storageState.applySettingsForScope).toHaveBeenCalledWith(
            SETTINGS_SCOPE,
            expect.objectContaining({
                sessionTmuxSessionName: 'old-name',
                preferredLanguage: 'de',
            }),
            8,
        );
    });

    it('passes destination authority into restore so a latest source cannot be reseeded', async () => {
        mocks.transferControl = { status: 'present', revision: 2, content: { t: 'plain', v: {
            v: 1, phase: 'active', sourceSettingsVersion: 6, migratedLogicalRevision: 1, inventory: [],
        } } };
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') return jsonResponse({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return jsonResponse({ mode: 'plain', version: 2, settingsVersion: 7,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            if (path === '/v2/account/settings' && init?.method === 'POST') return jsonResponse({ success: true, version: 8 });
            if (path === '/v2/account/settings') return jsonResponse({ content: { t: 'plain', v: LATEST_BASELINE }, version: 7 });
            if (path === '/v2/account/settings/history/3') return jsonResponse({
                content: { t: 'plain', v: HISTORY_SNAPSHOT }, version: 3, createdAt: '2026-01-01T00:00:00.000Z',
            });
            throw new Error(`Unexpected request: ${path}`);
        });
        await restoreAccountSettingsFromHistorySnapshot({
            credentials, encryption: null, settingsScope: SETTINGS_SCOPE,
            historyVersion: 3, expectedSettingsVersion: 7,
            destinationAuthority: { activeTransferredRoots: ['profiles'] },
        });
        const post = mocks.serverFetch.mock.calls.find(([path, init]) => path === '/v2/account/settings' && init?.method === 'POST');
        expect(JSON.parse(String(post?.[1]?.body)).content.v).toEqual({
            sessionTmuxSessionName: 'old-name', preferredLanguage: 'de', schemaVersion: ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION,
        });
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
            settingsScope: SETTINGS_SCOPE,
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
            settingsScope: SETTINGS_SCOPE,
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
            settingsScope: SETTINGS_SCOPE,
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
            settingsScope: SETTINGS_SCOPE,
            historyVersion: 3,
            expectedSettingsVersion: 7,
        })).rejects.toMatchObject({
            name: 'AccountSettingsHistoryRestoreInvalidError',
            reason: 'invalidValue',
        });
        expect(mocks.serverFetch.mock.calls.filter(([, init]) => init?.method === 'POST'))
            .toHaveLength(0);
    });

    it('abandons Account A history restore when its scope retires while the snapshot response is paused', async () => {
        let resolveSnapshot!: (response: Response) => void;
        const snapshotResponse = new Promise<Response>((resolve) => { resolveSnapshot = resolve; });
        mocks.serverFetch.mockImplementation(async (path: string) => {
            if (path === '/v2/account/settings/history/3') return await snapshotResponse;
            throw new Error(`Unexpected settings request after Account retirement: ${path}`);
        });

        const restore = restoreAccountSettingsFromHistorySnapshot({
            credentials,
            encryption: null,
            settingsScope: SETTINGS_SCOPE,
            historyVersion: 3,
            expectedSettingsVersion: 7,
        });
        await vi.waitFor(() => {
            expect(mocks.serverFetch).toHaveBeenCalledWith('/v2/account/settings/history/3', expect.anything());
        });

        mocks.activeLifetime.current = false;
        mocks.activeLifetime.retireCallback?.();
        resolveSnapshot(jsonResponse({
            content: { t: 'plain', v: HISTORY_SNAPSHOT },
            version: 3,
            createdAt: '2026-01-01T00:00:00.000Z',
        }));

        await expect(restore).rejects.toMatchObject({
            name: 'AccountSettingsHistoryRestoreUnavailableError',
            status: 0,
        });
        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
        expect(mocks.storageState.applySettingsForScope).not.toHaveBeenCalled();
    });

    it.each(['retired', 'newer-push'] as const)('retains an issued Account A restore acceptance without replacing newer local settings (%s)', async (presentation) => {
        const scopeB = { serverId: 'server-b', accountId: 'account-b' };
        const accountBSettings = { ...settingsDefaults, sessionTmuxSessionName: 'account-b' };
        saveAccountSettings(SETTINGS_SCOPE, { ...settingsDefaults, sessionTmuxSessionName: 'new-name' }, 7);
        saveAccountSettings(scopeB, accountBSettings, 2);
        type State = ReturnType<typeof createSettingsDomain> & {
            sessions: {}; machines: {}; machineDisplayById: {}; machineListByServerId: {};
            sessionListRowsByServerId: {}; sessionListIndexByServerId: {}; concurrentSessionListCacheByServerId: {};
        };
        let state: State;
        const domain = createSettingsDomain<State>({
            get: () => state,
            set: (updater) => { state = { ...state, ...(typeof updater === 'function' ? updater(state) : updater) }; },
        });
        state = {
            ...domain, sessions: {}, machines: {}, machineDisplayById: {}, machineListByServerId: {},
            sessionListRowsByServerId: {}, sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {},
            settingsScope: SETTINGS_SCOPE, settingsVersion: 7,
        };
        mocks.realSettingsState = () => state;
        let resolveWrite!: (response: Response) => void;
        const write = new Promise<Response>((resolve) => { resolveWrite = resolve; });
        mocks.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') return jsonResponse({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings/history/3') return jsonResponse({
                content: { t: 'plain', v: HISTORY_SNAPSHOT }, version: 3, createdAt: '2026-01-01T00:00:00.000Z',
            });
            if (path === '/v2/account/settings' && init?.method === 'POST') return await write;
            if (path === '/v2/account/settings') return jsonResponse({ content: { t: 'plain', v: LATEST_BASELINE }, version: 7 });
            return new Response(null, { status: 404 });
        });
        const restore = restoreAccountSettingsFromHistorySnapshot({
            credentials, encryption: null, settingsScope: SETTINGS_SCOPE, historyVersion: 3, expectedSettingsVersion: 7,
        });
        await vi.waitFor(() => expect(mocks.serverFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
        if (presentation === 'retired') {
            state = { ...state, settingsScope: scopeB, settingsVersion: 2, settings: accountBSettings };
            mocks.activeLifetime.current = false;
            mocks.activeLifetime.retireCallback?.();
        } else {
            // The live update-account socket callback enters this same scoped
            // store method, which persists the revision before publishing it.
            state.applySettingsForScope(SETTINGS_SCOPE, {
                ...settingsDefaults, sessionTmuxSessionName: 'newer-push',
                analyticsOptOut: true, crashReportsOptOut: true,
            }, 20);
            applyCrashReportsOptOut(true);
        }
        const visibleSettings = state.settings;
        const persistedB = loadAccountSettings(scopeB);
        const persistedA = loadAccountSettings(SETTINGS_SCOPE);
        resolveWrite(jsonResponse({ success: true, version: 8 }));

        await expect(restore).resolves.toEqual({ status: 'applied', settingsVersion: 8 });
        expect(state.settings).toBe(visibleSettings);
        expect(state.settingsScope).toEqual(presentation === 'retired' ? scopeB : SETTINGS_SCOPE);
        expect(state.settingsVersion).toBe(presentation === 'retired' ? 2 : 20);
        expect(loadAccountSettings(scopeB)).toEqual(persistedB);
        if (presentation === 'retired') {
            expect(loadAccountSettings(SETTINGS_SCOPE)).toMatchObject({ version: 8, settings: { sessionTmuxSessionName: 'old-name' } });
        } else {
            expect(loadAccountSettings(SETTINGS_SCOPE)).toEqual(persistedA);
            expect.soft(mocks.analyticsOptIn).not.toHaveBeenCalled();
            expect.soft(mocks.analyticsOptOut).toHaveBeenCalled();
            expect.soft(globalThis.__HAPPIER_CRASH_REPORTS_OPTOUT__).toBe(true);
        }
        expect(mocks.serverFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
        expect(mocks.createServerFetchAtEndpoint).toHaveBeenCalledWith(expect.objectContaining({
            endpointUrl: 'http://127.0.0.1:3009', credentials, serverId: 'server-a',
        }));
    });
});
