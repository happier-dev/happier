import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    return {
        serverFetch: vi.fn(),
    };
});

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
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

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
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

    it('sends the signed expected Account id only for Account-bound login', async () => {
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
            .mockResolvedValueOnce(
                jsonResponse({ token: 'recovery-token' }),
            );

        await expect(authGetToken(
            new Uint8Array(32).fill(9),
            { expectedAccountId: 'account-expected' },
        )).resolves.toBe('recovery-token');

        const request = mocks.serverFetch.mock.calls[1]?.[1] as
            | RequestInit
            | undefined;
        expect(JSON.parse(String(request?.body))).toMatchObject({
            expectedAccountId: 'account-expected',
            publicKey: expect.any(String),
            challenge: expect.any(String),
            signature: expect.any(String),
            contentPublicKey: expect.any(String),
            contentPublicKeySig: expect.any(String),
        });
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
});
