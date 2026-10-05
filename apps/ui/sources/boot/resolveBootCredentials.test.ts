// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { ACCOUNT_ENCRYPTION_FIRST_KEY_PENDING_TTL_MS, TokenStorage, type AuthCredentials, type PendingExternalAuth } from '@/auth/storage/tokenStorage';
import { setServerUrl, getServerUrl } from '@/sync/domains/server/serverConfig';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    getActiveServerId,
    getActiveServerUrl,
    getDeviceDefaultServerId,
    listServerProfiles,
    resetServerProfilesRuntimeForTests,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import type { HappierWebRuntimeConfig } from '@/sync/runtime/webRuntimeConfig';
import { scopedStorageId } from '@/utils/system/storageScope';
import { encodeBase64 } from '@/encryption/base64';
import { TERMINAL_CONNECT_WEB_BOOTSTRAP_STORAGE_KEY } from '@/utils/path/terminalConnectWebBootstrap';
import { resolveBootCredentials } from './resolveBootCredentials';

installTokenStorageWebPlatformMocks();
const runtime = await vi.hoisted(async () => {
    const { installLocalStorageMock, installWebLockManagerMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
    const storage = installLocalStorageMock();
    const locks = installWebLockManagerMock();
    const backend = globalThis.localStorage;
    // Real DOM-dependent imports evaluate before cases; retain the complete jsdom document.
    const document = globalThis.document;
    const navigator = globalThis.navigator;
    const sessionValues = new Map<string, string>();
    const sessionStorage: Storage = {
        get length() { return sessionValues.size; },
        clear: () => sessionValues.clear(),
        getItem: (key) => sessionValues.get(key) ?? null,
        key: (index) => [...sessionValues.keys()][index] ?? null,
        removeItem: (key) => { sessionValues.delete(key); },
        setItem: (key, value) => { sessionValues.set(key, value); },
    };
    const window: {
        location: URL;
        localStorage: Storage;
        sessionStorage: Storage;
        history: { replaceState: ReturnType<typeof vi.fn> };
        __HAPPIER_WEB_RUNTIME_CONFIG__?: HappierWebRuntimeConfig;
        __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
    } = {
        location: new URL('https://app.example.test/'),
        localStorage: backend,
        sessionStorage,
        history: { replaceState: vi.fn() },
    };
    // The actual owners first evaluate in this ordinary web realm, not an embed realm.
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', document);
    vi.stubGlobal('sessionStorage', sessionStorage);
    return {
        storage, locks, backend, navigator, window, document, sessionStorage, sessionValues,
        secureValues: new Map<string, string>(),
        invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
        bootCredentials: null as AuthCredentials | { token: string; encryption: null } | null,
        refuseCredentialWrite: false,
        onCredentialWrite: undefined as (() => void) | undefined,
    };
});

// Key-bearing fixtures are confined to the explicitly key-bearing credential cases.
const legacySecret = encodeBase64(new Uint8Array(32).fill(1));
const stackCredentials = {
    token: 'stack-token',
    encryption: {
        publicKey: encodeBase64(new Uint8Array(32).fill(2)),
        machineKey: encodeBase64(new Uint8Array(32).fill(3)),
    },
} satisfies AuthCredentials;
const stackUrl = 'http://127.0.0.1:3009';

function stubWebRuntime(href: string): void {
    runtime.window.location = new URL(href);
}

function enableStackDesktop(credentials: typeof runtime.bootCredentials = stackCredentials): void {
    runtime.window.__HAPPIER_WEB_RUNTIME_CONFIG__ = { serverUrl: stackUrl, serverContext: 'stack' };
    runtime.bootCredentials = credentials;
    runtime.window.__TAURI_INTERNALS__ = { invoke: runtime.invoke };
}

async function saveHomeCredentials(serverUrl: string, credentials: AuthCredentials) {
    const profile = await upsertServerProfile({ serverUrl, source: 'manual' });
    expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: profile.id }, credentials)).toBe(true);
    return profile;
}

async function retainHome(serverUrl: string, credentials: AuthCredentials) {
    await setServerUrl(serverUrl);
    expect(await TokenStorage.setCredentials(credentials)).toBe(true);
    const { serverId, serverUrl: selectedServerUrl } = getActiveServerSnapshot();
    return { serverId, serverUrl: selectedServerUrl };
}

