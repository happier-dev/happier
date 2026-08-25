import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    return {
        serverFetch: vi.fn(),
        ServerFetchAbortedForServerSwitchError: class ServerFetchAbortedForServerSwitchError extends Error {},
        StaleServerGenerationError: class StaleServerGenerationError extends Error {},
    };
});

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
    ServerFetchAbortedForServerSwitchError: mocks.ServerFetchAbortedForServerSwitchError,
    StaleServerGenerationError: mocks.StaleServerGenerationError,
}));

import { authGetToken } from './getToken';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import {
    AccountStoredContentClientUpgradeRequiredError,
} from '@/sync/api/capabilities/accountStoredContentCompatibility';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
} from '@happier-dev/protocol';
import { HappyError } from '@/utils/errors/errors';
import {
    setActiveServerId,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function keyChallengeV2Capabilities(serverIdentityId: string) {
    return {
        auth: {
            methods: [],
            keyChallenge: { v2: true },
            signup: { methods: [] },
            login: { methods: [], requiredProviders: [] },
            recovery: { providerReset: { providers: [] } },
            ui: { autoRedirect: { enabled: false, providerId: null } },
            providers: {},
            misconfig: [],
        },
        serverIdentity: { serverIdentityId },
    };
}

describe('authGetToken key-challenge gate', () => {
    beforeEach(() => {
        resetServerFeaturesClientForTests();
        mocks.serverFetch.mockReset();
    });

    it('fails fast when server disables key-challenge login', async () => {
        mocks.serverFetch.mockResolvedValueOnce(
            jsonResponse({
                features: { auth: { login: { keyChallenge: { enabled: false } } } },
                capabilities: {},
            }),
        );

        await expect(authGetToken(new Uint8Array(32))).rejects.toThrow(/key-challenge/i);
        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
        expect(mocks.serverFetch.mock.calls[0]?.[0]).toBe('/v1/features');
    });

    it('does not fail fast when server does not advertise key-challenge gate (legacy server)', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: { recovery: { providerReset: { enabled: false } }, ui: { recoveryKeyReminder: { enabled: true } } },
                        sharing: { contentKeys: { enabled: false } },
                    },
                    capabilities: {},
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ token: 'legacy-token' }));

        await expect(authGetToken(new Uint8Array(32))).resolves.toBe('legacy-token');
        expect(mocks.serverFetch).toHaveBeenCalledTimes(2);
        expect(mocks.serverFetch.mock.calls[0]?.[0]).toBe('/v1/features');
        expect(mocks.serverFetch.mock.calls[1]?.[0]).toBe('/v1/auth');
    });

    it.each([
        {
            name: 'network failure',
            prepare: () => {
                mocks.serverFetch
                    .mockRejectedValueOnce(new Error('network unavailable'))
                    .mockResolvedValueOnce(jsonResponse({ token: 'must-not-redeem' }));
            },
        },
        {
            name: 'server failure',
            prepare: () => {
                mocks.serverFetch
                    .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
                    .mockResolvedValueOnce(jsonResponse({ token: 'must-not-redeem' }));
            },
        },
        {
            name: 'malformed response',
            prepare: () => {
                mocks.serverFetch
                    .mockResolvedValueOnce(new Response('not-json', {
                        headers: { 'Content-Type': 'application/json' },
                    }))
                    .mockResolvedValueOnce(jsonResponse({ token: 'must-not-redeem' }));
            },
        },
        {
            name: 'missing endpoint',
            prepare: () => {
                mocks.serverFetch
                    .mockResolvedValueOnce(new Response(null, { status: 404 }))
                    .mockResolvedValueOnce(jsonResponse({ token: 'must-not-redeem' }));
            },
        },
    ])('fails closed and leaves the auth endpoint untouched when the feature probe has a $name', async ({ prepare }) => {
        prepare();

        await expect(authGetToken(new Uint8Array(32))).rejects.toMatchObject({
            name: 'HappyError',
            canTryAgain: true,
        } satisfies Partial<HappyError>);
        expect(mocks.serverFetch.mock.calls.map((call) => call[0])).toEqual([
            '/v1/features',
        ]);
    });

    it('fails closed and leaves the auth endpoint untouched when the feature probe times out', async () => {
        mocks.serverFetch
            .mockImplementationOnce((_url: string, init?: RequestInit) => {
                return new Promise<Response>((_resolve, reject) => {
                    const signal = init?.signal;
                    if (!signal) {
                        reject(new Error('missing feature-probe abort signal'));
                        return;
                    }
                    signal.addEventListener('abort', () => {
                        const error = Object.assign(new Error('feature probe timed out'), {
                            name: 'AbortError',
                        });
                        reject(error);
                    }, { once: true });
                });
            })
            .mockResolvedValueOnce(jsonResponse({ token: 'must-not-redeem' }));

        await expect(authGetToken(new Uint8Array(32))).rejects.toMatchObject({
            name: 'HappyError',
            canTryAgain: true,
        } satisfies Partial<HappyError>);
        expect(mocks.serverFetch.mock.calls.map((call) => call[0])).toEqual([
            '/v1/features',
        ]);
    });

    it('continues when server enables key-challenge login', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: { login: { keyChallenge: { enabled: true } } },
                        sharing: { contentKeys: { enabled: false } },
                    },
                    capabilities: {},
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ token: 'test-token' }));

        await expect(authGetToken(new Uint8Array(32))).resolves.toBe('test-token');
        expect(mocks.serverFetch).toHaveBeenCalledTimes(2);
        expect(mocks.serverFetch.mock.calls[0]?.[0]).toBe('/v1/features');
        expect(mocks.serverFetch.mock.calls[1]?.[0]).toBe('/v1/auth');
    });

    it('preserves a recognized signup policy error from the auth endpoint', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: { login: { keyChallenge: { enabled: true } } },
                        sharing: { contentKeys: { enabled: false } },
                    },
                    capabilities: {},
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ error: 'signup-disabled' }, 403));

        await expect(authGetToken(new Uint8Array(32))).rejects.toMatchObject({
            name: 'HappyError',
            code: 'signup-disabled',
            status: 403,
            kind: 'auth',
            canTryAgain: false,
        } satisfies Partial<HappyError>);
    });

    it('does not promote an unknown JSON error code into the typed auth contract', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: { login: { keyChallenge: { enabled: true } } },
                        sharing: { contentKeys: { enabled: false } },
                    },
                    capabilities: {},
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ error: 'signup-disable' }, 403));

        await expect(authGetToken(new Uint8Array(32))).rejects.toMatchObject({
            name: 'HappyError',
            code: undefined,
            status: 403,
            kind: 'auth',
            canTryAgain: false,
        } satisfies Partial<HappyError>);
    });

    it('classifies a non-JSON server failure as retryable without inventing an auth code', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: { login: { keyChallenge: { enabled: true } } },
                        sharing: { contentKeys: { enabled: false } },
                    },
                    capabilities: {},
                }),
            )
            .mockResolvedValueOnce(new Response('relay failure', { status: 500 }));

        await expect(authGetToken(new Uint8Array(32))).rejects.toMatchObject({
            name: 'HappyError',
            code: undefined,
            status: 500,
            kind: 'server',
            canTryAgain: true,
        } satisfies Partial<HappyError>);
    });

    it('sends the signed expected Account id through negotiated v2 Account-bound login', async () => {
        const profile = upsertServerProfile({
            serverUrl: 'https://selected.example.test/api',
            name: 'Selected test server',
        });
        setActiveServerId(profile.id);

        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: {
                            login: {
                                keyChallenge: {
                                    enabled: true,
                                },
                            },
                        },
                        sharing: {
                            contentKeys: {
                                enabled: true,
                            },
                        },
                    },
                    capabilities: {
                        ...keyChallengeV2Capabilities('srv_selected'),
                        accountStoredContentCompatibility: {
                            v: 1,
                            minimumProtocolVersion:
                                CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                            currentProtocolVersion:
                                CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                            declarationTransport:
                                'http-header-and-socket-auth-v1',
                        },
                    },
                }),
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    challengeId: 'challenge-account-expected',
                    nonce: 'nonce-account-expected',
                    issuedAt: '2026-08-22T12:00:00.000Z',
                    expiresAt: '2026-08-22T12:05:00.000Z',
                    audience: {
                        origin: 'https://selected.example.test',
                        serverIdentityId: 'srv_selected',
                    },
                }),
            )
            .mockResolvedValueOnce(
                jsonResponse({ token: 'recovery-token' }),
            );

        await expect(authGetToken(
            new Uint8Array(32).fill(9),
            { expectedAccountId: 'account-expected' },
        )).resolves.toBe('recovery-token');

        const request = mocks.serverFetch.mock.calls[2]?.[1] as
            | RequestInit
            | undefined;
        const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
            expectedAccountId: 'account-expected',
            challengeId: 'challenge-account-expected',
            publicKey: expect.any(String),
            signature: expect.any(String),
            contentPublicKey: expect.any(String),
            contentPublicKeySig: expect.any(String),
        });
        expect(body).not.toHaveProperty('challenge');
    });

    it('does not fall back to v1 for Account-bound login when a ready server lacks the v2 capability', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: {
                            login: {
                                keyChallenge: {
                                    enabled: true,
                                },
                            },
                        },
                        sharing: {
                            contentKeys: {
                                enabled: true,
                            },
                        },
                    },
                    capabilities: {
                        accountStoredContentCompatibility: {
                            v: 1,
                            minimumProtocolVersion:
                                CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                            currentProtocolVersion:
                                CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                            declarationTransport:
                                'http-header-and-socket-auth-v1',
                        },
                    },
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ token: 'must-not-redeem' }));

        await expect(authGetToken(
            new Uint8Array(32).fill(9),
            { expectedAccountId: 'account-expected' },
        )).rejects.toThrow(/v2/i);
        expect(mocks.serverFetch.mock.calls.map((call) => call[0])).toEqual([
            '/v1/features',
        ]);
    });

    it.each([
        {
            name: 'missing',
            capabilities: {},
        },
        {
            name: 'pre-current',
            capabilities: {
                accountStoredContentCompatibility: {
                    v: 1,
                    minimumProtocolVersion: 1,
                    currentProtocolVersion: 1,
                    declarationTransport:
                        'http-header-and-socket-auth-v1',
                },
            },
        },
        {
            name: 'malformed',
            capabilities: {
                accountStoredContentCompatibility: {
                    v: 1,
                    minimumProtocolVersion: 2,
                    currentProtocolVersion:
                        'not-a-version',
                    declarationTransport:
                        'http-header-and-socket-auth-v1',
                },
            },
        },
    ])('fails Account-bound login closed with typed upgrade-required and zero auth POST when compatibility is $name', async ({
        capabilities,
    }) => {
        mocks.serverFetch.mockResolvedValueOnce(
            jsonResponse({
                features: {
                    auth: {
                        login: {
                            keyChallenge: {
                                enabled: true,
                            },
                        },
                    },
                    sharing: {
                        contentKeys: {
                            enabled: true,
                        },
                    },
                },
                capabilities,
            }),
        );

        await expect(authGetToken(
            new Uint8Array(32).fill(9),
            { expectedAccountId: 'account-expected' },
        )).rejects.toBeInstanceOf(
            AccountStoredContentClientUpgradeRequiredError,
        );
        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
        expect(mocks.serverFetch.mock.calls[0]?.[0])
            .toBe('/v1/features');
    });

    it('refuses a mismatched v2 audience before signing or redeeming', async () => {
        const profile = upsertServerProfile({
            serverUrl: 'https://selected.example.test/api',
            name: 'Selected test server',
        });
        setActiveServerId(profile.id);

        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: { login: { keyChallenge: { enabled: true } } },
                        sharing: { contentKeys: { enabled: false } },
                    },
                    capabilities: keyChallengeV2Capabilities('srv_selected'),
                }),
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    challengeId: 'challenge-123',
                    nonce: 'nonce-abc',
                    issuedAt: '2026-08-22T12:00:00.000Z',
                    expiresAt: '2026-08-22T12:05:00.000Z',
                    audience: {
                        origin: 'https://attacker.example.test',
                        serverIdentityId: 'srv_attacker',
                    },
                }),
            );

        await expect(authGetToken(new Uint8Array(32))).rejects.toThrow(/audience/i);
        expect(mocks.serverFetch.mock.calls.map((call) => call[0])).toEqual([
            '/v1/features',
            '/v1/auth/challenge',
        ]);
    });

    it('redeems a negotiated v2 challenge without sending the legacy assertion', async () => {
        const profile = upsertServerProfile({
            serverUrl: 'https://selected.example.test/api',
            name: 'Selected test server',
        });
        setActiveServerId(profile.id);

        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: { login: { keyChallenge: { enabled: true } } },
                        sharing: { contentKeys: { enabled: false } },
                    },
                    capabilities: keyChallengeV2Capabilities('srv_selected'),
                }),
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    challengeId: 'challenge-123',
                    nonce: 'nonce-abc',
                    issuedAt: '2026-08-22T12:00:00.000Z',
                    expiresAt: '2026-08-22T12:05:00.000Z',
                    audience: {
                        origin: 'https://selected.example.test',
                        serverIdentityId: 'srv_selected',
                    },
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ token: 'v2-token' }));

        await expect(authGetToken(new Uint8Array(32).fill(6))).resolves.toBe('v2-token');
        expect(mocks.serverFetch.mock.calls.map((call) => call[0])).toEqual([
            '/v1/features',
            '/v1/auth/challenge',
            '/v1/auth',
        ]);
        const authRequest = mocks.serverFetch.mock.calls[2]?.[1] as RequestInit | undefined;
        const body = JSON.parse(String(authRequest?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
            challengeId: 'challenge-123',
            publicKey: expect.any(String),
            signature: expect.any(String),
        });
        expect(body).not.toHaveProperty('challenge');
    });
});
