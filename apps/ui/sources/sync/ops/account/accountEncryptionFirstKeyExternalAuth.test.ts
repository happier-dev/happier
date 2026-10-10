import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Linking, Platform } from 'react-native';

import {
    AccountEncryptionMigrateRequestSchema,
    createAccountEncryptionMigrateRequestBindingDigestV1,
} from '@happier-dev/protocol/account/encryptionMigrate';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createPasswordCredentialMutationDigestV1, createPasswordCredentialTargetDigestV1 } from '@happier-dev/protocol/auth/passwordMutationChallenge';
import { encodePasswordCredentialFieldV1, type PlainAccountPasswordCredentialV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import type { FeaturesResponse } from '@happier-dev/protocol';
import { deriveAccountSigningPublicKey } from '@/auth/flows/challenge';
import { buildContentKeyBinding } from '@/auth/oauth/contentKeyBinding';
import { encodeBase64 } from '@/encryption/base64';
import { HappyError } from '@/utils/errors/errors';
import { createAuthoringMemoryCipher } from '@/sync/encryption/authoringMemoryEncryption';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';

const mocks = vi.hoisted(() => ({
    clearPending: vi.fn(async () => true),
    setPending: vi.fn(async (_pending: unknown, _target: unknown) => true),
    readPending: vi.fn(),
    serverFetch: vi.fn(),
    getFeatures: vi.fn(),
    migrate: vi.fn(),
    fetchCurrentness: vi.fn(),
    authGetTokenAtEndpoint: vi.fn(),
    readExactAttempt: vi.fn(),
    acknowledgeSessionDrafts: vi.fn(),
    reconfigureSessionDraftRepository: vi.fn(),
    reconfigureAuthoringMemory: vi.fn(),
    endpointFetch: vi.fn(),
    createServerFetchAtEndpoint: vi.fn(),
    fetchHomeAuthEntry: vi.fn(),
    openAuthSessionAsync: vi.fn(),
}));

vi.mock('expo-web-browser', () => ({
    openAuthSessionAsync: mocks.openAuthSessionAsync,
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
        reconfigureAuthoringMemoryForAccountMode: mocks.reconfigureAuthoringMemory,
    },
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('@/auth/storage/tokenStorage')
        >();
    const readStoredPending = async () => {
        const state = await mocks.readPending();
        const value = state?.value;
        // TokenStorage enriches every real pending record with its physical
        // Home scope. Keep owner tests focused on first-key orchestration while
        // preserving that boundary invariant in their compact fixtures.
        if (
            value?.accountEncryptionFirstKey
            && (!value.serverId || !value.serverUrl)
        ) {
            return {
                ...state,
                value: {
                    ...value,
                    serverId: 'server-a',
                    serverUrl: 'https://server-a.example.test',
                },
            };
        }
        return state;
    };
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            clearPendingExternalAuth: mocks.clearPending,
            setPendingExternalAuth: mocks.setPending,
            readPendingExternalAuthState: readStoredPending,
            readPendingExternalAuthContinuationState:
                readStoredPending,
            readPendingExternalAuthStateForServerUrl:
                readStoredPending,
            readExactPendingExternalAuthFirstKeyMigrationAttempt:
                mocks.readExactAttempt,
        },
    };
});

vi.mock('@/auth/flows/getToken', () => ({
    authGetTokenAtEndpoint: mocks.authGetTokenAtEndpoint,
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
    createServerFetchAtEndpoint:
        mocks.createServerFetchAtEndpoint,
}));

