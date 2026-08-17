import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import {
    installLocalStorageMock,
    type LocalStorageMockHandle,
} from './tokenStorage.web.testHelpers';
import {
    installTokenStorageWebPlatformMocks,
} from './tokenStorage.testHelpers';

installTokenStorageWebPlatformMocks();

const server = {
    serverId: 'server-a',
    serverUrl: 'https://a.example.test',
} as const;

function createMarkedPending(suffix: string) {
    const createdAt = Date.now();
    return {
        provider: 'github',
        proof: `proof-${suffix}`,
        secret: `secret-${suffix}`,
        ...server,
        accountEncryptionFirstKey: {
            accountId: `account-${suffix}`,
            requestDigest:
                `aemrb1_${'A'.repeat(43)}`,
            requestJson: `{"suffix":"${suffix}"}`,
            createdAt,
            expiresAt:
                createdAt + 10 * 60 * 1000,
            pending: `pending-${suffix}`,
            migrationSubmissionAttempted:
                true as const,
        },
    };
}

describe('TokenStorage first-key rejected credential custody', () => {
    let storage: LocalStorageMockHandle;

    beforeEach(() => {
        vi.resetModules();
        storage = installLocalStorageMock();
        vi.doMock(
            '@/sync/domains/server/serverProfiles',
            async (importOriginal) => {
                const actual =
                    await importOriginal<
                        typeof import(
                            '@/sync/domains/server/serverProfiles'
                        )
                    >();
                return {
                    ...actual,
                    getActiveServerId:
                        () => server.serverId,
                    getActiveServerUrl:
                        () => server.serverUrl,
                    listServerProfiles: () => [{
                        id: server.serverId,
                        serverUrl:
                            server.serverUrl,
                        name: 'Server A',
                    }],
                };
            },
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.doUnmock(
            '@/sync/domains/server/serverProfiles',
        );
        storage.restore();
    });

    it('persists an exact rejected-token digest across module reload without storing the bearer', async () => {
        const { TokenStorage } =
            await import('./tokenStorage');
        const pending =
            createMarkedPending('current');
        await TokenStorage.setCredentials({
            token: 'token-rejected',
        });
        await TokenStorage.setPendingExternalAuth(
            pending,
        );

        const recorded =
            await TokenStorage
                .markPendingExternalAuthFirstKeyRejectedCredential({
                    expected: pending,
                    token: 'token-rejected',
                    ...server,
                });
        expect(recorded.kind).toBe('recorded');
        expect(
            JSON.stringify(
                [...storage.store.entries()]
                    .filter(([key]) =>
                        key.includes(
                            'pending_external_auth',
                        ))
                    .map(([, value]) => value),
            ),
        ).not.toContain('token-rejected');

        vi.resetModules();
        const reloaded =
            await import('./tokenStorage');
        await expect(
            reloaded.TokenStorage
                .classifyPendingExternalAuthFirstKeyRejectedCredential({
                    token: 'token-rejected',
                    ...server,
                }),
        ).resolves.toMatchObject({
            kind: 'rejected',
            pending: {
                accountEncryptionFirstKey: {
                    migrationSubmissionAttempted:
                        true,
                },
            },
        });
        await expect(
            reloaded.TokenStorage
                .classifyPendingExternalAuthFirstKeyRejectedCredential({
                    token: 'token-replacement',
                    ...server,
                }),
        ).resolves.toEqual({
            kind: 'allowed',
        });
    });

    it('does not mark a stale bearer that is not the current target credential', async () => {
        const { TokenStorage } =
            await import('./tokenStorage');
        const pending =
            createMarkedPending('current');
        await TokenStorage.setCredentials({
            token: 'token-current',
        });
        await TokenStorage.setPendingExternalAuth(
            pending,
        );

        await expect(
            TokenStorage
                .markPendingExternalAuthFirstKeyRejectedCredential({
                    expected: pending,
                    token: 'token-stale',
                    ...server,
                }),
        ).resolves.toEqual({
            kind: 'not_current',
        });
        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: pending,
            serverMismatch: false,
        });
    });

    it('returns marked custody only when the stored first-key attempt still exactly matches the recovery handle', async () => {
        const { TokenStorage } =
            await import('./tokenStorage');
        const pending =
            createMarkedPending('exact');
        await TokenStorage.setPendingExternalAuth(
            pending,
        );

        await expect(
            TokenStorage
                .readExactPendingExternalAuthFirstKeyMigrationAttempt({
                    expected: pending,
                    ...server,
                }),
        ).resolves.toEqual(pending);
        await expect(
            TokenStorage
                .readExactPendingExternalAuthFirstKeyMigrationAttempt({
                    expected: {
                        ...pending,
                        accountEncryptionFirstKey: {
                            ...pending
                                .accountEncryptionFirstKey,
                            accountId:
                                'account-replaced',
                        },
                    },
                    ...server,
                }),
        ).resolves.toBeNull();
    });

    it('rejects a noncanonical persisted rejection digest', async () => {
        const { TokenStorage } =
            await import('./tokenStorage');
        const pending =
            createMarkedPending('malformed');
        await TokenStorage.setPendingExternalAuth({
            ...pending,
            accountEncryptionFirstKey: {
                ...pending
                    .accountEncryptionFirstKey,
                rejectedCredentialTokenDigest:
                    `${'A'.repeat(42)}B`,
            },
        });

        vi.resetModules();
        const reloaded =
            await import('./tokenStorage');
        await expect(
            reloaded.TokenStorage
                .readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: null,
            serverMismatch: false,
        });
    });

    it('does not mark a concurrently replaced pending record', async () => {
        const { TokenStorage } =
            await import('./tokenStorage');
        const original =
            createMarkedPending('original');
        const replacement = {
            provider: 'github',
            proof: 'proof-replacement',
            secret: 'secret-replacement',
            ...server,
        };
        await TokenStorage.setCredentials({
            token: 'token-current',
        });
        await TokenStorage.setPendingExternalAuth(
            original,
        );

        const cleared =
            TokenStorage.clearPendingExternalAuth({
                removeFirstKeyMigrationAttempted:
                    original,
                ...server,
            });
        const replaced =
            TokenStorage.setPendingExternalAuth(
                replacement,
            );
        const marked =
            TokenStorage
                .markPendingExternalAuthFirstKeyRejectedCredential({
                    expected: original,
                    token: 'token-current',
                    ...server,
                });

        await expect(cleared).resolves.toBe(true);
        await expect(replaced).resolves.toBe(true);
        await expect(marked).resolves.toEqual({
            kind: 'not_current',
        });
        await expect(
            TokenStorage.readPendingExternalAuthState(),
        ).resolves.toEqual({
            value: replacement,
            serverMismatch: false,
        });
    });
});
