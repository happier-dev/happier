import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import sodium from '@/encryption/libsodium.lib';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { decryptBox, encryptBox } from '@/encryption/libsodium';
import {
    createHomeCredentialDestinationDigestV1,
    HomeLoginRedemptionResultV1Schema,
} from '@happier-dev/protocol';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createReactNativeNativeMock } from '@/dev/testkit/mocks/reactNative';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDirectoryHttpFixture } from './accountDirectoryTestFixtures';

/** Non-secret binding to the Account credential that created the continuation. */
const TEST_CREDENTIAL_TOKEN_DIGEST = 'sha256:test-account-credential';


const secureStoreValues = new Map<string, string>();
installTokenStorageWebPlatformMocks({
    reactNative: () => createReactNativeNativeMock({ platformOS: 'ios' }),
    secureStore: () => ({
        getItemAsync: async (key: string) => secureStoreValues.get(key) ?? null,
        setItemAsync: async (key: string, value: string) => { secureStoreValues.set(key, value); },
        deleteItemAsync: async (key: string) => { secureStoreValues.delete(key); },
    }),
});

const endpointFetchMock = vi.hoisted(() => vi.fn());
const acquireIrohHomeRuntimeOriginMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/http/client', () => ({
    createServerFetchAtEndpoint: vi.fn(() => endpointFetchMock),
    serverFetch: vi.fn(),
}));
vi.mock('@/sync/runtime/nativeIrohTunnels/runtime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/runtime/nativeIrohTunnels/runtime')>();
    return {
        ...actual,
        acquireIrohHomeRuntimeOrigin: (...args: unknown[]) => acquireIrohHomeRuntimeOriginMock(...args),
    };
});

