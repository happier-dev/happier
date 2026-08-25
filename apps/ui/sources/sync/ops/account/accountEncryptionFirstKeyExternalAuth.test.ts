import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    AccountEncryptionMigrateRequestSchema,
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    computeAccountEncryptionMigrateKeyFingerprintV1,
    createAccountEncryptionMigrateRequestBindingDigestV1,
    type FeaturesResponse,
} from '@happier-dev/protocol';
import { deriveAccountSigningPublicKey } from '@/auth/flows/challenge';
import { buildContentKeyBinding } from '@/auth/oauth/contentKeyBinding';
import { encodeBase64 } from '@/encryption/base64';
import { HappyError } from '@/utils/errors/errors';

const mocks = vi.hoisted(() => ({
    clearPending: vi.fn(async () => true),
    setPending: vi.fn(async () => true),
    readPending: vi.fn(),
    serverFetch: vi.fn(),
    getFeatures: vi.fn(),
    migrate: vi.fn(),
    fetchCurrentness: vi.fn(),
    authGetToken: vi.fn(),
    readExactAttempt: vi.fn(),
    acknowledgeSessionDrafts: vi.fn(),
    reconfigureSessionDraftRepository: vi.fn(),
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    getActiveServerAccountScope: () => ({
        serverId: 'server-a',
        accountId: 'account-1',
    }),
}));

vi.mock('@/sync/ops/sessionDrafts/sessionDraftRepository', () => ({
    acknowledgeNewSessionDraftEncryptionMigration:
        mocks.acknowledgeSessionDrafts,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        reconfigureSessionDraftRepositoryForAccountMode:
            mocks.reconfigureSessionDraftRepository,
    },
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('@/auth/storage/tokenStorage')
        >();
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            clearPendingExternalAuth: mocks.clearPending,
            setPendingExternalAuth: mocks.setPending,
            readPendingExternalAuthState: mocks.readPending,
            readPendingExternalAuthStateForServerUrl:
                mocks.readPending,
            readExactPendingExternalAuthFirstKeyMigrationAttempt:
                mocks.readExactAttempt,
        },
    };
});

vi.mock('@/auth/flows/getToken', () => ({
    authGetToken: mocks.authGetToken,
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: mocks.getFeatures,
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMigrate', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('@/sync/api/account/apiAccountEncryptionMigrate')
        >();
    return {
        ...actual,
        migrateAccountEncryptionMode: mocks.migrate,
    };
});

vi.mock('@/sync/api/account/apiAccountEncryptionMode', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('@/sync/api/account/apiAccountEncryptionMode')
        >();
    return {
        ...actual,
        fetchAccountEncryptionCurrentness:
            mocks.fetchCurrentness,
    };
});

import {
    guardAccountEncryptionFirstKeyCredentialMutation,
    openAccountEncryptionFirstKeyExternalAuthUrl,
    recoverAccountEncryptionFirstKeyRejectedCredential,
    retryPendingAccountEncryptionFirstKeyExternalAuth,
    resumeAccountEncryptionFirstKeyExternalAuth,
    startAccountEncryptionFirstKeyExternalAuth,
} from './accountEncryptionFirstKeyExternalAuth';

async function createFixture() {
    const seed = new Uint8Array(32).fill(7);
    const secret = Buffer.from(seed).toString('base64url');
    const contentBinding = await buildContentKeyBinding(seed);
    const request = AccountEncryptionMigrateRequestSchema.parse({
        toMode: 'e2ee',
        expectedAccountVersion: 8,
        expectedSigningKeyFingerprint: null,
        expectedContentKeyFingerprint: null,
        expectedSettingsVersion: 3,
        settingsContent: { t: 'encrypted', c: 'ciphertext' },
        connectedServices: { action: 'assert_empty' },
        automations: { action: 'assert_empty' },
        machines: { action: 'assert_empty' },
        todos: { action: 'assert_empty' },
        artifacts: { action: 'assert_empty' },
        sessions: { action: 'assert_empty' },
        reviewComments: {
            action: 'assert_empty',
        },
        sessionOrganization: {
            action: 'assert_empty',
        },
        pets: { action: 'assert_empty' },
        keyProof: {
            v: 1,
            publicKey: encodeBase64(
                deriveAccountSigningPublicKey(seed),
            ),
            ...contentBinding,
            signature: 'request-signature',
        },
    });
    return {
        accountId: 'account-1',
        currentCredentials: { token: 'token' } as const,
        proposedCredentials: { token: 'token', secret },
        request,
    };
}

function oauthFeatures() {
    return {
        status: 'ready',
        features: {
            features: {
                auth: { mtls: { enabled: false } },
            },
            capabilities: {
                oauth: {
                    providers: {
                        github: { enabled: true, configured: true },
                    },
                },
                auth: {
                    methods: [],
                    login: { methods: [], requiredProviders: [] },
                    providers: {
                        github: { enabled: true, configured: true },
                    },
                },
            },
        },
    } as unknown as FeaturesResponse;
}

function mtlsFeatures() {
    return {
        status: 'ready',
        features: {
            features: {
                auth: { mtls: { enabled: true } },
            },
            capabilities: {
                oauth: { providers: {} },
                auth: {
                    methods: [],
                    login: {
                        methods: [{ id: 'mtls', enabled: true }],
                        requiredProviders: [],
                    },
                    providers: {},
                },
            },
        },
    } as unknown as FeaturesResponse;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.clearPending
        .mockReset()
        .mockResolvedValue(true);
    mocks.setPending
        .mockReset()
        .mockResolvedValue(true);
    mocks.getFeatures.mockResolvedValue(oauthFeatures());
    mocks.migrate.mockResolvedValue({ mode: 'e2ee', version: 9 });
    mocks.fetchCurrentness.mockResolvedValue({
        mode: 'e2ee',
        updatedAt: 1,
        signingKeyFingerprint: null,
        contentKeyFingerprint: null,
    });
    mocks.authGetToken.mockReset();
    mocks.readExactAttempt.mockReset();
    mocks.acknowledgeSessionDrafts.mockReset();
    mocks.reconfigureSessionDraftRepository.mockReset();
});

