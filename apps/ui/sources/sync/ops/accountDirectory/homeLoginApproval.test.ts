import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import sodium from '@/encryption/libsodium.lib';
import { encodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';
import { createReactNativeNativeMock } from '@/dev/testkit/mocks/reactNative';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, type LocalStorageMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';
import { type AccountDirectoryHomeEntryV1, type HomeLoginAssertionV1 } from '@/sync/api/accountDirectory/accountDirectoryClient';
import {
    ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_CREDENTIAL_PLAINTEXT_BYTES,
    ACCOUNT_DIRECTORY_MAX_SEALED_TOKEN_BYTES,
    createHomeCredentialDestinationDigestV1,
} from '@happier-dev/protocol/auth/accountDirectory';

const endpointFetchMock = vi.hoisted(() => vi.fn());
const createServerFetchAtEndpointMock = vi.hoisted(() => vi.fn<
    (input: unknown) => typeof endpointFetchMock
>(() => endpointFetchMock));
const irohReleaseMock = vi.hoisted(() => vi.fn(async () => {}));
const acquireIrohHomeRuntimeOriginMock = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>(async () => {
    throw new Error('native unavailable');
}));
const secureStoreValues = new Map<string, string>();
let secureStoreWriteError: Error | null = null;
let secureStoreDeleteError: Error | null = null;
let secureStoreWriteObserver: (() => void) | null = null;
installTokenStorageWebPlatformMocks({
    reactNative: () => createReactNativeNativeMock({ platformOS: 'ios' }),
    secureStore: () => ({
        getItemAsync: async (key: string) => secureStoreValues.get(key) ?? null,
        setItemAsync: async (key: string, value: string) => {
            if (secureStoreWriteError) throw secureStoreWriteError;
            secureStoreValues.set(key, value);
            secureStoreWriteObserver?.();
        },
        deleteItemAsync: async (key: string) => {
            if (secureStoreDeleteError) throw secureStoreDeleteError;
            secureStoreValues.delete(key);
        },
    }),
});

vi.mock('@/sync/http/client', () => ({
    createServerFetchAtEndpoint: (input: unknown) => createServerFetchAtEndpointMock(input),
    serverFetch: vi.fn(),
}));

vi.mock('@/sync/runtime/nativeIrohTunnels/runtime', () => ({
    acquireIrohHomeRuntimeOrigin: (input: unknown) => acquireIrohHomeRuntimeOriginMock(input),
}));

let continueHomeLoginEnrollment: typeof import('./homeLoginApproval')['continueHomeLoginEnrollment'];
let TokenStorage: typeof import('@/auth/storage/tokenStorage')['TokenStorage'];
let serverProfiles: typeof import('@/sync/domains/server/serverProfiles');
let setCredentialsForServerUrlMock: MockInstance<typeof TokenStorage.setCredentialsForServerUrlWithRollback>;
let adoptHomeProfileMock: MockInstance<typeof import('@/sync/domains/server/serverProfiles').adoptHomeProfile>;
let preflightHomeProfileAdoptionMock: MockInstance<typeof import('@/sync/domains/server/serverProfiles').preflightHomeProfileAdoption>;
let reconcileServerProfileHomeConnectionDescriptorMock: MockInstance<typeof import('@/sync/domains/server/serverProfiles').reconcileServerProfileHomeConnectionDescriptor>;

