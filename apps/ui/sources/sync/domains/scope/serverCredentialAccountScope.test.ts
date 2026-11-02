import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import {
    installLocalStorageMock,
    installWebLockManagerMock,
    type LocalStorageMockHandle,
} from '@/auth/storage/tokenStorage.web.testHelpers';

// Browser-origin device-local storage is the Home credential custody boundary on
// web. A throwing `getItem` (a storage SecurityError) stands in for every
// secure-storage read failure: a locked keychain, a Desktop custody error.
// TokenStorage, the Home profile registry and the resolver stay real.
installTokenStorageWebPlatformMocks();

const captureExceptionIfEnabled = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/sentry', async (importOriginal) => ({
    ...(await (importOriginal as () => Promise<typeof import('@/utils/system/sentry')>)()),
    captureExceptionIfEnabled,
}));

// Load the real owners during collection, after the platform boundary mocks are
// registered; their cold transform is not the contract under test.
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
const { resolveServerCredentialAccountScope, captureServerCredentialAccountScopeLifetime } = await import('./serverCredentialAccountScope');

describe('resolveServerCredentialAccountScope', () => {
    let localStorage: LocalStorageMockHandle | null = null;
    let restoreWebLocks: (() => void) | null = null;

    beforeAll(() => {
        restoreWebLocks = installWebLockManagerMock().restore;
    });

    beforeEach(() => {
        // The shared setup re-stubs `localStorage` before every test, so the
        // failing boundary is installed per test, after it.
        localStorage = installLocalStorageMock();
        captureExceptionIfEnabled.mockClear();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        localStorage?.restore();
        localStorage = null;
    });

    afterAll(() => {
        restoreWebLocks?.();
        restoreWebLocks = null;
    });

    it('retains one exact credential lifetime between readers and retires it on a hidden credential replacement', async () => {
        const home = await upsertServerProfile({ name: 'Retained Account', serverUrl: 'https://retained-credential.test' });
        const token = (subject: string) => `e30.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature`;
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: token('original') });
        const first = await resolveServerCredentialAccountScope(home.id);
        if (first.kind !== 'bound') throw new Error('Expected original credential');
        const lifetime = captureServerCredentialAccountScopeLifetime(first);
        const retire = vi.fn();
        lifetime.onRetire(retire);
        const nextReader = await resolveServerCredentialAccountScope(home.id);
        if (nextReader.kind !== 'bound') throw new Error('Expected retained credential');
        expect(captureServerCredentialAccountScopeLifetime(nextReader)).toBe(lifetime);
        expect(lifetime.isCurrent()).toBe(true);
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: token('replacement') });
        expect(lifetime.isCurrent()).toBe(false);
        expect(retire).toHaveBeenCalledTimes(1);
        const replacement = await resolveServerCredentialAccountScope(home.id);
        if (replacement.kind !== 'bound') throw new Error('Expected replacement credential');
        const replaced = captureServerCredentialAccountScopeLifetime(replacement);
        expect(replaced).not.toBe(lifetime);
        expect(replaced.scope.accountId).toBe('replacement');
        await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
        expect(replaced.isCurrent()).toBe(false);
    });

    it('reports an unreadable credential store as unavailable, never as a sign-out', async () => {
        const home = await upsertServerProfile({
            name: 'Unreadable credential Home',
            serverUrl: 'https://unreadable-credential-home.example.test',
        });

        // A readable store with nothing in it is a confirmed absence.
        await expect(resolveServerCredentialAccountScope(home.id)).resolves.toEqual({ kind: 'signed_out' });
        expect(captureExceptionIfEnabled).not.toHaveBeenCalled();

        const storageFailure = new Error('The operation is insecure.');
        const store = localStorage!.store;
        localStorage!.getItemMock.mockImplementation((key: string) => {
            if (key.includes('auth_credentials')) throw storageFailure;
            return store.get(key) ?? null;
        });

        await expect(resolveServerCredentialAccountScope(home.id)).resolves.toEqual({ kind: 'unavailable' });
        expect(captureExceptionIfEnabled).toHaveBeenCalledTimes(1);
        expect(captureExceptionIfEnabled).toHaveBeenCalledWith(storageFailure, {
            tags: { operation: 'resolve_server_credential_account_scope' },
            extra: { serverId: home.id },
        });

        // Readers that did not ask to see storage failures keep their tolerant
        // contract, so boot and request paths are unchanged by this distinction.
        await expect(TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id }))
            .resolves.toBeNull();
        expect(captureExceptionIfEnabled).toHaveBeenCalledTimes(1);
    });

    it('reports one persistent storage failure once per Home, and again after the store recovers', async () => {
        const home = await upsertServerProfile({
            name: 'Persistently unreadable Home',
            serverUrl: 'https://persistently-unreadable-home.example.test',
        });
        const store = localStorage!.store;
        const failing = (key: string) => {
            if (key.includes('auth_credentials')) throw new Error('The operation is insecure.');
            return store.get(key) ?? null;
        };
        localStorage!.getItemMock.mockImplementation(failing);

        // Every mounted consumer and every profile refresh resolves again.
        await expect(resolveServerCredentialAccountScope(home.id)).resolves.toEqual({ kind: 'unavailable' });
        await expect(resolveServerCredentialAccountScope(home.id)).resolves.toEqual({ kind: 'unavailable' });
        await expect(resolveServerCredentialAccountScope(home.id)).resolves.toEqual({ kind: 'unavailable' });
        expect(captureExceptionIfEnabled).toHaveBeenCalledTimes(1);

        localStorage!.getItemMock.mockImplementation((key: string) => store.get(key) ?? null);
        await expect(resolveServerCredentialAccountScope(home.id)).resolves.toEqual({ kind: 'signed_out' });

        localStorage!.getItemMock.mockImplementation(failing);
        await expect(resolveServerCredentialAccountScope(home.id)).resolves.toEqual({ kind: 'unavailable' });
        expect(captureExceptionIfEnabled).toHaveBeenCalledTimes(2);
    });

    it('returns a readable legacy credential even when a sibling legacy scope cannot be read', async () => {
        // A loopback Home keeps two legacy URL scopes (localhost and 127.0.0.1).
        const home = await upsertServerProfile({
            name: 'Loopback legacy Home',
            serverUrl: 'http://localhost:43917',
        });
        const store = localStorage!.store;
        const readKeys = new Set<string>();
        localStorage!.getItemMock.mockImplementation((key: string) => {
            readKeys.add(key);
            return store.get(key) ?? null;
        });
        await expect(resolveServerCredentialAccountScope(home.id)).resolves.toEqual({ kind: 'signed_out' });
        const credentialKeys = [...readKeys].filter((key) => key.includes('auth_credentials'));
        const legacyKeys = credentialKeys.filter((key) => !key.includes(home.id));
        expect(legacyKeys.length).toBeGreaterThanOrEqual(2);

        const [unreadableLegacyKey, readableLegacyKey] = legacyKeys;
        const payload = Buffer.from(JSON.stringify({ sub: 'legacy-account' })).toString('base64');
        store.set(readableLegacyKey!, JSON.stringify({ token: `header.${payload}.signature`, secret: 'legacy-secret' }));
        localStorage!.getItemMock.mockImplementation((key: string) => {
            if (key === unreadableLegacyKey) throw new Error('The operation is insecure.');
            return store.get(key) ?? null;
        });

        await expect(resolveServerCredentialAccountScope(home.id)).resolves.toMatchObject({
            kind: 'bound',
            scope: { serverId: home.id, accountId: 'legacy-account' },
        });
        expect(captureExceptionIfEnabled).not.toHaveBeenCalled();
    });

    it('treats a malformed credential as signed out and fingerprints each bound credential without its token', async () => {
        const home = await upsertServerProfile({
            name: 'Malformed credential Home',
            serverUrl: 'https://malformed-credential-home.example.test',
        });
        const store = (token: string) => TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token });
        const token = (signature: string) => `e30.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.${signature}`;

        // A stored credential that names no Account cannot establish a binding.
        expect(await store('malformed')).toBe(true);
        await expect(resolveServerCredentialAccountScope(home.id)).resolves.toEqual({ kind: 'signed_out' });

        expect(await store(token('first'))).toBe(true);
        const first = await resolveServerCredentialAccountScope(home.id);
        expect(first).toMatchObject({ kind: 'bound', scope: { serverId: home.id, accountId: 'account-a' } });
        const firstKey = first.kind === 'bound' ? first.credentialKey : undefined;
        expect(firstKey).toEqual(expect.any(String));
        expect(firstKey).not.toContain(token('first'));
        // The same stored credential keeps its fingerprint across reads ...
        await expect(resolveServerCredentialAccountScope(home.id)).resolves.toMatchObject({ credentialKey: firstKey });

        // ... and a replacement credential for the same Account does not.
        expect(await store(token('second'))).toBe(true);
        const second = await resolveServerCredentialAccountScope(home.id);
        expect(second).toMatchObject({ kind: 'bound', scope: { accountId: 'account-a' } });
        expect(second.kind === 'bound' ? second.credentialKey : undefined).not.toBe(firstKey);
    });
});
