import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { encodeBase64 } from '@/encryption/base64';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { adoptHomeProfile, resetServerProfilesRuntimeForTests } from '@/sync/domains/server/serverProfiles';
import { HappyError } from '@/utils/errors/errors';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { HOME_IDENTITY_MISMATCH_AUTH_CODE } from './authenticationFailure';
import type { AuthGetTokenAtEndpointParams } from './getToken';
import { Modal } from '@/modal';

installTokenStorageWebPlatformMocks();

const runtimeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
    get runtimeFetchManualResponse() { return this.runtimeFetch; },
}));
// The address-trust decision asks the person; their answer is the boundary.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// The modal testkit's own spy; re-armed per test because `vi.restoreAllMocks()` resets every vi.fn.
const confirmBoundary = vi.mocked(Modal.confirm);

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

let restoreStorage: () => void;
let restoreLocks: () => void;
let focusedSnapshot: ReturnType<typeof getActiveServerSnapshot>;
beforeEach(async () => {
    restoreStorage = installLocalStorageMock().restore;
    restoreLocks = installWebLockManagerMock().restore;
    runtimeFetchMock.mockResolvedValue(jsonResponse({}, 404));
    confirmBoundary.mockReset();
    confirmBoundary.mockResolvedValue(false);
    resetServerProfilesRuntimeForTests();
    await upsertAndActivateServer({ serverUrl: 'https://focused.example.test', scope: 'device' });
    focusedSnapshot = getActiveServerSnapshot();
    runtimeFetchMock.mockClear();
});
afterEach(() => {
    vi.useRealTimers();
    runtimeFetchMock.mockReset();
    vi.restoreAllMocks();
    restoreLocks();
    restoreStorage();
});

