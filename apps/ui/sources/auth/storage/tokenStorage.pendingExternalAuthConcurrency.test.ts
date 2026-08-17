import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    installTokenStorageWebPlatformMocks,
} from './tokenStorage.testHelpers';

const secureStore = vi.hoisted(() => {
    const store = new Map<string, string>();
    let blockGenericScopedWrite = false;
    let releaseGenericScopedWrite:
        (() => void) | null = null;
    let genericScopedWriteReached:
        (() => void) | null = null;

    return {
        store,
        reset() {
            store.clear();
            blockGenericScopedWrite = false;
            releaseGenericScopedWrite = null;
            genericScopedWriteReached = null;
        },
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
        async getItemAsync(key: string) {
            return store.get(key) ?? null;
        },
        async setItemAsync(key: string, value: string) {
            const parsed = JSON.parse(value) as {
                proof?: string;
            };
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
    };
});

installTokenStorageWebPlatformMocks({
    reactNative: () => ({
        Platform: { OS: 'ios' },
    }),
    secureStore: () => ({
        getItemAsync: secureStore.getItemAsync,
        setItemAsync: secureStore.setItemAsync,
        deleteItemAsync: secureStore.deleteItemAsync,
    }),
});

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/sync/domains/server/serverProfiles')
    >();
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

describe('TokenStorage pending external auth mutation serialization', () => {
    beforeEach(() => {
        vi.resetModules();
        secureStore.reset();
    });

    it('does not let a stale generic write overwrite admitted first-key custody', async () => {
        const { TokenStorage } = await import('./tokenStorage');
        const createdAt = Date.now();
        await TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'initial-proof',
            secret: 'initial-secret',
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
        });
        const gate = secureStore.blockNextGenericScopedWrite();
        const genericWrite =
            TokenStorage.setPendingExternalAuth({
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
            TokenStorage.setPendingExternalAuth(marked);
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
        gate.release();
        await expect(
            Promise.all([genericWrite, markerWrite]),
        ).resolves.toEqual([true, true]);

        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: marked,
            serverMismatch: false,
        });
    });
});
