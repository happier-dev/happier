import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
    createPasswordCredentialMutationDigestV1,
    createPasswordCredentialTargetDigestV1} from '@happier-dev/protocol/auth/passwordMutationChallenge';
import {
    encodePasswordCredentialFieldV1,
} from '@happier-dev/protocol/auth/accountPasswordCredential';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import { installLocalStorageMock, type LocalStorageMockHandle } from './tokenStorage.web.testHelpers';
import {
    homeProfileForTests,
    installTokenStorageTestIsolation,
    installTokenStorageWebPlatformMocks,
} from './tokenStorage.testHelpers';

installTokenStorageWebPlatformMocks();
installTokenStorageTestIsolation('token_storage_pending_external_auth');

const { TokenStorage } = await import('./tokenStorage');

const HOME_A = homeProfileForTests('server-a', 'https://a.example.test', { name: 'Server A' });
const HOME_B = homeProfileForTests('server-b', 'https://b.example.test', { name: 'Server B' });
const SHARED_URL = 'https://shared.example.test';
// The profile owner folds identity-less profiles at one URL; distinct Homes there carry distinct identities.
const SHARED_A = homeProfileForTests('server-a', SHARED_URL, { name: 'Server A', serverIdentityId: 'srv_shared_a', canonicalServerUrl: SHARED_URL });
const SHARED_B = homeProfileForTests('server-b', SHARED_URL, { name: 'Server B', serverIdentityId: 'srv_shared_b', canonicalServerUrl: SHARED_URL });
const TEAM_HOME = homeProfileForTests('home-team', 'https://home.example.test');

async function focus(profiles: readonly ServerProfile[], activeServerId: string): Promise<void> {
    await seedPersistedHomeProfilesForTests({ profiles, activeServerId });
}

/** A device without a saved Home: the real profile owner reports no active server id or URL. */
async function focusNoHome(): Promise<void> {
    await focus([], '');
}

function createFirstKeyContinuation() {
    const createdAt = Date.now();
    return {
        accountId: 'account-1',
        requestDigest: `aemrb1_${'A'.repeat(43)}`,
        requestJson: '{"toMode":"e2ee"}',
        createdAt,
        expiresAt: createdAt + 10 * 60 * 1000,
    };
}

/** Native secure storage whose next generic scoped pending write can be held until released. */
function createGatedNativeSecureStore() {
    const store = new Map<string, string>();
    let blockGenericScopedWrite = false;
    let releaseGenericScopedWrite: (() => void) | null = null;
    let genericScopedWriteReached: (() => void) | null = null;
    return {
        store,
        blockNextGenericScopedWrite() {
            blockGenericScopedWrite = true;
            return {
                reached: new Promise<void>((resolve) => {
                    genericScopedWriteReached = resolve;
                }),
                release() {
                    releaseGenericScopedWrite?.();
                },
            };
        },
        module: {
            async getItemAsync(key: string) {
                return store.get(key) ?? null;
            },
            async setItemAsync(key: string, value: string) {
                const parsed = JSON.parse(value) as { proof?: string };
                if (
                    blockGenericScopedWrite
                    && parsed.proof === 'generic-proof'
                    && key.includes('pending_external_auth__srv_')
                ) {
                    blockGenericScopedWrite = false;
                    genericScopedWriteReached?.();
                    await new Promise<void>((resolve) => {
                        releaseGenericScopedWrite = resolve;
                    });
                }
                store.set(key, value);
            },
            async deleteItemAsync(key: string) {
                store.delete(key);
            },
        },
    };
}

