import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { encodeBase64 } from '@/encryption/base64';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetServerProfilesRuntimeForTests } from '@/sync/domains/server/serverProfiles';

installTokenStorageWebPlatformMocks();

const runtimeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));
// The address-trust decision can ask the person; this lean endpoint suite keeps
// the modal surface out of its graph.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

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
    it.each([true, false])('waits for a slow identity-pinned endpoint before issuing a challenge (require v2: %s)', async (requireKeyChallengeV2) => {
        const { authGetTokenAtEndpoint } = await import('./getToken');
        vi.useFakeTimers();
        const paths: string[] = [];
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            const url = String(input);
            paths.push(new URL(url).pathname);
            if (url.endsWith('/v1/features')) {
                await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
                return jsonResponse(createRootLayoutFeaturesResponse({ capabilities: keyChallengeV2Capabilities('srv_slow_home') }));
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
            endpointUrl: 'https://slow.example.test', serverIdentityId: 'srv_slow_home',
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
        expect(paths).toEqual(['/v1/features', '/v1/auth/challenge', '/v1/auth']);
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

    it('keeps the typed Secret Key restore result when only the bearer remains', async () => {
        const request = vi.fn(async () => jsonResponse({
            error: 'migration-required',
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' },
        }, 400));
        const { fetchAccountEncryptionCurrentness } = await import('@/sync/api/account/apiAccountEncryptionMode');
        await expect(fetchAccountEncryptionCurrentness({ token: 'bearer-only' }, { request })).rejects.toMatchObject({
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' },
        });
        expect(runtimeFetchMock).not.toHaveBeenCalled();
    });

    it('does not borrow focused Home recovery authority for an explicitly captured currentness request', async () => {
        const credentials = { token: 'header.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', secret: encodeBase64(new Uint8Array(32).fill(7)) };
        await TokenStorage.setCredentialsForServerUrl(focusedSnapshot.serverUrl, { serverId: focusedSnapshot.serverId }, credentials);
        const readCredentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
        const request = vi.fn(async () => jsonResponse({
            error: 'migration-required',
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' },
        }, 400));
        const { fetchAccountEncryptionCurrentness } = await import('@/sync/api/account/apiAccountEncryptionMode');
        await expect(fetchAccountEncryptionCurrentness(credentials, { request })).rejects.toMatchObject({
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' },
        });
        expect(request).toHaveBeenCalledOnce();
        expect(readCredentials).not.toHaveBeenCalled();
        expect(runtimeFetchMock).not.toHaveBeenCalled();
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
        expect(runtimeFetchMock.mock.calls.map(([url]) => String(url)))
            .not.toContain('http://127.0.0.1:4311/v1/auth');
    });

    it('sends an explicit target request through runtimeOrigin without consulting focused Home state', async () => {
        runtimeFetchMock.mockResolvedValue(jsonResponse({ ok: true }));

        const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
        const request = createServerFetchAtEndpoint({
            endpointUrl: 'https://home-b.example.test',
            runtimeOrigin: 'http://127.0.0.1:4312',
            serverId: 'srv_home_b',
            credentials: { token: 'home-b-token' },
        });
        await upsertAndActivateServer({ serverUrl: 'https://focused-after-switch.example.test', scope: 'device' });
        const switchedSnapshot = getActiveServerSnapshot();

        await expect(request('/v1/account/profile', { method: 'GET' }, { retry: 'none' })).resolves.toMatchObject({
            ok: true,
        });

        expect(String(runtimeFetchMock.mock.calls[0]?.[0])).toBe(
            'http://127.0.0.1:4312/v1/account/profile',
        );
        const init = runtimeFetchMock.mock.calls[0]?.[1] as RequestInit;
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer home-b-token');
        expect(getActiveServerSnapshot()).toEqual(switchedSnapshot);
    });

    it('probes a supplied endpoint and returns observed features without adopting a profile or changing focus', async () => {
        runtimeFetchMock.mockResolvedValue(jsonResponse({
            features: {},
            capabilities: {
                serverIdentity: { serverIdentityId: 'srv_home_b' },
            },
        }));

        const { probeServerFeaturesAtUrl } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const result = await probeServerFeaturesAtUrl('https://home-b.example.test', {
            force: true,
            timeoutMs: 100,
        });

        expect(result.status).toBe('ready');
        if (result.status === 'ready') {
            expect(result.features.capabilities.serverIdentity.serverIdentityId).toBe('srv_home_b');
            expect(result.serverIdentityId).toBe('srv_home_b');
        }
        expect(String(runtimeFetchMock.mock.calls[0]?.[0])).toBe(
            'https://home-b.example.test/v1/features',
        );
        expect(getActiveServerSnapshot()).toEqual(focusedSnapshot);
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