async function markFirstKeyCustody(target: { serverId: string; serverUrl: string }) {
    const createdAt = Date.now();
    // Same bounded persisted continuation shape as the storage owner's rejected-bearer keeper.
    const pending = {
        provider: 'github', proof: 'boot-proof', secret: legacySecret, returnTo: '/', ...target,
        accountEncryptionFirstKey: {
            accountId: 'boot-account', requestDigest: `aemrb1_${'A'.repeat(43)}`,
            requestJson: '{"fixture":"boot-custody"}', createdAt,
            expiresAt: createdAt + ACCOUNT_ENCRYPTION_FIRST_KEY_PENDING_TTL_MS,
            pending: 'boot-migration', migrationSubmissionAttempted: true,
        },
    } satisfies PendingExternalAuth;
    expect(await TokenStorage.setPendingExternalAuth(pending, target)).toBe(true);
    expect(await TokenStorage.readPendingExternalAuthStateForServerUrl(target.serverUrl, { serverId: target.serverId }))
        .toEqual({ value: pending, serverMismatch: false });
    return pending;
}

async function expectStoredCredentials(serverUrl: string, credentials: AuthCredentials | null) {
    const profile = listServerProfiles().find((candidate) => candidate.serverUrl === serverUrl);
    expect(profile).toBeDefined();
    expect(await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId: profile!.id })).toEqual(credentials);
}