function json(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function sealCredentialPayload(
    token: string,
    recipientPublicKey: Uint8Array,
): string {
    const payload = { token };
    return encodeBase64(
        encryptBox(
            new TextEncoder().encode(JSON.stringify(payload)),
            recipientPublicKey,
        ),
        'base64url',
    );
}

function sealLegacyCredentialPayload(payload: unknown, recipientPublicKey: Uint8Array): string {
    return encodeBase64(
        encryptBox(
            new TextEncoder().encode(JSON.stringify(payload)),
            recipientPublicKey,
        ),
        'base64url',
    );
}

const HOME_B: AccountDirectoryHomeEntryV1 = {
    v: 1,
    homeServerIdentityId: 'srv_home_b',
    canonicalServerUrl: 'https://home-b.test',
    label: 'Home B',
    preferred: false,
    connectionDescriptor: {
        v: 1,
        homeServerIdentityId: 'srv_home_b',
        canonicalServerUrl: 'https://home-b.test',
        revision: 1,
        endpoints: [{ kind: 'https', url: 'https://home-b.test' }],
    },
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_001,
};

const ASSERTION: HomeLoginAssertionV1 = {
    v: 1,
    purpose: 'happier.home-login',
    issuerServerIdentityId: 'srv_dir_1',
    issuerSubjectId: 'account-1',
    audienceHomeServerIdentityId: 'srv_home_b',
    credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1(HOME_B.connectionDescriptor),
    clientBoxPublicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    issuedAtMs: Date.now() - 1_000,
    expiresAtMs: Date.now() + 120_000,
    keyId: 'a'.repeat(64),
    signatureBase64Url: 'A'.repeat(86),
};

function assertionForHome(home: AccountDirectoryHomeEntryV1): HomeLoginAssertionV1 {
    return {
        ...ASSERTION,
        audienceHomeServerIdentityId: home.homeServerIdentityId,
        credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1(
            home.connectionDescriptor,
        ),
    };
}

async function expectHomeCredential(
    expected: { token: string } | null,
    home: AccountDirectoryHomeEntryV1 = HOME_B,
): Promise<void> {
    await expect(TokenStorage.getCredentialsForServerUrl(
        home.connectionDescriptor.canonicalServerUrl,
        { serverId: home.homeServerIdentityId },
    )).resolves.toEqual(expected);
}

describe('Home login approval continuation (explicit target, Home-authoritative)', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    let localStorageHandle: LocalStorageMockHandle | null = null;

    beforeAll(async () => {
        await sodium.ready;
        localStorageHandle = installLocalStorageMock();
        ({ continueHomeLoginEnrollment } = await import('./homeLoginApproval'));
        ({ TokenStorage } = await import('@/auth/storage/tokenStorage'));
        serverProfiles = await import('@/sync/domains/server/serverProfiles');
    });

    beforeEach(() => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `home_login_approval_${Date.now()}_${Math.random()}`;
        secureStoreValues.clear();
        localStorageHandle!.store.clear();
        secureStoreWriteError = null;
        secureStoreDeleteError = null;
        secureStoreWriteObserver = null;
        setCredentialsForServerUrlMock = vi.spyOn(TokenStorage, 'setCredentialsForServerUrlWithRollback');
        adoptHomeProfileMock = vi.spyOn(serverProfiles, 'adoptHomeProfile');
        preflightHomeProfileAdoptionMock = vi.spyOn(serverProfiles, 'preflightHomeProfileAdoption');
        reconcileServerProfileHomeConnectionDescriptorMock = vi.spyOn(
            serverProfiles,
            'reconcileServerProfileHomeConnectionDescriptor',
        );
        createServerFetchAtEndpointMock.mockImplementation(() => (async (path: string, ...args: unknown[]) => {
            if (path === '/v1/features' || path === '/v1/features/authenticated') {
                return json(200, {
                    features: {},
                    capabilities: { serverIdentity: { serverIdentityId: 'srv_home_b' } },
                    homeConnectionDescriptor: HOME_B.connectionDescriptor,
                });
            }
            return await endpointFetchMock(path, ...args);
        }) as typeof endpointFetchMock);
    });

    afterEach(() => {
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        secureStoreWriteError = null;
        secureStoreDeleteError = null;
        secureStoreWriteObserver = null;
        vi.useRealTimers();
        vi.restoreAllMocks();
        endpointFetchMock.mockReset();
        createServerFetchAtEndpointMock.mockClear();
        irohReleaseMock.mockClear();
        acquireIrohHomeRuntimeOriginMock.mockReset();
        acquireIrohHomeRuntimeOriginMock.mockRejectedValue(new Error('native unavailable'));
    });

    afterAll(() => {
        localStorageHandle?.restore();
        localStorageHandle = null;
    });

    it('preserves the same assertion and approval id in an explicit resume operation', async () => {
        const keyPair = sodium.crypto_box_keypair();
        const sealedToken = sealCredentialPayload('home-b-session-token', keyPair.publicKey);
        endpointFetchMock
            .mockResolvedValueOnce(json(202, {
                v: 1,
                outcome: 'approval_required',
                homeServerIdentityId: 'srv_home_b',
                approvalId: 'approval-1',
                deviceLabel: 'Phone',
                expiresAtMs: Date.now() + 60_000,
            }))
            .mockResolvedValueOnce(json(200, {
                v: 1,
                homeServerIdentityId: 'srv_home_b',
                sealedHomeTokenBase64Url: sealedToken,
                issuedAtMs: Date.now() - 500,
                expiresAtMs: Date.now() + 120_000,
            }));

        const pending = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
            approvalId: 'approval-1',
        });

        expect(pending).toMatchObject({ kind: 'approval_required', approvalId: 'approval-1' });
        if (pending.kind !== 'approval_required') return;
        const result = await pending.resume();
        expect(result).toEqual({ kind: 'enrolled', homeServerIdentityId: 'srv_home_b' });
        expect(endpointFetchMock).toHaveBeenCalledTimes(2);
        expect(endpointFetchMock.mock.calls[0]?.[0]).toBe('/v1/auth/home-login');
        const firstBody = JSON.parse(String((endpointFetchMock.mock.calls[0]?.[1] as RequestInit).body));
        const secondBody = JSON.parse(String((endpointFetchMock.mock.calls[1]?.[1] as RequestInit).body));
        expect(firstBody.approvalId).toBe('approval-1');
        expect(firstBody.assertion).toEqual(secondBody.assertion);
        expect(secondBody.approvalId).toBe('approval-1');
        expect(serverProfiles.getServerProfileById(HOME_B.homeServerIdentityId)).toMatchObject({
            serverIdentityId: HOME_B.homeServerIdentityId,
            homeConnectionDescriptor: HOME_B.connectionDescriptor,
        });
        expect(serverProfiles.getServerProfileById(HOME_B.homeServerIdentityId))
            .not.toHaveProperty('descriptorProvenance');
        await expectHomeCredential({ token: 'home-b-session-token' });
    });

    it('rejects a conflicting authenticated descriptor before credential persistence', async () => {
        const keyPair = sodium.crypto_box_keypair();
        const advisoryHome = {
            ...HOME_B,
            canonicalServerUrl: 'https://directory-advisory-route.test',
            connectionDescriptor: {
                ...HOME_B.connectionDescriptor,
                canonicalServerUrl: 'https://directory-advisory-route.test',
                revision: 99,
                endpoints: [{ kind: 'https' as const, url: 'https://directory-advisory-route.test' }],
            },
        };
        const assertion = {
            ...ASSERTION,
            credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1(
                advisoryHome.connectionDescriptor,
            ),
        };
        const authenticatedDescriptor = {
            ...HOME_B.connectionDescriptor,
            revision: 100,
            endpoints: [{
                kind: 'iroh' as const,
                endpointId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            }],
        };
        createServerFetchAtEndpointMock.mockImplementation(() => (async (path: string, ...args: unknown[]) => {
            if (path === '/v1/features') {
                return json(200, {
                    features: {},
                    capabilities: { serverIdentity: { serverIdentityId: 'srv_home_b' } },
                    homeConnectionDescriptor: {
                        ...advisoryHome.connectionDescriptor,
                        revision: 100,
                    },
                });
            }
            if (path === '/v1/features/authenticated') {
                return json(200, {
                    features: {},
                    capabilities: { serverIdentity: { serverIdentityId: 'srv_home_b' } },
                    homeConnectionDescriptor: authenticatedDescriptor,
                });
            }
            return await endpointFetchMock(path, ...args);
        }) as typeof endpointFetchMock);
        endpointFetchMock.mockResolvedValueOnce(json(200, {
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            sealedHomeTokenBase64Url: sealCredentialPayload(
                'home-selected-token',
                keyPair.publicKey,
            ),
            issuedAtMs: Date.now() - 500,
            expiresAtMs: Date.now() + 120_000,
        }));
        await expect(continueHomeLoginEnrollment({
            home: advisoryHome,
            clientSecretKey: keyPair.privateKey,
            assertion,
        })).resolves.toMatchObject({
            kind: 'transport_unavailable',
            reason: 'home_observation_unavailable',
            resume: expect.any(Function),
            cancel: expect.any(Function),
        });

        expect(createServerFetchAtEndpointMock).toHaveBeenCalledWith(expect.objectContaining({
            endpointUrl: 'https://directory-advisory-route.test',
        }));
        expect(reconcileServerProfileHomeConnectionDescriptorMock).not.toHaveBeenCalled();
        expect(endpointFetchMock).toHaveBeenCalledOnce();
        expect(preflightHomeProfileAdoptionMock).not.toHaveBeenCalled();
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
        expect(adoptHomeProfileMock).not.toHaveBeenCalled();
    });

    it('retains an explicit retry after authenticated descriptor reconciliation conflicts', async () => {
        const keyPair = sodium.crypto_box_keypair();
        const approvalExpiresAtMs = Date.now() + 40_000;
        endpointFetchMock.mockResolvedValueOnce(json(200, {
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            sealedHomeTokenBase64Url: sealCredentialPayload('home-reconcile-token', keyPair.publicKey),
            issuedAtMs: Date.now() - 500,
            expiresAtMs: Date.now() + 120_000,
        }));
        reconcileServerProfileHomeConnectionDescriptorMock.mockResolvedValueOnce({
            kind: 'conflict',
            code: 'identity_mismatch',
            profile: null,
        });

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
            approvalId: 'approval-reconciliation-conflict',
            approvalExpiresAtMs,
        });

        expect(result).toMatchObject({
            kind: 'transport_unavailable',
            reason: 'home_observation_unavailable',
            resume: expect.any(Function),
            cancel: expect.any(Function),
        });
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
        expect(adoptHomeProfileMock).not.toHaveBeenCalled();
        if (result.kind !== 'transport_unavailable' || !result.resume) return;
        vi.useFakeTimers();
        vi.setSystemTime(approvalExpiresAtMs);
        await expect(result.resume()).resolves.toEqual({ kind: 'expired' });
        expect(endpointFetchMock).toHaveBeenCalledOnce();
    });

    it('rejects an assertion whose signed destination does not match the exact Directory entry before transport', async () => {
        const keyPair = sodium.crypto_box_keypair();

        await expect(continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: {
                ...ASSERTION,
                credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1({
                    ...HOME_B.connectionDescriptor,
                    canonicalServerUrl: 'https://attacker.test',
                    endpoints: [{ kind: 'https', url: 'https://attacker.test' }],
                }),
            },
        })).resolves.toEqual({ kind: 'failed' });

        expect(createServerFetchAtEndpointMock).not.toHaveBeenCalled();
        expect(acquireIrohHomeRuntimeOriginMock).not.toHaveBeenCalled();
        expect(endpointFetchMock).not.toHaveBeenCalled();
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
    });

    it('preserves Directory authentication and returns an explicit retry when Home observation is unavailable', async () => {
        const keyPair = sodium.crypto_box_keypair();
        createServerFetchAtEndpointMock.mockImplementation(() => (async (path: string, ...args: unknown[]) => {
            if (path === '/v1/features') return json(503, { error: 'temporarily_unavailable' });
            return await endpointFetchMock(path, ...args);
        }) as typeof endpointFetchMock);

        const unavailable = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
        });

        expect(unavailable).toMatchObject({
            kind: 'transport_unavailable',
            reason: 'home_observation_unavailable',
            resume: expect.any(Function),
            cancel: expect.any(Function),
        });
        expect(endpointFetchMock).not.toHaveBeenCalled();
        expect(reconcileServerProfileHomeConnectionDescriptorMock).not.toHaveBeenCalled();
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();

        createServerFetchAtEndpointMock.mockImplementation(() => (async (path: string, ...args: unknown[]) => {
            if (path === '/v1/features' || path === '/v1/features/authenticated') {
                return json(200, {
                    features: {},
                    capabilities: { serverIdentity: { serverIdentityId: 'srv_home_b' } },
                    homeConnectionDescriptor: HOME_B.connectionDescriptor,
                });
            }
            return await endpointFetchMock(path, ...args);
        }) as typeof endpointFetchMock);
        endpointFetchMock.mockResolvedValueOnce(json(200, {
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            sealedHomeTokenBase64Url: sealCredentialPayload('home-b-retried-token', keyPair.publicKey),
            issuedAtMs: Date.now() - 500,
            expiresAtMs: Date.now() + 120_000,
        }));
        if (unavailable.kind !== 'transport_unavailable' || !unavailable.resume) return;

        await expect(unavailable.resume()).resolves.toEqual({
            kind: 'enrolled',
            homeServerIdentityId: 'srv_home_b',
        });
        expect(endpointFetchMock).toHaveBeenCalledTimes(1);
    });

    it('retains an unavailable Home observation when the initiating screen unmounts during the probe', async () => {
        const keyPair = sodium.crypto_box_keypair();
        let initiatingScreenCancelled = false;
        let releaseObservation!: () => void;
        const observationGate = new Promise<void>((resolve) => {
            releaseObservation = resolve;
        });
        createServerFetchAtEndpointMock.mockImplementation(() => (async (path: string, ...args: unknown[]) => {
            if (path === '/v1/features' || path === '/v1/features/authenticated') {
                await observationGate;
                return json(503, { error: 'temporarily_unavailable' });
            }
            return await endpointFetchMock(path, ...args);
        }) as typeof endpointFetchMock);

        const enrollment = continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
            shouldCancel: () => initiatingScreenCancelled,
        });
        await vi.waitFor(() => expect(createServerFetchAtEndpointMock).toHaveBeenCalledOnce());
        initiatingScreenCancelled = true;
        releaseObservation();

        await expect(enrollment).resolves.toMatchObject({
            kind: 'transport_unavailable',
            reason: 'home_observation_unavailable',
            resume: expect.any(Function),
            cancel: expect.any(Function),
        });
        expect(endpointFetchMock).not.toHaveBeenCalled();
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
    });

    it('fails closed before redemption when the observed Home identity differs from the selected target', async () => {
        const keyPair = sodium.crypto_box_keypair();
        createServerFetchAtEndpointMock.mockImplementation(() => (async (path: string, ...args: unknown[]) => {
            if (path === '/v1/features') {
                return json(200, {
                    features: {},
                    capabilities: { serverIdentity: { serverIdentityId: 'srv_attacker' } },
                    homeConnectionDescriptor: {
                        ...HOME_B.connectionDescriptor,
                        homeServerIdentityId: 'srv_attacker',
                    },
                });
            }
            return await endpointFetchMock(path, ...args);
        }) as typeof endpointFetchMock);

        await expect(continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
        })).resolves.toEqual({ kind: 'failed' });

        expect(endpointFetchMock).not.toHaveBeenCalled();
        expect(reconcileServerProfileHomeConnectionDescriptorMock).not.toHaveBeenCalled();
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
        expect(adoptHomeProfileMock).not.toHaveBeenCalled();
    });

    it('rejects a published descriptor whose credential destination differs from the signed assertion', async () => {
        const keyPair = sodium.crypto_box_keypair();
        createServerFetchAtEndpointMock.mockImplementation(() => (async (path: string, ...args: unknown[]) => {
            if (path === '/v1/features') {
                return json(200, {
                    features: {},
                    capabilities: { serverIdentity: { serverIdentityId: 'srv_home_b' } },
                    homeConnectionDescriptor: {
                        ...HOME_B.connectionDescriptor,
                        canonicalServerUrl: 'https://attacker.test',
                        endpoints: [{ kind: 'https', url: 'https://attacker.test' }],
                    },
                });
            }
            return await endpointFetchMock(path, ...args);
        }) as typeof endpointFetchMock);

        await expect(continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
        })).resolves.toEqual({ kind: 'failed' });

        expect(reconcileServerProfileHomeConnectionDescriptorMock).not.toHaveBeenCalled();
        expect(endpointFetchMock).not.toHaveBeenCalled();
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
        expect(adoptHomeProfileMock).not.toHaveBeenCalled();
    });

    it('does not redeem after cancellation arrives while Home observation is pending', async () => {
        const keyPair = sodium.crypto_box_keypair();
        let cancelled = false;
        let finishObservation!: () => void;
        createServerFetchAtEndpointMock.mockImplementation(() => (async (path: string, ...args: unknown[]) => {
            if (path !== '/v1/features') return await endpointFetchMock(path, ...args);
            await new Promise<void>((resolve) => {
                finishObservation = resolve;
            });
            return json(200, {
                features: {},
                capabilities: { serverIdentity: { serverIdentityId: 'srv_home_b' } },
                homeConnectionDescriptor: HOME_B.connectionDescriptor,
            });
        }) as typeof endpointFetchMock);
        endpointFetchMock.mockResolvedValueOnce(json(202, {
            v: 1,
            outcome: 'approval_required',
            homeServerIdentityId: 'srv_home_b',
            approvalId: 'must-not-be-created',
            deviceLabel: null,
            expiresAtMs: Date.now() + 60_000,
        }));

        const result = continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
            shouldCancel: () => cancelled,
        });
        await vi.waitFor(() => {
            expect(createServerFetchAtEndpointMock).toHaveBeenCalledTimes(1);
        });
        cancelled = true;
        finishObservation();

        await expect(result).resolves.toEqual({ kind: 'cancelled' });
        expect(endpointFetchMock).not.toHaveBeenCalled();
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
    });

    it('keeps a Home approval continuation resumable after its initiating screen unmounts', async () => {
        const keyPair = sodium.crypto_box_keypair();
        let initiatingScreenCancelled = false;
        endpointFetchMock
            .mockResolvedValueOnce(json(202, {
                v: 1,
                outcome: 'approval_required',
                homeServerIdentityId: 'srv_home_b',
                approvalId: 'approval-screen-transition',
                deviceLabel: null,
                expiresAtMs: Date.now() + 60_000,
            }))
            .mockResolvedValueOnce(json(200, {
                v: 1,
                homeServerIdentityId: 'srv_home_b',
                sealedHomeTokenBase64Url: sealCredentialPayload('home-b-screen-transition-token', keyPair.publicKey),
                issuedAtMs: Date.now() - 500,
                expiresAtMs: Date.now() + 120_000,
            }));

        const pending = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
            shouldCancel: () => initiatingScreenCancelled,
        });
        expect(pending.kind).toBe('approval_required');
        if (pending.kind !== 'approval_required') return;

        initiatingScreenCancelled = true;
        await expect(pending.resume()).resolves.toEqual({
            kind: 'enrolled',
            homeServerIdentityId: 'srv_home_b',
        });
        expect(endpointFetchMock).toHaveBeenCalledTimes(2);
    });

    it('publishes the detached approval continuation when initiating cancellation flips after redemption resolves', async () => {
        const keyPair = sodium.crypto_box_keypair();
        let initiatingScreenCancelled = false;
        endpointFetchMock.mockImplementationOnce(async () => {
            initiatingScreenCancelled = true;
            return json(202, {
                v: 1,
                outcome: 'approval_required',
                homeServerIdentityId: 'srv_home_b',
                approvalId: 'approval-publication-race',
                deviceLabel: null,
                expiresAtMs: Date.now() + 60_000,
            });
        });

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
            shouldCancel: () => initiatingScreenCancelled,
        });

        expect(result).toMatchObject({
            kind: 'approval_required',
            homeServerIdentityId: 'srv_home_b',
            approvalId: 'approval-publication-race',
        });
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
    });

    it('redeems and stores a destination-bound credential through the selected Iroh EndpointId', async () => {
        const keyPair = sodium.crypto_box_keypair();
        const endpointId = 'a'.repeat(64);
        acquireIrohHomeRuntimeOriginMock.mockResolvedValueOnce({
            leaseId: 'lease-home-b',
            status: 'ready',
            homeServerIdentityId: 'srv_home_b',
            runtimeOrigin: 'http://127.0.0.1:45991',
            endpointId,
            release: irohReleaseMock,
        });
        const home = {
            ...HOME_B,
            connectionDescriptor: {
                ...HOME_B.connectionDescriptor,
                canonicalServerUrl: 'http://localhost:3010',
                endpoints: [{ kind: 'iroh' as const, endpointId }],
            },
        };
        createServerFetchAtEndpointMock.mockImplementation(() => (async (path: string, ...args: unknown[]) => {
            if (path === '/v1/features' || path === '/v1/features/authenticated') {
                return json(200, {
                    features: {},
                    capabilities: { serverIdentity: { serverIdentityId: 'srv_home_b' } },
                    homeConnectionDescriptor: home.connectionDescriptor,
                });
            }
            return await endpointFetchMock(path, ...args);
        }) as typeof endpointFetchMock);
        endpointFetchMock.mockResolvedValueOnce(json(200, {
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            sealedHomeTokenBase64Url: sealCredentialPayload('home-b-iroh-token', keyPair.publicKey),
            issuedAtMs: Date.now() - 500,
            expiresAtMs: Date.now() + 120_000,
        }));

        const result = await continueHomeLoginEnrollment({
            home,
            clientSecretKey: keyPair.privateKey,
            assertion: assertionForHome(home),
        });

        expect(result).toEqual({ kind: 'enrolled', homeServerIdentityId: 'srv_home_b' });
        expect(acquireIrohHomeRuntimeOriginMock).toHaveBeenCalledTimes(1);
        expect(irohReleaseMock).toHaveBeenCalledTimes(1);
        expect(createServerFetchAtEndpointMock).toHaveBeenCalledWith(expect.objectContaining({
            endpointUrl: 'http://localhost:3010',
            runtimeOrigin: 'http://127.0.0.1:45991',
            serverId: 'srv_home_b',
        }));
        expect(endpointFetchMock).toHaveBeenCalledOnce();
        expect(serverProfiles.getServerProfileById(home.homeServerIdentityId)).toMatchObject({
            serverIdentityId: home.homeServerIdentityId,
            homeConnectionDescriptor: home.connectionDescriptor,
        });
        expect(serverProfiles.getServerProfileById(home.homeServerIdentityId))
            .not.toHaveProperty('descriptorProvenance');
        await expectHomeCredential({ token: 'home-b-iroh-token' }, home);
    });

    it('releases a transport acquired after the enrollment attempt was cancelled', async () => {
        const keyPair = sodium.crypto_box_keypair();
        let cancelled = false;
        const home = {
            ...HOME_B,
            connectionDescriptor: {
                ...HOME_B.connectionDescriptor,
                canonicalServerUrl: 'http://localhost:3010',
                endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
            },
        };
        const acquisition = {
            finish: null as ((lease: {
                leaseId: string;
                status: 'ready';
                homeServerIdentityId: string;
                runtimeOrigin: string;
                endpointId: string;
                release: typeof irohReleaseMock;
            }) => void) | null,
        };
        acquireIrohHomeRuntimeOriginMock.mockImplementationOnce(async () => await new Promise((resolve) => {
            acquisition.finish = resolve;
        }));

        const resultPromise = continueHomeLoginEnrollment({
            home,
            clientSecretKey: keyPair.privateKey,
            assertion: assertionForHome(home),
            shouldCancel: () => cancelled,
        });

        await vi.waitFor(() => expect(acquisition.finish).not.toBeNull());
        cancelled = true;
        acquisition.finish?.({
            leaseId: 'lease-cancelled-after-acquire',
            status: 'ready',
            homeServerIdentityId: 'srv_home_b',
            runtimeOrigin: 'http://127.0.0.1:45991',
            endpointId: 'a'.repeat(64),
            release: irohReleaseMock,
        });

        await expect(resultPromise).resolves.toEqual({ kind: 'cancelled' });
        expect(irohReleaseMock).toHaveBeenCalledTimes(1);
        expect(endpointFetchMock).not.toHaveBeenCalled();
    });

    it('reports failure without credential-bearing profile adoption when explicit-target storage fails', async () => {
        const keyPair = sodium.crypto_box_keypair();
        secureStoreWriteError = new Error('secure store unavailable');
        endpointFetchMock.mockResolvedValueOnce(json(200, {
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            sealedHomeTokenBase64Url: sealCredentialPayload('home-b-session-token', keyPair.publicKey),
            issuedAtMs: Date.now() - 500,
            expiresAtMs: Date.now() + 120_000,
        }));

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
            approvalId: 'approval-storage-failure',
        });

        expect(result).toEqual({ kind: 'failed' });
        await expectHomeCredential(null);
        expect(serverProfiles.getServerProfileById(HOME_B.homeServerIdentityId)).toMatchObject({
            serverIdentityId: HOME_B.homeServerIdentityId,
            homeConnectionDescriptor: HOME_B.connectionDescriptor,
        });
    });

    it('does not persist a Home credential when authenticated descriptor observation is unavailable', async () => {
        const keyPair = sodium.crypto_box_keypair();
        createServerFetchAtEndpointMock.mockImplementation(() => (async (path: string, ...args: unknown[]) => {
            if (path === '/v1/features') {
                return json(200, {
                    features: {},
                    capabilities: { serverIdentity: { serverIdentityId: 'srv_home_b' } },
                    homeConnectionDescriptor: HOME_B.connectionDescriptor,
                });
            }
            if (path === '/v1/features/authenticated') return json(503, { error: 'temporarily_unavailable' });
            return await endpointFetchMock(path, ...args);
        }) as typeof endpointFetchMock);
        endpointFetchMock.mockResolvedValueOnce(json(200, {
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            sealedHomeTokenBase64Url: sealCredentialPayload('home-b-stored-token', keyPair.publicKey),
            issuedAtMs: Date.now() - 500,
            expiresAtMs: Date.now() + 120_000,
        }));

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
        });
        expect(result).toMatchObject({
            kind: 'transport_unavailable',
            reason: 'home_observation_unavailable',
        });
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
        expect(adoptHomeProfileMock).not.toHaveBeenCalled();
        expect(reconcileServerProfileHomeConnectionDescriptorMock).not.toHaveBeenCalled();
    });

    it('preserves target and rollback uncertainty for a partial credential/adoption commit', async () => {
        const keyPair = sodium.crypto_box_keypair();
        const rollbackError = new Error('secure store rollback failed');
        let cancelled = false;
        endpointFetchMock.mockResolvedValueOnce(json(200, {
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            sealedHomeTokenBase64Url: sealCredentialPayload('partially-stored-token', keyPair.publicKey),
            issuedAtMs: Date.now() - 500,
            expiresAtMs: Date.now() + 120_000,
        }));
        secureStoreWriteObserver = () => {
            secureStoreWriteObserver = null;
            secureStoreDeleteError = rollbackError;
            cancelled = true;
        };

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
            shouldCancel: () => cancelled,
        });

        expect(result).toMatchObject({
            kind: 'partial_commit',
            homeServerIdentityId: 'srv_home_b',
            canonicalServerUrl: 'https://home-b.test',
            error: {
                adoptionError: { message: 'Home credential adoption cancelled' },
                rollbackOutcome: { kind: 'failed', error: rollbackError },
            },
        });
        expect(result).not.toEqual({ kind: 'failed' });
    });

    it('never sends Account Service credentials and never stores a token while approval is still pending', async () => {
        const keyPair = sodium.crypto_box_keypair();
        endpointFetchMock.mockResolvedValue(json(202, {
            v: 1,
            outcome: 'approval_required',
            homeServerIdentityId: 'srv_home_b',
            approvalId: 'approval-2',
            deviceLabel: 'Phone',
            expiresAtMs: Date.now() + 40_000,
        }));

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
            approvalId: 'approval-2',
            approvalExpiresAtMs: Date.now() + 40_000,
        });

        expect(result).toMatchObject({ kind: 'approval_required', approvalId: 'approval-2' });
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
        expect(adoptHomeProfileMock).not.toHaveBeenCalled();
        // Redemption at the target Home must never carry Account Service credentials.
        for (const call of createServerFetchAtEndpointMock.mock.calls) {
            expect(call[0]).toMatchObject({ credentials: null });
        }
        expect(endpointFetchMock).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the sealed token names a different Home than the target descriptor', async () => {
        const keyPair = sodium.crypto_box_keypair();
        endpointFetchMock.mockResolvedValueOnce(json(200, {
            v: 1,
            homeServerIdentityId: 'srv_home_other',
            sealedHomeTokenBase64Url: sealCredentialPayload('other-home-token', keyPair.publicKey),
            issuedAtMs: Date.now() - 500,
            expiresAtMs: Date.now() + 120_000,
        }));

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
            approvalId: 'approval-3',
        });

        expect(result.kind).toBe('failed');
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
        expect(adoptHomeProfileMock).not.toHaveBeenCalled();
    });

    it('fails closed when the sealed token cannot be opened by this client key', async () => {
        const keyPair = sodium.crypto_box_keypair();
        const otherKey = sodium.crypto_box_keypair();
        endpointFetchMock.mockResolvedValueOnce(json(200, {
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            sealedHomeTokenBase64Url: sealCredentialPayload('token-for-someone-else', otherKey.publicKey),
            issuedAtMs: Date.now() - 500,
            expiresAtMs: Date.now() + 120_000,
        }));

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
            approvalId: 'approval-4',
        });

        expect(result.kind).toBe('failed');
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
    });

    it('retains assertion and key across an initial transient redemption until one explicit resume', async () => {
        const keyPair = sodium.crypto_box_keypair();
        endpointFetchMock
            .mockResolvedValueOnce(json(503, { error: 'home_unavailable' }))
            .mockResolvedValueOnce(json(200, {
                v: 1,
                homeServerIdentityId: 'srv_home_b',
                sealedHomeTokenBase64Url: sealCredentialPayload('home-b-after-initial-retry', keyPair.publicKey),
                issuedAtMs: Date.now() - 500,
                expiresAtMs: Date.now() + 120_000,
            }));

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
        });

        expect(result).toMatchObject({
            kind: 'transport_unavailable',
            reason: 'request_failed',
            resume: expect.any(Function),
            cancel: expect.any(Function),
        });
        expect(endpointFetchMock).toHaveBeenCalledTimes(1);
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(endpointFetchMock).toHaveBeenCalledTimes(1);
        if (result.kind !== 'transport_unavailable' || !result.resume) return;

        await expect(result.resume()).resolves.toEqual({
            kind: 'enrolled',
            homeServerIdentityId: 'srv_home_b',
        });
        expect(endpointFetchMock).toHaveBeenCalledTimes(2);
        const firstBody = JSON.parse(String((endpointFetchMock.mock.calls[0]?.[1] as RequestInit).body));
        const secondBody = JSON.parse(String((endpointFetchMock.mock.calls[1]?.[1] as RequestInit).body));
        expect(secondBody.assertion).toEqual(firstBody.assertion);
    });

    it('single-flights concurrent resume calls for one retained initial attempt', async () => {
        const keyPair = sodium.crypto_box_keypair();
        const redemption = { release: null as (() => void) | null };
        endpointFetchMock
            .mockResolvedValueOnce(json(503, { error: 'home_unavailable' }))
            .mockImplementationOnce(async () => {
                await new Promise<void>((resolve) => { redemption.release = resolve; });
                return json(202, {
                    v: 1,
                    outcome: 'approval_required',
                    homeServerIdentityId: 'srv_home_b',
                    approvalId: 'approval-single-flight',
                    deviceLabel: 'Phone',
                    expiresAtMs: Date.now() + 60_000,
                });
            });

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
        });
        if (result.kind !== 'transport_unavailable' || !result.resume) {
            throw new Error('expected a resumable transient continuation');
        }

        const firstResume = result.resume();
        const secondResume = result.resume();
        expect(secondResume).toBe(firstResume);
        await vi.waitFor(() => expect(endpointFetchMock).toHaveBeenCalledTimes(2));
        redemption.release?.();
        await expect(firstResume).resolves.toMatchObject({
            kind: 'approval_required',
            approvalId: 'approval-single-flight',
        });
        await expect(secondResume).resolves.toMatchObject({
            kind: 'approval_required',
            approvalId: 'approval-single-flight',
        });
        expect(endpointFetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps an initial transient continuation resumable after its initiating screen unmounts', async () => {
        const keyPair = sodium.crypto_box_keypair();
        let initiatingScreenCancelled = false;
        endpointFetchMock
            .mockResolvedValueOnce(json(503, { error: 'home_unavailable' }))
            .mockResolvedValueOnce(json(200, {
                v: 1,
                homeServerIdentityId: 'srv_home_b',
                sealedHomeTokenBase64Url: sealCredentialPayload('home-b-after-unmount', keyPair.publicKey),
                issuedAtMs: Date.now() - 500,
                expiresAtMs: Date.now() + 120_000,
            }));

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
            shouldCancel: () => initiatingScreenCancelled,
        });
        expect(result).toMatchObject({ kind: 'transport_unavailable', reason: 'request_failed' });
        if (result.kind !== 'transport_unavailable' || !result.resume) return;

        initiatingScreenCancelled = true;
        await expect(result.resume()).resolves.toEqual({
            kind: 'enrolled',
            homeServerIdentityId: 'srv_home_b',
        });
        expect(endpointFetchMock).toHaveBeenCalledTimes(2);
    });

    it('stops a detached initial transient continuation through its own cancel owner', async () => {
        const keyPair = sodium.crypto_box_keypair();
        endpointFetchMock
            .mockResolvedValueOnce(json(503, { error: 'home_unavailable' }))
            .mockResolvedValueOnce(json(200, {
                v: 1,
                homeServerIdentityId: 'srv_home_b',
                sealedHomeTokenBase64Url: sealCredentialPayload('must-not-be-consumed', keyPair.publicKey),
                issuedAtMs: Date.now() - 500,
                expiresAtMs: Date.now() + 120_000,
            }));

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
        });
        if (result.kind !== 'transport_unavailable' || !result.resume || !result.cancel) {
            throw new Error('expected a resumable transient continuation');
        }

        await expect(result.cancel()).resolves.toEqual({ kind: 'cancelled' });
        await expect(result.resume()).resolves.toEqual({ kind: 'cancelled' });
        expect(endpointFetchMock).toHaveBeenCalledTimes(1);
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
        expect(adoptHomeProfileMock).not.toHaveBeenCalled();
    });

    it('does not let retained screen-unmount immunity outlive Account credential custody', async () => {
        const keyPair = sodium.crypto_box_keypair();
        let initiatingScreenCancelled = false;
        let credentialCustodyIsCurrent = true;
        endpointFetchMock
            .mockResolvedValueOnce(json(503, { error: 'home_unavailable' }))
            .mockResolvedValueOnce(json(200, {
                v: 1,
                homeServerIdentityId: 'srv_home_b',
                sealedHomeTokenBase64Url: sealCredentialPayload('must-not-be-consumed', keyPair.publicKey),
                issuedAtMs: Date.now() - 500,
                expiresAtMs: Date.now() + 120_000,
            }));

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
            shouldCancel: () => initiatingScreenCancelled,
            credentialCustodyIsCurrent: () => credentialCustodyIsCurrent,
        });
        if (result.kind !== 'transport_unavailable' || !result.resume) {
            throw new Error('expected a resumable transient continuation');
        }

        initiatingScreenCancelled = true;
        credentialCustodyIsCurrent = false;
        await expect(result.resume()).resolves.toEqual({ kind: 'cancelled' });
        expect(endpointFetchMock).toHaveBeenCalledTimes(1);
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
    });

    it('retains approval state across a transient resume and retries through a fresh transport', async () => {
        const keyPair = sodium.crypto_box_keypair();
        endpointFetchMock
            .mockResolvedValueOnce(json(202, {
                v: 1,
                outcome: 'approval_required',
                homeServerIdentityId: 'srv_home_b',
                approvalId: 'approval-transient',
                deviceLabel: 'Phone',
                expiresAtMs: Date.now() + 60_000,
            }))
            .mockResolvedValueOnce(json(503, { error: 'home_unavailable' }))
            .mockResolvedValueOnce(json(200, {
                v: 1,
                homeServerIdentityId: 'srv_home_b',
                sealedHomeTokenBase64Url: sealCredentialPayload('home-b-after-retry', keyPair.publicKey),
                issuedAtMs: Date.now() - 500,
                expiresAtMs: Date.now() + 120_000,
            }));

        const first = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
        });
        expect(first).toMatchObject({ kind: 'approval_required', approvalId: 'approval-transient' });
        expect(endpointFetchMock).toHaveBeenCalledTimes(1);
        if (first.kind !== 'approval_required') return;

        const second = await first.resume();
        expect(second).toMatchObject({ kind: 'transport_unavailable', resume: expect.any(Function) });
        expect(endpointFetchMock).toHaveBeenCalledTimes(2);
        if (second.kind !== 'transport_unavailable' || !second.resume) return;

        await expect(second.resume()).resolves.toEqual({
            kind: 'enrolled',
            homeServerIdentityId: 'srv_home_b',
        });
        expect(endpointFetchMock).toHaveBeenCalledTimes(3);
        const firstBody = JSON.parse(String((endpointFetchMock.mock.calls[0]?.[1] as RequestInit).body));
        const secondBody = JSON.parse(String((endpointFetchMock.mock.calls[1]?.[1] as RequestInit).body));
        const thirdBody = JSON.parse(String((endpointFetchMock.mock.calls[2]?.[1] as RequestInit).body));
        expect(secondBody.assertion).toEqual(firstBody.assertion);
        expect(thirdBody).toEqual(secondBody);
    });

    it('does not retry a terminal Home rejection', async () => {
        const keyPair = sodium.crypto_box_keypair();
        endpointFetchMock
            .mockResolvedValueOnce(json(403, { error: 'approval_rejected' }))
            .mockResolvedValueOnce(json(200, {
                v: 1,
                homeServerIdentityId: 'srv_home_b',
                sealedHomeTokenBase64Url: sealCredentialPayload('must-not-be-consumed', keyPair.publicKey),
                issuedAtMs: Date.now() - 500,
                expiresAtMs: Date.now() + 120_000,
            }));

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
            approvalId: 'approval-terminal',
        });

        expect(result).toEqual({ kind: 'rejected' });
        expect(endpointFetchMock).toHaveBeenCalledTimes(1);
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
        expect(adoptHomeProfileMock).not.toHaveBeenCalled();
    });

    it.each([
        ['approval_expired', 'expired'],
        ['approval_invalid', 'failed'],
        ['invalid_audience', 'failed'],
    ] as const)('maps terminal %s without retry or credential mutation', async (error, kind) => {
        const keyPair = sodium.crypto_box_keypair();
        endpointFetchMock
            .mockResolvedValueOnce(json(401, { error }))
            .mockResolvedValueOnce(json(200, { unexpected: true }));

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
            approvalId: 'approval-terminal',
        });

        if (kind === 'expired') {
            expect(result).toEqual({ kind: 'expired' });
        } else {
            expect(result).toMatchObject({
                kind: 'failed',
                error: {
                    name: 'AccountDirectoryRequestError',
                    status: 401,
                    code: error,
                    transient: false,
                },
            });
        }
        expect(endpointFetchMock).toHaveBeenCalledTimes(1);
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
        expect(adoptHomeProfileMock).not.toHaveBeenCalled();
    });

    it('does not classify an arbitrary error containing expired as protocol expiry', async () => {
        const keyPair = sodium.crypto_box_keypair();
        endpointFetchMock.mockResolvedValueOnce(json(401, { error: 'attacker_controlled_expired' }));

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
        });

        expect(result).toMatchObject({
            kind: 'failed',
            error: {
                name: 'AccountDirectoryRequestError',
                status: 401,
                transient: false,
            },
        });
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
        expect(adoptHomeProfileMock).not.toHaveBeenCalled();
    });

    it('returns a typed transport blocker for an Iroh-only non-focused Home', async () => {
        acquireIrohHomeRuntimeOriginMock.mockRejectedValueOnce(
            Object.assign(new Error('native unavailable'), { name: 'IrohError', code: 'unavailable' }),
        );
        const keyPair = sodium.crypto_box_keypair();
        const home = {
            ...HOME_B,
            connectionDescriptor: {
                ...HOME_B.connectionDescriptor,
                endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
            },
        };
        const result = await continueHomeLoginEnrollment({
            home,
            clientSecretKey: keyPair.privateKey,
            assertion: assertionForHome(home),
        });

        expect(result).toMatchObject({
            kind: 'transport_unavailable',
            reason: 'iroh_transport_unavailable',
            resume: expect.any(Function),
            cancel: expect.any(Function),
        });
        expect(createServerFetchAtEndpointMock).not.toHaveBeenCalled();
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
        expect(adoptHomeProfileMock).not.toHaveBeenCalled();
    });

    it('propagates a failed-closed Iroh transport reason without collapsing it', async () => {
        acquireIrohHomeRuntimeOriginMock.mockRejectedValueOnce(
            Object.assign(new Error('identity mismatch'), { name: 'IrohError', code: 'identity_mismatch' }),
        );
        const keyPair = sodium.crypto_box_keypair();
        const home = {
            ...HOME_B,
            connectionDescriptor: {
                ...HOME_B.connectionDescriptor,
                endpoints: [
                    { kind: 'iroh' as const, endpointId: 'a'.repeat(64) },
                    { kind: 'https' as const, url: 'https://home-b.test' },
                ],
            },
        };

        const result = await continueHomeLoginEnrollment({
            home,
            clientSecretKey: keyPair.privateKey,
            assertion: assertionForHome(home),
        });

        expect(result).toEqual({
            kind: 'transport_unavailable',
            reason: 'iroh_transport_failed_closed',
        });
        expect(endpointFetchMock).not.toHaveBeenCalled();
    });

    it('rejects malformed UTF-8 token bytes before persistence', async () => {
        const keyPair = sodium.crypto_box_keypair();
        endpointFetchMock.mockResolvedValueOnce(json(200, {
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            sealedHomeTokenBase64Url: encodeBase64(
                // A non-fatal decoder would replace 0xff and leave valid JSON.
                encryptBox(new Uint8Array([
                    0x7b, 0x22, 0x74, 0x6f, 0x6b, 0x65, 0x6e,
                    0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d,
                ]), keyPair.publicKey),
                'base64url',
            ),
            issuedAtMs: Date.now() - 500,
            expiresAtMs: Date.now() + 120_000,
        }));

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
        });

        expect(result).toEqual({ kind: 'failed' });
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
    });

    it('fails closed on a legacy credential wrapper with zero credential write or profile mutation', async () => {
        const keyPair = sodium.crypto_box_keypair();
        endpointFetchMock.mockResolvedValueOnce(json(200, {
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            sealedHomeTokenBase64Url: sealLegacyCredentialPayload(
                { credentials: { token: 'legacy-wrapped-token' } },
                keyPair.publicKey,
            ),
            issuedAtMs: Date.now() - 500,
            expiresAtMs: Date.now() + 120_000,
        }));

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
        });

        expect(result).toEqual({ kind: 'failed' });
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
        expect(adoptHomeProfileMock).not.toHaveBeenCalled();
        expect(preflightHomeProfileAdoptionMock).not.toHaveBeenCalled();
    });

    it('rejects an unbound legacy credential envelope before persistence', async () => {
        const keyPair = sodium.crypto_box_keypair();
        endpointFetchMock.mockResolvedValueOnce(json(200, {
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            sealedHomeTokenBase64Url: sealLegacyCredentialPayload(
                { token: 'legacy-token', secret: 'legacy-secret' },
                keyPair.publicKey,
            ),
            issuedAtMs: Date.now() - 500,
            expiresAtMs: Date.now() + 120_000,
        }));

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
        });

        expect(result).toEqual({ kind: 'failed' });
        expect(adoptHomeProfileMock).not.toHaveBeenCalled();
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
    });

    it.each([
        ['data-key credentials', {
            v: 1,
            credentials: {
                token: 'forged-home-token',
                encryption: { publicKey: 'forged-public-key', machineKey: 'forged-machine-key' },
            },
            connectionDescriptor: HOME_B.connectionDescriptor,
        }],
        ['an unknown field', {
            v: 1,
            credentials: { token: 'forged-home-token' },
            connectionDescriptor: HOME_B.connectionDescriptor,
            futureAuthority: true,
        }],
    ])('rejects sealed %s at the coupled redemption boundary', async (_label, payload) => {
        const keyPair = sodium.crypto_box_keypair();
        endpointFetchMock.mockResolvedValueOnce(json(200, {
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            sealedHomeTokenBase64Url: sealLegacyCredentialPayload(payload, keyPair.publicKey),
            issuedAtMs: Date.now() - 500,
            expiresAtMs: Date.now() + 120_000,
        }));

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
        });

        expect(result).toEqual({ kind: 'failed' });
        expect(adoptHomeProfileMock).not.toHaveBeenCalled();
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
    });

    it('keeps the sealed token bounded and fails closed on oversized material', async () => {
        const keyPair = sodium.crypto_box_keypair();
        endpointFetchMock.mockResolvedValueOnce(json(200, {
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            sealedHomeTokenBase64Url: encodeBase64(
                new Uint8Array(ACCOUNT_DIRECTORY_MAX_SEALED_TOKEN_BYTES + 1).fill(1),
                'base64url',
            ),
            issuedAtMs: Date.now() - 500,
            expiresAtMs: Date.now() + 120_000,
        }));

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
            approvalId: 'approval-9',
        });

        expect(result.kind).toBe('failed');
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
    });

    it('fails closed when decrypted credential plaintext exceeds the protocol bound', async () => {
        const keyPair = sodium.crypto_box_keypair();
        endpointFetchMock.mockResolvedValueOnce(json(200, {
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            sealedHomeTokenBase64Url: sealLegacyCredentialPayload(
                { token: 't'.repeat(ACCOUNT_DIRECTORY_MAX_HOME_LOGIN_CREDENTIAL_PLAINTEXT_BYTES) },
                keyPair.publicKey,
            ),
            issuedAtMs: Date.now() - 500,
            expiresAtMs: Date.now() + 120_000,
        }));

        const result = await continueHomeLoginEnrollment({
            home: HOME_B,
            clientSecretKey: keyPair.privateKey,
            assertion: ASSERTION,
        });

        expect(result.kind).toBe('failed');
        expect(setCredentialsForServerUrlMock).not.toHaveBeenCalled();
    });
});