describe('explicit endpoint authentication foundations', () => {
    it.each([
        { name: 'identity-pinned (require v2)', serverIdentityId: 'srv_slow_home', requireKeyChallengeV2: true, wire: ['/v1/auth/challenge', '/v1/auth'] },
        { name: 'identity-pinned (v2 optional)', serverIdentityId: 'srv_slow_home', requireKeyChallengeV2: false, wire: ['/v1/auth/challenge', '/v1/auth'] },
        { name: 'unbound', serverIdentityId: undefined, requireKeyChallengeV2: false, wire: ['/v1/auth'] },
    ])('waits for a slow $name endpoint observation before choosing the authentication wire version', async ({ serverIdentityId, requireKeyChallengeV2, wire }) => {
        const { authGetTokenAtEndpoint } = await import('./getToken');
        vi.useFakeTimers();
        const paths: string[] = [];
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input);
            paths.push(new URL(url).pathname);
            if (url.endsWith('/v1/features')) {
                await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
                return jsonResponse(serverIdentityId
                    ? createRootLayoutFeaturesResponse({ capabilities: keyChallengeV2Capabilities(serverIdentityId) })
                    : { features: {}, capabilities: {} });
            }
            if (url.endsWith('/v1/auth/challenge')) return jsonResponse({
                challengeId: 'slow-challenge', nonce: 'nonce',
                issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
                audience: { origin: 'https://slow.example.test', serverIdentityId: 'srv_slow_home' },
            });
            if (url.endsWith('/v1/auth')) return jsonResponse({ token: 'slow-home-token' });
            throw new Error(`Unexpected request: ${url}`);
        });
        let settled = false;
        const result = authGetTokenAtEndpoint({
            endpointUrl: 'https://slow.example.test', ...(serverIdentityId ? { serverIdentityId } : {}),
            secret: new Uint8Array(32).fill(7), requireKeyChallengeV2,
        }).then((credentials) => { settled = true; return credentials; }, (error: unknown) => {
            settled = true;
            return error;
        });
        await vi.dynamicImportSettled();
        await vi.advanceTimersByTimeAsync(800);
        expect(settled).toBe(false);
        expect(paths).toEqual(['/v1/features']);
        await vi.advanceTimersByTimeAsync(700);
        await expect(result).resolves.toEqual({ token: 'slow-home-token' });
        expect(paths).toEqual(['/v1/features', ...wire]);
        const authInit = runtimeFetchMock.mock.calls.find(([input]) => String(input).endsWith('/v1/auth'))?.[1] as RequestInit;
        const authBody = JSON.parse(String(authInit.body)) as Record<string, unknown>;
        expect(authBody).toHaveProperty(serverIdentityId ? 'challengeId' : 'challenge');
        expect(authBody).not.toHaveProperty(serverIdentityId ? 'challenge' : 'challengeId');
    });

    it('repairs retained 0.2 secret credentials during focused Account currentness without a restore action', async () => {
        const token = 'header.eyJzdWIiOiJhY2NvdW50LTEifQ.signature';
        const credentials = { token, secret: encodeBase64(new Uint8Array(32).fill(7)) };
        await TokenStorage.setCredentialsForServerUrl(focusedSnapshot.serverUrl, { serverId: focusedSnapshot.serverId }, credentials);
        const readCredentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
        let repaired = false;
        const request = vi.fn(async () => jsonResponse(repaired
            ? { mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content', updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } }
            : { error: 'migration-required', recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' } },
        repaired ? 200 : 400));
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/v1/auth/ping')) return jsonResponse({ ok: true });
            if (url.endsWith('/v1/account/encryption/currentness')) return request();
            if (url.endsWith('/v1/features')) return jsonResponse({ features: {}, capabilities: keyChallengeV2Capabilities('srv_home') });
            if (url.endsWith('/v1/auth/challenge')) return jsonResponse({
                challengeId: 'challenge-retained', nonce: 'nonce-retained',
                issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
                audience: { origin: 'https://focused.example.test', serverIdentityId: 'srv_home' },
            });
            if (url.endsWith('/v1/auth')) {
                expect(JSON.parse(String(init?.body))).toMatchObject({
                    requireExistingAccount: true,
                    contentPublicKey: expect.any(String),
                    contentPublicKeySig: expect.any(String),
                });
                repaired = true;
                return jsonResponse({ token });
            }
            throw new Error(`Unexpected test request: ${url}`);
        });
        const { fetchAccountEncryptionCurrentness } = await import('@/sync/api/account/apiAccountEncryptionMode');
        // Only the focused request owner can authorize retained-credential recovery;
        // an explicitly captured transport must not borrow active Home authority.
        const result = await fetchAccountEncryptionCurrentness(credentials).catch((error: unknown) => error);
        expect(readCredentials).toHaveBeenCalledWith('https://focused.example.test', { serverId: focusedSnapshot.serverId });
        expect(runtimeFetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
            'https://focused.example.test/v1/auth/ping',
            'https://focused.example.test/v1/account/encryption/currentness',
            'https://focused.example.test/v1/features',
            'https://focused.example.test/v1/auth/challenge',
            'https://focused.example.test/v1/auth',
            'https://focused.example.test/v1/account/encryption/currentness',
        ]);
        expect(result).toMatchObject({ mode: 'e2ee' });
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('does not redeem when the captured authentication flow retires during challenge issuance', async () => {
        let current = true;
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/v1/features')) return jsonResponse({ features: {}, capabilities: keyChallengeV2Capabilities('srv_home_b') });
            if (url.endsWith('/v1/auth/challenge')) {
                current = false;
                return jsonResponse({
                    challengeId: 'retired-challenge', nonce: 'nonce',
                    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    audience: { origin: 'https://home-b.example.test', serverIdentityId: 'srv_home_b' },
                });
            }
            return jsonResponse({ token: 'must-not-mint' });
        });
        const { authGetTokenAtEndpoint } = await import('./getToken');
        await expect(authGetTokenAtEndpoint({
            endpointUrl: 'https://home-b.example.test', serverIdentityId: 'srv_home_b',
            secret: new Uint8Array(32).fill(7), requireKeyChallengeV2: true,
            isCurrent: () => current,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(runtimeFetchMock.mock.calls.map(([url]) => String(url))).not.toContain('https://home-b.example.test/v1/auth');
    });

    it('signs a scanned descriptor address at first contact without asking, even from a loopback endpoint', async () => {
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/v1/features')) {
                return jsonResponse({ features: {}, capabilities: keyChallengeV2Capabilities('srv_qr_home') });
            }
            if (url.endsWith('/v1/auth/challenge')) {
                return jsonResponse({
                    challengeId: 'challenge-qr', nonce: 'nonce-qr',
                    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    audience: { origin: 'https://qr-home.example.test', serverIdentityId: 'srv_qr_home' },
                });
            }
            return jsonResponse({ token: 'qr-home-token' });
        });

        const { authGetTokenAtEndpoint } = await import('./getToken');
        await expect(authGetTokenAtEndpoint({
            endpointUrl: 'http://127.0.0.1:4310',
            // Out of band: this canonical URL arrived with the scanned descriptor,
            // not from the endpoint being contacted.
            addressAnchorUrl: 'https://qr-home.example.test',
            canonicalServerUrl: 'https://qr-home.example.test',
            serverIdentityId: 'srv_qr_home',
            secret: new Uint8Array(32).fill(3),
            requireKeyChallengeV2: true,
        })).resolves.toMatchObject({ token: 'qr-home-token' });
        expect(confirmBoundary).not.toHaveBeenCalled();
    });

    it('asks before signing a first-contact address that only the caller-supplied canonical URL vouches for', async () => {
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/v1/features')) {
                return jsonResponse({ features: {}, capabilities: keyChallengeV2Capabilities('srv_unanchored_home') });
            }
            if (url.endsWith('/v1/auth/challenge')) {
                return jsonResponse({
                    challengeId: 'challenge-unanchored', nonce: 'nonce-unanchored',
                    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    audience: { origin: 'https://unanchored-home.example.test', serverIdentityId: 'srv_unanchored_home' },
                });
            }
            return jsonResponse({ token: 'must-not-redeem' });
        });

        const { authGetTokenAtEndpoint } = await import('./getToken');
        // No out-of-band anchor: a canonical URL the flow read back from profile
        // state is not a fact the contacted endpoint could not have supplied.
        await expect(authGetTokenAtEndpoint({
            endpointUrl: 'http://127.0.0.1:4311',
            canonicalServerUrl: 'https://unanchored-home.example.test',
            serverIdentityId: 'srv_unanchored_home',
            secret: new Uint8Array(32).fill(4),
            requireKeyChallengeV2: true,
        })).rejects.toMatchObject({ kind: 'auth', code: 'home-address-mismatch' });
        expect(confirmBoundary).toHaveBeenCalledTimes(1);
        expect(runtimeFetchMock.mock.calls.map(([url]) => String(url)))
            .not.toContain('http://127.0.0.1:4311/v1/auth');
    });

    it('authenticates at an explicit endpoint while signing the stable canonical audience', async () => {
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/v1/features')) {
                return jsonResponse({
                    features: {},
                    capabilities: keyChallengeV2Capabilities('srv_home_b'),
                });
            }
            if (url.endsWith('/health')) {
                return jsonResponse({ status: 'ok' });
            }
            if (url.endsWith('/v1/auth/challenge')) {
                return jsonResponse({
                    challengeId: 'challenge-home-b',
                    nonce: 'nonce-home-b',
                    issuedAt: '2026-08-22T12:00:00.000Z',
                    expiresAt: '2026-08-22T12:05:00.000Z',
                    audience: {
                        origin: 'https://home-b.example.test',
                        serverIdentityId: 'srv_home_b',
                    },
                });
            }
            if (url.endsWith('/v1/auth')) {
                return jsonResponse({ token: 'home-b-token' });
            }
            throw new Error(`Unexpected test request: ${url}`);
        });

        const { authGetTokenAtEndpoint } = await import('./getToken');
        await expect(authGetTokenAtEndpoint({
            endpointUrl: 'https://home-b.example.test/api',
            canonicalServerUrl: 'https://home-b.example.test/api',
            serverIdentityId: 'srv_home_b',
            secret: new Uint8Array(32).fill(7),
            requireKeyChallengeV2: true,
            requireExistingAccount: true,
        })).resolves.toEqual({ token: 'home-b-token' });
        expect(runtimeFetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
            'https://home-b.example.test/api/v1/features',
            'https://home-b.example.test/api/v1/auth/challenge',
            'https://home-b.example.test/api/v1/auth',
        ]);
        const authInit = runtimeFetchMock.mock.calls[2]?.[1] as RequestInit;
        const authBody = JSON.parse(String(authInit.body)) as Record<string, unknown>;
        expect(authBody).toMatchObject({
            challengeId: 'challenge-home-b',
            publicKey: expect.any(String),
            signature: expect.any(String),
            requireExistingAccount: true,
            contentPublicKey: expect.any(String),
            contentPublicKeySig: expect.any(String),
        });
        expect(authBody).not.toHaveProperty('challenge');
        expect(getActiveServerSnapshot()).toEqual(focusedSnapshot);
    });

    it('offers a signed content binding on ordinary v2 secret-key sign-in even without content-key sharing', async () => {
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/v1/features')) {
                return jsonResponse({ features: {}, capabilities: keyChallengeV2Capabilities('srv_home_b') });
            }
            if (url.endsWith('/health')) return jsonResponse({ status: 'ok' });
            if (url.endsWith('/v1/auth/challenge')) {
                return jsonResponse({
                    challengeId: 'challenge-ordinary',
                    nonce: 'nonce-ordinary',
                    issuedAt: '2026-08-22T12:00:00.000Z',
                    expiresAt: '2026-08-22T12:05:00.000Z',
                    audience: { origin: 'https://home-b.example.test', serverIdentityId: 'srv_home_b' },
                });
            }
            if (url.endsWith('/v1/auth')) return jsonResponse({ token: 'home-b-token' });
            throw new Error(`Unexpected test request: ${url}`);
        });

        const { authGetTokenAtEndpoint } = await import('./getToken');
        await expect(authGetTokenAtEndpoint({
            endpointUrl: 'https://home-b.example.test/api',
            canonicalServerUrl: 'https://home-b.example.test/api',
            serverIdentityId: 'srv_home_b',
            secret: new Uint8Array(32).fill(7),
            requireKeyChallengeV2: true,
        })).resolves.toEqual({ token: 'home-b-token' });
        const authInit = runtimeFetchMock.mock.calls.find((call) => String(call[0]).endsWith('/v1/auth'))?.[1] as RequestInit;
        expect(JSON.parse(String(authInit.body))).toMatchObject({
            contentPublicKey: expect.any(String),
            contentPublicKeySig: expect.any(String),
        });
    });

    it('uses the dedicated v2-only Account Directory key routes for a restricted credential target', async () => {
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/v1/features')) {
                return jsonResponse({
                    features: {},
                    capabilities: keyChallengeV2Capabilities('srv_directory'),
                });
            }
            if (url.endsWith('/health')) {
                return jsonResponse({ status: 'ok' });
            }
            if (url.endsWith('/v1/auth/account-directory/challenge')) {
                return jsonResponse({
                    challengeId: 'account-directory:challenge-1',
                    nonce: 'nonce-directory',
                    issuedAt: '2026-08-22T12:00:00.000Z',
                    expiresAt: '2026-08-22T12:05:00.000Z',
                    audience: {
                        origin: 'https://accounts.example.test',
                        serverIdentityId: 'srv_directory',
                    },
                });
            }
            if (url.endsWith('/v1/auth/account-directory')) {
                return jsonResponse({ token: 'restricted-directory-token' });
            }
            throw new Error(`Unexpected test request: ${url}`);
        });

        const { authGetTokenAtEndpoint } = await import('./getToken');
        await expect(authGetTokenAtEndpoint({
            endpointUrl: 'https://accounts.example.test',
            canonicalServerUrl: 'https://accounts.example.test',
            serverIdentityId: 'srv_directory',
            secret: new Uint8Array(32).fill(9),
            requireKeyChallengeV2: true,
            credentialTarget: 'account_directory',
        })).resolves.toEqual({ token: 'restricted-directory-token' });

        expect(runtimeFetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
            'https://accounts.example.test/v1/features',
            'https://accounts.example.test/v1/auth/account-directory/challenge',
            'https://accounts.example.test/v1/auth/account-directory',
        ]);
        expect(getActiveServerSnapshot()).toEqual(focusedSnapshot);
    });

    it('reuses an already verified Account Service discovery snapshot instead of probing twice', async () => {
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/v1/auth/account-directory/challenge')) {
                return jsonResponse({
                    challengeId: 'account-directory:challenge-discovered',
                    nonce: 'nonce-directory',
                    issuedAt: '2026-08-22T12:00:00.000Z',
                    expiresAt: '2026-08-22T12:05:00.000Z',
                    audience: {
                        origin: 'https://accounts.example.test',
                        serverIdentityId: 'srv_directory',
                    },
                });
            }
            if (url.endsWith('/v1/auth/account-directory')) {
                return jsonResponse({ token: 'restricted-directory-token' });
            }
            throw new Error(`Unexpected test request: ${url}`);
        });

        const { authGetTokenAtEndpoint } = await import('./getToken');
        await expect(authGetTokenAtEndpoint({
            endpointUrl: 'https://accounts.example.test',
            canonicalServerUrl: 'https://accounts.example.test',
            serverIdentityId: 'srv_directory',
            secret: new Uint8Array(32).fill(9),
            requireKeyChallengeV2: true,
            credentialTarget: 'account_directory',
            verifiedServerFeaturesSnapshot: {
                status: 'ready',
                serverIdentityId: 'srv_directory',
                features: createRootLayoutFeaturesResponse({
                    capabilities: keyChallengeV2Capabilities('srv_directory'),
                }),
            },
        })).resolves.toEqual({ token: 'restricted-directory-token' });

        expect(runtimeFetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
            'https://accounts.example.test/v1/auth/account-directory/challenge',
            'https://accounts.example.test/v1/auth/account-directory',
        ]);
    });

    it('authenticates through a semantic Iroh carrier while signing the canonical Home audience', async () => {
        const carrierRequest = vi.fn(async (url: string) => {
            if (url.endsWith('/v1/features')) return jsonResponse({
                features: {},
                capabilities: keyChallengeV2Capabilities('srv_iroh_home'),
            });
            if (url.endsWith('/health')) return jsonResponse({ status: 'ok' });
            if (url.endsWith('/v1/auth/challenge')) return jsonResponse({
                challengeId: 'challenge-iroh',
                nonce: 'nonce-iroh',
                issuedAt: new Date(Date.now() - 1_000).toISOString(),
                expiresAt: new Date(Date.now() + 300_000).toISOString(),
                audience: {
                    origin: 'https://canonical-iroh-home.example.test',
                    serverIdentityId: 'srv_iroh_home',
                },
            });
            if (url.endsWith('/v1/auth')) return jsonResponse({ token: 'iroh-home-token' });
            throw new Error(`Unexpected carrier request: ${url}`);
        });
        const { authGetTokenAtEndpoint } = await import('./getToken');

        await expect(authGetTokenAtEndpoint({
            endpointUrl: 'https://canonical-iroh-home.example.test',
            canonicalServerUrl: 'https://canonical-iroh-home.example.test',
            serverIdentityId: 'srv_iroh_home',
            homeCarrier: {
                endpointId: 'a'.repeat(64),
                readObservedPath: () => 'relay',
                request: carrierRequest,
                createWebSocket: () => ({}),
            },
            secret: new Uint8Array(32).fill(5),
            requireKeyChallengeV2: true,
        })).resolves.toEqual({ token: 'iroh-home-token' });

        expect(carrierRequest.mock.calls.map(([url]) => url)).toEqual([
            'https://canonical-iroh-home.example.test/v1/features',
            'https://canonical-iroh-home.example.test/v1/auth/challenge',
            'https://canonical-iroh-home.example.test/v1/auth',
        ]);
        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it.each([true, false])('keeps identity-pinned authentication fail closed when feature discovery is unavailable (require v2: %s)', async (requireKeyChallengeV2) => {
        runtimeFetchMock.mockRejectedValue(new Error('feature endpoint unavailable'));

        const { authGetTokenAtEndpoint } = await import('./getToken');
        await expect(authGetTokenAtEndpoint({
            endpointUrl: 'https://home-b.example.test',
            canonicalServerUrl: 'https://home-b.example.test',
            serverIdentityId: 'srv_home_b',
            secret: new Uint8Array(32).fill(7),
            requireKeyChallengeV2,
        })).rejects.toMatchObject({
            name: 'HappyError',
            canTryAgain: true,
        });

        expect(runtimeFetchMock.mock.calls.map((call) => String(call[0]))).not.toContain(
            'https://home-b.example.test/v1/auth',
        );
        expect(getActiveServerSnapshot()).toEqual(focusedSnapshot);
    });

    it('rejects an endpoint whose observed identity does not match the expected Home before authentication', async () => {
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/v1/features')) {
                return jsonResponse({
                features: {},
                capabilities: {
                    serverIdentity: { serverIdentityId: 'srv_other_home' },
                },
                });
            }
            if (url.endsWith('/health')) return jsonResponse({ status: 'ok' });
            return jsonResponse({ token: 'must-not-authenticate' });
        });

        const { authGetTokenAtEndpoint } = await import('./getToken');
        await expect(authGetTokenAtEndpoint({
            endpointUrl: 'https://home-b.example.test',
            serverIdentityId: 'srv_home_b',
            secret: new Uint8Array(32).fill(7),
            requireKeyChallengeV2: false,
        })).rejects.toMatchObject({
            name: 'HappyError',
            kind: 'auth',
            canTryAgain: false,
        });

        const requestedUrls = runtimeFetchMock.mock.calls.map((call) => String(call[0]));
        expect(requestedUrls).toContain('https://home-b.example.test/v1/features');
        expect(requestedUrls).not.toContain('https://home-b.example.test/v1/auth/challenge');
        expect(requestedUrls).not.toContain('https://home-b.example.test/v1/auth');
        expect(getActiveServerSnapshot()).toEqual(focusedSnapshot);
    });
});