describe('resolveBootCredentials', () => {
    beforeEach(() => {
        // Shared UI setup resets DOM globals; reattach the same pre-evaluation backend and realm.
        vi.stubGlobal('window', runtime.window);
        vi.stubGlobal('document', runtime.document);
        vi.stubGlobal('navigator', runtime.navigator);
        vi.stubGlobal('localStorage', runtime.backend);
        vi.stubGlobal('sessionStorage', runtime.sessionStorage);
        vi.stubGlobal('__TAURI_INTERNALS__', undefined);
        runtime.storage.store.clear();
        runtime.sessionValues.clear();
        runtime.secureValues.clear();
        runtime.window.location = new URL('https://app.example.test/');
        runtime.window.__HAPPIER_WEB_RUNTIME_CONFIG__ = undefined;
        runtime.window.__TAURI_INTERNALS__ = undefined;
        runtime.window.history.replaceState.mockClear();
        runtime.bootCredentials = null;
        runtime.refuseCredentialWrite = false;
        runtime.onCredentialWrite = undefined;
        runtime.invoke.mockReset();
        // Genuine desktop SDK transport preserves native-first secret custody beneath the owner.
        runtime.invoke.mockImplementation(async (command, args) => {
            if (command === 'desktop_read_stack_boot_credentials') return runtime.bootCredentials;
            const key = args?.key;
            if (typeof key !== 'string') throw new Error(`Missing desktop storage key: ${command}`);
            if (command === 'desktop_secure_storage_read') return runtime.secureValues.get(key) ?? null;
            if (command === 'desktop_secure_storage_remove') { runtime.secureValues.delete(key); return null; }
            if (command === 'desktop_secure_storage_write' && typeof args?.value === 'string') {
                if (key.startsWith('auth_credentials')) {
                    runtime.onCredentialWrite?.();
                    if (runtime.refuseCredentialWrite) throw new Error('OS credential write refused');
                }
                runtime.secureValues.set(key, args.value);
                return null;
            }
            throw new Error(`Unexpected desktop command: ${command}`);
        });
        resetServerProfilesRuntimeForTests();
    });

    afterEach(() => vi.unstubAllEnvs());
    afterAll(() => {
        runtime.locks.restore();
        runtime.storage.restore();
        vi.unstubAllGlobals();
    });

    it('prefers server-scoped credentials when the web URL selects a saved Home', async () => {
        stubWebRuntime('http://happier.example.test/?server=http%3A%2F%2Flocalhost%3A24731');
        const retained = { token: 'other-token' };
        await retainHome('https://other.example.test', retained);
        const target = await saveHomeCredentials('http://localhost:24731', { token: 'stack-token', secret: legacySecret });
        const deviceDefaultBefore = getDeviceDefaultServerId();
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'stack-token', secret: legacySecret });
        expect(getActiveServerSnapshot().serverId).toBe(target.id);
        expect(getServerUrl()).toBe('http://localhost:24731');
        expect(getDeviceDefaultServerId()).toBe(deviceDefaultBefore);
        await expectStoredCredentials('https://other.example.test', retained);
    });

    it('leaves an unknown web Home address for the mounted connect flow', async () => {
        stubWebRuntime('https://app.example.test/?server=https%3A%2F%2Fnew.example.test');
        await retainHome('https://retained.example.test', { token: 'retained-token' });
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'retained-token' });
        expect(getServerUrl()).toBe('https://retained.example.test');
        expect(listServerProfiles().some((profile) => profile.serverUrl === 'https://new.example.test')).toBe(false);
        expect(runtime.window.location.search).toContain('new.example.test');
    });

    it('keeps the current server and credentials when active custody blocks a web server override', async () => {
        stubWebRuntime('http://happier.example.test/?server=http%3A%2F%2Flocalhost%3A24731');
        const retained = await retainHome('https://retained.example.test', { token: 'retained-token' });
        await saveHomeCredentials('http://localhost:24731', { token: 'target-token' });
        const pending = await markFirstKeyCustody(retained);
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'retained-token' });
        expect(getActiveServerSnapshot().serverId).toBe(retained.serverId);
        await expectStoredCredentials('http://localhost:24731', { token: 'target-token' });
        expect((await TokenStorage.readPendingExternalAuthState()).value).toEqual(pending);
    });

    it('falls back to default credentials when no terminal-connect boot override exists for the current route', async () => {
        stubWebRuntime('http://happier.example.test/');
        runtime.sessionStorage.setItem(TERMINAL_CONNECT_WEB_BOOTSTRAP_STORAGE_KEY, '#key=abc123&server=http%3A%2F%2Flocalhost%3A24731');
        await retainHome('https://other.example.test', { token: 'default-token', secret: legacySecret });
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'default-token', secret: legacySecret });
        expect(getServerUrl()).toBe('https://other.example.test');
        expect(runtime.sessionStorage.getItem(TERMINAL_CONNECT_WEB_BOOTSTRAP_STORAGE_KEY)).toBeNull();
        expect(listServerProfiles().some((profile) => profile.serverUrl === 'http://localhost:24731')).toBe(false);
    });

    it('does not adopt the exact first-key bearer rejected before reload', async () => {
        const target = await retainHome('https://retained.example.test', { token: 'rejected-token' });
        const pending = await markFirstKeyCustody(target);
        expect((await TokenStorage.markPendingExternalAuthFirstKeyRejectedCredential({ expected: pending, ...target, token: 'rejected-token' })).kind).toBe('recorded');
        resetServerProfilesRuntimeForTests();
        await expect(resolveBootCredentials('web')).resolves.toBeNull();
        expect(await TokenStorage.getCredentials()).toEqual({ token: 'rejected-token' });
        const persisted = (await TokenStorage.readPendingExternalAuthState()).value;
        expect(persisted?.accountEncryptionFirstKey?.rejectedCredentialTokenDigest).toBeDefined();
        expect(JSON.stringify(persisted)).not.toContain('rejected-token');
    });

    it('adopts a replacement bearer when the first-key rejection classifier allows it', async () => {
        const target = await retainHome('https://retained.example.test', { token: 'rejected-token' });
        const pending = await markFirstKeyCustody(target);
        expect((await TokenStorage.markPendingExternalAuthFirstKeyRejectedCredential({ expected: pending, ...target, token: 'rejected-token' })).kind).toBe('recorded');
        expect(await TokenStorage.setCredentials({ token: 'replacement-token' })).toBe(true);
        resetServerProfilesRuntimeForTests();
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'replacement-token' });
        expect((await TokenStorage.readPendingExternalAuthState()).value?.accountEncryptionFirstKey?.rejectedCredentialTokenDigest).toBeDefined();
        expect(getServerUrl()).toBe(target.serverUrl);
    });

    it('falls back to stack-owned desktop boot credentials when a stack Tauri app has no persisted UI credentials yet', async () => {
        stubWebRuntime('http://localhost:8081/');
        enableStackDesktop();
        await expect(resolveBootCredentials('web')).resolves.toEqual(stackCredentials);
        await expectStoredCredentials(stackUrl, stackCredentials);
        expect(runtime.invoke).toHaveBeenCalledWith('desktop_read_stack_boot_credentials', undefined);
        expect([...runtime.storage.store.values()].join('')).not.toContain(stackCredentials.token);
        expect([...runtime.secureValues.values()].join('')).toContain(stackCredentials.token);
    });

    it('persists token-only stack desktop boot credentials without fabricating account encryption material', async () => {
        stubWebRuntime('http://localhost:8081/');
        enableStackDesktop({ token: 'stack-token-only', encryption: null });
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'stack-token-only' });
        await expectStoredCredentials(stackUrl, { token: 'stack-token-only' });
        const credentialBytes = [...runtime.secureValues.entries()].filter(([key]) => key.startsWith('auth_credentials')).map(([, value]) => JSON.parse(value));
        expect(credentialBytes).toEqual([{ token: 'stack-token-only' }]);
    });

    it('does not adopt imported desktop credentials when marked first-key custody refuses replacement', async () => {
        stubWebRuntime('http://localhost:8081/');
        enableStackDesktop({ token: 'replacement-token', encryption: null });
        const retained = await retainHome('https://retained.example.test', { token: 'retained-token' });
        const target = await upsertServerProfile({ serverUrl: stackUrl, source: 'stack-env' });
        const pending = await markFirstKeyCustody({ serverId: target.id, serverUrl: 'http://localhost:3009' });
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'retained-token' });
        expect(getActiveServerSnapshot().serverId).toBe(retained.serverId);
        await expectStoredCredentials(stackUrl, null);
        expect((await TokenStorage.readPendingExternalAuthStateForServerUrl(stackUrl, { serverId: target.id })).value).toEqual(pending);
        expect(runtime.invoke).not.toHaveBeenCalledWith('desktop_read_stack_boot_credentials', undefined);
    });

    it('does not adopt imported desktop credentials when credential persistence is refused', async () => {
        stubWebRuntime('http://localhost:8081/');
        enableStackDesktop({ token: 'replacement-token', encryption: null });
        runtime.refuseCredentialWrite = true;
        await expect(resolveBootCredentials('web')).resolves.toBeNull();
        expect(getServerUrl()).toBe(stackUrl);
        await expectStoredCredentials(stackUrl, null);
        expect(runtime.invoke).toHaveBeenCalledWith('desktop_read_stack_boot_credentials', undefined);
        expect([...runtime.secureValues.values()].join('')).not.toContain('replacement-token');
        expect([...runtime.storage.store.values()].join('')).not.toContain('replacement-token');
    });

    it('activates the stack runtime server before persisting desktop boot credentials without an explicit override', async () => {
        stubWebRuntime('http://localhost:8081/');
        enableStackDesktop();
        await retainHome('https://other.example.test', { token: 'other-token' });
        const credentialWriteHomes: string[] = [];
        runtime.onCredentialWrite = () => { credentialWriteHomes.push(getServerUrl()); };
        await expect(resolveBootCredentials('web')).resolves.toEqual(stackCredentials);
        expect(credentialWriteHomes).toEqual([stackUrl]);
        expect(getServerUrl()).toBe(stackUrl);
        await expectStoredCredentials(stackUrl, stackCredentials);
        await expectStoredCredentials('https://other.example.test', { token: 'other-token' });
    });

    it('prefers stack-runtime scoped credentials over unrelated active-server credentials in stack Tauri mode', async () => {
        stubWebRuntime('http://localhost:8081/');
        enableStackDesktop();
        await retainHome('https://other.example.test', { token: 'other-token', secret: legacySecret });
        const stored = { token: 'stored-stack-token', secret: legacySecret };
        await saveHomeCredentials(stackUrl, stored);
        await expect(resolveBootCredentials('web')).resolves.toEqual(stored);
        expect(getServerUrl()).toBe(stackUrl);
        expect(runtime.invoke).not.toHaveBeenCalledWith('desktop_read_stack_boot_credentials', undefined);
        await expectStoredCredentials('https://other.example.test', { token: 'other-token', secret: legacySecret });
        await expectStoredCredentials(stackUrl, stored);
    });

    it('keeps the current server and credentials when active custody blocks stack runtime activation', async () => {
        stubWebRuntime('http://localhost:8081/');
        enableStackDesktop();
        const retained = await retainHome('https://retained.example.test', { token: 'retained-token' });
        await saveHomeCredentials(stackUrl, { token: 'stored-stack-token' });
        const pending = await markFirstKeyCustody(retained);
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'retained-token' });
        expect(getActiveServerSnapshot().serverId).toBe(retained.serverId);
        expect((await TokenStorage.readPendingExternalAuthState()).value).toEqual(pending);
        expect(runtime.invoke).not.toHaveBeenCalledWith('desktop_read_stack_boot_credentials', undefined);
        await expectStoredCredentials(stackUrl, { token: 'stored-stack-token' });
    });

    it('falls back to stack-owned desktop boot credentials when the active stack server is selected but no server-scoped UI credentials exist yet', async () => {
        stubWebRuntime('http://localhost:8081/?server=http%3A%2F%2F127.0.0.1%3A3009');
        enableStackDesktop();
        const target = await upsertServerProfile({ serverUrl: stackUrl, source: 'stack-env' });
        await expect(resolveBootCredentials('web')).resolves.toEqual(stackCredentials);
        expect(getActiveServerSnapshot().serverId).toBe(target.id);
        await expectStoredCredentials(stackUrl, stackCredentials);
        expect(runtime.invoke).toHaveBeenCalledWith('desktop_read_stack_boot_credentials', undefined);
    });

    it('does not reuse stack desktop boot credentials for a different boot server URL', async () => {
        stubWebRuntime('http://localhost:8081/?server=http%3A%2F%2F127.0.0.1%3A3010');
        enableStackDesktop();
        const differentUrl = 'http://127.0.0.1:3010';
        const target = await upsertServerProfile({ serverUrl: differentUrl, source: 'manual' });
        await expect(resolveBootCredentials('web')).resolves.toBeNull();
        expect(getActiveServerSnapshot().serverId).toBe(target.id);
        await expectStoredCredentials(differentUrl, null);
        expect(runtime.invoke).not.toHaveBeenCalledWith('desktop_read_stack_boot_credentials', undefined);
        expect([...runtime.secureValues.values()].join('')).not.toContain(stackCredentials.token);
    });

    it('prefers server-scoped credentials when booting from a terminal-connect hash stored in sessionStorage', async () => {
        stubWebRuntime('http://happier.example.test/terminal/connect');
        runtime.sessionStorage.setItem(TERMINAL_CONNECT_WEB_BOOTSTRAP_STORAGE_KEY, '#key=abc123&server=http%3A%2F%2Flocalhost%3A24731');
        await retainHome('https://other.example.test', { token: 'other-token' });
        const target = await saveHomeCredentials('http://localhost:24731', { token: 'hash-token', secret: legacySecret });
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'hash-token', secret: legacySecret });
        expect(getActiveServerSnapshot().serverId).toBe(target.id);
        expect(getServerUrl()).toBe('http://localhost:24731');
        await expectStoredCredentials('https://other.example.test', { token: 'other-token' });
    });

    it('preserves the explicit active server id when equivalent server profiles already exist for the boot URL', async () => {
        const storageScope = 'resolve_boot_equivalent';
        vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', storageScope);
        stubWebRuntime('http://happier.example.test/?server=http%3A%2F%2F127.0.0.1%3A3009');
        runtime.backend.setItem(`${scopedStorageId('server-profiles', storageScope)}:server-state-v1`, JSON.stringify({
            activeServerIdIsExplicit: true, activeServerId: 'manual-id', servers: {
                'stack-id': { id: 'stack-id', name: 'Stack Seeded', serverUrl: 'http://localhost:3009', createdAt: 100, updatedAt: 200, lastUsedAt: 0, source: 'stack-env' },
                'manual-id': { id: 'manual-id', name: 'Manual Active', serverUrl: stackUrl, createdAt: 150, updatedAt: 250, lastUsedAt: 999, source: 'manual' },
            },
        }));
        resetServerProfilesRuntimeForTests();
        expect(getActiveServerSnapshot().serverId).toBe('manual-id');
        const credentials = { token: 'stored-stack-token', secret: legacySecret };
        expect(await TokenStorage.setCredentialsForServerUrl(stackUrl, { serverId: 'manual-id' }, credentials)).toBe(true);
        await expect(resolveBootCredentials('web')).resolves.toEqual(credentials);
        expect(getActiveServerSnapshot().serverId).toBe('manual-id');
        expect(await TokenStorage.getCredentialsForServerUrl(stackUrl, { serverId: 'manual-id' })).toEqual(credentials);
    });

    it('does not rewrite an equivalent stack relay profile url when terminal-connect boot uses another loopback alias', async () => {
        const storageScope = 'resolve_boot_stack_alias';
        vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', storageScope);
        stubWebRuntime('http://happier-stack.localhost:24541/terminal/connect#key=abc123&server=http%3A%2F%2Flocalhost%3A24541');
        const namedUrl = 'http://happier-stack.localhost:24541';
        runtime.backend.setItem(`${scopedStorageId('server-profiles', storageScope)}:server-state-v1`, JSON.stringify({
            activeServerIdIsExplicit: true, activeServerId: 'stack-id', servers: {
                'stack-id': { id: 'stack-id', name: 'Stack Seeded', serverUrl: namedUrl, createdAt: 100, updatedAt: 200, lastUsedAt: 300, source: 'stack-env' },
            },
        }));
        resetServerProfilesRuntimeForTests();
        const credentials = { token: 'stored-stack-token', secret: legacySecret };
        expect(await TokenStorage.setCredentialsForServerUrl(namedUrl, { serverId: 'stack-id' }, credentials)).toBe(true);
        await expect(resolveBootCredentials('web')).resolves.toEqual(credentials);
        expect(getActiveServerId()).toBe('stack-id');
        expect(getActiveServerUrl()).toBe(namedUrl);
        expect(await TokenStorage.getCredentialsForServerUrl('http://localhost:24541', { serverId: 'stack-id' })).toEqual(credentials);
    });
});