describe('first Account key external auth', () => {
    it('recovers a rejected bearer only through the exact Account-bound challenge, then persists before exact cleanup', async () => {
        const fixture = await createFixture();
        const now = Date.now();
        const marked = {
            provider: 'github',
            proof: 'proof',
            secret: fixture.proposedCredentials.secret,
            serverId: 'server-a',
            serverUrl: 'https://server.example.test',
            returnTo: '/settings/account',
            accountEncryptionFirstKey: {
                accountId: fixture.accountId,
                requestDigest:
                    createAccountEncryptionMigrateRequestBindingDigestV1({
                        request: fixture.request,
                        accountId: fixture.accountId,
                        sourceMode: 'plain',
                    }),
                requestJson: JSON.stringify(fixture.request),
                createdAt: now - 60_000,
                expiresAt: now - 1,
                pending: 'oauth-pending',
                migrationSubmissionAttempted: true as const,
                rejectedCredentialTokenDigest:
                    'A'.repeat(43),
            },
        };
        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: marked,
        });
        mocks.readExactAttempt.mockResolvedValue(marked);
        const guard =
            await guardAccountEncryptionFirstKeyCredentialMutation({
                serverId: 'server-a',
                serverUrl: 'https://server.example.test',
            });
        if (guard.kind === 'allowed') {
            throw new Error('Expected retained recovery');
        }
        const recoveredToken = [
            'header',
            Buffer.from(JSON.stringify({
                sub: fixture.accountId,
            })).toString('base64url'),
            'signature',
        ].join('.');
        mocks.authGetToken.mockResolvedValue(recoveredToken);
        const keyProof = fixture.request.keyProof;
        if (!keyProof?.contentPublicKey) {
            throw new Error('Expected key proof');
        }
        mocks.fetchCurrentness.mockResolvedValue({
            mode: 'e2ee',
            updatedAt: 1,
            signingKeyFingerprint:
                computeAccountEncryptionMigrateKeyFingerprintV1(
                    Buffer.from(keyProof.publicKey, 'base64url'),
                ),
            contentKeyFingerprint:
                computeAccountEncryptionMigrateKeyFingerprintV1(
                    Buffer.from(
                        keyProof.contentPublicKey,
                        'base64url',
                    ),
                ),
        });
        const order: string[] = [];
        const persistCredentials = vi.fn(async () => {
            order.push('persist');
            return { kind: 'completed' as const };
        });
        mocks.clearPending.mockImplementationOnce(async () => {
            order.push('clear');
            return true;
        });

        await expect(
            recoverAccountEncryptionFirstKeyRejectedCredential({
                recovery: guard.recovery,
                persistCredentials,
            }),
        ).resolves.toMatchObject({
            kind: 'completed',
            mode: 'e2ee',
        });

        expect(mocks.authGetToken).toHaveBeenCalledWith(
            new Uint8Array(32).fill(7),
            { expectedAccountId: fixture.accountId },
        );
        expect(persistCredentials).toHaveBeenCalledWith(
            {
                token: recoveredToken,
                secret: fixture.proposedCredentials.secret,
            },
            expect.anything(),
        );
        expect(order).toEqual(['persist', 'clear']);
        expect(mocks.clearPending).toHaveBeenCalledWith({
            removeFirstKeyMigrationAttempted: marked,
            serverId: 'server-a',
            serverUrl: 'https://server.example.test',
        });
    });

    it('retains exact custody and performs no credential mutation when Account-bound recovery returns another identity', async () => {
        const fixture = await createFixture();
        const now = Date.now();
        const marked = {
            provider: 'github',
            proof: 'proof',
            secret: fixture.proposedCredentials.secret,
            serverId: 'server-a',
            serverUrl: 'https://server.example.test',
            accountEncryptionFirstKey: {
                accountId: fixture.accountId,
                requestDigest:
                    createAccountEncryptionMigrateRequestBindingDigestV1({
                        request: fixture.request,
                        accountId: fixture.accountId,
                        sourceMode: 'plain',
                    }),
                requestJson: JSON.stringify(fixture.request),
                createdAt: now - 60_000,
                expiresAt: now - 1,
                pending: 'oauth-pending',
                migrationSubmissionAttempted: true as const,
                rejectedCredentialTokenDigest:
                    'A'.repeat(43),
            },
        };
        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: marked,
        });
        mocks.readExactAttempt.mockResolvedValue(marked);
        const guard =
            await guardAccountEncryptionFirstKeyCredentialMutation({
                serverId: 'server-a',
                serverUrl: 'https://server.example.test',
            });
        if (guard.kind === 'allowed') {
            throw new Error('Expected retained recovery');
        }
        mocks.authGetToken.mockResolvedValue([
            'header',
            Buffer.from(JSON.stringify({
                sub: 'another-account',
            })).toString('base64url'),
            'signature',
        ].join('.'));
        const persistCredentials = vi.fn();

        await expect(
            recoverAccountEncryptionFirstKeyRejectedCredential({
                recovery: guard.recovery,
                persistCredentials,
            }),
        ).resolves.toEqual({
            kind: 'recovery_failed',
        });
        expect(persistCredentials).not.toHaveBeenCalled();
        expect(mocks.clearPending).not.toHaveBeenCalled();
        expect(mocks.fetchCurrentness).not.toHaveBeenCalled();
    });

    it('does not start Account-bound recovery from stale or unmarked custody', async () => {
        const fixture = await createFixture();
        const now = Date.now();
        const marked = {
            provider: 'github',
            proof: 'proof',
            secret: fixture.proposedCredentials.secret,
            serverId: 'server-a',
            serverUrl: 'https://server.example.test',
            accountEncryptionFirstKey: {
                accountId: fixture.accountId,
                requestDigest:
                    createAccountEncryptionMigrateRequestBindingDigestV1({
                        request: fixture.request,
                        accountId: fixture.accountId,
                        sourceMode: 'plain',
                    }),
                requestJson: JSON.stringify(fixture.request),
                createdAt: now - 60_000,
                expiresAt: now - 1,
                pending: 'oauth-pending',
                migrationSubmissionAttempted: true as const,
                rejectedCredentialTokenDigest:
                    'A'.repeat(43),
            },
        };
        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: marked,
        });
        const guard =
            await guardAccountEncryptionFirstKeyCredentialMutation({
                serverId: 'server-a',
                serverUrl: 'https://server.example.test',
            });
        if (guard.kind === 'allowed') {
            throw new Error('Expected retained recovery');
        }
        mocks.readExactAttempt.mockResolvedValue(null);
        const persistCredentials = vi.fn();

        await expect(
            recoverAccountEncryptionFirstKeyRejectedCredential({
                recovery: guard.recovery,
                persistCredentials,
            }),
        ).resolves.toEqual({
            kind: 'recovery_failed',
        });
        expect(mocks.authGetToken).not.toHaveBeenCalled();
        expect(persistCredentials).not.toHaveBeenCalled();
        expect(mocks.clearPending).not.toHaveBeenCalled();
    });

    it('retries only exact cleanup when keyed credentials prove the marked migration already committed', async () => {
        const fixture = await createFixture();
        const accountToken = [
            'header',
            Buffer.from(
                JSON.stringify({
                    sub: fixture.accountId,
                }),
            ).toString('base64url'),
            'signature',
        ].join('.');
        const marked = {
            provider: 'github',
            proof: 'proof',
            secret:
                fixture.proposedCredentials.secret,
            accountEncryptionFirstKey: {
                accountId: fixture.accountId,
                requestDigest:
                    createAccountEncryptionMigrateRequestBindingDigestV1({
                        request: fixture.request,
                        accountId:
                            fixture.accountId,
                        sourceMode: 'plain',
                    }),
                requestJson:
                    JSON.stringify(fixture.request),
                createdAt: Date.now() - 60_000,
                expiresAt: Date.now() - 1,
                pending: 'oauth-pending',
                migrationSubmissionAttempted: true,
            },
        };
        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: marked,
        });
        const persistCredentials = vi.fn();
        const keyProof = fixture.request.keyProof;
        if (!keyProof?.contentPublicKey) {
            throw new Error('Expected key proof');
        }
        mocks.fetchCurrentness.mockResolvedValue({
            mode: 'e2ee',
            updatedAt: 1,
            signingKeyFingerprint:
                computeAccountEncryptionMigrateKeyFingerprintV1(
                    Buffer.from(
                        keyProof.publicKey,
                        'base64url',
                    ),
                ),
            contentKeyFingerprint:
                computeAccountEncryptionMigrateKeyFingerprintV1(
                    Buffer.from(
                        keyProof.contentPublicKey,
                        'base64url',
                    ),
                ),
        });
        mocks.clearPending
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const currentCredentials = {
            token: accountToken,
            secret:
                fixture.proposedCredentials.secret,
        } as const;

        await expect(
            retryPendingAccountEncryptionFirstKeyExternalAuth({
                currentCredentials,
                persistCredentials,
            }),
        ).rejects.toMatchObject({
            code: 'first-key-pending-cleanup-failed',
        });
        expect(mocks.migrate).not.toHaveBeenCalled();
        expect(persistCredentials).not.toHaveBeenCalled();

        mocks.fetchCurrentness.mockResolvedValueOnce({
            mode: 'e2ee',
            updatedAt: 2,
            signingKeyFingerprint:
                'aemk1_wrong-signing',
            contentKeyFingerprint:
                'aemk1_wrong-content',
        });
        await expect(
            retryPendingAccountEncryptionFirstKeyExternalAuth({
                currentCredentials,
                persistCredentials,
            }),
        ).resolves.toBeNull();
        expect(mocks.clearPending).toHaveBeenCalledTimes(1);

        mocks.fetchCurrentness.mockResolvedValueOnce({
            mode: 'e2ee',
            updatedAt: 3,
            signingKeyFingerprint:
                computeAccountEncryptionMigrateKeyFingerprintV1(
                    Buffer.from(
                        keyProof.publicKey,
                        'base64url',
                    ),
                ),
            contentKeyFingerprint:
                computeAccountEncryptionMigrateKeyFingerprintV1(
                    Buffer.from(
                        keyProof.contentPublicKey,
                        'base64url',
                    ),
                ),
        });
        await expect(
            retryPendingAccountEncryptionFirstKeyExternalAuth({
                currentCredentials,
                persistCredentials,
            }),
        ).resolves.toMatchObject({
            mode: 'e2ee',
        });
        expect(
            mocks.fetchCurrentness,
        ).toHaveBeenCalledWith(
            currentCredentials,
        );
        expect(mocks.clearPending).toHaveBeenLastCalledWith({
            removeFirstKeyMigrationAttempted: marked,
        });
        expect(mocks.migrate).not.toHaveBeenCalled();
        expect(persistCredentials).not.toHaveBeenCalled();
    });

    it('clears the pending proposed key when the returned external URL is unsafe', async () => {
        await expect(
            openAccountEncryptionFirstKeyExternalAuthUrl(
                'javascript:alert(1)',
            ),
        ).rejects.toThrow('first-key-external-auth-invalid');
        expect(mocks.clearPending).toHaveBeenCalledTimes(1);
    });

    it('binds an authenticated OAuth start to the exact request and stores only the pending continuation', async () => {
        const fixture = await createFixture();
        mocks.serverFetch.mockResolvedValue(new Response(
            JSON.stringify({ url: 'https://github.com/login/oauth/authorize' }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            },
        ));

        const result =
            await startAccountEncryptionFirstKeyExternalAuth({
                ...fixture,
                linkedProviderIds: ['github'],
                returnTo: '/settings/account',
            });

        expect(result).toMatchObject({
            kind: 'oauth',
            provider: 'github',
            url: 'https://github.com/login/oauth/authorize',
        });
        expect(mocks.clearPending).toHaveBeenCalledTimes(1);
        expect(mocks.setPending).toHaveBeenCalledTimes(1);
        const stored = (
            mocks.setPending.mock.calls as unknown as Array<
                [Readonly<{
                    provider: string;
                    proof: string;
                    secret: string;
                    returnTo: string;
                    accountEncryptionFirstKey: Readonly<{
                        accountId: string;
                        requestJson: string;
                        requestDigest: string;
                        createdAt: number;
                        expiresAt: number;
                    }>;
                }>]
            >
        )[0]![0];
        expect(stored).toMatchObject({
            provider: 'github',
            proof: expect.any(String),
            secret: fixture.proposedCredentials.secret,
            returnTo: '/settings/account',
            accountEncryptionFirstKey: {
                accountId: fixture.accountId,
                requestJson: JSON.stringify(fixture.request),
                requestDigest: createAccountEncryptionMigrateRequestBindingDigestV1({
                    request: fixture.request,
                    accountId: fixture.accountId,
                    sourceMode: 'plain',
                }),
                createdAt: expect.any(Number),
                expiresAt: expect.any(Number),
            },
        });
        expect(
            stored.accountEncryptionFirstKey.expiresAt,
        ).toBeGreaterThan(
            stored.accountEncryptionFirstKey.createdAt,
        );
        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
        const [path, init, options] = mocks.serverFetch.mock.calls[0]!;
        const url = new URL(path, 'https://server.example');
        expect(url.pathname).toBe('/v1/auth/external/github/params');
        expect(url.searchParams.get('mode')).toBe('keyless');
        expect(url.searchParams.get('purpose')).toBe(
            'account_encryption_first_key',
        );
        expect(url.searchParams.get('proofHash')).toMatch(/^[a-f0-9]{64}$/);
        expect(url.searchParams.get('requestDigest')).toBe(
            stored.accountEncryptionFirstKey.requestDigest,
        );
        expect(init).toMatchObject({
            method: 'GET',
            headers: {
                Authorization: 'Bearer token',
            },
        });
        expect(options).toEqual({ includeAuth: false, retry: 'none' });
        expect(mocks.migrate).not.toHaveBeenCalled();
    });

    it('uses the existing authenticated mTLS endpoint and returns an immediate strict proof', async () => {
        const fixture = await createFixture();
        mocks.getFeatures.mockResolvedValue(mtlsFeatures());
        mocks.serverFetch.mockResolvedValue(new Response(
            JSON.stringify({ success: true, pending: 'mtls-pending' }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            },
        ));

        const result =
            await startAccountEncryptionFirstKeyExternalAuth({
                ...fixture,
                linkedProviderIds: ['mtls'],
                returnTo: '/settings/account',
            });

        expect(result).toMatchObject({
            kind: 'mtls',
            externalAuthProof: {
                provider: 'mtls',
                pending: 'mtls-pending',
                proof: expect.any(String),
            },
        });
        expect(mocks.setPending).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'mtls',
                proof:
                    result.kind === 'mtls'
                        ? result.externalAuthProof.proof
                        : '',
                secret: fixture.proposedCredentials.secret,
                accountEncryptionFirstKey:
                    expect.objectContaining({
                        accountId: fixture.accountId,
                        requestJson:
                            JSON.stringify(fixture.request),
                        pending: 'mtls-pending',
                        createdAt: expect.any(Number),
                        expiresAt: expect.any(Number),
                    }),
            }),
        );
        const [, init] = mocks.serverFetch.mock.calls[0]!;
        expect(init).toMatchObject({
            method: 'POST',
            headers: {
                Authorization: 'Bearer token',
                'Content-Type': 'application/json',
            },
        });
        expect(JSON.parse(init.body)).toEqual({
            purpose: 'account_encryption_first_key',
            proofHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            requestDigest:
                createAccountEncryptionMigrateRequestBindingDigestV1({
                    request: fixture.request,
                    accountId: fixture.accountId,
                    sourceMode: 'plain',
                }),
        });
    });

    it('retains immediate mTLS custody when persistence fails after commit', async () => {
        const fixture = await createFixture();
        mocks.getFeatures.mockResolvedValue(mtlsFeatures());
        mocks.serverFetch.mockResolvedValue(new Response(
            JSON.stringify({
                success: true,
                pending: 'mtls-pending',
            }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            },
        ));
        const started =
            await startAccountEncryptionFirstKeyExternalAuth({
                ...fixture,
                linkedProviderIds: ['mtls'],
                returnTo: '/settings/account',
            });
        if (started.kind !== 'mtls') {
            throw new Error('Expected mTLS start');
        }
        const now = Date.now();
        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: {
                provider: 'mtls',
                proof: started.externalAuthProof.proof,
                secret: fixture.proposedCredentials.secret,
                returnTo: '/settings/account',
                accountEncryptionFirstKey: {
                    accountId: fixture.accountId,
                    requestDigest:
                        createAccountEncryptionMigrateRequestBindingDigestV1({
                            request: fixture.request,
                            accountId: fixture.accountId,
                            sourceMode: 'plain',
                        }),
                    requestJson: JSON.stringify(fixture.request),
                    createdAt: now,
                    expiresAt: now + 10 * 60 * 1000,
                    pending: 'mtls-pending',
                },
            },
        });
        const persistCredentials = vi.fn()
            .mockRejectedValue(
                new Error('credential storage unavailable'),
            );

        await expect(
            resumeAccountEncryptionFirstKeyExternalAuth({
                provider: 'mtls',
                pending: 'mtls-pending',
                currentCredentials: fixture.currentCredentials,
                persistCredentials,
            }),
        ).rejects.toThrow('credential storage unavailable');
        expect(mocks.migrate).toHaveBeenCalledTimes(1);
        expect(mocks.clearPending).toHaveBeenCalledTimes(1);
    });

    it('strictly resumes the exact OAuth request and removes the continuation after success', async () => {
        const fixture = await createFixture();
        const requestDigest =
            createAccountEncryptionMigrateRequestBindingDigestV1({
                request: fixture.request,
                accountId: fixture.accountId,
                sourceMode: 'plain',
            });
        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: {
                provider: 'github',
                proof: 'proof',
                secret: fixture.proposedCredentials.secret,
                returnTo: '/settings/account',
                accountEncryptionFirstKey: {
                    accountId: fixture.accountId,
                    requestDigest,
                    requestJson: JSON.stringify(fixture.request),
                    createdAt: Date.now(),
                    expiresAt: Date.now() + 10 * 60 * 1000,
                },
            },
        });
        const persistCredentials = vi.fn(async () => ({ kind: 'completed' as const }));

        const result =
            await resumeAccountEncryptionFirstKeyExternalAuth({
                provider: 'github',
                pending: 'oauth-pending',
                currentCredentials: fixture.currentCredentials,
                persistCredentials,
            });

        expect(result.returnTo).toBe('/settings/account');
        expect(mocks.setPending).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'github',
                accountEncryptionFirstKey:
                    expect.objectContaining({
                        pending: 'oauth-pending',
                    }),
            }),
        );
        expect(
            mocks.setPending.mock.invocationCallOrder[0],
        ).toBeLessThan(
            mocks.migrate.mock.invocationCallOrder[0]!,
        );
        expect(mocks.migrate).toHaveBeenCalledWith(
            fixture.currentCredentials,
            expect.objectContaining({
                externalAuthProof: {
                    provider: 'github',
                    pending: 'oauth-pending',
                    proof: 'proof',
                },
            }),
            { retry: 'none' },
        );
        expect(persistCredentials).toHaveBeenCalledWith(
            fixture.proposedCredentials,
            expect.anything(),
        );
        expect(
            mocks.migrate.mock.invocationCallOrder[0],
        ).toBeLessThan(
            persistCredentials.mock.invocationCallOrder[0]!,
        );
        expect(mocks.clearPending).toHaveBeenCalledTimes(1);
        expect(mocks.clearPending).toHaveBeenCalledWith({
            removeFirstKeyMigrationAttempted:
                expect.objectContaining({
                    provider: 'github',
                    proof: 'proof',
                    secret:
                        fixture.proposedCredentials.secret,
                    accountEncryptionFirstKey:
                        expect.objectContaining({
                            requestDigest,
                            pending: 'oauth-pending',
                            migrationSubmissionAttempted:
                                true,
                        }),
                }),
        });
    });

    it('activates and acknowledges atomically migrated new-session drafts before credential persistence', async () => {
        const fixture = await createFixture();
        const address = {
            kind: 'newSession' as const,
            draftId: '00000000-0000-4000-8000-000000000401',
        };
        const content = {
            t: 'encrypted' as const,
            c: 'draft-ciphertext',
        };
        const request = AccountEncryptionMigrateRequestSchema.parse({
            ...fixture.request,
            sessionDrafts: {
                items: [{ address, expectedRevision: 4, content }],
            },
        });
        const requestDigest =
            createAccountEncryptionMigrateRequestBindingDigestV1({
                request,
                accountId: fixture.accountId,
                sourceMode: 'plain',
            });
        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: {
                provider: 'github',
                proof: 'proof',
                secret: fixture.proposedCredentials.secret,
                returnTo: '/settings/account',
                accountEncryptionFirstKey: {
                    accountId: fixture.accountId,
                    requestDigest,
                    requestJson: JSON.stringify(request),
                    createdAt: Date.now(),
                    expiresAt: Date.now() + 10 * 60 * 1000,
                },
            },
        });
        const record = {
            address,
            revision: 5,
            content,
            createdAt: 1,
            updatedAt: 2,
        };
        mocks.migrate.mockResolvedValue({
            success: true,
            mode: 'e2ee',
            accountVersion: 9,
            settingsVersion: 4,
            sessionDrafts: { records: [record] },
        });
        const persistCredentials = vi.fn(async () => ({
            kind: 'completed' as const,
        }));

        await resumeAccountEncryptionFirstKeyExternalAuth({
            provider: 'github',
            pending: 'oauth-pending',
            currentCredentials: fixture.currentCredentials,
            persistCredentials,
        });

        expect(
            mocks.reconfigureSessionDraftRepository,
        ).toHaveBeenCalledWith(
            fixture.proposedCredentials,
            'e2ee',
        );
        expect(mocks.acknowledgeSessionDrafts).toHaveBeenCalledWith(
            { serverId: 'server-a', accountId: 'account-1' },
            [record],
        );
        expect(
            mocks.reconfigureSessionDraftRepository
                .mock.invocationCallOrder[0],
        ).toBeLessThan(
            mocks.acknowledgeSessionDrafts
                .mock.invocationCallOrder[0]!,
        );
        expect(
            mocks.acknowledgeSessionDrafts
                .mock.invocationCallOrder[0],
        ).toBeLessThan(
            persistCredentials.mock.invocationCallOrder[0]!,
        );
    });

    it('fails closed and clears pending state on a wrong provider without posting or persisting', async () => {
        const fixture = await createFixture();
        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: {
                provider: 'oidc',
                proof: 'proof',
                secret: fixture.proposedCredentials.secret,
                accountEncryptionFirstKey: {
                    accountId: fixture.accountId,
                    requestDigest:
                        createAccountEncryptionMigrateRequestBindingDigestV1({
                            request: fixture.request,
                            accountId: fixture.accountId,
                            sourceMode: 'plain',
                        }),
                    requestJson: JSON.stringify(fixture.request),
                    createdAt: Date.now(),
                    expiresAt: Date.now() + 10 * 60 * 1000,
                },
            },
        });
        const persistCredentials = vi.fn();

        await expect(
            resumeAccountEncryptionFirstKeyExternalAuth({
                provider: 'github',
                pending: 'oauth-pending',
                currentCredentials: fixture.currentCredentials,
                persistCredentials,
            }),
        ).rejects.toThrow('first-key-external-auth-invalid');
        expect(mocks.migrate).not.toHaveBeenCalled();
        expect(persistCredentials).not.toHaveBeenCalled();
        expect(mocks.clearPending).toHaveBeenCalledTimes(1);
        expect(mocks.clearPending).toHaveBeenCalledWith(
            undefined,
        );
    });

    it('retains marked custody on an active-server mismatch without posting or persisting', async () => {
        const fixture = await createFixture();
        const now = Date.now();
        mocks.readPending.mockResolvedValue({
            serverMismatch: true,
            value: {
                provider: 'github',
                proof: 'proof',
                secret: fixture.proposedCredentials.secret,
                returnTo: '/settings/account',
                accountEncryptionFirstKey: {
                    accountId: fixture.accountId,
                    requestDigest:
                        createAccountEncryptionMigrateRequestBindingDigestV1({
                            request: fixture.request,
                            accountId: fixture.accountId,
                            sourceMode: 'plain',
                        }),
                    requestJson: JSON.stringify(fixture.request),
                    createdAt: now,
                    expiresAt: now + 10 * 60 * 1000,
                    pending: 'oauth-pending',
                    migrationSubmissionAttempted: true,
                },
            },
        });
        const persistCredentials = vi.fn(async () => ({ kind: 'completed' as const }));

        await expect(
            resumeAccountEncryptionFirstKeyExternalAuth({
                provider: 'github',
                pending: 'oauth-pending',
                currentCredentials: fixture.currentCredentials,
                persistCredentials,
            }),
        ).rejects.toThrow('first-key-external-auth-invalid');

        expect(mocks.migrate).not.toHaveBeenCalled();
        expect(persistCredentials).not.toHaveBeenCalled();
        expect(mocks.clearPending).not.toHaveBeenCalled();
    });

    it('retains marked custody on a provider validation mismatch without posting or persisting', async () => {
        const fixture = await createFixture();
        const now = Date.now();
        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: {
                provider: 'oidc',
                proof: 'proof',
                secret: fixture.proposedCredentials.secret,
                returnTo: '/settings/account',
                accountEncryptionFirstKey: {
                    accountId: fixture.accountId,
                    requestDigest:
                        createAccountEncryptionMigrateRequestBindingDigestV1({
                            request: fixture.request,
                            accountId: fixture.accountId,
                            sourceMode: 'plain',
                        }),
                    requestJson: JSON.stringify(fixture.request),
                    createdAt: now,
                    expiresAt: now + 10 * 60 * 1000,
                    pending: 'oauth-pending',
                    migrationSubmissionAttempted: true,
                },
            },
        });
        const persistCredentials = vi.fn(async () => ({ kind: 'completed' as const }));

        await expect(
            resumeAccountEncryptionFirstKeyExternalAuth({
                provider: 'github',
                pending: 'oauth-pending',
                currentCredentials: fixture.currentCredentials,
                persistCredentials,
            }),
        ).rejects.toThrow('first-key-external-auth-invalid');

        expect(mocks.migrate).not.toHaveBeenCalled();
        expect(persistCredentials).not.toHaveBeenCalled();
        expect(mocks.clearPending).not.toHaveBeenCalled();
    });

    it('stores the OAuth callback handle, retains it through ambiguous failures, and replays it from stored custody', async () => {
        const fixture = await createFixture();
        const requestDigest =
            createAccountEncryptionMigrateRequestBindingDigestV1({
                request: fixture.request,
                accountId: fixture.accountId,
                sourceMode: 'plain',
            });
        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: {
                provider: 'github',
                proof: 'proof',
                secret: fixture.proposedCredentials.secret,
                accountEncryptionFirstKey: {
                    accountId: fixture.accountId,
                    requestDigest,
                    requestJson: JSON.stringify(fixture.request),
                    createdAt: Date.now(),
                    expiresAt: Date.now() + 10 * 60 * 1000,
                },
            },
        });
        const retainedState = {
            provider: 'github',
            proof: 'proof',
            secret: fixture.proposedCredentials.secret,
            accountEncryptionFirstKey: {
                accountId: fixture.accountId,
                requestDigest,
                requestJson: JSON.stringify(fixture.request),
                createdAt: Date.now(),
                expiresAt: Date.now() + 10 * 60 * 1000,
                pending: 'oauth-pending',
                migrationSubmissionAttempted: true,
            },
        };
        const persistCredentials = vi.fn()
            .mockRejectedValueOnce(
                new Error('credential storage unavailable'),
            )
            .mockResolvedValueOnce({ kind: 'completed' });
        mocks.migrate
            .mockRejectedValueOnce(
                new Error('migration network unavailable'),
            )
            .mockResolvedValue({
                mode: 'e2ee',
                version: 9,
            });

        await expect(
            resumeAccountEncryptionFirstKeyExternalAuth({
                provider: 'github',
                pending: 'oauth-pending',
                currentCredentials: fixture.currentCredentials,
                persistCredentials,
            }),
        ).rejects.toThrow('migration network unavailable');
        expect(persistCredentials).not.toHaveBeenCalled();
        expect(mocks.clearPending).not.toHaveBeenCalled();
        expect(mocks.setPending).toHaveBeenCalledWith(
            retainedState,
        );
        expect(
            mocks.setPending.mock.invocationCallOrder[0],
        ).toBeLessThan(
            mocks.migrate.mock.invocationCallOrder[0]!,
        );

        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: retainedState,
        });
        await expect(
            retryPendingAccountEncryptionFirstKeyExternalAuth({
                currentCredentials: fixture.currentCredentials,
                persistCredentials,
            }),
        ).rejects.toThrow('credential storage unavailable');
        expect(mocks.clearPending).not.toHaveBeenCalled();

        await expect(
            retryPendingAccountEncryptionFirstKeyExternalAuth({
                currentCredentials: fixture.currentCredentials,
                persistCredentials,
            }),
        ).resolves.toMatchObject({
            returnTo: '/settings/account',
        });

        expect(mocks.migrate).toHaveBeenCalledTimes(3);
        expect(
            JSON.stringify(
                mocks.migrate.mock.calls[2]?.[1],
            ),
        ).toBe(
            JSON.stringify(
                mocks.migrate.mock.calls[0]?.[1],
            ),
        );
        expect(persistCredentials).toHaveBeenCalledTimes(2);
        expect(mocks.clearPending).toHaveBeenCalledTimes(1);
    });

    it('clears retained custody after a definitive pre-commit 4xx migration rejection', async () => {
        const fixture = await createFixture();
        const now = Date.now();
        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: {
                provider: 'github',
                proof: 'proof',
                secret: fixture.proposedCredentials.secret,
                returnTo: '/settings/account',
                accountEncryptionFirstKey: {
                    accountId: fixture.accountId,
                    requestDigest:
                        createAccountEncryptionMigrateRequestBindingDigestV1({
                            request: fixture.request,
                            accountId: fixture.accountId,
                            sourceMode: 'plain',
                        }),
                    requestJson: JSON.stringify(fixture.request),
                    createdAt: now,
                    expiresAt: now + 10 * 60 * 1000,
                    pending: 'oauth-pending',
                },
            },
        });
        mocks.migrate.mockRejectedValueOnce(
            new HappyError(
                'migration conflict',
                false,
                {
                    status: 409,
                    kind: 'server',
                    code: 'conflict',
                },
            ),
        );
        const persistCredentials = vi.fn(async () => ({ kind: 'completed' as const }));

        await expect(
            resumeAccountEncryptionFirstKeyExternalAuth({
                provider: 'github',
                pending: 'oauth-pending',
                currentCredentials: fixture.currentCredentials,
                persistCredentials,
            }),
        ).rejects.toMatchObject({ status: 409 });
        expect(persistCredentials).not.toHaveBeenCalled();
        expect(mocks.clearPending).toHaveBeenCalledTimes(1);
        expect(mocks.clearPending).toHaveBeenCalledWith({
            removeFirstKeyMigrationAttempted:
                expect.objectContaining({
                    provider: 'github',
                    proof: 'proof',
                    secret:
                        fixture.proposedCredentials.secret,
                    accountEncryptionFirstKey:
                        expect.objectContaining({
                            pending: 'oauth-pending',
                            migrationSubmissionAttempted:
                                true,
                        }),
                }),
        });
    });

    it('retains marked custody when a definitive 4xx follows an ambiguous admitted attempt', async () => {
        const fixture = await createFixture();
        const now = Date.now();
        const continuation = {
            accountId: fixture.accountId,
            requestDigest:
                createAccountEncryptionMigrateRequestBindingDigestV1({
                    request: fixture.request,
                    accountId: fixture.accountId,
                    sourceMode: 'plain',
                }),
            requestJson: JSON.stringify(fixture.request),
            createdAt: now,
            expiresAt: now + 10 * 60 * 1000,
            pending: 'oauth-pending',
        } as const;
        const state = {
            provider: 'github',
            proof: 'proof',
            secret: fixture.proposedCredentials.secret,
            returnTo: '/settings/account',
            accountEncryptionFirstKey: continuation,
        } as const;
        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: state,
        });
        mocks.migrate
            .mockRejectedValueOnce(
                new HappyError(
                    'migration outcome is ambiguous',
                    true,
                    {
                        status: 503,
                        kind: 'server',
                    },
                ),
            )
            .mockRejectedValueOnce(
                new HappyError(
                    'migration conflict',
                    false,
                    {
                        status: 409,
                        kind: 'server',
                    },
                ),
            );
        const persistCredentials = vi.fn(async () => ({ kind: 'completed' as const }));

        await expect(
            resumeAccountEncryptionFirstKeyExternalAuth({
                provider: 'github',
                pending: 'oauth-pending',
                currentCredentials: fixture.currentCredentials,
                persistCredentials,
            }),
        ).rejects.toMatchObject({ status: 503 });
        expect(mocks.setPending).toHaveBeenCalledWith({
            ...state,
            accountEncryptionFirstKey: {
                ...continuation,
                migrationSubmissionAttempted: true,
            },
        });
        expect(mocks.clearPending).not.toHaveBeenCalled();

        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: {
                ...state,
                accountEncryptionFirstKey: {
                    ...continuation,
                    migrationSubmissionAttempted: true,
                },
            },
        });
        await expect(
            resumeAccountEncryptionFirstKeyExternalAuth({
                provider: 'github',
                pending: 'oauth-pending',
                currentCredentials: fixture.currentCredentials,
                persistCredentials,
            }),
        ).rejects.toMatchObject({ status: 409 });
        expect(mocks.clearPending).not.toHaveBeenCalled();
    });

    it('emits one migration POST per resume when the persisted marker owns exact replay', async () => {
        const fixture = await createFixture();
        const now = Date.now();
        const state = {
            provider: 'github',
            proof: 'proof',
            secret: fixture.proposedCredentials.secret,
            returnTo: '/settings/account',
            accountEncryptionFirstKey: {
                accountId: fixture.accountId,
                requestDigest:
                    createAccountEncryptionMigrateRequestBindingDigestV1({
                        request: fixture.request,
                        accountId: fixture.accountId,
                        sourceMode: 'plain',
                    }),
                requestJson: JSON.stringify(fixture.request),
                createdAt: now,
                expiresAt: now + 10 * 60 * 1000,
                pending: 'oauth-pending',
            },
        } as const;
        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: state,
        });
        const lostResponse = Object.assign(
            new Error('response was lost after commit'),
            { retryable: true },
        );
        mocks.getFeatures.mockResolvedValue({
            status: 'ready',
            features: {
                capabilities: {
                    accountStoredContentCompatibility: {
                        v: 1,
                        minimumProtocolVersion: 1,
                        currentProtocolVersion:
                            CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                        declarationTransport:
                            'http-header-and-socket-auth-v1',
                    },
                },
            },
        });
        mocks.serverFetch
            .mockRejectedValueOnce(lostResponse)
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        error: 'invalid-params',
                        reason: 'account_version_conflict',
                    }),
                    {
                        status: 409,
                        headers: {
                            'Content-Type': 'application/json',
                        },
                    },
                ),
            );
        const actualMigrationApi = await vi.importActual<
            typeof import(
                '@/sync/api/account/apiAccountEncryptionMigrate'
            )
        >('@/sync/api/account/apiAccountEncryptionMigrate');
        mocks.migrate.mockImplementationOnce(
            (...args: Parameters<
                typeof actualMigrationApi.migrateAccountEncryptionMode
            >) =>
                actualMigrationApi.migrateAccountEncryptionMode(
                    ...args,
                ),
        );
        const persistCredentials = vi.fn(async () => ({ kind: 'completed' as const }));

        await expect(
            resumeAccountEncryptionFirstKeyExternalAuth({
                provider: 'github',
                pending: 'oauth-pending',
                currentCredentials: fixture.currentCredentials,
                persistCredentials,
            }),
        ).rejects.toBe(lostResponse);

        expect(mocks.setPending).toHaveBeenCalledWith({
            ...state,
            accountEncryptionFirstKey: {
                ...state.accountEncryptionFirstKey,
                migrationSubmissionAttempted: true,
            },
        });
        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
        expect(persistCredentials).not.toHaveBeenCalled();
        expect(mocks.clearPending).not.toHaveBeenCalled();
    });

    it('retains marked custody when a definitive 4xx follows commit-observed credential persistence failure', async () => {
        const fixture = await createFixture();
        const now = Date.now();
        const continuation = {
            accountId: fixture.accountId,
            requestDigest:
                createAccountEncryptionMigrateRequestBindingDigestV1({
                    request: fixture.request,
                    accountId: fixture.accountId,
                    sourceMode: 'plain',
                }),
            requestJson: JSON.stringify(fixture.request),
            createdAt: now,
            expiresAt: now + 10 * 60 * 1000,
            pending: 'oauth-pending',
        } as const;
        const state = {
            provider: 'github',
            proof: 'proof',
            secret: fixture.proposedCredentials.secret,
            returnTo: '/settings/account',
            accountEncryptionFirstKey: continuation,
        } as const;
        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: state,
        });
        const persistCredentials = vi.fn()
            .mockRejectedValueOnce(
                new Error('credential storage unavailable'),
            );

        await expect(
            resumeAccountEncryptionFirstKeyExternalAuth({
                provider: 'github',
                pending: 'oauth-pending',
                currentCredentials: fixture.currentCredentials,
                persistCredentials,
            }),
        ).rejects.toThrow('credential storage unavailable');
        expect(mocks.setPending).toHaveBeenCalledWith({
            ...state,
            accountEncryptionFirstKey: {
                ...continuation,
                migrationSubmissionAttempted: true,
            },
        });
        expect(mocks.clearPending).not.toHaveBeenCalled();

        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: {
                ...state,
                accountEncryptionFirstKey: {
                    ...continuation,
                    migrationSubmissionAttempted: true,
                },
            },
        });
        mocks.migrate.mockRejectedValueOnce(
            new HappyError(
                'migration conflict',
                false,
                {
                    status: 409,
                    kind: 'server',
                },
            ),
        );
        await expect(
            resumeAccountEncryptionFirstKeyExternalAuth({
                provider: 'github',
                pending: 'oauth-pending',
                currentCredentials: fixture.currentCredentials,
                persistCredentials,
            }),
        ).rejects.toMatchObject({ status: 409 });
        expect(mocks.clearPending).not.toHaveBeenCalled();
    });

    it('does not submit when the first migration-submission custody write fails', async () => {
        const fixture = await createFixture();
        const now = Date.now();
        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: {
                provider: 'github',
                proof: 'proof',
                secret: fixture.proposedCredentials.secret,
                returnTo: '/settings/account',
                accountEncryptionFirstKey: {
                    accountId: fixture.accountId,
                    requestDigest:
                        createAccountEncryptionMigrateRequestBindingDigestV1({
                            request: fixture.request,
                            accountId: fixture.accountId,
                            sourceMode: 'plain',
                        }),
                    requestJson: JSON.stringify(fixture.request),
                    createdAt: now,
                    expiresAt: now + 10 * 60 * 1000,
                    pending: 'oauth-pending',
                },
            },
        });
        mocks.setPending.mockResolvedValueOnce(false);
        const persistCredentials = vi.fn(async () => ({ kind: 'completed' as const }));

        await expect(
            resumeAccountEncryptionFirstKeyExternalAuth({
                provider: 'github',
                pending: 'oauth-pending',
                currentCredentials: fixture.currentCredentials,
                persistCredentials,
            }),
        ).rejects.toMatchObject({
            code: 'first-key-pending-custody-failed',
        });
        expect(mocks.migrate).not.toHaveBeenCalled();
        expect(persistCredentials).not.toHaveBeenCalled();
        expect(mocks.clearPending).not.toHaveBeenCalled();
    });

    it.each([408, 429, 503])(
        'retains exact custody after an ambiguous pre-commit HTTP %s migration failure',
        async (status) => {
            const fixture = await createFixture();
            const now = Date.now();
            mocks.readPending.mockResolvedValue({
                serverMismatch: false,
                value: {
                    provider: 'github',
                    proof: 'proof',
                    secret: fixture.proposedCredentials.secret,
                    returnTo: '/settings/account',
                    accountEncryptionFirstKey: {
                        accountId: fixture.accountId,
                        requestDigest:
                            createAccountEncryptionMigrateRequestBindingDigestV1({
                                request: fixture.request,
                                accountId: fixture.accountId,
                                sourceMode: 'plain',
                            }),
                        requestJson:
                            JSON.stringify(fixture.request),
                        createdAt: now,
                        expiresAt:
                            now + 10 * 60 * 1000,
                        pending: 'oauth-pending',
                    },
                },
            });
            mocks.migrate.mockRejectedValueOnce(
                new HappyError(
                    'migration outcome is ambiguous',
                    true,
                    {
                        status,
                        kind: 'server',
                    },
                ),
            );
            const persistCredentials =
                vi.fn(async () => ({
                    kind: 'completed' as const,
                }));

            await expect(
                resumeAccountEncryptionFirstKeyExternalAuth({
                    provider: 'github',
                    pending: 'oauth-pending',
                    currentCredentials:
                        fixture.currentCredentials,
                    persistCredentials,
                }),
            ).rejects.toMatchObject({ status });
            expect(persistCredentials).not.toHaveBeenCalled();
            expect(mocks.clearPending).not.toHaveBeenCalled();
        },
    );

    it('surfaces cleanup failure only after credentials have been persisted', async () => {
        const fixture = await createFixture();
        const now = Date.now();
        mocks.readPending.mockResolvedValue({
            serverMismatch: false,
            value: {
                provider: 'github',
                proof: 'proof',
                secret: fixture.proposedCredentials.secret,
                returnTo: '/settings/account',
                accountEncryptionFirstKey: {
                    accountId: fixture.accountId,
                    requestDigest:
                        createAccountEncryptionMigrateRequestBindingDigestV1({
                            request: fixture.request,
                            accountId: fixture.accountId,
                            sourceMode: 'plain',
                        }),
                    requestJson: JSON.stringify(fixture.request),
                    createdAt: now,
                    expiresAt: now + 10 * 60 * 1000,
                },
            },
        });
        mocks.clearPending.mockResolvedValue(false);
        const persistCredentials = vi.fn(async () => ({ kind: 'completed' as const }));

        await expect(
            resumeAccountEncryptionFirstKeyExternalAuth({
                provider: 'github',
                pending: 'oauth-pending',
                currentCredentials: fixture.currentCredentials,
                persistCredentials,
            }),
        ).rejects.toMatchObject({
            code: 'first-key-pending-cleanup-failed',
        });
        expect(mocks.migrate).toHaveBeenCalledTimes(1);
        expect(persistCredentials).toHaveBeenCalledWith(
            fixture.proposedCredentials,
            expect.anything(),
        );
        expect(mocks.clearPending).toHaveBeenCalledTimes(1);
    });
});
