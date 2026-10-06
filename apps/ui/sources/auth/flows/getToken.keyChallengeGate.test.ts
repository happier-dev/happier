import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MMKV } from 'react-native-mmkv';

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

// Device credential storage and the person's own answer are the two genuine
// boundaries this policy consults; everything below them stays real.
const boundaries = vi.hoisted(() => ({
    confirm: vi.fn(async () => false),
    getCredentialsForServerUrl: vi.fn(async () => null as { token: string } | null),
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal'))
    .createModalModuleMock({ spies: { confirm: boundaries.confirm } }).module);
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            getCredentialsForServerUrl: boundaries.getCredentialsForServerUrl,
        },
    };
});

import { authGetToken } from './getToken';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
} from '@happier-dev/protocol';
import { HappyError } from '@/utils/errors/errors';
import {
    getServerProfileById,
    setActiveServerId,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import {
    HOME_ADDRESS_MISMATCH_AUTH_CODE,
    HOME_IDENTITY_MISMATCH_AUTH_CODE,
} from './authenticationFailure';
import {
    readStorageScopeFromEnv,
    scopedStorageId,
} from '@/utils/system/storageScope';

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
    afterEach(() => { vi.useRealTimers(); });
    beforeEach(() => {
        resetServerFeaturesClientForTests();
        mocks.serverFetch.mockReset();
        boundaries.confirm.mockReset();
        boundaries.confirm.mockResolvedValue(false);
        boundaries.getCredentialsForServerUrl.mockReset();
        boundaries.getCredentialsForServerUrl.mockResolvedValue(null);
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
    ])('uses the released v1 request shape when an ordinary unbound Home feature probe has a $name', async ({ prepare }) => {
        prepare();

        await expect(authGetToken(new Uint8Array(32))).resolves.toBe('must-not-redeem');
        expect(mocks.serverFetch.mock.calls.map((call) => call[0])).toEqual([
            '/v1/features',
            '/v1/auth',
        ]);
        const authRequest = mocks.serverFetch.mock.calls[1]?.[1] as RequestInit | undefined;
        const body = JSON.parse(String(authRequest?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
            challenge: expect.any(String),
            publicKey: expect.any(String),
            signature: expect.any(String),
        });
        expect(body).not.toHaveProperty('challengeId');
        expect(body).not.toHaveProperty('contentPublicKey');
    });

    it('uses the released v1 request shape when an ordinary unbound Home feature probe times out', async () => {
        vi.useFakeTimers();
        let featureSignal: AbortSignal | null | undefined;
        mocks.serverFetch
            .mockImplementationOnce((_url: string, init?: RequestInit) => {
                featureSignal = init?.signal;
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
            .mockResolvedValueOnce(jsonResponse({ token: 'legacy-token' }));

        const result = authGetToken(new Uint8Array(32));
        await vi.advanceTimersByTimeAsync(799);
        expect(mocks.serverFetch.mock.calls.map((call) => call[0])).toEqual(['/v1/features']);
        await vi.advanceTimersByTimeAsync(1);
        await expect(result).resolves.toBe('legacy-token');
        expect(featureSignal).toBeDefined();
        expect(featureSignal?.aborted).toBe(false);
        const body = JSON.parse(String(mocks.serverFetch.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
        expect(body).toHaveProperty('challenge');
        expect(body).not.toHaveProperty('challengeId');
        expect(mocks.serverFetch.mock.calls.map((call) => call[0])).toEqual([
            '/v1/features',
            '/v1/auth',
        ]);
        await vi.advanceTimersByTimeAsync(59_200);
    });

    it('waits for slow features when focused key login requires an Account-bound challenge', async () => {
        const profile = upsertServerProfile({ serverUrl: 'https://slow-focused.example.test', name: 'Slow Home' });
        await setActiveServerId(profile.id);
        vi.useFakeTimers();
        mocks.serverFetch.mockImplementation(async (path: string) => {
            if (path === '/v1/features') {
                await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
                return jsonResponse({ features: {}, capabilities: keyChallengeV2Capabilities('srv_slow_focused') });
            }
            if (path === '/v1/auth/challenge') return jsonResponse({
                challengeId: 'slow-challenge', nonce: 'nonce',
                issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
                audience: { origin: 'https://slow-focused.example.test', serverIdentityId: 'srv_slow_focused' },
            });
            if (path === '/v1/auth') return jsonResponse({ token: 'focused-token' });
            throw new Error(`Unexpected request: ${path}`);
        });
        let settled = false;
        const result = authGetToken(new Uint8Array(32).fill(7), { expectedAccountId: 'expected-account' })
            .then((token) => { settled = true; return token; }, (error: unknown) => { settled = true; return error; });
        await vi.advanceTimersByTimeAsync(800);
        expect(settled).toBe(false);
        expect(mocks.serverFetch.mock.calls.map((call) => call[0])).toEqual(['/v1/features']);
        await vi.advanceTimersByTimeAsync(700);
        await expect(result).resolves.toBe('focused-token');
        expect(mocks.serverFetch.mock.calls.map((call) => call[0])).toEqual(['/v1/features', '/v1/auth/challenge', '/v1/auth']);
    });

    it('keeps Account-bound login fail closed when its feature probe is unavailable', async () => {
        mocks.serverFetch
            .mockRejectedValueOnce(new Error('network unavailable'))
            .mockResolvedValueOnce(jsonResponse({ token: 'must-not-redeem' }));

        await expect(authGetToken(
            new Uint8Array(32),
            { expectedAccountId: 'account-expected' },
        )).rejects.toBeInstanceOf(HappyError);
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
        const profile = await upsertServerProfile({
            serverUrl: 'https://selected.example.test/api',
            name: 'Selected test server',
        });
        await setActiveServerId(profile.id);

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
    ])('fails Account-bound login closed independently of a $name stored-content declaration', async ({
        name,
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

        const login = authGetToken(
            new Uint8Array(32).fill(9),
            { expectedAccountId: 'account-expected' },
        );
        if (name === 'malformed') {
            await expect(login).rejects.toBeInstanceOf(HappyError);
        } else {
            await expect(login).rejects.toThrow(/key-challenge v2 is required/i);
        }
        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
        expect(mocks.serverFetch.mock.calls[0]?.[0])
            .toBe('/v1/features');
    });

    it('refuses a v2 challenge issued by a different Home identity before signing or redeeming', async () => {
        const profile = await upsertServerProfile({
            serverUrl: 'https://selected.example.test/api',
            name: 'Selected test server',
        });
        await setActiveServerId(profile.id);

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
                        // Relayed proof: the reached origin looks right, the Home does not.
                        origin: 'https://selected.example.test',
                        serverIdentityId: 'srv_other_home',
                    },
                }),
            );

        await expect(authGetToken(new Uint8Array(32))).rejects.toMatchObject({
            kind: 'auth',
            code: HOME_IDENTITY_MISMATCH_AUTH_CODE,
        } satisfies Partial<HappyError>);
        expect(mocks.serverFetch.mock.calls.map((call) => call[0])).toEqual([
            '/v1/features',
            '/v1/auth/challenge',
        ]);
    });

    async function prepareAlternateAddressLogin(params: Readonly<{
        serverUrl: string;
        identity: string;
        issuedOrigin: string;
        token: string;
    }>) {
        const profile = await upsertServerProfile({ serverUrl: params.serverUrl, name: 'Home over LAN' });
        await setActiveServerId(profile.id);
        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: { login: { keyChallenge: { enabled: true } } },
                        sharing: { contentKeys: { enabled: false } },
                    },
                    capabilities: keyChallengeV2Capabilities(params.identity),
                }),
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    challengeId: `challenge-${params.identity}`,
                    nonce: `nonce-${params.identity}`,
                    issuedAt: '2026-08-22T12:00:00.000Z',
                    expiresAt: '2026-08-22T12:05:00.000Z',
                    // A Home always binds its own canonical origin, even when this
                    // device reached it over the LAN.
                    audience: { origin: params.issuedOrigin, serverIdentityId: params.identity },
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ token: params.token }));
        return profile;
    }

    it('refuses a first-contact challenge naming another address until the person confirms it', async () => {
        const profile = await prepareAlternateAddressLogin({
            serverUrl: 'http://192.168.2.7:3005',
            identity: 'srv_first_contact',
            issuedOrigin: 'https://first-contact.example.test',
            token: 'must-not-redeem',
        });
        expect(getServerProfileById(profile.id)?.serverIdentityId).toBeUndefined();

        await expect(authGetToken(new Uint8Array(32).fill(5))).rejects.toMatchObject({
            kind: 'auth',
            code: HOME_ADDRESS_MISMATCH_AUTH_CODE,
        } satisfies Partial<HappyError>);
        expect(mocks.serverFetch.mock.calls.map((call) => call[0])).toEqual([
            '/v1/features',
            '/v1/auth/challenge',
        ]);
        expect(boundaries.confirm).toHaveBeenCalledTimes(1);
    });

    it('signs a first-contact alternate address once the person confirms it and pins the identity', async () => {
        boundaries.confirm.mockResolvedValue(true);
        const profile = await prepareAlternateAddressLogin({
            serverUrl: 'http://192.168.1.5:3005',
            identity: 'srv_lan_home',
            issuedOrigin: 'https://home.example.test',
            token: 'lan-home-token',
        });

        await expect(authGetToken(new Uint8Array(32).fill(5))).resolves.toBe('lan-home-token');
        expect(mocks.serverFetch.mock.calls.map((call) => call[0])).toEqual([
            '/v1/features',
            '/v1/auth/challenge',
            '/v1/auth',
        ]);
        expect(boundaries.confirm).toHaveBeenCalledTimes(1);
        expect(getServerProfileById(profile.id)?.serverIdentityId).toBe('srv_lan_home');
    });

    it('still asks at first contact when the contacted endpoint publishes the Home address it claims', async () => {
        // A proxying endpoint can serve the real Home's feature response, descriptor
        // included, so the profile's canonical URL is not a fact it did not choose.
        const profile = await upsertServerProfile({
            serverUrl: 'http://proxy.example.test',
            name: 'Home added by URL',
        });
        await setActiveServerId(profile.id);

        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: { login: { keyChallenge: { enabled: true } } },
                        sharing: { contentKeys: { enabled: false } },
                    },
                    capabilities: keyChallengeV2Capabilities('srv_proxied_home'),
                    homeConnectionDescriptor: {
                        v: 1,
                        homeServerIdentityId: 'srv_proxied_home',
                        canonicalServerUrl: 'https://real-home.example.test',
                        revision: 1,
                        endpoints: [{ kind: 'https', url: 'https://real-home.example.test' }],
                    },
                }),
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    challengeId: 'challenge-proxied',
                    nonce: 'nonce-proxied',
                    issuedAt: '2026-08-22T12:00:00.000Z',
                    expiresAt: '2026-08-22T12:05:00.000Z',
                    audience: {
                        origin: 'https://real-home.example.test',
                        serverIdentityId: 'srv_proxied_home',
                    },
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ token: 'must-not-redeem' }));

        await expect(authGetToken(new Uint8Array(32).fill(5))).rejects.toMatchObject({
            kind: 'auth',
            code: HOME_ADDRESS_MISMATCH_AUTH_CODE,
        } satisfies Partial<HappyError>);
        expect(boundaries.confirm).toHaveBeenCalledTimes(1);
        expect(mocks.serverFetch.mock.calls.map((call) => call[0])).toEqual([
            '/v1/features',
            '/v1/auth/challenge',
        ]);
    });

    it('signs for an established Home answering on another address without asking again', async () => {
        boundaries.getCredentialsForServerUrl.mockResolvedValue({ token: 'stored-token' });
        await prepareAlternateAddressLogin({
            serverUrl: 'http://192.168.3.9:3005',
            identity: 'srv_established_home',
            issuedOrigin: 'https://established.example.test',
            token: 'established-home-token',
        });

        await expect(authGetToken(new Uint8Array(32).fill(5))).resolves.toBe('established-home-token');
        expect(mocks.serverFetch.mock.calls.map((call) => call[0])).toEqual([
            '/v1/features',
            '/v1/auth/challenge',
            '/v1/auth',
        ]);
        expect(boundaries.confirm).not.toHaveBeenCalled();
    });

    it('signs focused v2 authentication for the canonical Home URL instead of its legacy profile alias', async () => {
        const scope = readStorageScopeFromEnv();
        const storage = new MMKV({ id: scopedStorageId('server-profiles', scope) });
        const rawState = JSON.parse(storage.getString('server-state-v1') ?? '{}') as Record<string, unknown>;
        const rawServers = rawState.servers && typeof rawState.servers === 'object'
            ? rawState.servers as Record<string, unknown>
            : {};
        storage.set('server-state-v1', JSON.stringify({
            ...rawState,
            activeServerIdIsExplicit: true,
            activeServerId: 'canonical-audience-home',
            servers: {
                ...rawServers,
                'canonical-audience-home': {
                    id: 'canonical-audience-home',
                    name: 'Canonical audience Home',
                    serverUrl: 'https://legacy-alias.example.test',
                    canonicalServerUrl: 'https://canonical-home.example.test',
                    serverIdentityId: 'srv_canonical_home',
                    createdAt: 1,
                    updatedAt: 1,
                    lastUsedAt: 1,
                    source: 'legacy',
                },
            },
        }));
        await setActiveServerId('canonical-audience-home');

        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: { login: { keyChallenge: { enabled: true } } },
                        sharing: { contentKeys: { enabled: false } },
                    },
                    capabilities: keyChallengeV2Capabilities('srv_canonical_home'),
                }),
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    challengeId: 'challenge-canonical-home',
                    nonce: 'nonce-canonical-home',
                    issuedAt: '2026-08-22T12:00:00.000Z',
                    expiresAt: '2026-08-22T12:05:00.000Z',
                    audience: {
                        origin: 'https://canonical-home.example.test',
                        serverIdentityId: 'srv_canonical_home',
                    },
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ token: 'canonical-home-token' }));

        await expect(authGetToken(new Uint8Array(32).fill(4))).resolves.toBe('canonical-home-token');
        expect(mocks.serverFetch.mock.calls.map((call) => call[0])).toEqual([
            '/v1/features',
            '/v1/auth/challenge',
            '/v1/auth',
        ]);
    });

    it("refreshes a cached v1 capability snapshot before ordinary login can select the auth assertion", async () => {
        const profile = await upsertServerProfile({
            serverUrl: "https://fresh-probe.example.test",
            name: "Fresh-probe server",
        });
        await setActiveServerId(profile.id);

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
            .mockResolvedValueOnce(jsonResponse({ token: "legacy-token" }));
        await expect(authGetToken(new Uint8Array(32).fill(3))).resolves.toBe("legacy-token");

        mocks.serverFetch.mockReset();
        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: { login: { keyChallenge: { enabled: true } } },
                        sharing: { contentKeys: { enabled: false } },
                    },
                    capabilities: keyChallengeV2Capabilities("srv_fresh_probe"),
                }),
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    challengeId: "challenge-fresh-probe",
                    nonce: "nonce-fresh-probe",
                    issuedAt: "2026-08-22T12:00:00.000Z",
                    expiresAt: "2026-08-22T12:05:00.000Z",
                    audience: {
                        origin: "https://fresh-probe.example.test",
                        serverIdentityId: "srv_fresh_probe",
                    },
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ token: "v2-token" }));

        await expect(authGetToken(new Uint8Array(32).fill(3))).resolves.toBe("v2-token");
        expect(mocks.serverFetch.mock.calls.map((call) => call[0])).toEqual([
            "/v1/features",
            "/v1/auth/challenge",
            "/v1/auth",
        ]);
    });

    it('redeems a negotiated v2 challenge without sending the legacy assertion', async () => {
        const profile = await upsertServerProfile({
            serverUrl: 'https://selected.example.test/api',
            name: 'Selected test server',
        });
        await setActiveServerId(profile.id);

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