vi.mock('@/auth/entry/authEntryClient', () => ({
    fetchHomeAuthEntry: mocks.fetchHomeAuthEntry,
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: mocks.getFeatures,
    probeServerFeaturesAtUrl: mocks.getFeatures,
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
    startAccountPasswordEnrollmentExternalAuth,
    openAccountPasswordEnrollmentExternalAuthSession,
    resumeAccountPasswordEnrollmentExternalAuth,
    cancelAccountPasswordEnrollmentExternalAuth,
    clearAccountPasswordEnrollmentExternalAuthCustody,
    readAccountPasswordEnrollmentExternalAuthProof,
    readAccountPasswordEnrollmentExternalAuthCallbackContext,
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

function mtlsAuthEntry() {
    return {
        kind: 'ready',
        projection: {
            v: 1,
            state: 'ready',
            scope: { kind: 'home' },
            autoRedirect: null,
            actions: [{
                kind: 'authenticate',
                methodId: 'mtls',
                action: 'login',
                mode: 'keyless',
                origin: 'home',
                presentation: { displayName: 'Client certificate' },
            }],
        },
    } as const;
}

function legacyOauthFeatures() {
    return {
        status: 'ready',
        features: {
            features: { auth: { mtls: { enabled: false } } },
            capabilities: {
                oauth: {
                    providers: {
                        github: { enabled: true, configured: true },
                    },
                },
                auth: {
                    login: {
                        methods: [{ id: 'github', enabled: true }],
                        requiredProviders: [],
                    },
                    signup: { methods: [] },
                    providers: {
                        github: { enabled: true, configured: true },
                    },
                },
            },
        },
    } as unknown as FeaturesResponse;
}

beforeEach(() => {
    vi.clearAllMocks();
    clearAccountPasswordEnrollmentExternalAuthCustody();
    mocks.clearPending
        .mockReset()
        .mockResolvedValue(true);
    mocks.setPending
        .mockReset()
        .mockResolvedValue(true);
    mocks.readPending.mockReset();
    mocks.serverFetch.mockReset();
    mocks.getFeatures.mockReset().mockResolvedValue(oauthFeatures());
    mocks.migrate.mockReset().mockResolvedValue({ mode: 'e2ee', version: 9 });
    mocks.fetchCurrentness.mockReset().mockResolvedValue({
        mode: 'e2ee',
        updatedAt: 1,
        signingKeyFingerprint: null,
        contentKeyFingerprint: null,
    });
    mocks.authGetTokenAtEndpoint.mockReset();
    mocks.readExactAttempt.mockReset();
    mocks.acknowledgeSessionDrafts.mockReset();
    mocks.reconfigureSessionDraftRepository.mockReset();
    mocks.reconfigureAuthoringMemory.mockReset();
    mocks.endpointFetch.mockReset();
    mocks.createServerFetchAtEndpoint.mockReset();
    mocks.createServerFetchAtEndpoint.mockReturnValue(
        mocks.serverFetch,
    );
    mocks.fetchHomeAuthEntry.mockReset().mockResolvedValue({
        kind: 'ready',
        projection: {
            v: 1,
            state: 'ready',
            scope: { kind: 'home' },
            autoRedirect: null,
            actions: [
                {
                    kind: 'authenticate',
                    methodId: 'unlinked',
                    action: 'login',
                    mode: 'keyless',
                    origin: 'home',
                    presentation: { displayName: 'Unlinked' },
                },
                {
                    kind: 'authenticate',
                    methodId: 'github',
                    action: 'login',
                    mode: 'keyless',
                    origin: 'home',
                    presentation: { displayName: 'GitHub' },
                },
            ],
        },
    });
    mocks.openAuthSessionAsync.mockReset();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Plain password enrollment external auth', () => {
    const currentCredentials = {
        token: `header.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`,
    } as const;
    const target = {
        serverId: 'server-a',
        serverUrl: 'https://server-a.example.test',
    } as const;

    const targetCredential = {
        v: 1,
        kind: 'plain_password_hash',
        hash: {
            v: 1,
            algorithm: 'scrypt',
            parameters: { n: 2 ** 14, r: 8, p: 5, keyLength: 32 },
            salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)),
            digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)),
        },
    } as const satisfies PlainAccountPasswordCredentialV1;
    const normalizedNativeEmail = 'person@example.test';
    const requestDigest = createPasswordCredentialMutationDigestV1({
        v: 1,
        action: 'connect',
        accountId: 'account-1',
        expectedCredentialRevision: null,
        normalizedNativeEmail,
        newCredentialDigest: createPasswordCredentialTargetDigestV1(targetCredential),
    });

    it('returns the web OAuth callback to the same process-local ceremony and never navigates the owner document', async () => {
        vi.spyOn(Platform, 'OS', 'get').mockReturnValue('web');
        const assign = vi.fn();
        vi.stubGlobal('window', {
            location: {
                origin: 'https://app.example.test',
                assign,
            },
        });
        mocks.serverFetch
            .mockResolvedValueOnce(Response.json({ targetCredential }))
            .mockResolvedValueOnce(Response.json({ url: 'https://github.example.test/authorize' }));
        mocks.openAuthSessionAsync.mockResolvedValueOnce({
            type: 'success',
            url: 'https://app.example.test/oauth/github?flow=auth&purpose=account_password_enrollment&pending=server-pending',
        });

        const started = await startAccountPasswordEnrollmentExternalAuth({
            accountId: 'account-1',
            currentCredentials,
            linkedProviderIds: ['github'],
            normalizedNativeEmail,
            newPassword: 'correct horse battery staple',
            returnTo: '/settings/account/security?verificationToken=mailbox-proof',
            target,
        });
        if (started.kind !== 'oauth') throw new Error('Expected OAuth enrollment');

        await expect(openAccountPasswordEnrollmentExternalAuthSession({
            ...started,
            currentCredentials,
            target,
        })).resolves.toEqual({ kind: 'completed' });

        expect(mocks.openAuthSessionAsync).toHaveBeenCalledWith(
            'https://github.example.test/authorize',
            'https://app.example.test/oauth/github',
        );
        expect(assign).not.toHaveBeenCalled();
        expect(mocks.setPending).not.toHaveBeenCalled();
        await expect(readAccountPasswordEnrollmentExternalAuthProof({
            accountId: 'account-1',
            currentCredentials,
            target,
        })).resolves.toEqual({
            normalizedNativeEmail,
            targetCredential,
            externalAuthProof: {
                provider: 'github',
                pending: 'server-pending',
                proof: expect.any(String),
            },
        });
        await expect(readAccountPasswordEnrollmentExternalAuthProof({
            accountId: 'account-1',
            currentCredentials,
            target,
        })).resolves.toBeNull();
    });

    it.each([
        { name: 'dismissed', result: { type: 'dismiss' } },
        {
            name: 'substituted callback',
            result: {
                type: 'success',
                url: 'https://attacker.example.test/oauth/github?flow=auth&purpose=account_password_enrollment&pending=server-pending',
            },
        },
        {
            name: 'provider error',
            result: {
                type: 'success',
                url: 'https://app.example.test/oauth/github?flow=auth&purpose=account_password_enrollment&error=access_denied',
            },
        },
    ])('retires process-local custody when the web auth session is $name', async ({ result }) => {
        vi.spyOn(Platform, 'OS', 'get').mockReturnValue('web');
        vi.stubGlobal('window', {
            location: { origin: 'https://app.example.test' },
        });
        mocks.serverFetch
            .mockResolvedValueOnce(Response.json({ targetCredential }))
            .mockResolvedValueOnce(Response.json({ url: 'https://github.example.test/authorize' }));
        mocks.openAuthSessionAsync.mockResolvedValueOnce(result);

        const started = await startAccountPasswordEnrollmentExternalAuth({
            accountId: 'account-1', currentCredentials,
            linkedProviderIds: ['github'], normalizedNativeEmail,
            newPassword: 'correct horse battery staple',
            returnTo: '/settings/account/security', target,
        });
        if (started.kind !== 'oauth') throw new Error('Expected OAuth enrollment');
        if (!started.url) throw new Error('Expected OAuth enrollment URL');

        if (result.type === 'dismiss') {
            await expect(openAccountPasswordEnrollmentExternalAuthSession({
                ...started, currentCredentials, target,
            })).resolves.toEqual({ kind: 'cancelled' });
        } else if ('url' in result && typeof result.url === 'string' && result.url.includes('error=access_denied')) {
            await expect(openAccountPasswordEnrollmentExternalAuthSession({
                ...started, currentCredentials, target,
            })).resolves.toEqual({ kind: 'cancelled' });
        } else {
            await expect(openAccountPasswordEnrollmentExternalAuthSession({
                ...started, currentCredentials, target,
            })).rejects.toMatchObject({
                code: 'password-enrollment-external-auth-invalid',
            });
        }
        await expect(readAccountPasswordEnrollmentExternalAuthProof({
            accountId: 'account-1', currentCredentials, target,
        })).resolves.toBeNull();
        expect(mocks.setPending).not.toHaveBeenCalled();
    });

    it('rejects an unsafe web launch URL before opening a browser and retires custody', async () => {
        vi.spyOn(Platform, 'OS', 'get').mockReturnValue('web');
        vi.stubGlobal('window', {
            location: { origin: 'https://app.example.test' },
        });
        mocks.serverFetch
            .mockResolvedValueOnce(Response.json({ targetCredential }))
            .mockResolvedValueOnce(Response.json({ url: 'https://github.example.test/authorize' }));
        const started = await startAccountPasswordEnrollmentExternalAuth({
            accountId: 'account-1', currentCredentials,
            linkedProviderIds: ['github'], normalizedNativeEmail,
            newPassword: 'correct horse battery staple',
            returnTo: '/settings/account/security', target,
        });
        if (started.kind !== 'oauth') throw new Error('Expected OAuth enrollment');

        await expect(openAccountPasswordEnrollmentExternalAuthSession({
            ...started,
            url: 'javascript:alert(1)',
            currentCredentials,
            target,
        })).rejects.toMatchObject({
            code: 'password-enrollment-external-auth-invalid',
        });
        expect(mocks.openAuthSessionAsync).not.toHaveBeenCalled();
        await expect(readAccountPasswordEnrollmentExternalAuthProof({
            accountId: 'account-1', currentCredentials, target,
        })).resolves.toBeNull();
    });

    it('preserves the existing native Linking callback path and process-local custody', async () => {
        vi.spyOn(Platform, 'OS', 'get').mockReturnValue('ios');
        vi.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
        const openUrl = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
        mocks.serverFetch
            .mockResolvedValueOnce(Response.json({ targetCredential }))
            .mockResolvedValueOnce(Response.json({ url: 'https://github.example.test/authorize' }));

        const started = await startAccountPasswordEnrollmentExternalAuth({
            accountId: 'account-1', currentCredentials,
            linkedProviderIds: ['github'], normalizedNativeEmail,
            newPassword: 'correct horse battery staple',
            returnTo: '/settings/account/security', target,
        });
        if (started.kind !== 'oauth') throw new Error('Expected OAuth enrollment');

        await expect(openAccountPasswordEnrollmentExternalAuthSession({
            ...started, currentCredentials, target,
        })).resolves.toEqual({ kind: 'opened' });
        expect(openUrl).toHaveBeenCalledWith(started.url);
        expect(mocks.openAuthSessionAsync).not.toHaveBeenCalled();
        expect(readAccountPasswordEnrollmentExternalAuthCallbackContext('github')).toEqual({ target });
    });

    it('prepares one exact Plain credential and binds OAuth proof custody to its canonical mutation digest', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(Response.json({ targetCredential }))
            .mockResolvedValueOnce(Response.json({ url: 'https://github.example.test/authorize' }));

        const result = await startAccountPasswordEnrollmentExternalAuth({
            accountId: 'account-1',
            currentCredentials,
            linkedProviderIds: ['github'],
            normalizedNativeEmail,
            newPassword: 'correct horse battery staple',
            returnTo: '/settings/account/security?verificationToken=mailbox-proof',
            target,
        });

        expect(result).toEqual({ kind: 'oauth', provider: 'github', url: 'https://github.example.test/authorize' });
        expect(mocks.fetchHomeAuthEntry).toHaveBeenCalledWith(expect.objectContaining({
            accountScope: { serverId: 'server-a', accountId: 'account-1' },
        }));
        expect(mocks.serverFetch.mock.calls[0]).toEqual([
            '/v1/auth/password/mutation/challenge',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    v: 1,
                    action: 'connect',
                    expectedCredentialRevision: null,
                    normalizedNativeEmail,
                    newPlainPassword: 'correct horse battery staple',
                }),
            }),
            expect.objectContaining({ retry: 'none' }),
        ]);
        const [, init] = mocks.serverFetch.mock.calls[1]!;
        const url = String(mocks.serverFetch.mock.calls[1]![0]);
        const digest = new URL(url, target.serverUrl).searchParams.get('requestDigest');
        expect(url).toContain('/v1/auth/external/github/params?');
        expect(url).toContain('purpose=account_password_enrollment');
        expect(digest).toBe(requestDigest);
        expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${currentCredentials.token}`);
        expect(mocks.setPending).not.toHaveBeenCalled();
        expect(readAccountPasswordEnrollmentExternalAuthCallbackContext('github')).toEqual({ target });
    });

    it('custodies only an exact callback pending and exposes the strict proof to the enrollment submitter', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(Response.json({ targetCredential }))
            .mockResolvedValueOnce(Response.json({ url: 'https://github.example.test/authorize' }));
        await startAccountPasswordEnrollmentExternalAuth({
            accountId: 'account-1', currentCredentials,
            linkedProviderIds: ['github'], normalizedNativeEmail,
            newPassword: 'correct horse battery staple',
            returnTo: '/settings/account/security?verificationToken=mailbox-proof', target,
        });

        await expect(resumeAccountPasswordEnrollmentExternalAuth({
            provider: 'github', pending: 'server-pending', currentCredentials, target,
        })).resolves.toEqual({
            returnTo: '/settings/account/security?verificationToken=mailbox-proof',
        });
        expect(mocks.setPending).not.toHaveBeenCalled();
        await expect(readAccountPasswordEnrollmentExternalAuthProof({
            accountId: 'account-1', currentCredentials, target,
        })).resolves.toEqual({
            normalizedNativeEmail,
            targetCredential,
            externalAuthProof: {
                provider: 'github',
                pending: 'server-pending',
                proof: expect.any(String),
            },
        });
        await expect(readAccountPasswordEnrollmentExternalAuthProof({
            accountId: 'account-1', currentCredentials, target,
        })).resolves.toBeNull();
    });

    it('keeps exact custody through the originating screen unmount after the callback claims it', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(Response.json({ targetCredential }))
            .mockResolvedValueOnce(Response.json({ url: 'https://github.example.test/authorize' }));
        await startAccountPasswordEnrollmentExternalAuth({
            accountId: 'account-1', currentCredentials,
            linkedProviderIds: ['github'], normalizedNativeEmail,
            newPassword: 'correct horse battery staple',
            returnTo: '/settings/account/security?verificationToken=mailbox-proof', target,
        });

        expect(readAccountPasswordEnrollmentExternalAuthCallbackContext('github')).toEqual({ target });
        clearAccountPasswordEnrollmentExternalAuthCustody({
            accountId: 'account-1',
            target,
        });
        await expect(resumeAccountPasswordEnrollmentExternalAuth({
            provider: 'github', pending: 'server-pending', currentCredentials, target,
        })).resolves.toEqual({
            returnTo: '/settings/account/security?verificationToken=mailbox-proof',
        });
    });

    it('cannot resume after a fresh module reload loses process-local custody', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(Response.json({ targetCredential }))
            .mockResolvedValueOnce(Response.json({ url: 'https://github.example.test/authorize' }));
        await startAccountPasswordEnrollmentExternalAuth({
            accountId: 'account-1', currentCredentials,
            linkedProviderIds: ['github'], normalizedNativeEmail,
            newPassword: 'correct horse battery staple',
            returnTo: '/settings/account/security', target,
        });

        vi.resetModules();
        const reloaded = await import('./accountEncryptionFirstKeyExternalAuth');
        await expect(reloaded.resumeAccountPasswordEnrollmentExternalAuth({
            provider: 'github', pending: 'server-pending', currentCredentials, target,
        })).rejects.toMatchObject({ code: 'password-enrollment-external-auth-invalid' });
        expect(mocks.clearPending).not.toHaveBeenCalled();
        expect(mocks.setPending).not.toHaveBeenCalled();
    });

    it('replaces a retired attempt with a freshly prepared salted credential', async () => {
        const freshTargetCredential = {
            ...targetCredential,
            hash: {
                ...targetCredential.hash,
                salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(7)),
                digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(9)),
            },
        } satisfies PlainAccountPasswordCredentialV1;
        mocks.serverFetch
            .mockResolvedValueOnce(Response.json({ targetCredential }))
            .mockResolvedValueOnce(Response.json({ url: 'https://github.example.test/authorize-first' }))
            .mockResolvedValueOnce(Response.json({ targetCredential: freshTargetCredential }))
            .mockResolvedValueOnce(Response.json({ url: 'https://github.example.test/authorize-second' }));

        await startAccountPasswordEnrollmentExternalAuth({
            accountId: 'account-1', currentCredentials,
            linkedProviderIds: ['github'], normalizedNativeEmail,
            newPassword: 'first password attempt',
            returnTo: '/settings/account/security', target,
        });
        clearAccountPasswordEnrollmentExternalAuthCustody({
            accountId: 'account-1',
            target,
        });
        await startAccountPasswordEnrollmentExternalAuth({
            accountId: 'account-1', currentCredentials,
            linkedProviderIds: ['github'], normalizedNativeEmail,
            newPassword: 'second password attempt',
            returnTo: '/settings/account/security', target,
        });
        await resumeAccountPasswordEnrollmentExternalAuth({
            provider: 'github', pending: 'second-server-pending', currentCredentials, target,
        });

        await expect(readAccountPasswordEnrollmentExternalAuthProof({
            accountId: 'account-1', currentCredentials, target,
        })).resolves.toMatchObject({
            targetCredential: freshTargetCredential,
            externalAuthProof: {
                provider: 'github',
                pending: 'second-server-pending',
            },
        });
        expect(freshTargetCredential.hash.salt).not.toBe(targetCredential.hash.salt);
    });

    it('retires process-local custody at the authoritative pending expiry', async () => {
        vi.useFakeTimers();
        try {
            mocks.serverFetch
                .mockResolvedValueOnce(Response.json({ targetCredential }))
                .mockResolvedValueOnce(Response.json({ url: 'https://github.example.test/authorize' }));
            await startAccountPasswordEnrollmentExternalAuth({
                accountId: 'account-1', currentCredentials,
                linkedProviderIds: ['github'], normalizedNativeEmail,
                newPassword: 'correct horse battery staple',
                returnTo: '/settings/account/security', target,
            });
            expect(readAccountPasswordEnrollmentExternalAuthCallbackContext('github')).toEqual({ target });

            await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

            expect(readAccountPasswordEnrollmentExternalAuthCallbackContext('github')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('clears cancellation custody at the exact Home and preserves only its verified mailbox return', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(Response.json({ targetCredential }))
            .mockResolvedValueOnce(Response.json({ url: 'https://github.example.test/authorize' }));
        await startAccountPasswordEnrollmentExternalAuth({
            accountId: 'account-1', currentCredentials,
            linkedProviderIds: ['github'], normalizedNativeEmail,
            newPassword: 'correct horse battery staple',
            returnTo: '/settings/account/security?verificationToken=mailbox-proof', target,
        });

        await expect(cancelAccountPasswordEnrollmentExternalAuth({
            provider: 'github',
            currentCredentials,
            target,
        })).resolves.toEqual({
            returnTo: '/settings/account/security?verificationToken=mailbox-proof',
        });
        expect(mocks.clearPending).not.toHaveBeenCalled();
        expect(readAccountPasswordEnrollmentExternalAuthCallbackContext('github')).toBeNull();

        mocks.serverFetch
            .mockResolvedValueOnce(Response.json({ targetCredential }))
            .mockResolvedValueOnce(Response.json({ url: 'https://github.example.test/authorize' }));
        await startAccountPasswordEnrollmentExternalAuth({
            accountId: 'account-1', currentCredentials,
            linkedProviderIds: ['github'], normalizedNativeEmail,
            newPassword: 'correct horse battery staple',
            returnTo: '/settings/account/security?verificationToken=mailbox-proof', target,
        });
        await expect(cancelAccountPasswordEnrollmentExternalAuth({
            provider: 'github',
            currentCredentials: {
                token: `header.${Buffer.from(JSON.stringify({ sub: 'account-2' })).toString('base64url')}.signature`,
            },
            target,
        })).resolves.toEqual({ returnTo: '/settings/account/security' });
        expect(mocks.clearPending).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: 'Account',
            provider: 'github',
            credentials: {
                token: `header.${Buffer.from(JSON.stringify({ sub: 'account-2' })).toString('base64url')}.signature`,
            },
            callbackTarget: target,
        },
        {
            name: 'Home',
            provider: 'github',
            credentials: currentCredentials,
            callbackTarget: { serverId: 'server-b', serverUrl: target.serverUrl },
        },
        {
            name: 'provider',
            provider: 'oidc',
            credentials: currentCredentials,
            callbackTarget: target,
        },
    ])('rejects a substituted callback $name and retires the ceremony', async ({
        provider,
        credentials,
        callbackTarget,
    }) => {
        mocks.serverFetch
            .mockResolvedValueOnce(Response.json({ targetCredential }))
            .mockResolvedValueOnce(Response.json({ url: 'https://github.example.test/authorize' }));
        await startAccountPasswordEnrollmentExternalAuth({
            accountId: 'account-1', currentCredentials,
            linkedProviderIds: ['github'], normalizedNativeEmail,
            newPassword: 'correct horse battery staple',
            returnTo: '/settings/account/security', target,
        });

        await expect(resumeAccountPasswordEnrollmentExternalAuth({
            provider,
            pending: 'server-pending',
            currentCredentials: credentials,
            target: callbackTarget,
        })).rejects.toMatchObject({ code: 'password-enrollment-external-auth-invalid' });
        await expect(readAccountPasswordEnrollmentExternalAuthProof({
            accountId: 'account-1', currentCredentials, target,
        })).resolves.toBeNull();
    });

    it('uses the existing mTLS step-up adapter and returns the same request-bound proof it custodies', async () => {
        mocks.fetchHomeAuthEntry.mockResolvedValueOnce({
            kind: 'ready',
            projection: {
                v: 1,
                state: 'ready',
                scope: { kind: 'home' },
                autoRedirect: null,
                actions: [{
                    kind: 'authenticate',
                    methodId: 'mtls',
                    action: 'login',
                    mode: 'keyless',
                    origin: 'home',
                    presentation: { displayName: 'Client certificate' },
                }],
            },
        });
        mocks.serverFetch
            .mockResolvedValueOnce(Response.json({ targetCredential }))
            .mockResolvedValueOnce(Response.json({ success: true, pending: 'mtls-pending' }));

        const result = await startAccountPasswordEnrollmentExternalAuth({
            accountId: 'account-1',
            currentCredentials,
            linkedProviderIds: ['mtls'],
            normalizedNativeEmail,
            newPassword: 'correct horse battery staple',
            returnTo: '/settings/account/security?verificationToken=mailbox-proof',
            target,
        });

        expect(result.kind).toBe('mtls');
        if (result.kind !== 'mtls') throw new Error('Expected mTLS proof');
        const requestBody = JSON.parse(String(mocks.serverFetch.mock.calls[1]![1]?.body));
        expect(requestBody).toMatchObject({
            purpose: 'account_password_enrollment',
            requestDigest,
        });
        expect(result.externalAuthProof).toEqual({
            provider: 'mtls',
            pending: 'mtls-pending',
            proof: expect.any(String),
        });
        expect(mocks.setPending).not.toHaveBeenCalled();
        expect(readAccountPasswordEnrollmentExternalAuthCallbackContext('mtls')).toBeNull();
    });

    it('fails closed before creating proof custody when no linked current method is available', async () => {
        await expect(startAccountPasswordEnrollmentExternalAuth({
            accountId: 'account-1',
            currentCredentials,
            linkedProviderIds: ['different-provider'],
            normalizedNativeEmail,
            newPassword: 'correct horse battery staple',
            returnTo: '/settings/account/security?verificationToken=mailbox-proof',
            target,
        })).rejects.toMatchObject({ code: 'password-enrollment-external-auth-unavailable' });
        expect(mocks.setPending).not.toHaveBeenCalled();
        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('rejects callback replay without erasing the exact Settings handoff', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(Response.json({ targetCredential }))
            .mockResolvedValueOnce(Response.json({ url: 'https://github.example.test/authorize' }));
        await startAccountPasswordEnrollmentExternalAuth({
            accountId: 'account-1', currentCredentials,
            linkedProviderIds: ['github'], normalizedNativeEmail,
            newPassword: 'correct horse battery staple',
            returnTo: '/settings/account/security', target,
        });
        await resumeAccountPasswordEnrollmentExternalAuth({
            provider: 'github', pending: 'already-custodied', currentCredentials, target,
        });
        await expect(resumeAccountPasswordEnrollmentExternalAuth({
            provider: 'github',
            pending: 'replayed-pending',
            currentCredentials,
            target,
        })).rejects.toMatchObject({ code: 'password-enrollment-external-auth-invalid' });
        expect(mocks.setPending).not.toHaveBeenCalled();

        await expect(readAccountPasswordEnrollmentExternalAuthProof({
            accountId: 'account-1', currentCredentials, target,
        })).resolves.toMatchObject({
            normalizedNativeEmail,
            targetCredential,
            externalAuthProof: {
                provider: 'github',
                pending: 'already-custodied',
            },
        });
        await expect(readAccountPasswordEnrollmentExternalAuthProof({
            accountId: 'account-1', currentCredentials, target,
        })).resolves.toBeNull();
    });

    it('claims the OAuth callback ceremony exactly once while preserving the Settings handoff', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(Response.json({ targetCredential }))
            .mockResolvedValueOnce(Response.json({ url: 'https://github.example.test/authorize' }));
        await startAccountPasswordEnrollmentExternalAuth({
            accountId: 'account-1', currentCredentials,
            linkedProviderIds: ['github'], normalizedNativeEmail,
            newPassword: 'correct horse battery staple',
            returnTo: '/settings/account/security', target,
        });

        expect(readAccountPasswordEnrollmentExternalAuthCallbackContext('github')).toEqual({ target });
        expect(readAccountPasswordEnrollmentExternalAuthCallbackContext('github')).toBeNull();

        await resumeAccountPasswordEnrollmentExternalAuth({
            provider: 'github', pending: 'server-pending', currentCredentials, target,
        });
        await expect(readAccountPasswordEnrollmentExternalAuthProof({
            accountId: 'account-1', currentCredentials, target,
        })).resolves.toMatchObject({
            normalizedNativeEmail,
            targetCredential,
            externalAuthProof: { provider: 'github', pending: 'server-pending' },
        });
    });
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
        mocks.authGetTokenAtEndpoint.mockResolvedValue({ token: recoveredToken });
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

        expect(mocks.authGetTokenAtEndpoint).toHaveBeenCalledWith(
            expect.objectContaining({
                secret: new Uint8Array(32),
                expectedAccountId: fixture.accountId,
                endpointUrl: 'https://server.example.test',
                serverId: 'server-a',
                requireKeyChallengeV2: true,
            }),
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
        mocks.authGetTokenAtEndpoint.mockResolvedValue({ token: [
            'header',
            Buffer.from(JSON.stringify({
                sub: 'another-account',
            })).toString('base64url'),
            'signature',
        ].join('.') });
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
        expect(mocks.authGetTokenAtEndpoint).not.toHaveBeenCalled();
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
            { request: mocks.serverFetch },
        );
        expect(mocks.clearPending).toHaveBeenLastCalledWith({
            removeFirstKeyMigrationAttempted: {
                ...marked,
                serverId: 'server-a',
                serverUrl: 'https://server-a.example.test',
            },
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
        // The feature snapshot is transport/readiness evidence only. Method
        // admission comes from the authenticated exact-Home auth-entry owner;
        // stale legacy provider maps must not suppress that current decision.
        mocks.getFeatures.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: { auth: { mtls: { enabled: false } } },
                capabilities: {
                    oauth: { providers: {} },
                    auth: {
                        methods: [],
                        login: { methods: [], requiredProviders: [] },
                        providers: {},
                    },
                },
            },
        });
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
        expect(mocks.fetchHomeAuthEntry).toHaveBeenCalledWith({
            accountScope: { serverId: 'api.happier.dev', accountId: fixture.accountId },
            endpointUrl: 'https://api.happier.dev',
            serverId: 'api.happier.dev',
        });
        expect(mocks.getFeatures).not.toHaveBeenCalled();
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

    it('uses the canonical released-feature adapter only when the exact auth-entry endpoint is unsupported', async () => {
        const fixture = await createFixture();
        mocks.fetchHomeAuthEntry.mockResolvedValueOnce({ kind: 'unsupported' });
        mocks.getFeatures.mockResolvedValueOnce(legacyOauthFeatures());
        mocks.serverFetch.mockResolvedValueOnce(Response.json({
            url: 'https://github.example.test/authorize',
        }));

        await expect(startAccountEncryptionFirstKeyExternalAuth({
            ...fixture,
            linkedProviderIds: ['github'],
            returnTo: '/settings/account',
        })).resolves.toMatchObject({
            kind: 'oauth',
            provider: 'github',
            url: 'https://github.example.test/authorize',
        });
        expect(mocks.getFeatures).toHaveBeenCalledTimes(1);
    });

    it('does not reinterpret an incompatible exact auth-entry response through legacy feature maps', async () => {
        const fixture = await createFixture();
        mocks.fetchHomeAuthEntry.mockResolvedValueOnce({ kind: 'incompatible' });
        mocks.getFeatures.mockResolvedValueOnce(legacyOauthFeatures());

        await expect(startAccountEncryptionFirstKeyExternalAuth({
            ...fixture,
            linkedProviderIds: ['github'],
            returnTo: '/settings/account',
        })).rejects.toMatchObject({ code: 'first-key-external-auth-unavailable' });
        expect(mocks.getFeatures).not.toHaveBeenCalled();
        expect(mocks.serverFetch).not.toHaveBeenCalled();
        expect(mocks.setPending).not.toHaveBeenCalled();
    });

    it('uses the enrolled native password as the exact first-key proof and retains the migration continuation', async () => {
        const fixture = await createFixture();
        mocks.serverFetch.mockResolvedValue(new Response(JSON.stringify({
            externalAuthProof: {
                provider: 'email_password',
                pending: 'password-step-up-pending',
                proof: 'password-step-up-proof',
            },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        const result = await startAccountEncryptionFirstKeyExternalAuth({
            ...fixture,
            linkedProviderIds: [],
            nativePassword: 'current password with spaces',
            returnTo: '/settings/account/security',
        });

        expect(result).toEqual({
            kind: 'email_password',
            externalAuthProof: {
                provider: 'email_password',
                pending: 'password-step-up-pending',
                proof: 'password-step-up-proof',
            },
        });
        const [path, init, options] = mocks.serverFetch.mock.calls[0]!;
        expect(path).toBe('/v1/auth/email/step-up');
        expect(JSON.parse(init.body)).toEqual({
            v: 1,
            password: 'current password with spaces',
            purpose: 'account_encryption_first_key',
            requestDigest: createAccountEncryptionMigrateRequestBindingDigestV1({
                request: fixture.request,
                accountId: fixture.accountId,
                sourceMode: 'plain',
            }),
        });
        expect(options).toEqual({ includeAuth: false, retry: 'none' });
        expect(mocks.setPending).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'email_password',
            proof: 'password-step-up-proof',
            secret: fixture.proposedCredentials.secret,
            returnTo: '/settings/account/security',
            accountEncryptionFirstKey: expect.objectContaining({
                accountId: fixture.accountId,
                requestJson: JSON.stringify(fixture.request),
                pending: 'password-step-up-pending',
            }),
        }), expect.anything());
    });

    it('uses the existing authenticated mTLS endpoint and returns an immediate strict proof', async () => {
        const fixture = await createFixture();
        mocks.fetchHomeAuthEntry.mockResolvedValueOnce(mtlsAuthEntry());
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
            {
                serverId: 'api.happier.dev',
                serverUrl: 'https://api.happier.dev',
            },
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
        mocks.fetchHomeAuthEntry.mockResolvedValueOnce(mtlsAuthEntry());
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

    it.each(['empty', 'authoring-memory', 'project-rows', 'profile-rows', 'profile-reference-conflict'] as const)('validates the exact OAuth migration before adopting it (%s)', async (family) => {
        const fixture = await createFixture();
        const withMemory = family === 'authoring-memory';
        if (withMemory) {
            const content = createAuthoringMemoryCipher({ mode: 'e2ee',
                material: resolveAccountScopedCryptoMaterialFromCredentials(fixture.proposedCredentials),
                randomBytes: (length) => new Uint8Array(length),
            }).seal('lastUsedProfile', 'profile-a');
            fixture.request = AccountEncryptionMigrateRequestSchema.parse({ ...fixture.request,
                authoringMemory: { items: [{ key: 'lastUsedProfile', expectedRevision: 3, content }] },
            });
            mocks.migrate.mockResolvedValue({ success: true, mode: 'e2ee', accountVersion: 9, settingsVersion: 4,
                authoringMemory: { rows: [{ key: 'lastUsedProfile', revision: 4, content }] },
            });
        }
        if (family === 'project-rows') {
            const key = { kind: 'project-organization' as const, serverId: 'server-a', projectKey: 'project' };
            const content = createProjectAccountRowCipherV1({ mode: 'e2ee',
                material: resolveAccountScopedCryptoMaterialFromCredentials(fixture.proposedCredentials), randomBytes: length => new Uint8Array(length),
            }).seal({ key, value: { hidden: true } });
            fixture.request = AccountEncryptionMigrateRequestSchema.parse({ ...fixture.request, projectRows: { items: [{ key, expectedRevision: 3, content }] } });
            mocks.migrate.mockResolvedValue({ success: true, mode: 'e2ee', accountVersion: 9, settingsVersion: 4,
                projectRows: { rows: [{ key, revision: 4, content }] },
            });
        }
        if (family === 'profile-rows' || family === 'profile-reference-conflict') {
            fixture.request = AccountEncryptionMigrateRequestSchema.parse({ ...fixture.request,
                profileRows: { items: [], expectedReferenceGuardRevision: 11,
                  transferControl: { expectedRevision: 'absent', content: null } },
            });
            mocks.migrate.mockResolvedValue({ success: true, mode: 'e2ee', accountVersion: 9, settingsVersion: 4,
                profileRows: { rows: [], referenceGuardRevision: family === 'profile-rows' ? 11 : 12,
                  transferControl: { status: 'absent' } },
            });
        }
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
                serverId: 'server-a',
                serverUrl: 'https://server-a.example.test',
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

        const resume = resumeAccountEncryptionFirstKeyExternalAuth({
                provider: 'github',
                pending: 'oauth-pending',
                target: {
                    serverId: 'server-a',
                    serverUrl: 'https://server-a.example.test',
                },
                currentCredentials: fixture.currentCredentials,
                persistCredentials,
            });
        if (family === 'profile-reference-conflict') {
            await expect(resume).rejects.toThrow('Invalid Profile row migration response');
            expect(persistCredentials).not.toHaveBeenCalled();
            expect(mocks.clearPending).not.toHaveBeenCalled();
            return;
        }
        const result = await resume;

        expect(result.returnTo).toBe('/settings/account');
        if (family === 'profile-rows') {
            expect(result.migration.profileRows).toEqual({ rows: [], referenceGuardRevision: 11,
              transferControl: { status: 'absent' } });
        }
        if (family === 'project-rows') {
            expect(result.migration.projectRows).toMatchObject({ rows: [{ revision: 4, content: fixture.request.projectRows!.items[0]!.content }] });
            expect(mocks.reconfigureAuthoringMemory).toHaveBeenCalledWith(fixture.proposedCredentials, 'e2ee');
            expect(mocks.reconfigureSessionDraftRepository).not.toHaveBeenCalled();
        }
        if (withMemory) {
            expect(result.migration.authoringMemory).toEqual({ rows: [{ key: 'lastUsedProfile', revision: 4,
                content: fixture.request.authoringMemory!.items[0]!.content,
            }] });
            expect(mocks.reconfigureAuthoringMemory).toHaveBeenCalledWith(fixture.proposedCredentials, 'e2ee');
            expect(mocks.reconfigureSessionDraftRepository).not.toHaveBeenCalled();
        }
        expect(mocks.setPending).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'github',
                accountEncryptionFirstKey:
                    expect.objectContaining({
                        pending: 'oauth-pending',
                    }),
            }),
            {
                serverId: 'server-a',
                serverUrl: 'https://server-a.example.test',
            },
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
            {
                retry: 'none',
                request: mocks.serverFetch,
                target: {
                    serverId: 'server-a',
                    serverUrl: 'https://server-a.example.test',
                },
            },
        );
        expect(persistCredentials).toHaveBeenCalledWith(
            fixture.proposedCredentials,
            expect.objectContaining({
                target: {
                    serverId: 'server-a',
                    serverUrl: 'https://server-a.example.test',
                },
            }),
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

    it.each(['before-admission', 'after-commit'] as const)('does not adopt a first-key migration after the settings scope retires (%s)', async (retirement) => {
        const fixture = await createFixture();
        fixture.request = AccountEncryptionMigrateRequestSchema.parse({ ...fixture.request,
            profileRows: { items: [], expectedReferenceGuardRevision: 11,
                transferControl: { expectedRevision: 'absent', content: null } },
        });
        let isCurrent = retirement !== 'before-admission';
        mocks.migrate.mockImplementationOnce(async () => {
            isCurrent = false;
            return { success: true, mode: 'e2ee', accountVersion: 9, settingsVersion: 4,
                profileRows: { rows: [], referenceGuardRevision: 12, transferControl: { status: 'absent' } },
            };
        });
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
                serverId: 'server-a',
                serverUrl: 'https://server-a.example.test',
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

        await expect(
            resumeAccountEncryptionFirstKeyExternalAuth({
                provider: 'github',
                pending: 'oauth-pending',
                target: {
                    serverId: 'server-a',
                    serverUrl: 'https://server-a.example.test',
                },
                currentCredentials: fixture.currentCredentials,
                persistCredentials,
                scopeGuard: { isCurrent: () => isCurrent },
            }),
        ).rejects.toThrow('account_encryption_scope_changed');
        expect(persistCredentials).not.toHaveBeenCalled();
        if (retirement === 'before-admission') expect(mocks.migrate).not.toHaveBeenCalled();
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
            expect.objectContaining(retainedState),
            {
                serverId: 'server-a',
                serverUrl: 'https://server-a.example.test',
            },
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
        expect(mocks.setPending).toHaveBeenCalledWith(
            expect.objectContaining({
                ...state,
                accountEncryptionFirstKey: {
                    ...continuation,
                    migrationSubmissionAttempted: true,
                },
            }),
            {
                serverId: 'server-a',
                serverUrl: 'https://server-a.example.test',
            },
        );
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
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            accountEncryptionFirstKey: {
                ...state.accountEncryptionFirstKey,
                migrationSubmissionAttempted: true,
            },
        }, { serverId: 'server-a', serverUrl: 'https://server-a.example.test' });
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
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            accountEncryptionFirstKey: {
                ...continuation,
                migrationSubmissionAttempted: true,
            },
        }, { serverId: 'server-a', serverUrl: 'https://server-a.example.test' });
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