describe('key-challenge negotiation, typed failures and address trust at an explicit endpoint', () => {
    const homeOrigin = 'https://negotiation.example.test';
    const keyChallengeEnabled = { auth: { login: { keyChallenge: { enabled: true } } }, sharing: { contentKeys: { enabled: false } } };
    const accountBoundFeatures = { auth: { login: { keyChallenge: { enabled: true } } }, sharing: { contentKeys: { enabled: true } } };
    const currentStoredContentDeclaration = {
        v: 1,
        minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
        currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
        declarationTransport: 'http-header-and-socket-auth-v1',
    };
    type Route = (init?: RequestInit) => Response | Promise<Response>;

    /** One Home's network boundary: every request must reach `origin` and a declared path. */
    function serve(routes: Record<string, Route>, origin = homeOrigin) {
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            if (url.origin !== origin) throw new Error(`Unexpected origin: ${url}`);
            if (url.pathname === '/health') return jsonResponse({ status: 'ok' });
            const route = routes[url.pathname];
            if (!route) throw new Error(`Unexpected request: ${url}`);
            return await route(init);
        });
    }
    function requestedPaths(): string[] {
        return runtimeFetchMock.mock.calls
            .map(([input]) => new URL(String(input)).pathname)
            .filter((path) => path !== '/health');
    }
    function requestBody(path: string): Record<string, unknown> {
        const call = runtimeFetchMock.mock.calls.find(([input]) => new URL(String(input)).pathname === path);
        return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>;
    }
    function issuedChallenge(audience: Readonly<{ origin: string; serverIdentityId: string }>): Response {
        return jsonResponse({
            challengeId: `challenge-${audience.serverIdentityId}`, nonce: `nonce-${audience.serverIdentityId}`,
            issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
            audience,
        });
    }
    async function authenticate(params: Partial<AuthGetTokenAtEndpointParams> = {}) {
        const { authGetTokenAtEndpoint } = await import('./getToken');
        return await authGetTokenAtEndpoint({
            endpointUrl: homeOrigin, secret: new Uint8Array(32).fill(9), requireKeyChallengeV2: false, ...params,
        });
    }

    it('fails fast when the Home disables key-challenge login', async () => {
        serve({ '/v1/features': () => jsonResponse({ features: { auth: { login: { keyChallenge: { enabled: false } } } }, capabilities: {} }) });
        await expect(authenticate()).rejects.toThrow(/key-challenge login is disabled/i);
        expect(requestedPaths()).toEqual(['/v1/features']);
    });

    it.each([
        {
            name: 'does not advertise the key-challenge gate (legacy Home)',
            features: {
                auth: { recovery: { providerReset: { enabled: false } }, ui: { recoveryKeyReminder: { enabled: true } } },
                sharing: { contentKeys: { enabled: false } },
            },
        },
        { name: 'enables key-challenge login without the v2 capability', features: keyChallengeEnabled },
    ])('continues with released v1 login when the Home $name', async ({ features }) => {
        serve({
            '/v1/features': () => jsonResponse({ features, capabilities: {} }),
            '/v1/auth': () => jsonResponse({ token: 'released-v1-token' }),
        });
        await expect(authenticate()).resolves.toEqual({ token: 'released-v1-token' });
        expect(requestedPaths()).toEqual(['/v1/features', '/v1/auth']);
        expect(requestBody('/v1/auth')).toHaveProperty('challenge');
        expect(requestBody('/v1/auth')).not.toHaveProperty('challengeId');
    });

    it('refreshes a cached v1 observation of the endpoint before choosing the login assertion', async () => {
        serve({
            '/v1/features': () => jsonResponse({ features: keyChallengeEnabled, capabilities: {} }),
            '/v1/auth': () => jsonResponse({ token: 'released-v1-token' }),
        });
        await expect(authenticate()).resolves.toEqual({ token: 'released-v1-token' });
        runtimeFetchMock.mockClear();
        // The Home upgraded since the cached observation; login must not sign the released v1 shape.
        serve({
            '/v1/features': () => jsonResponse({ features: keyChallengeEnabled, capabilities: keyChallengeV2Capabilities('srv_upgraded') }),
            '/v1/auth/challenge': () => issuedChallenge({ origin: homeOrigin, serverIdentityId: 'srv_upgraded' }),
            '/v1/auth': () => jsonResponse({ token: 'v2-token' }),
        });
        await expect(authenticate()).resolves.toEqual({ token: 'v2-token' });
        expect(requestedPaths()).toEqual(['/v1/features', '/v1/auth/challenge', '/v1/auth']);
        expect(requestBody('/v1/auth')).toMatchObject({ challengeId: 'challenge-srv_upgraded' });
        expect(requestBody('/v1/auth')).not.toHaveProperty('challenge');
    });

    it.each([
        { name: 'network failure', features: (): Response => { throw new TypeError('network unavailable'); } },
        { name: 'server failure', features: () => new Response('unavailable', { status: 503 }) },
        { name: 'malformed response', features: () => new Response('not-json', { headers: { 'Content-Type': 'application/json' } }) },
        { name: 'missing endpoint', features: () => new Response(null, { status: 404 }) },
    ])('uses the released v1 request shape when an ordinary unbound Home feature probe has a $name', async ({ features }) => {
        serve({ '/v1/features': features, '/v1/auth': () => jsonResponse({ token: 'released-v1-token' }) });
        await expect(authenticate()).resolves.toEqual({ token: 'released-v1-token' });
        expect(requestedPaths()).toEqual(['/v1/features', '/v1/auth']);
        const body = requestBody('/v1/auth');
        expect(body).toMatchObject({ challenge: expect.any(String), publicKey: expect.any(String), signature: expect.any(String) });
        expect(body).not.toHaveProperty('challengeId');
        expect(body).not.toHaveProperty('contentPublicKey');
    });

    it.each([
        {
            name: 'preserves a recognized signup policy error',
            response: () => jsonResponse({ error: 'signup-disabled' }, 403),
            failure: { code: 'signup-disabled', status: 403, kind: 'auth', canTryAgain: false },
        },
        {
            name: 'does not promote an unknown JSON error code into the typed auth contract',
            response: () => jsonResponse({ error: 'signup-disable' }, 403),
            failure: { code: undefined, status: 403, kind: 'auth', canTryAgain: false },
        },
        {
            name: 'classifies a non-JSON server failure as retryable without inventing an auth code',
            response: () => new Response('relay failure', { status: 500 }),
            failure: { code: undefined, status: 500, kind: 'server', canTryAgain: true },
        },
    ])('$name from the auth endpoint', async ({ response, failure }) => {
        serve({ '/v1/features': () => jsonResponse({ features: keyChallengeEnabled, capabilities: {} }), '/v1/auth': response });
        await expect(authenticate()).rejects.toMatchObject({ name: 'HappyError', ...failure });
    });

    it('sends the signed expected Account id through negotiated v2 Account-bound login', async () => {
        serve({
            '/v1/features': () => jsonResponse({
                features: accountBoundFeatures,
                capabilities: { ...keyChallengeV2Capabilities('srv_selected'), accountStoredContentCompatibility: currentStoredContentDeclaration },
            }),
            '/v1/auth/challenge': () => issuedChallenge({ origin: homeOrigin, serverIdentityId: 'srv_selected' }),
            '/v1/auth': () => jsonResponse({ token: 'recovery-token' }),
        });
        await expect(authenticate({ serverIdentityId: 'srv_selected', expectedAccountId: 'account-expected', requireKeyChallengeV2: true }))
            .resolves.toEqual({ token: 'recovery-token' });
        expect(requestBody('/v1/auth/challenge')).toEqual({ expectedAccountId: 'account-expected' });
        const body = requestBody('/v1/auth');
        expect(body).toMatchObject({
            expectedAccountId: 'account-expected',
            challengeId: 'challenge-srv_selected',
            publicKey: expect.any(String),
            signature: expect.any(String),
            contentPublicKey: expect.any(String),
            contentPublicKeySig: expect.any(String),
        });
        expect(body).not.toHaveProperty('challenge');
    });

    it.each([
        { name: 'current', declaration: currentStoredContentDeclaration },
        { name: 'missing', declaration: undefined },
        {
            name: 'pre-current',
            declaration: { v: 1, minimumProtocolVersion: 1, currentProtocolVersion: 1, declarationTransport: 'http-header-and-socket-auth-v1' },
        },
    ])('does not fall back to v1 for Account-bound login when a ready Home with a $name stored-content declaration lacks the v2 capability', async ({ declaration }) => {
        serve({
            '/v1/features': () => jsonResponse({
                features: accountBoundFeatures,
                capabilities: declaration ? { accountStoredContentCompatibility: declaration } : {},
            }),
            '/v1/auth': () => jsonResponse({ token: 'must-not-redeem' }),
        });
        await expect(authenticate({ expectedAccountId: 'account-expected', requireKeyChallengeV2: true }))
            .rejects.toThrow(/key-challenge v2 is required/i);
        expect(requestedPaths()).toEqual(['/v1/features']);
    });

    it('fails Account-bound login closed when the Home publishes a malformed stored-content declaration', async () => {
        serve({
            '/v1/features': () => jsonResponse({
                features: accountBoundFeatures,
                capabilities: {
                    accountStoredContentCompatibility: {
                        v: 1, minimumProtocolVersion: 2, currentProtocolVersion: 'not-a-version',
                        declarationTransport: 'http-header-and-socket-auth-v1',
                    },
                },
            }),
            '/v1/auth': () => jsonResponse({ token: 'must-not-redeem' }),
        });
        await expect(authenticate({ expectedAccountId: 'account-expected', requireKeyChallengeV2: true }))
            .rejects.toBeInstanceOf(HappyError);
        expect(requestedPaths()).toEqual(['/v1/features']);
    });

    it('refuses a v2 challenge issued by a different Home identity before signing or redeeming', async () => {
        serve({
            '/v1/features': () => jsonResponse({ features: keyChallengeEnabled, capabilities: keyChallengeV2Capabilities('srv_selected') }),
            // Relayed proof: the reached origin looks right, the Home does not.
            '/v1/auth/challenge': () => issuedChallenge({ origin: homeOrigin, serverIdentityId: 'srv_other_home' }),
            '/v1/auth': () => jsonResponse({ token: 'must-not-redeem' }),
        });
        await expect(authenticate({ serverIdentityId: 'srv_selected' })).rejects.toMatchObject({
            kind: 'auth',
            code: HOME_IDENTITY_MISMATCH_AUTH_CODE,
        });
        expect(requestedPaths()).toEqual(['/v1/features', '/v1/auth/challenge']);
    });

    it('signs a first-contact alternate address once the person confirms it', async () => {
        confirmBoundary.mockResolvedValue(true);
        const lanEndpoint = 'http://192.168.1.5:3005';
        serve({
            '/v1/features': () => jsonResponse({ features: keyChallengeEnabled, capabilities: keyChallengeV2Capabilities('srv_lan_home') }),
            // A Home always binds its own canonical origin, even when this device reached it over the LAN.
            '/v1/auth/challenge': () => issuedChallenge({ origin: 'https://home.example.test', serverIdentityId: 'srv_lan_home' }),
            '/v1/auth': () => jsonResponse({ token: 'lan-home-token' }),
        }, lanEndpoint);
        await expect(authenticate({ endpointUrl: lanEndpoint, serverIdentityId: 'srv_lan_home' }))
            .resolves.toEqual({ token: 'lan-home-token' });
        expect(requestedPaths()).toEqual(['/v1/features', '/v1/auth/challenge', '/v1/auth']);
        expect(confirmBoundary).toHaveBeenCalledTimes(1);
    });

    it('signs for an established Home answering on another address without asking again', async () => {
        const profile = await adoptHomeProfile({
            descriptor: {
                v: 1, homeServerIdentityId: 'srv_established_home', canonicalServerUrl: 'https://established.example.test', revision: 1,
                endpoints: [{ kind: 'https', url: 'https://established.example.test' }],
            },
            source: 'qr',
            descriptorAuthority: 'advisory',
        });
        // A credential stored for this identity is the record of a completed authentication.
        await TokenStorage.setCredentialsForServerUrl(
            profile.canonicalServerUrl ?? profile.serverUrl,
            { serverId: 'srv_established_home' },
            { token: 'stored-token', secret: encodeBase64(new Uint8Array(32).fill(5)) },
        );
        const lanEndpoint = 'http://192.168.3.9:3005';
        serve({
            '/v1/features': () => jsonResponse({ features: keyChallengeEnabled, capabilities: keyChallengeV2Capabilities('srv_established_home') }),
            '/v1/auth/challenge': () => issuedChallenge({ origin: 'https://established.example.test', serverIdentityId: 'srv_established_home' }),
            '/v1/auth': () => jsonResponse({ token: 'established-home-token' }),
        }, lanEndpoint);
        await expect(authenticate({ endpointUrl: lanEndpoint, serverIdentityId: 'srv_established_home' }))
            .resolves.toEqual({ token: 'established-home-token' });
        expect(requestedPaths()).toEqual(['/v1/features', '/v1/auth/challenge', '/v1/auth']);
        expect(confirmBoundary).not.toHaveBeenCalled();
    });

    it.each([
        { name: 'features of an identity-pinned Home', phase: 'features', serverIdentityId: 'srv_cancelled_home' },
        // Cancellation must never turn into a released-v1 redeem for an unbound Home.
        { name: 'features of an unbound Home', phase: 'features', serverIdentityId: undefined },
        { name: 'auth', phase: 'auth', serverIdentityId: 'srv_cancelled_home' },
    ] as const)('cancels key authentication during $name without accepting a late response', async ({ phase, serverIdentityId }) => {
        let releaseHeld!: (response: Response) => void;
        const held = new Promise<Response>((resolve) => { releaseHeld = resolve; });
        let heldSignal: AbortSignal | null | undefined;
        let arrived = false;
        const hold: Route = async (init) => {
            heldSignal = init?.signal;
            arrived = true;
            return await held;
        };
        const features = () => jsonResponse(createRootLayoutFeaturesResponse({ capabilities: keyChallengeV2Capabilities('srv_cancelled_home') }));
        serve({
            '/v1/features': phase === 'features' ? hold : features,
            '/v1/auth/challenge': () => issuedChallenge({ origin: homeOrigin, serverIdentityId: 'srv_cancelled_home' }),
            '/v1/auth': phase === 'auth' ? hold : () => jsonResponse({ token: 'late-token' }),
        });
        const controller = new AbortController();
        const result = authenticate({
            ...(serverIdentityId ? { serverIdentityId, requireKeyChallengeV2: true } : {}),
            signal: controller.signal,
        }).then((credentials) => ({ credentials }), (error: unknown) => ({ error }));
        try {
            await vi.waitFor(() => expect(arrived).toBe(true));
            controller.abort();
            expect(heldSignal?.aborted).toBe(true);
        } finally {
            releaseHeld(phase === 'features' ? features() : jsonResponse({ token: 'late-token' }));
        }
        const settled = await result;
        expect(settled).not.toHaveProperty('credentials');
        // An identity-pinned Home fails closed on the abandoned probe before any request
        // (a retryable HappyError today, not AbortError — see the lane report follow-up).
        if (phase === 'auth' || !serverIdentityId) expect(settled).toMatchObject({ error: { name: 'AbortError' } });
        if (phase === 'features') expect(requestedPaths()).toEqual(['/v1/features']);
    });
});
