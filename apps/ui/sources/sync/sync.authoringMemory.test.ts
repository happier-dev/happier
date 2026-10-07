import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    AccountSettingsV2UpdateRequestSchema,
    AuthoringMemoryMutationRequestV1Schema,
    LegacyLastUsedProfileSchema,
    openAccountScopedBlobCiphertext,
    sealAccountScopedBlobCiphertext,
    type AuthoringMemoryContentV1,
} from '@happier-dev/protocol';
import { encodeBase64 } from '@/encryption/base64';
import { encodeUTF8 } from '@/encryption/text';
import { loadAuthoringMemoryProjection, saveAuthoringMemoryProjection } from './domains/state/authoringMemoryPersistence';
import { getPersistenceStorage } from './domains/state/persistenceStorage';
import { createAccountSettingsScope, type AccountSettingsScope } from './domains/settings/scope/accountSettingsScope';
import type { Settings } from './domains/settings/settings';

// MMKV/native SDK and the prepared HTTP adapter are the real system boundaries.
vi.mock('react-native-mmkv', () => {
    class MMKV {
        private readonly values = new Map<string, string>();
        getString(key: string) { return this.values.get(key); }
        set(key: string, value: string) { this.values.set(key, value); }
        delete(key: string) { this.values.delete(key); }
        getAllKeys() { return [...this.values.keys()]; }
        clearAll() { this.values.clear(); }
        trim() {}
    }
    return { MMKV };
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});
// Sync's eager UI imports include this platform SDK; markdown is not exercised.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Markdown SDK is outside authoring-memory runtime tests'); },
}));
const network = vi.hoisted(() => ({ request: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>() }));
vi.mock('@/sync/api/session/apiSocket', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/session/apiSocket')>();
    vi.spyOn(actual.apiSocket, 'createRequestForPreparedTarget').mockImplementation(() => network.request);
    return actual;
});

import './syncEngine';
import { sync, type SyncServerTarget } from './sync';
import { storage } from './domains/state/storage';
import { Encryption } from './encryption/encryption';
import { StaleServerGenerationError } from './http/client';

// Initialize incumbent owner state, without replacing any internal operation.
type AuthoringRuntimeTestAccess = {
    credentials: AuthCredentials | undefined;
    pendingSettingsScope: AccountSettingsScope | null;
    pendingSettings: Partial<Settings>;
    appliedServerTarget: SyncServerTarget | null;
    authoringMemoryRuntime: unknown;
    encryption: Encryption | null;
    settingsSecretsKey: Uint8Array | null;
    settingsSecretsReadKeys: ReadonlyArray<Uint8Array>;
};
const owner = sync as unknown as AuthoringRuntimeTestAccess;
const original = { credentials: owner.credentials, pendingSettingsScope: owner.pendingSettingsScope,
    pendingSettings: owner.pendingSettings,
    appliedServerTarget: owner.appliedServerTarget, authoringMemoryRuntime: owner.authoringMemoryRuntime,
    encryption: owner.encryption, settingsSecretsKey: owner.settingsSecretsKey,
    settingsSecretsReadKeys: owner.settingsSecretsReadKeys };
const originalSettings = { settings: storage.getState().settings, settingsVersion: storage.getState().settingsVersion,
    settingsScope: storage.getState().settingsScope };

afterEach(() => {
    Object.assign(owner, original);
    storage.getState().resetAuthoringMemory();
    storage.setState(originalSettings);
    network.request.mockReset();
    if (vi.isMockFunction(console.error)) vi.mocked(console.error).mockRestore();
});