describe('TokenStorage pending external auth (web)', () => {
    let restoreLocalStorage: (() => void) | null = null;
    let localStorageHandle: LocalStorageMockHandle | null = null;

    function requireStorage(): LocalStorageMockHandle {
        if (!localStorageHandle) {
            throw new Error('Expected localStorage mock handle');
        }
        return localStorageHandle;
    }

    beforeEach(() => {
        localStorageHandle = installLocalStorageMock();
        restoreLocalStorage = localStorageHandle.restore;
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        restoreLocalStorage?.();
        restoreLocalStorage = null;
        localStorageHandle = null;
    });

    it('round-trips pending external auth state', async () => {
        const relay = homeProfileForTests('relay', 'https://relay.example.test');
        await focus([relay], relay.id);

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();

        const ok = await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'p',
            serverUrl: 'https://relay.example.test',
        });
        expect(ok).toBe(true);

        // The write records the exact focused Home for its URL.
        const stored = {
            provider: 'github',
            proof: 'p',
            serverId: 'relay',
            serverUrl: 'https://relay.example.test',
        };
        await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual(stored);

        const storage = requireStorage();
        const pendingKeys = [...storage.store.keys()].filter((k) => k.includes('pending_external_auth'));
        expect(pendingKeys.length).toBe(2);
        expect(pendingKeys.some((k) => k.includes('__srv_'))).toBe(true);
        expect(pendingKeys.some((k) => k.includes('__global'))).toBe(true);

        // If the server-scoped key can't be resolved on return (server selection changed / lost),
        // TokenStorage should still recover the pending state from the global fallback.
        for (const key of pendingKeys) {
            if (key.includes('__srv_')) {
                storage.store.delete(key);
            }
        }
        await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual(stored);

        const cleared = await TokenStorage.clearPendingExternalAuth();
        expect(cleared).toBe(true);
        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
    });

    it('rejects password-enrollment custody without writing its verifier, proof, or digest to browser storage', async () => {
        const homeA = homeProfileForTests('home-a', 'https://home-a.example.test');
        await focus([homeA], homeA.id);
        const createdAt = Date.now();
        const targetCredential = {
            v: 1 as const,
            kind: 'plain_password_hash' as const,
            hash: {
                v: 1 as const,
                algorithm: 'scrypt' as const,
                parameters: { n: 2 ** 14, r: 8 as const, p: 5, keyLength: 32 as const },
                salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)),
                digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)),
            },
        };
        const normalizedNativeEmail = 'person@example.test';
        const requestDigest = createPasswordCredentialMutationDigestV1({
            v: 1,
            action: 'connect',
            accountId: 'account-a',
            expectedCredentialRevision: null,
            normalizedNativeEmail,
            newCredentialDigest: createPasswordCredentialTargetDigestV1(targetCredential),
        });
        const pending = {
            provider: 'github',
            proof: 'local-proof',
            serverId: 'home-a',
            serverUrl: 'https://home-a.example.test',
            returnTo: '/settings/account/security?verificationToken=mailbox-proof',
            accountPasswordEnrollment: {
                v: 1 as const,
                accountId: 'account-a',
                normalizedNativeEmail,
                targetCredential,
                requestDigest,
                createdAt,
                expiresAt: createdAt + 60_000,
                pending: 'server-pending',
            },
        };

        await expect(TokenStorage.setPendingExternalAuth(pending)).resolves.toBe(false);
        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();

        const storedBytes = [...requireStorage().store.values()].join('\n');
        expect(storedBytes).not.toContain('local-proof');
        expect(storedBytes).not.toContain(targetCredential.hash.salt);
        expect(storedBytes).not.toContain(targetCredential.hash.digest);
        expect(storedBytes).not.toContain(requestDigest);
    });

    it('rejects global fallback pending external auth when the active server changed', async () => {
        const relayB = homeProfileForTests('relay-b', 'https://relay-b.example.test');
        await focus([relayB], relayB.id);

        const ok = await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'p',
            serverUrl: 'https://relay-a.example.test',
        });
        expect(ok).toBe(true);

        const storage = requireStorage();
        for (const key of [...storage.store.keys()]) {
            if (key.includes('pending_external_auth') && key.includes('__srv_')) {
                storage.store.delete(key);
            }
        }

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
    });

    it('reports a server mismatch for global fallback pending external auth when the active same-origin server profile changed', async () => {
        await focus([SHARED_A, SHARED_B], SHARED_A.id);

        const ok = await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'p',
            serverUrl: SHARED_URL,
        });
        expect(ok).toBe(true);

        const storage = requireStorage();
        for (const key of [...storage.store.keys()]) {
            if (key.includes('pending_external_auth') && key.includes('__srv_')) {
                storage.store.delete(key);
            }
        }

        await focus([SHARED_A, SHARED_B], SHARED_B.id);

        await expect(TokenStorage.readPendingExternalAuthState()).resolves.toEqual({
            value: {
                provider: 'github',
                proof: 'p',
                serverId: 'srv_shared_a',
                serverUrl: SHARED_URL,
            },
            serverMismatch: true,
        });
        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
    });

    it('clears the original scoped pending external auth key even after the active server changes', async () => {
        await focus([SHARED_A, SHARED_B], SHARED_A.id);

        const ok = await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'p',
            serverUrl: SHARED_URL,
        });
        expect(ok).toBe(true);

        await focus([SHARED_A, SHARED_B], SHARED_B.id);

        await expect(TokenStorage.clearPendingExternalAuth()).resolves.toBe(true);

        const remainingScopedKeys = [...requireStorage().store.keys()].filter(
            (key) => key.includes('pending_external_auth') && key.includes('__srv_'),
        );
        expect(remainingScopedKeys).toEqual([]);
    });

    it('rejects scoped pending external auth records that lack explicit server context', async () => {
        const relay = homeProfileForTests('server-a', 'https://relay.example.test', { name: 'Server A' });
        await focus([relay], relay.id);

        await expect(
            TokenStorage.setPendingExternalAuth({ provider: 'github', proof: 'p' }),
        ).resolves.toBe(true);

        const storage = requireStorage();
        for (const key of [...storage.store.keys()]) {
            if (key.includes('pending_external_auth') && key.includes('__srv_')) {
                storage.store.set(key, JSON.stringify({ provider: 'github', proof: 'p' }));
            }
            if (key.includes('pending_external_auth') && key.includes('__global')) {
                storage.store.delete(key);
            }
        }

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
    });

    it.each([
        {
            name: 'both proof and secret',
            pending: { provider: 'github', proof: 'p', secret: 's', intent: 'reset' as const },
        },
        {
            name: 'the bounded first-key migration continuation',
            pending: {
                provider: 'github',
                proof: 'proof',
                secret: 'secret',
                returnTo: '/settings/account',
                accountEncryptionFirstKey: createFirstKeyContinuation(),
            },
        },
    ])('round-trips pending external auth state with $name', async ({ pending }) => {
        await focusNoHome();

        await expect(TokenStorage.setPendingExternalAuth(pending)).resolves.toBe(true);
        await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual(pending);
    });

    it.each([
        { returnTo: '/settings/account', readable: true },
        { returnTo: 'https://attacker.example.test/settings/account', readable: false },
        { returnTo: '//attacker.example.test/settings/account', readable: false },
    ])('reads back pending external auth returnTo $returnTo only when it is an internal path', async ({ returnTo, readable }) => {
        await focusNoHome();
        const pending = { provider: 'github', proof: 'p', returnTo };

        await TokenStorage.setPendingExternalAuth(pending);

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual(readable ? pending : null);
    });

    it('round-trips an mTLS first-key continuation in the active server scope', async () => {
        const happier = homeProfileForTests('api.happier.dev', 'https://api.happier.dev', { name: 'Happier' });
        await focus([happier], happier.id);
        const createdAt = Date.now();
        const pending = {
            provider: 'mtls',
            proof: 'proof',
            secret: 'secret',
            serverId: 'api.happier.dev',
            serverUrl: 'https://api.happier.dev',
            returnTo: '/settings/account',
            accountEncryptionFirstKey: {
                accountId: 'account-1',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{"toMode":"e2ee"}',
                createdAt,
                expiresAt: createdAt + 10 * 60 * 1000,
                pending: 'mtls-pending',
                migrationSubmissionAttempted: true,
            },
        } as const;

        await expect(
            TokenStorage.setPendingExternalAuth(pending),
        ).resolves.toBe(true);
        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: pending,
            serverMismatch: false,
        });
    });

    it('preserves server A marked custody when server B clears and starts an unmarked flow', async () => {
        await focus([HOME_A, HOME_B], HOME_A.id);
        const createdAt = Date.now();
        const markedServerA = {
            provider: 'github',
            proof: 'proof-a',
            secret: 'secret-a',
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
            accountEncryptionFirstKey: {
                accountId: 'account-a',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{"toMode":"e2ee","server":"a"}',
                createdAt,
                expiresAt: createdAt + 10 * 60 * 1000,
                pending: 'pending-a',
                migrationSubmissionAttempted: true,
            },
        } as const;

        await expect(
            TokenStorage.setPendingExternalAuth(markedServerA),
        ).resolves.toBe(true);

        await focus([HOME_A, HOME_B], HOME_B.id);
        await TokenStorage.clearPendingExternalAuth();
        await expect(
            TokenStorage.setPendingExternalAuth({
                provider: 'github',
                proof: 'proof-b',
                secret: 'secret-b',
                serverId: 'server-b',
                serverUrl: 'https://b.example.test',
            }),
        ).resolves.toBe(true);

        await focus([HOME_A, HOME_B], HOME_A.id);
        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: markedServerA,
            serverMismatch: false,
        });
    });

    it('reads retained marked custody from an active legacy profile scope before another server global pointer', async () => {
        const serverAOld = homeProfileForTests('server-a-old', 'https://a.example.test', { name: 'Server A' });
        await focus([serverAOld], serverAOld.id);
        const createdAt = Date.now();
        const markedServerA = {
            provider: 'github',
            proof: 'proof-a',
            secret: 'secret-a',
            serverId: 'server-a-old',
            serverUrl: 'https://a.example.test',
            accountEncryptionFirstKey: {
                accountId: 'account-a',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{"toMode":"e2ee","server":"a"}',
                createdAt,
                expiresAt: createdAt + 10 * 60 * 1000,
                pending: 'pending-a',
                migrationSubmissionAttempted: true,
            },
        } as const;
        await TokenStorage.setPendingExternalAuth(markedServerA);

        // The Home is re-registered under a new profile id that retains its old id as a legacy alias.
        const serverANew = homeProfileForTests('server-a-new', 'https://a.example.test', {
            name: 'Server A',
            legacyServerIds: ['server-a-old'],
        });
        await focus([serverANew, HOME_B], HOME_B.id);
        await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'proof-b',
            secret: 'secret-b',
            serverId: 'server-b',
            serverUrl: 'https://b.example.test',
        });

        await focus([serverANew, HOME_B], serverANew.id);
        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: markedServerA,
            serverMismatch: false,
        });
    });

    it('rejects an unrelated same-server write that would replace marked custody', async () => {
        await focus([HOME_A], HOME_A.id);
        const createdAt = Date.now();
        const marked = {
            provider: 'github',
            proof: 'proof-a',
            secret: 'secret-a',
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
            accountEncryptionFirstKey: {
                accountId: 'account-a',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{"toMode":"e2ee","server":"a"}',
                createdAt,
                expiresAt: createdAt + 10 * 60 * 1000,
                pending: 'pending-a',
                migrationSubmissionAttempted: true,
            },
        } as const;
        await TokenStorage.setPendingExternalAuth(marked);

        await expect(
            TokenStorage.setPendingExternalAuth({
                provider: 'github',
                proof: 'unrelated-proof',
                secret: 'unrelated-secret',
                serverId: 'server-a',
                serverUrl: 'https://a.example.test',
            }),
        ).resolves.toBe(false);
        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: marked,
            serverMismatch: false,
        });
    });

    it('removes only the exactly authorized marked continuation when two servers have marked custody', async () => {
        await focus([HOME_A, HOME_B], HOME_A.id);
        const createdAt = Date.now();
        const markedServerA = {
            provider: 'github',
            proof: 'proof-a',
            secret: 'secret-a',
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
            accountEncryptionFirstKey: {
                accountId: 'account-a',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{"toMode":"e2ee","server":"a"}',
                createdAt,
                expiresAt: createdAt + 10 * 60 * 1000,
                pending: 'pending-a',
                migrationSubmissionAttempted: true,
            },
        } as const;
        const markedServerB = {
            provider: 'github',
            proof: 'proof-b',
            secret: 'secret-b',
            serverId: 'server-b',
            serverUrl: 'https://b.example.test',
            accountEncryptionFirstKey: {
                accountId: 'account-b',
                requestDigest:
                    `aemrb1_${'A'.repeat(42)}E`,
                requestJson: '{"toMode":"e2ee","server":"b"}',
                createdAt: createdAt + 1,
                expiresAt: createdAt + 10 * 60 * 1000,
                pending: 'pending-b',
                migrationSubmissionAttempted: true,
            },
        } as const;

        await TokenStorage.setPendingExternalAuth(markedServerA);
        await focus([HOME_A, HOME_B], HOME_B.id);
        await expect(
            TokenStorage.setPendingExternalAuth(markedServerB),
        ).resolves.toBe(true);
        await focus([HOME_A, HOME_B], HOME_A.id);

        await expect(
            TokenStorage.clearPendingExternalAuth({
                removeFirstKeyMigrationAttempted: {
                    ...markedServerA,
                    secret: 'wrong-secret',
                },
            }),
        ).resolves.toBe(false);
        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: markedServerA,
            serverMismatch: false,
        });

        await expect(
            TokenStorage.clearPendingExternalAuth({
                removeFirstKeyMigrationAttempted: markedServerA,
            }),
        ).resolves.toBe(true);

        await focus([HOME_A, HOME_B], HOME_B.id);
        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: markedServerB,
            serverMismatch: false,
        });
    });

    it('retains expired post-submission custody for every server until exact recovery or abandonment', async () => {
        await focus([HOME_A, HOME_B], HOME_A.id);
        const now = Date.now();
        const markedServerA = {
            provider: 'github',
            proof: 'proof-a',
            secret: 'secret-a',
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
            accountEncryptionFirstKey: {
                accountId: 'account-a',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{"toMode":"e2ee","server":"a"}',
                createdAt: now - 60_001,
                expiresAt: now - 1,
                pending: 'pending-a',
                migrationSubmissionAttempted: true,
            },
        } as const;
        await TokenStorage.setPendingExternalAuth(
            markedServerA,
        );
        const markedServerB = {
            provider: 'github',
            proof: 'proof-b',
            secret: 'secret-b',
            serverId: 'server-b',
            serverUrl: 'https://b.example.test',
            accountEncryptionFirstKey: {
                accountId: 'account-b',
                requestDigest:
                    `aemrb1_${'A'.repeat(42)}E`,
                requestJson: '{"toMode":"e2ee","server":"b"}',
                createdAt: now,
                expiresAt: now + 10 * 60 * 1000,
                pending: 'pending-b',
                migrationSubmissionAttempted: true,
            },
        } as const;
        await focus([HOME_A, HOME_B], HOME_B.id);
        await expect(
            TokenStorage.setPendingExternalAuth(markedServerB),
        ).resolves.toBe(true);

        await focus([HOME_A, HOME_B], HOME_A.id);
        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: markedServerA,
            serverMismatch: false,
        });

        await focus([HOME_A, HOME_B], HOME_B.id);
        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: markedServerB,
            serverMismatch: false,
        });
    });

    it('rejects a false first-key migration-submission marker', async () => {
        await focusNoHome();
        const createdAt = Date.now();

        await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'proof',
            secret: 'secret',
            accountEncryptionFirstKey: {
                accountId: 'account-1',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{"toMode":"e2ee"}',
                createdAt,
                expiresAt: createdAt + 10 * 60 * 1000,
                migrationSubmissionAttempted:
                    false as never,
            },
        });

        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: null,
            serverMismatch: false,
        });
    });

    it('rejects a migration-submission marker without a pending handle', async () => {
        await focusNoHome();
        const createdAt = Date.now();

        await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'proof',
            secret: 'secret',
            accountEncryptionFirstKey: {
                accountId: 'account-1',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{"toMode":"e2ee"}',
                createdAt,
                expiresAt: createdAt + 10 * 60 * 1000,
                migrationSubmissionAttempted: true,
            },
        });

        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: null,
            serverMismatch: false,
        });
    });

    it('clears an expired first-key continuation and its only pending seed', async () => {
        await focusNoHome();
        const expiresAt = Date.now() - 1;

        await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'proof',
            secret: 'secret',
            accountEncryptionFirstKey: {
                accountId: 'account-1',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{"toMode":"e2ee"}',
                createdAt: expiresAt - 60_000,
                expiresAt,
            },
        });

        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: null,
            serverMismatch: false,
        });
        expect(
            [...requireStorage().store.keys()].filter(
                (key) => key.includes('pending_external_auth'),
            ),
        ).toEqual([]);
    });

    it('rejects a noncanonical first-key request digest with invalid final base64url bits', async () => {
        await focusNoHome();

        await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'proof',
            secret: 'secret',
            accountEncryptionFirstKey: {
                accountId: 'account-1',
                requestDigest:
                    `aemrb1_${'A'.repeat(42)}B`,
                requestJson: '{"toMode":"e2ee"}',
                createdAt: Date.now(),
                expiresAt: Date.now() + 10 * 60 * 1000,
            },
        });

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
    });

    const storedPending = { provider: 'github', proof: 'proof', secret: 'secret' };
    it.each([
        { name: 'a valid record', payload: storedPending, expected: storedPending },
        {
            name: 'a malformed first-key migration continuation',
            payload: {
                ...storedPending,
                accountEncryptionFirstKey: {
                    accountId: '',
                    requestDigest: 'not-a-binding-digest',
                    requestJson: '',
                },
            },
            expected: null,
        },
        { name: 'malformed pending external auth fields', payload: { provider: 123, secret: true }, expected: null },
    ])('reads $name stored at the exact pending external auth key', async ({ payload, expected }) => {
        await focusNoHome();
        await expect(TokenStorage.setPendingExternalAuth(storedPending)).resolves.toBe(true);
        const storage = requireStorage();
        const pendingKeys = [...storage.store.keys()].filter((key) => key.includes('pending_external_auth'));
        const scopedKey = pendingKeys.find((key) => key.includes('__srv_'));
        if (!scopedKey) throw new Error('Expected the scoped pending external auth key');
        // Leave only the exact scoped record, so the read cannot fall back to the global copy.
        for (const key of pendingKeys) {
            if (key !== scopedKey) storage.store.delete(key);
        }
        storage.store.set(scopedKey, JSON.stringify(payload));

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual(expected);
    });

    it('retains only the strict Team-purpose continuation without a generic return destination', async () => {
        await focus([TEAM_HOME], TEAM_HOME.id);
        const pending = {
            provider: 'github',
            proof: 'proof',
            serverId: 'home-team',
            serverUrl: 'https://home.example.test',
            teamContinuation: {
                v: 1 as const,
                purpose: 'team_admission' as const,
                admissionReference: 'oauth-attempt-1',
                teamId: 'team-1',
                homeServerIdentityId: 'home-team',
                destination: { kind: 'team_sign_in' as const, teamId: 'team-1' },
            },
        };

        await expect(TokenStorage.setPendingExternalAuth(pending)).resolves.toBe(true);
        await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual(pending);
    });

    it('round-trips native mTLS Team custody without an OAuth proof or secret', async () => {
        await focus([TEAM_HOME], TEAM_HOME.id);
        const pending = {
            provider: 'mtls',
            serverId: 'home-team',
            serverUrl: 'https://home.example.test',
            teamContinuation: {
                v: 1 as const,
                purpose: 'team_admission' as const,
                admissionReference: 'mtls-admission-1',
                teamId: 'team-1',
                homeServerIdentityId: 'home-team',
                destination: { kind: 'team_sign_in' as const, teamId: 'team-1' },
            },
        };

        await expect(TokenStorage.setPendingExternalAuth(pending)).resolves.toBe(true);
        await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual(pending);
    });

    it.each([
        { name: 'complete exact custody', change: {}, written: true },
        { name: 'missing exact server identity', change: { serverId: undefined }, written: false },
        { name: 'missing exact server URL', change: { serverUrl: undefined }, written: false },
        { name: 'no safe continuation', change: { teamContinuation: undefined }, written: false },
        { name: 'mismatched Team destination', change: { teamContinuation: {
            v: 1, purpose: 'team_admission', admissionReference: 'mtls-admission-1', teamId: 'team-1',
            homeServerIdentityId: 'home-team', destination: { kind: 'team_sign_in', teamId: 'team-other' },
        } }, written: false },
    ])('writes native mTLS custody with $name only when it is complete', async ({ change, written }) => {
        await focus([TEAM_HOME], TEAM_HOME.id);
        await expect(TokenStorage.setPendingExternalAuth({
            provider: 'mtls',
            serverId: 'home-team',
            serverUrl: 'https://home.example.test',
            teamContinuation: {
                v: 1,
                purpose: 'team_admission',
                admissionReference: 'mtls-admission-1',
                teamId: 'team-1',
                homeServerIdentityId: 'home-team',
                destination: { kind: 'team_sign_in', teamId: 'team-1' },
            },
            ...change,
        } as never)).resolves.toBe(written);
    });

    it.each([
        { name: 'generic return destination', change: { returnTo: '/teams/team-1/join/invitation-secret' } },
        { name: 'wrong Home identity', change: { teamContinuation: {
            v: 1, purpose: 'team_admission', admissionReference: 'oauth-attempt-1', teamId: 'team-1',
            homeServerIdentityId: 'home-other', destination: { kind: 'team_sign_in', teamId: 'team-1' },
        } } },
        { name: 'extra destination field', change: { teamContinuation: {
            v: 1, purpose: 'team_admission', admissionReference: 'oauth-attempt-1', teamId: 'team-1',
            homeServerIdentityId: 'home-team', destination: { kind: 'team_sign_in', teamId: 'team-1', token: 'secret' },
        } } },
    ])('rejects a Team continuation with a $name', async ({ change }) => {
        // Same focused Home as the strict Team continuation above, which this record differs from only by `change`.
        await focus([TEAM_HOME], TEAM_HOME.id);
        await expect(TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'proof',
            serverId: 'home-team',
            serverUrl: 'https://home.example.test',
            teamContinuation: {
                v: 1,
                purpose: 'team_admission',
                admissionReference: 'oauth-attempt-1',
                teamId: 'team-1',
                homeServerIdentityId: 'home-team',
                destination: { kind: 'team_sign_in', teamId: 'team-1' },
            },
            ...change,
        } as never)).resolves.toBe(false);

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
    });

    it('does not let a stale generic write overwrite admitted first-key custody in native secure storage', async () => {
        // Native secure-store writes are asynchronous, so a write can still be in storage when a
        // later mutation is issued; this needs a second TokenStorage instance on a native platform.
        await focus([HOME_A], HOME_A.id);
        const secureStore = createGatedNativeSecureStore();
        // Mocked module results survive vi.resetModules(); doMock replaces them for later imports.
        // Fresh imports after this point would also be native, so this test stays last in the file.
        vi.doMock('react-native', () => ({ Platform: { OS: 'ios' } }));
        vi.doMock('expo-secure-store', () => secureStore.module);
        vi.resetModules();
        const { TokenStorage: NativeTokenStorage } = await import('./tokenStorage');
        const createdAt = Date.now();
        await NativeTokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'initial-proof',
            secret: 'initial-secret',
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
        });
        expect([...secureStore.store.keys()].some((key) => key.includes('pending_external_auth__srv_'))).toBe(true);
        const gate = secureStore.blockNextGenericScopedWrite();
        const genericWrite =
            NativeTokenStorage.setPendingExternalAuth({
                provider: 'github',
                proof: 'generic-proof',
                secret: 'generic-secret',
                serverId: 'server-a',
                serverUrl: 'https://a.example.test',
            });
        await gate.reached;

        const marked = {
            provider: 'github',
            proof: 'first-key-proof',
            secret: 'first-key-secret',
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
            accountEncryptionFirstKey: {
                accountId: 'account-a',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{"toMode":"e2ee"}',
                createdAt,
                expiresAt: createdAt + 10 * 60 * 1000,
                pending: 'pending-a',
                migrationSubmissionAttempted: true,
            },
        } as const;
        const markerWrite =
            NativeTokenStorage.setPendingExternalAuth(marked);
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
        gate.release();
        await expect(
            Promise.all([genericWrite, markerWrite]),
        ).resolves.toEqual([true, true]);

        await expect(
            NativeTokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: marked,
            serverMismatch: false,
        });
    });
});