describe('Directory enrollment production composition', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    let restoreLocalStorage: (() => void) | null = null;

    beforeAll(async () => {
        await sodium.ready;
    });

    beforeEach(() => {
        secureStoreValues.clear();
        restoreLocalStorage = installLocalStorageMock().restore;
    });

    afterEach(() => {
        restoreLocalStorage?.();
        restoreLocalStorage = null;
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        endpointFetchMock.mockReset();
        acquireIrohHomeRuntimeOriginMock.mockReset();
        vi.resetModules();
    });

    it('enrolls an Iroh-only Home using the transport-authenticated EndpointId destination', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `directory_enrollment_iroh_${Date.now()}_${Math.random()}`;
        const now = Date.now();
        const endpointId = 'c'.repeat(64);
        const keyPair = sodium.crypto_box_keypair();
        const descriptor = {
            v: 1 as const,
            homeServerIdentityId: 'srv_home_iroh_only',
            canonicalServerUrl: 'http://127.0.0.1:43123',
            revision: 4,
            endpoints: [{ kind: 'iroh' as const, endpointId }],
        };
        const assertion = {
            v: 1 as const,
            purpose: 'happier.home-login' as const,
            issuerServerIdentityId: 'srv_directory',
            issuerSubjectId: 'account-1',
            audienceHomeServerIdentityId: descriptor.homeServerIdentityId,
            credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1(descriptor),
            clientBoxPublicKeyBase64: encodeBase64(keyPair.publicKey, 'base64'),
            issuedAtMs: now - 1_000,
            expiresAtMs: now + 2 * 60_000,
            keyId: 'a'.repeat(64),
            signatureBase64Url: 'A'.repeat(86),
        };
        const sealedHomeTokenBase64Url = encodeBase64(
            encryptBox(
                new TextEncoder().encode(JSON.stringify({ token: 'iroh-home-token' })),
                keyPair.publicKey,
            ),
            'base64url',
        );
        acquireIrohHomeRuntimeOriginMock.mockResolvedValue({
            leaseId: 'iroh-enrollment-lease',
            homeServerIdentityId: descriptor.homeServerIdentityId,
            endpointId,
            runtimeOrigin: 'http://127.0.0.1:54321',
            status: 'ready',
            release: vi.fn(async () => {}),
        });
        endpointFetchMock.mockImplementation(async (path: string) => new Response(JSON.stringify(
            path === '/v1/features' || path === '/v1/features/authenticated'
                ? {
                    ...createRootLayoutFeaturesResponse({
                        capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } },
                    }),
                    homeConnectionDescriptor: descriptor,
                }
                : HomeLoginRedemptionResultV1Schema.parse({
                    v: 1,
                    homeServerIdentityId: descriptor.homeServerIdentityId,
                    sealedHomeTokenBase64Url,
                    issuedAtMs: now,
                    expiresAtMs: now + 2 * 60_000,
                }),
        ), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        const { continueHomeLoginEnrollment } = await import('./homeLoginApproval');

        await expect(continueHomeLoginEnrollment({
            home: {
                v: 1,
                homeServerIdentityId: descriptor.homeServerIdentityId,
                canonicalServerUrl: descriptor.canonicalServerUrl,
                label: 'Iroh Home',
                preferred: true,
                connectionDescriptor: descriptor,
                createdAtMs: now,
                updatedAtMs: now,
            },
            clientSecretKey: keyPair.privateKey,
            assertion,
        })).resolves.toEqual({
            kind: 'enrolled',
            homeServerIdentityId: descriptor.homeServerIdentityId,
        });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await expect(TokenStorage.getCredentialsForServerUrl(
            descriptor.canonicalServerUrl,
            { serverId: descriptor.homeServerIdentityId },
        )).resolves.toEqual({ token: 'iroh-home-token' });
    });

    it('enrolls a fresh destination-bound Home through one advisory credential write without changing focus or groups', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `directory_enrollment_${Date.now()}_${Math.random()}`;
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const focused = await profiles.upsertServerProfile({ serverUrl: 'https://home-a.test', source: 'manual' });
        await profiles.setActiveServerId(focused.id);
        await profiles.saveHomeViewState({
            version: 1,
            activeTargetKind: 'server',
            activeTargetId: focused.id,
            groups: [{ id: 'g', name: 'Homes', serverIds: [focused.id] }],
        });
        const activeBefore = profiles.getActiveServerSnapshot();
        const now = Date.now();
        // `afterEach` resets the module graph so this composed test must spy on the same
        // libsodium instance the lazily imported enrollment owner will consume. Spying on the
        // file's top-level instance would couple the case to execution order.
        const runtimeSodium = (await import('@/encryption/libsodium.lib')).default;
        await runtimeSodium.ready;
        const keyPair = runtimeSodium.crypto_box_keypair();
        vi.spyOn(runtimeSodium, 'crypto_box_keypair').mockReturnValueOnce(keyPair);
        const home = {
            v: 1 as const,
            homeServerIdentityId: 'srv_home_b',
            canonicalServerUrl: 'https://canonical.home-b.test',
            label: 'Home B',
            preferred: true,
            connectionDescriptor: {
                v: 1 as const,
                homeServerIdentityId: 'srv_home_b',
                canonicalServerUrl: 'https://canonical.home-b.test',
                revision: 1,
                endpoints: [{ kind: 'https' as const, url: 'https://public.home-b.test' }],
            },
            createdAtMs: now,
            updatedAtMs: now,
        };
        let requesterPublicKey: Uint8Array | null = null;
        const client = {
            isCurrent: () => true,
            getMe: vi.fn(async () => ({ accountId: 'account-1' })),
            listHomes: vi.fn(async () => ({ homes: [home], preferredHomeServerIdentityId: 'srv_home_b' })),
            requestLoginAssertion: vi.fn(async (_homeServerIdentityId: string, body: { clientBoxPublicKeyBase64: string }) => {
                requesterPublicKey = decodeBase64(body.clientBoxPublicKeyBase64, 'base64');
                return {
                    v: 1 as const,
                    purpose: 'happier.home-login' as const,
                    issuerServerIdentityId: 'srv_directory',
                    issuerSubjectId: 'account-1',
                    audienceHomeServerIdentityId: 'srv_home_b',
                    credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1(
                        home.connectionDescriptor,
                    ),
                    clientBoxPublicKeyBase64: body.clientBoxPublicKeyBase64,
                    issuedAtMs: now - 1_000,
                    expiresAtMs: now + 2 * 60_000,
                    keyId: 'a'.repeat(64),
                    signatureBase64Url: 'A'.repeat(86),
                };
            }),
        };
        const coupledPayload = { token: 'home-b-token' };
        const sealedTokenBase64Url = encodeBase64(
            encryptBox(new TextEncoder().encode(JSON.stringify(coupledPayload)), keyPair.publicKey),
            'base64url',
        );
        expect(new TextDecoder().decode(decryptBox(
            decodeBase64(sealedTokenBase64Url, 'base64url'),
            keyPair.privateKey,
        )!)).toBe(JSON.stringify(coupledPayload));
        const authorized = HomeLoginRedemptionResultV1Schema.parse({
            v: 1,
            homeServerIdentityId: 'srv_home_b',
            sealedHomeTokenBase64Url: sealedTokenBase64Url,
            issuedAtMs: now,
            expiresAtMs: now + 2 * 60_000,
        });
        const observedDescriptor = {
            ...home.connectionDescriptor,
            revision: 2,
        };
        endpointFetchMock.mockImplementation(async (path: string) => new Response(JSON.stringify(
            path === '/v1/features' || path === '/v1/features/authenticated'
                ? {
                    ...createRootLayoutFeaturesResponse({
                        capabilities: { serverIdentity: { serverIdentityId: 'srv_home_b' } },
                    }),
                    homeConnectionDescriptor: path === '/v1/features/authenticated'
                        ? observedDescriptor
                        : home.connectionDescriptor,
                }
                : authorized,
        ), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        const { AccountDirectorySession } = await import('@/sync/domains/accountDirectory/accountDirectorySession');
        const session = new AccountDirectorySession({
            endpoint: 'https://directory.test',
            serverIdentityId: 'srv_directory',
        }, {
            client: client as never,
            capability: {
                version: 1,
                homeDirectory: true,
                homeEnrollment: true,
                homeLoginAssertion: {
                    keyId: 'a'.repeat(64),
                    publicKeyBase64Url: 'A'.repeat(43),
                },
            },
        });
        const { refreshAccountHomeDirectory } = await import('./refreshAccountHomeDirectory');
        const { enrollDirectoryHome } = await import('./enrollDirectoryHome');
        expect(profiles.preflightHomeProfileAdoption({
            descriptor: home.connectionDescriptor,
            source: 'account-directory',
            preserveUserLabel: true,
            suggestedName: home.label,
        })).toEqual({
            canonicalServerUrl: 'https://canonical.home-b.test',
            serverIdentityId: 'srv_home_b',
            credentialWrite: 'required',
        });
        await expect(refreshAccountHomeDirectory(session)).resolves.toMatchObject({ status: 'ready' });
        expect(profiles.listServerProfiles()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                serverIdentityId: 'srv_home_b',
                source: 'account-directory',
            }),
        ]));
        const result = await enrollDirectoryHome({ credentialTokenDigest: TEST_CREDENTIAL_TOKEN_DIGEST, session, service: createDirectoryHttpFixture().service,
            intent: { kind: 'enroll', homeServerIdentityId: home.homeServerIdentityId } },
            {
                home,
                shouldCancel: () => false,
                complete: async () => ({ kind: 'home_enrolled', homeServerIdentityId: home.homeServerIdentityId }),
                completeRetained: async () => ({ kind: 'home_enrolled', homeServerIdentityId: home.homeServerIdentityId }),
            });

        expect(requesterPublicKey).toEqual(keyPair.publicKey);
        expect(endpointFetchMock).toHaveBeenCalledTimes(3);
        expect(endpointFetchMock.mock.calls.map(([path]) => path)).toEqual([
            '/v1/features',
            '/v1/auth/home-login',
            '/v1/features/authenticated',
        ]);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await expect(TokenStorage.getCredentialsForServerUrl(
            'https://canonical.home-b.test',
            { serverId: 'srv_home_b' },
        )).resolves.toEqual({ token: 'home-b-token' });
        expect(profiles.listServerProfiles()).toEqual(expect.arrayContaining([
            expect.objectContaining({ serverIdentityId: 'srv_home_b', name: 'Home B' }),
        ]));
        expect(profiles.listServerProfiles().filter((profile) => profile.serverIdentityId === 'srv_home_b')).toHaveLength(1);
        expect(profiles.listServerProfiles()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                serverIdentityId: 'srv_home_b',
                name: 'Home B',
                canonicalServerUrl: 'https://canonical.home-b.test',
                homeConnectionDescriptor: observedDescriptor,
            }),
        ]));
        expect(profiles.listServerProfiles().find(
            (profile) => profile.serverIdentityId === 'srv_home_b',
        )).not.toHaveProperty('descriptorProvenance');
        expect(result).toEqual({ kind: 'enrolled', homeServerIdentityId: 'srv_home_b' });
        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: activeBefore.serverId,
            serverUrl: activeBefore.serverUrl,
        });
        expect(profiles.loadHomeViewState()).toMatchObject({
            activeTargetId: focused.id,
            groups: [{ id: 'g', serverIds: [focused.id] }],
        });
    });

    it.each(['fresh', 'same-account', 'different-account'] as const)(
        'keeps the different-Account cause visible without refusing valid Home HTTP redemption (%s)', async (custody) => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `directory_account_conflict_${Date.now()}_${Math.random()}`;
        const fixture = createDirectoryHttpFixture({ sameServiceHome: true });
        fixture.state.approval = 'approved';
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
        const { AccountDirectorySession } = await import('@/sync/domains/accountDirectory/accountDirectorySession');
        const { completeAccountServicePostAuth } = await import('./completeAccountServicePostAuth');
        await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor, source: 'manual' });
        const incumbent = {
            token: `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({
                sub: custody === 'same-account' ? 'account-directory' : 'incumbent-account', refresh: 1,
            })), 'base64url')}.signature`,
        };
        if (custody !== 'fresh') {
            await TokenStorage.setCredentialsForServerUrl(fixture.home.canonicalServerUrl,
                { serverId: fixture.home.homeServerIdentityId }, incumbent);
        }
        await TokenStorage.accountDirectoryAuthCredentials.set(
            { endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId },
            { token: 'directory-fixture-credential' },
        );
        endpointFetchMock.mockImplementation((path: string, init?: RequestInit) => fixture.request(
            fixture.service.endpointUrl, path, init,
        ));
        const session = new AccountDirectorySession(
            { endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId },
            { capability: fixture.service.capability },
        );

        const result = await completeAccountServicePostAuth({
            credentialTokenDigest: TEST_CREDENTIAL_TOKEN_DIGEST, service: fixture.service, session,
            intent: { kind: 'enroll', homeServerIdentityId: fixture.home.homeServerIdentityId },
        });

        expect(result).toMatchObject(custody === 'different-account' ? {
            kind: 'failure', stage: 'enroll', homeCredentialCommitted: false,
            code: { source: 'home', code: 'failed', reason: 'account_mismatch' }, recovery: 'use_home_auth',
        } : { kind: 'home_enrolled', homeServerIdentityId: fixture.home.homeServerIdentityId });
        expect(fixture.state.calls.map(({ path }) => path)).toContain('/v1/features/authenticated');
        await expect(TokenStorage.getCredentialsForServerUrl(fixture.home.canonicalServerUrl,
            { serverId: fixture.home.homeServerIdentityId })).resolves.toEqual(
                custody === 'different-account' ? incumbent : { token: fixture.token },
            );
    });

    it('fails closed before Home contact when the production caller receives the wrong signed destination digest', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `directory_enrollment_wrong_digest_${Date.now()}_${Math.random()}`;
        const now = Date.now();
        const home = {
            v: 1 as const,
            homeServerIdentityId: 'srv_home_wrong_digest',
            canonicalServerUrl: 'https://wrong-digest-home.test',
            label: 'Wrong digest Home',
            preferred: true,
            connectionDescriptor: {
                v: 1 as const,
                homeServerIdentityId: 'srv_home_wrong_digest',
                canonicalServerUrl: 'https://wrong-digest-home.test',
                revision: 1,
                endpoints: [{ kind: 'https' as const, url: 'https://wrong-digest-home.test' }],
            },
            createdAtMs: now,
            updatedAtMs: now,
        };
        const { AccountDirectorySession } = await import('@/sync/domains/accountDirectory/accountDirectorySession');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const target = { endpoint: 'https://directory.test', serverIdentityId: 'srv_directory' };
        await TokenStorage.accountDirectoryAuthCredentials.set(target, { token: 'directory-token' });
        const session = new AccountDirectorySession(target, { capability: {
            version: 1, homeDirectory: true, homeEnrollment: true,
            homeLoginAssertion: { keyId: 'a'.repeat(64), publicKeyBase64Url: 'A'.repeat(43) },
        } });
        endpointFetchMock.mockImplementationOnce(async (_path: string, init: RequestInit) => new Response(JSON.stringify({
                v: 1 as const,
                purpose: 'happier.home-login' as const,
                issuerServerIdentityId: 'srv_directory',
                issuerSubjectId: 'account-1',
                audienceHomeServerIdentityId: home.homeServerIdentityId,
                credentialDestinationDigestBase64Url: createHomeCredentialDestinationDigestV1({
                    ...home.connectionDescriptor,
                    canonicalServerUrl: 'https://attacker.test',
                    endpoints: [{ kind: 'https' as const, url: 'https://attacker.test' }],
                }),
                clientBoxPublicKeyBase64: JSON.parse(String(init.body)).clientBoxPublicKeyBase64,
                issuedAtMs: now - 1_000,
                expiresAtMs: now + 2 * 60_000,
                keyId: 'a'.repeat(64),
                signatureBase64Url: 'A'.repeat(86),
            })));
        const { enrollDirectoryHome } = await import('./enrollDirectoryHome');

        await expect(enrollDirectoryHome({ credentialTokenDigest: TEST_CREDENTIAL_TOKEN_DIGEST, session, service: createDirectoryHttpFixture().service,
            intent: { kind: 'enroll', homeServerIdentityId: home.homeServerIdentityId } }, {
            home, shouldCancel: () => false,
            complete: async () => ({ kind: 'home_enrolled', homeServerIdentityId: home.homeServerIdentityId }),
            completeRetained: async () => ({ kind: 'home_enrolled', homeServerIdentityId: home.homeServerIdentityId }),
        })).resolves.toMatchObject({ kind: 'failed' });
        expect(endpointFetchMock.mock.calls.map(([path]) => path)).toEqual([
            `/v1/account-directory/homes/${home.homeServerIdentityId}/login-assertion`,
        ]);
        await expect(TokenStorage.getCredentialsForServerUrl(
            home.canonicalServerUrl,
            { serverId: home.homeServerIdentityId },
        )).resolves.toBeNull();
    });

    it('persists a later valid Home when an earlier Directory entry conflicts in the real profile owner', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `directory_refresh_isolation_${Date.now()}_${Math.random()}`;
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const focused = await profiles.adoptHomeProfile({
            source: 'qr',
            descriptor: {
                v: 1,
                homeServerIdentityId: 'srv_existing_home',
                canonicalServerUrl: 'https://claimed-route.test',
                revision: 1,
                endpoints: [{ kind: 'https', url: 'https://claimed-route.test' }],
            },
        });
        await profiles.setActiveServerId(focused.id);
        const activeBefore = profiles.getActiveServerSnapshot();
        const now = Date.now();
        const conflicting = {
            v: 1 as const,
            homeServerIdentityId: 'srv_conflicting_home',
            label: 'Conflicting Home',
            preferred: false,
            connectionDescriptor: {
                v: 1 as const,
                homeServerIdentityId: 'srv_conflicting_home',
                canonicalServerUrl: 'https://claimed-route.test',
                revision: 1,
                endpoints: [{ kind: 'https' as const, url: 'https://claimed-route.test' }],
            },
            createdAtMs: now,
            updatedAtMs: now,
        };
        const valid = {
            v: 1 as const,
            homeServerIdentityId: 'srv_valid_home',
            label: 'Valid Home',
            preferred: true,
            connectionDescriptor: {
                v: 1 as const,
                homeServerIdentityId: 'srv_valid_home',
                canonicalServerUrl: 'https://valid-home.test',
                revision: 1,
                endpoints: [{ kind: 'https' as const, url: 'https://valid-home.test' }],
            },
            createdAtMs: now,
            updatedAtMs: now,
        };
        const { AccountDirectorySession } = await import('@/sync/domains/accountDirectory/accountDirectorySession');
        const session = new AccountDirectorySession({
            endpoint: 'https://directory.test',
            serverIdentityId: 'srv_directory',
        }, {
            client: {
                isCurrent: () => true,
                listHomes: vi.fn(async () => ({
                    homes: [conflicting, valid],
                    preferredHomeServerIdentityId: valid.homeServerIdentityId,
                })),
            } as never,
            capability: {
                version: 1,
                homeDirectory: true,
                homeEnrollment: true,
                homeLoginAssertion: {
                    keyId: 'a'.repeat(64),
                    publicKeyBase64Url: 'A'.repeat(43),
                },
            },
        });
        const { refreshAccountHomeDirectory } = await import('./refreshAccountHomeDirectory');

        const result = await refreshAccountHomeDirectory(session);
        if (result.status !== 'ready') throw result.error;

        expect(result.reconciliation).toMatchObject({
            kind: 'partial',
            adopted: [{ homeServerIdentityId: 'srv_valid_home', label: 'Valid Home' }],
            failures: [{ homeServerIdentityId: 'srv_conflicting_home', label: 'Conflicting Home' }],
        });
        expect(profiles.listServerProfiles()).toEqual(expect.arrayContaining([
            expect.objectContaining({ serverIdentityId: 'srv_valid_home', name: 'Valid Home' }),
        ]));
        expect(profiles.listServerProfiles()).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ serverIdentityId: 'srv_conflicting_home' }),
        ]));
        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: activeBefore.serverId,
            serverUrl: activeBefore.serverUrl,
        });
    });
});