describe('Sync authoring-memory runtime', () => {
    it('retires a cancelled bootstrap quietly and bootstraps the current Home on the next settings refresh', async () => {
        const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
        owner.credentials = { token: 'authoring-cancelled-account' };
        owner.encryption = null;
        owner.settingsSecretsKey = null;
        owner.settingsSecretsReadKeys = [];
        owner.pendingSettings = {};
        owner.appliedServerTarget = { serverId: 'https://authoring-cancelled.test', serverUrl: 'https://authoring-cancelled.test', generation: 1 };
        const scope = createAccountSettingsScope(owner.appliedServerTarget.serverId, 'authoring-cancelled-account');
        if (!scope) throw new Error('Expected valid Account/Home scope');
        owner.pendingSettingsScope = scope;
        owner.authoringMemoryRuntime = null;
        await storage.getState().activateSettingsScope(scope);
        let cancelled = true;
        network.request.mockImplementation(async (path, init) => {
            if (path === '/v1/account/encryption') {
                return Response.json({ mode: 'plain', updatedAt: 1 });
            }
            if (path === '/v1/account/authoring-memory') {
                if (cancelled) throw new StaleServerGenerationError();
                return Response.json({ rows: [
                    { key: 'lastUsedProfile', revision: 1, content: { t: 'plain', v: 'current-profile' } },
                ] });
            }
            if (path === '/v2/account/settings' && init?.method !== 'POST') {
                return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            }
            if (path === '/v1/push-tokens?projectionVersion=2') return Response.json({}, { status: 404 });
            throw new Error(`Unexpected bootstrap request: ${path}`);
        });

        await sync.refreshAccountSettingsFromServer(1, scope);
        await vi.waitFor(() => expect(owner.authoringMemoryRuntime).toBeNull());
        expect(storage.getState().authoringMemory.lastUsedProfile).toBeNull();
        expect(diagnostics).not.toHaveBeenCalled();

        cancelled = false;
        owner.appliedServerTarget = { ...owner.appliedServerTarget, generation: 2 };
        await sync.refreshAccountSettingsFromServer(1, scope);
        await vi.waitFor(() => expect(storage.getState().authoringMemory.lastUsedProfile).toBe('current-profile'));
    });

    it('refreshes ordinary Account Settings when authoring-memory storage is unavailable', async () => {
        const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {});
        owner.credentials = { token: 'settings-independent-account' };
        owner.encryption = null;
        owner.settingsSecretsKey = null;
        owner.settingsSecretsReadKeys = [];
        owner.pendingSettings = {};
        owner.appliedServerTarget = { serverId: 'https://settings-independent.test', serverUrl: 'https://settings-independent.test', generation: 1 };
        const scope = createAccountSettingsScope(owner.appliedServerTarget.serverId, 'settings-independent-account');
        if (!scope) throw new Error('Expected valid Account/Home scope');
        owner.pendingSettingsScope = scope;
        owner.authoringMemoryRuntime = null;
        await storage.getState().activateSettingsScope(scope);
        network.request.mockImplementation(async (path, init) => {
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/authoring-memory') return Response.json({ error: 'authoring_memory_storage_unavailable' }, { status: 503 });
            if (path === '/v2/account/settings' && init?.method !== 'POST') {
                return Response.json({ content: { t: 'plain', v: { analyticsOptOut: true } }, version: 1 });
            }
            if (path === '/v1/push-tokens?projectionVersion=2') return Response.json({}, { status: 404 });
            throw new Error(`Unexpected independent Settings request: ${path}`);
        });

        await sync.refreshAccountSettingsFromServer(1, scope);

        expect(storage.getState().settingsVersion).toBe(1);
        expect(storage.getState().settings.analyticsOptOut).toBe(true);
        await expect(sync.applyAuthoringMemoryDelta({ lastUsedProfile: 'must-not-write' })).rejects.toThrow();
        expect(storage.getState().authoringMemory.lastUsedProfile).toBeNull();
        expect(diagnostics).toHaveBeenCalledWith('[fireAndForget] Sync.authoringMemory.bootstrap', expect.any(Error));
    });

    it('retires only the transferred legacy key and preserves an unrelated raw SecretString sibling exactly under E2EE', async () => {
        const machineKey = new Uint8Array(32).fill(7);
        const publicKey = new Uint8Array(32).fill(8);
        const material = { type: 'dataKey', machineKey } as const;
        const sealSettings = (raw: Record<string, unknown>) => ({ t: 'encrypted' as const,
            c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material, payload: raw,
                randomBytes: (length) => new Uint8Array(length).fill(9) }) });
        const unrelatedSecretBag = { secret: { _isSecretValue: true, value: 'must-remain-exactly-raw' },
            futureOpaque: [false, { future: 'unchanged' }] };
        let raw: Record<string, unknown> = { lastUsedProfile: 'legacy-profile', unrelatedSecretBag };
        let settingsVersion = 6;
        let row: AuthoringMemoryContentV1 | null = null;
        owner.credentials = { token: 'e2ee-retirement-account', encryption: {
            machineKey: encodeBase64(machineKey, 'base64'), publicKey: encodeBase64(publicKey, 'base64'),
        } };
        owner.encryption = await Encryption.createFromContentKeyPair({ machineKey, publicKey });
        owner.settingsSecretsKey = new Uint8Array(32).fill(10);
        owner.settingsSecretsReadKeys = [owner.settingsSecretsKey];
        owner.appliedServerTarget = { serverId: 'https://e2ee-retirement.test', serverUrl: 'https://e2ee-retirement.test', generation: 1 };
        owner.pendingSettingsScope = createAccountSettingsScope(owner.appliedServerTarget.serverId, 'e2ee-account');
        owner.authoringMemoryRuntime = null;
        network.request.mockImplementation(async (path, init) => {
            if (path === '/v1/account/encryption') return Response.json({ mode: 'e2ee', updatedAt: 1 });
            if (path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
            if (path === '/v2/account/settings') {
                if (init?.method !== 'POST') return Response.json({ content: sealSettings(raw), version: settingsVersion });
                const body = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                expect(body.expectedVersion).toBe(settingsVersion);
                if (body.content?.t !== 'encrypted') throw new Error('Expected E2EE retirement envelope');
                const opened = openAccountScopedBlobCiphertext({ kind: 'account_settings', material, ciphertext: body.content.c });
                if (!opened || !opened.value || typeof opened.value !== 'object' || Array.isArray(opened.value)) throw new Error('Expected readable raw settings');
                raw = opened.value as Record<string, unknown>;
                settingsVersion++;
                return Response.json({ success: true, version: settingsVersion });
            }
            if (path === '/v1/account/authoring-memory/lastUsedProfile') {
                if (init?.method !== 'POST') return Response.json(row ? { status: 'present', revision: 0, content: row } : { status: 'absent' });
                row = AuthoringMemoryMutationRequestV1Schema.parse(JSON.parse(String(init.body))).content;
                return Response.json({ status: 'updated', revision: 0, cursor: 1 });
            }
            if (path === '/v1/push-tokens?projectionVersion=2') return Response.json({}, { status: 404 });
            throw new Error(`Unexpected retirement request: ${path}`);
        });

        await sync.applyAuthoringMemoryDelta({ lastUsedProfile: 'legacy-profile' });

        expect(raw).toEqual({ unrelatedSecretBag });
        expect(row).toMatchObject({ t: 'encrypted' });
        expect(storage.getState().authoringMemory.lastUsedProfile).toBe('legacy-profile');
    });

    it('hydrates remembered choices synchronously for the exact Account/Home before transport', () => {
        const serverUrl = 'https://offline-authoring-home.test';
        const scope = createAccountSettingsScope(serverUrl, 'offline-account');
        if (!scope) throw new Error('Expected valid Account/Home scope');
        saveAuthoringMemoryProjection(scope, {
            recentMachinePaths: [{ machineId: 'machine', path: '/work/project' }],
            lastUsedProfile: 'remembered-profile',
            lastEngineSelectionsByScopeV1: {},
        });
        const token = `hdr.${encodeBase64(encodeUTF8(JSON.stringify({ sub: 'offline-account' })), 'base64')}.sig`;
        const credentials: AuthCredentials = { token, secret: 'unused' };
        sync.hydrateLocalState(credentials, { serverId: serverUrl, serverUrl, generation: 1 });
        expect(storage.getState().authoringMemory).toMatchObject({
            recentMachinePaths: [{ machineId: 'machine', path: '/work/project' }], lastUsedProfile: 'remembered-profile',
        });
        sync.hydrateLocalState(credentials, { serverId: 'https://different-home.test', serverUrl: 'https://different-home.test', generation: 2 });
        expect(storage.getState().authoringMemory.lastUsedProfile).toBeNull();
        expect(storage.getState().authoringMemory.recentMachinePaths).toEqual([]);
    });

    it('bootstraps and commits a keyless plain row through the prepared Home request', async () => {
        owner.credentials = { token: 'authoring-runtime-account' };
        owner.appliedServerTarget = { serverId: 'https://authoring-home.test', serverUrl: 'https://authoring-home.test', generation: 1 };
        owner.pendingSettingsScope = createAccountSettingsScope(owner.appliedServerTarget.serverId, 'account-a');
        owner.authoringMemoryRuntime = null;
        let profile: string | null = null;
        network.request.mockImplementation(async (path, init) => {
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (path === '/v1/account/authoring-memory/lastUsedProfile') {
                if (init?.method !== 'POST') return Response.json(profile === null
                    ? { status: 'absent' }
                    : { status: 'present', revision: 0, content: { t: 'plain', v: profile } });
                const body = AuthoringMemoryMutationRequestV1Schema.parse(JSON.parse(String(init.body)));
                if (body.content?.t !== 'plain') throw new Error('Plain Account must commit a plain envelope');
                profile = LegacyLastUsedProfileSchema.parse(body.content.v);
                return Response.json({ status: 'updated', revision: 0, cursor: 1 });
            }
            throw new Error(`Unexpected Home request: ${path}`);
        });

        await sync.applyAuthoringMemoryDelta({ lastUsedProfile: 'profile-new' });
        expect(profile).toBe('profile-new');
        expect(storage.getState().authoringMemory.lastUsedProfile).toBe('profile-new');
        expect(loadAuthoringMemoryProjection(owner.pendingSettingsScope!)).toMatchObject({ lastUsedProfile: 'profile-new' });

        const unchanged = storage.getState().authoringMemory;
        const persistence = vi.spyOn(getPersistenceStorage(), 'set');
        try {
            await sync.applyAuthoringMemoryDelta({ lastUsedProfile: 'profile-new' });
            expect(storage.getState().authoringMemory).toBe(unchanged);
            expect(persistence.mock.calls.filter(([key]) => key.startsWith('authoring-memory:'))).toEqual([]);
        } finally {
            persistence.mockRestore();
        }
    });
});
