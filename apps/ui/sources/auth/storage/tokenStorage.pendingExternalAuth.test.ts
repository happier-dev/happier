import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { installLocalStorageMock, type LocalStorageMockHandle } from './tokenStorage.web.testHelpers';
import { installTokenStorageWebPlatformMocks } from './tokenStorage.testHelpers';

installTokenStorageWebPlatformMocks();

describe('TokenStorage pending external auth (web)', () => {
    let restoreLocalStorage: (() => void) | null = null;
    let localStorageHandle: LocalStorageMockHandle | null = null;

    beforeEach(() => {
        vi.resetModules();
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
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerUrl: () => 'https://relay.example.test',
            };
        });

        const { TokenStorage } = await import('./tokenStorage');

        expect(typeof TokenStorage.setPendingExternalAuth).toBe('function');
        expect(typeof TokenStorage.getPendingExternalAuth).toBe('function');
        expect(typeof TokenStorage.clearPendingExternalAuth).toBe('function');

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();

        const ok = await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'p',
            serverUrl: 'https://relay.example.test',
        });
        expect(ok).toBe(true);

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual({
            provider: 'github',
            proof: 'p',
            serverUrl: 'https://relay.example.test',
        });

        if (!localStorageHandle) {
            throw new Error('Expected localStorage mock handle');
        }
        const pendingKeys = [...localStorageHandle.store.keys()].filter((k) => k.includes('pending_external_auth'));
        expect(pendingKeys.length).toBe(2);
        expect(pendingKeys.some((k) => k.includes('__srv_'))).toBe(true);
        expect(pendingKeys.some((k) => k.includes('__global'))).toBe(true);

        // If the server-scoped key can't be resolved on return (server selection changed / lost),
        // TokenStorage should still recover the pending state from the global fallback.
        for (const key of pendingKeys) {
            if (key.includes('__srv_')) {
                localStorageHandle.store.delete(key);
            }
        }
        await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual({
            provider: 'github',
            proof: 'p',
            serverUrl: 'https://relay.example.test',
        });

        const cleared = await TokenStorage.clearPendingExternalAuth();
        expect(cleared).toBe(true);
        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('rejects global fallback pending external auth when the active server changed', async () => {
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerUrl: () => 'https://relay-b.example.test',
            };
        });

        const { TokenStorage } = await import('./tokenStorage');

        const ok = await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'p',
            serverUrl: 'https://relay-a.example.test',
        });
        expect(ok).toBe(true);

        if (!localStorageHandle) {
            throw new Error('Expected localStorage mock handle');
        }
        for (const key of [...localStorageHandle.store.keys()]) {
            if (key.includes('pending_external_auth') && key.includes('__srv_')) {
                localStorageHandle.store.delete(key);
            }
        }

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('reports a server mismatch for global fallback pending external auth when the active same-origin server profile changed', async () => {
        const state = {
            activeServerId: 'server-a',
            activeServerUrl: 'https://shared.example.test',
            profiles: [
                { id: 'server-a', serverUrl: 'https://shared.example.test', name: 'Server A' },
                { id: 'server-b', serverUrl: 'https://shared.example.test', name: 'Server B' },
            ],
        };

        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => state.activeServerId,
                getActiveServerUrl: () => state.activeServerUrl,
                listServerProfiles: () => state.profiles,
            };
        });

        const { TokenStorage } = await import('./tokenStorage');

        const ok = await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'p',
            serverUrl: state.activeServerUrl,
        });
        expect(ok).toBe(true);

        if (!localStorageHandle) {
            throw new Error('Expected localStorage mock handle');
        }
        for (const key of [...localStorageHandle.store.keys()]) {
            if (key.includes('pending_external_auth') && key.includes('__srv_')) {
                localStorageHandle.store.delete(key);
            }
        }

        state.activeServerId = 'server-b';

        await expect(TokenStorage.readPendingExternalAuthState()).resolves.toEqual({
            value: {
                provider: 'github',
                proof: 'p',
                serverId: 'server-a',
                serverUrl: state.activeServerUrl,
            },
            serverMismatch: true,
        });
        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('clears the original scoped pending external auth key even after the active server changes', async () => {
        const state = {
            activeServerId: 'server-a',
            activeServerUrl: 'https://shared.example.test',
            profiles: [
                { id: 'server-a', serverUrl: 'https://shared.example.test', name: 'Server A' },
                { id: 'server-b', serverUrl: 'https://shared.example.test', name: 'Server B' },
            ],
        };

        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => state.activeServerId,
                getActiveServerUrl: () => state.activeServerUrl,
                listServerProfiles: () => state.profiles,
            };
        });

        const { TokenStorage } = await import('./tokenStorage');

        const ok = await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'p',
            serverUrl: state.activeServerUrl,
        });
        expect(ok).toBe(true);

        state.activeServerId = 'server-b';

        await expect(TokenStorage.clearPendingExternalAuth()).resolves.toBe(true);

        if (!localStorageHandle) {
            throw new Error('Expected localStorage mock handle');
        }
        const remainingScopedKeys = [...localStorageHandle.store.keys()].filter(
            (key) => key.includes('pending_external_auth') && key.includes('__srv_'),
        );
        expect(remainingScopedKeys).toEqual([]);
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('rejects scoped pending external auth records that lack explicit server context', async () => {
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => 'server-a',
                getActiveServerUrl: () => 'https://relay.example.test',
                listServerProfiles: () => [{ id: 'server-a', serverUrl: 'https://relay.example.test', name: 'Server A' }],
            };
        });

        const { TokenStorage } = await import('./tokenStorage');

        await expect(
            TokenStorage.setPendingExternalAuth({ provider: 'github', proof: 'p' }),
        ).resolves.toBe(true);

        if (!localStorageHandle) {
            throw new Error('Expected localStorage mock handle');
        }

        for (const key of [...localStorageHandle.store.keys()]) {
            if (key.includes('pending_external_auth') && key.includes('__srv_')) {
                localStorageHandle.store.set(key, JSON.stringify({ provider: 'github', proof: 'p' }));
            }
            if (key.includes('pending_external_auth') && key.includes('__global')) {
                localStorageHandle.store.delete(key);
            }
        }

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('round-trips pending external auth state with both proof and secret', async () => {
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => null,
                getActiveServerUrl: () => '',
                listServerProfiles: () => [],
            };
        });

        const { TokenStorage } = await import('./tokenStorage');

        const ok = await TokenStorage.setPendingExternalAuth({ provider: 'github', proof: 'p', secret: 's', intent: 'reset' });
        expect(ok).toBe(true);

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual({ provider: 'github', proof: 'p', secret: 's', intent: 'reset' });
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('round-trips pending external auth returnTo when it is an internal path', async () => {
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => null,
                getActiveServerUrl: () => '',
                listServerProfiles: () => [],
            };
        });

        const { TokenStorage } = await import('./tokenStorage');

        const ok = await TokenStorage.setPendingExternalAuth({ provider: 'github', proof: 'p', returnTo: '/settings/account' });
        expect(ok).toBe(true);
        await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual({
            provider: 'github',
            proof: 'p',
            returnTo: '/settings/account',
        });
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('round-trips the bounded first-key migration continuation', async () => {
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => null,
                getActiveServerUrl: () => '',
                listServerProfiles: () => [],
            };
        });

        const { TokenStorage } = await import('./tokenStorage');
        const createdAt = Date.now();
        const continuation = {
            accountId: 'account-1',
            requestDigest: `aemrb1_${'A'.repeat(43)}`,
            requestJson: '{"toMode":"e2ee"}',
            createdAt,
            expiresAt: createdAt + 10 * 60 * 1000,
        };

        await expect(TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'proof',
            secret: 'secret',
            returnTo: '/settings/account',
            accountEncryptionFirstKey: continuation,
        })).resolves.toBe(true);
        await expect(TokenStorage.getPendingExternalAuth()).resolves.toEqual({
            provider: 'github',
            proof: 'proof',
            secret: 'secret',
            returnTo: '/settings/account',
            accountEncryptionFirstKey: continuation,
        });
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('round-trips an mTLS first-key continuation in the active server scope', async () => {
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => 'api.happier.dev',
                getActiveServerUrl: () => 'https://api.happier.dev',
                listServerProfiles: () => [{
                    id: 'api.happier.dev',
                    serverUrl: 'https://api.happier.dev',
                    name: 'Happier',
                }],
            };
        });

        const { TokenStorage } = await import('./tokenStorage');
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
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('preserves server A marked custody when server B clears and starts an unmarked flow', async () => {
        const state = {
            activeServerId: 'server-a',
            activeServerUrl: 'https://a.example.test',
            profiles: [
                {
                    id: 'server-a',
                    serverUrl: 'https://a.example.test',
                    name: 'Server A',
                },
                {
                    id: 'server-b',
                    serverUrl: 'https://b.example.test',
                    name: 'Server B',
                },
            ],
        };
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => state.activeServerId,
                getActiveServerUrl: () => state.activeServerUrl,
                listServerProfiles: () => state.profiles,
            };
        });
        const { TokenStorage } = await import('./tokenStorage');
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

        state.activeServerId = 'server-b';
        state.activeServerUrl = 'https://b.example.test';
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

        state.activeServerId = 'server-a';
        state.activeServerUrl = 'https://a.example.test';
        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: markedServerA,
            serverMismatch: false,
        });
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('reads retained marked custody from an active legacy profile scope before another server global pointer', async () => {
        const state = {
            activeServerId: 'server-a-old',
            activeServerUrl: 'https://a.example.test',
            profiles: [{
                id: 'server-a-old',
                serverUrl: 'https://a.example.test',
                name: 'Server A',
            }] as Array<{
                id: string;
                serverUrl: string;
                name: string;
                legacyServerIds?: string[];
            }>,
        };
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => state.activeServerId,
                getActiveServerUrl: () => state.activeServerUrl,
                listServerProfiles: () => state.profiles,
                areServerProfileIdentifiersEquivalent:
                    (
                        left: string | null | undefined,
                        right: string | null | undefined,
                    ) => {
                        if (left === right) return true;
                        return [left, right].every(
                            (id) =>
                                id === 'server-a-old'
                                || id === 'server-a-new',
                        );
                    },
            };
        });
        const { TokenStorage } = await import('./tokenStorage');
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

        state.profiles = [
            {
                id: 'server-a-new',
                serverUrl: 'https://a.example.test',
                name: 'Server A',
                legacyServerIds: ['server-a-old'],
            },
            {
                id: 'server-b',
                serverUrl: 'https://b.example.test',
                name: 'Server B',
            },
        ];
        state.activeServerId = 'server-b';
        state.activeServerUrl = 'https://b.example.test';
        await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'proof-b',
            secret: 'secret-b',
            serverId: 'server-b',
            serverUrl: 'https://b.example.test',
        });

        state.activeServerId = 'server-a-new';
        state.activeServerUrl = 'https://a.example.test';
        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: markedServerA,
            serverMismatch: false,
        });
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('rejects an unrelated same-server write that would replace marked custody', async () => {
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => 'server-a',
                getActiveServerUrl: () => 'https://a.example.test',
                listServerProfiles: () => [{
                    id: 'server-a',
                    serverUrl: 'https://a.example.test',
                    name: 'Server A',
                }],
            };
        });
        const { TokenStorage } = await import('./tokenStorage');
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
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('removes only the exactly authorized marked continuation when two servers have marked custody', async () => {
        const state = {
            activeServerId: 'server-a',
            activeServerUrl: 'https://a.example.test',
            profiles: [
                {
                    id: 'server-a',
                    serverUrl: 'https://a.example.test',
                    name: 'Server A',
                },
                {
                    id: 'server-b',
                    serverUrl: 'https://b.example.test',
                    name: 'Server B',
                },
            ],
        };
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => state.activeServerId,
                getActiveServerUrl: () => state.activeServerUrl,
                listServerProfiles: () => state.profiles,
            };
        });
        const { TokenStorage } = await import('./tokenStorage');
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
        state.activeServerId = 'server-b';
        state.activeServerUrl = 'https://b.example.test';
        await expect(
            TokenStorage.setPendingExternalAuth(markedServerB),
        ).resolves.toBe(true);
        state.activeServerId = 'server-a';
        state.activeServerUrl = 'https://a.example.test';

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

        state.activeServerId = 'server-b';
        state.activeServerUrl = 'https://b.example.test';
        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: markedServerB,
            serverMismatch: false,
        });
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('retains expired post-submission custody for every server until exact recovery or abandonment', async () => {
        const state = {
            activeServerId: 'server-a',
            activeServerUrl: 'https://a.example.test',
            profiles: [
                {
                    id: 'server-a',
                    serverUrl: 'https://a.example.test',
                    name: 'Server A',
                },
                {
                    id: 'server-b',
                    serverUrl: 'https://b.example.test',
                    name: 'Server B',
                },
            ],
        };
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => state.activeServerId,
                getActiveServerUrl: () => state.activeServerUrl,
                listServerProfiles: () => state.profiles,
            };
        });
        const { TokenStorage } = await import('./tokenStorage');
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
        state.activeServerId = 'server-b';
        state.activeServerUrl = 'https://b.example.test';
        await expect(
            TokenStorage.setPendingExternalAuth(markedServerB),
        ).resolves.toBe(true);

        state.activeServerId = 'server-a';
        state.activeServerUrl = 'https://a.example.test';
        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: markedServerA,
            serverMismatch: false,
        });

        state.activeServerId = 'server-b';
        state.activeServerUrl = 'https://b.example.test';
        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: markedServerB,
            serverMismatch: false,
        });
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('rejects a false first-key migration-submission marker', async () => {
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => null,
                getActiveServerUrl: () => '',
                listServerProfiles: () => [],
            };
        });
        const { TokenStorage } = await import('./tokenStorage');
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
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('rejects a migration-submission marker without a pending handle', async () => {
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => null,
                getActiveServerUrl: () => '',
                listServerProfiles: () => [],
            };
        });
        const { TokenStorage } = await import('./tokenStorage');
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
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('clears an expired first-key continuation and its only pending seed', async () => {
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => null,
                getActiveServerUrl: () => '',
                listServerProfiles: () => [],
            };
        });
        const { TokenStorage } = await import('./tokenStorage');
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
        if (!localStorageHandle) {
            throw new Error('Expected localStorage mock handle');
        }
        expect(
            [...localStorageHandle.store.keys()].filter(
                (key) => key.includes('pending_external_auth'),
            ),
        ).toEqual([]);
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('rejects a malformed first-key migration continuation', async () => {
        const { TokenStorage } = await import('./tokenStorage');

        if (!localStorageHandle) {
            throw new Error('Expected localStorage mock handle');
        }
        localStorageHandle.getItemMock.mockReturnValueOnce(JSON.stringify({
            provider: 'github',
            proof: 'proof',
            secret: 'secret',
            accountEncryptionFirstKey: {
                accountId: '',
                requestDigest: 'not-a-binding-digest',
                requestJson: '',
            },
        }));

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
    });

    it('rejects a noncanonical first-key request digest with invalid final base64url bits', async () => {
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getActiveServerId: () => null,
                getActiveServerUrl: () => '',
                listServerProfiles: () => [],
            };
        });
        const { TokenStorage } = await import('./tokenStorage');

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
        vi.doUnmock('@/sync/domains/server/serverProfiles');
    });

    it('returns null for malformed pending external auth payloads', async () => {
        const { TokenStorage } = await import('./tokenStorage');

        if (!localStorageHandle) {
            throw new Error('Expected localStorage mock handle');
        }
        localStorageHandle.getItemMock.mockReturnValueOnce(JSON.stringify({ provider: 123, secret: true }));

        await expect(TokenStorage.getPendingExternalAuth()).resolves.toBeNull();
    });
});
