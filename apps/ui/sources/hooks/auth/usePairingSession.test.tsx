import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    computeHomeQrBindingProofV2,
    deriveHomeQrRendezvousVerifierV2,
    type HomeQrInviteV2,
} from '@happier-dev/protocol/crypto/qrProvisioningV2';
import {
    FeaturesResponseSchema,
    type FeaturesResponse} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import {
    HomeConnectionDescriptorV1Schema,
    type HomeConnectionDescriptorV1} from '@happier-dev/protocol/auth/accountDirectory';
import {
    tryWriteServerEnabledBitInPlace} from '@happier-dev/protocol/features/serverEnabledBit';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { waitForNetworkResponseForTests } from '@/dev/testkit/mocks/runtimeFetch';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';

installTokenStorageWebPlatformMocks();

// Load the real auth/profile/Sync graph once, with only platform ports replaced.
const { createDeferred, flushHookEffects, renderHook, standardCleanup } = await import('@/dev/testkit');
const { reactNativeWebAppState } = await import('@/dev/testkit/mocks/reactNative');
await initializeRealAppRuntimeForTests();
const { createAccountTokenForTests, createHomeGovernanceHarness, waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const profiles = await import('@/sync/domains/server/serverProfiles');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { resetServerFeaturesClientForTests, getCachedServerFeaturesSnapshot, getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { parseHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
const { usePairingSession } = await import('./usePairingSession');

type HttpRequest = Readonly<{
    origin: string;
    path: string;
    method: string;
    body: unknown;
    token: string | null;
    signal?: AbortSignal | null;
}>;
type HttpReply = (request: HttpRequest) => Promise<Response>;
type PairingHome = Readonly<{
    profileId: string;
    serverId: string;
    serverUrl: string;
    accountId: string;
    token: string;
    descriptor: HomeConnectionDescriptorV1;
    features: FeaturesResponse;
    authenticatedFeatures: ReturnType<typeof vi.fn<HttpReply>>;
}>;
type PairingHook = Awaited<ReturnType<typeof mountPairing>>;

const homes = createHomeGovernanceHarness();
const servedHomes = new Map<string, PairingHome>();
const requests: HttpRequest[] = [];
const http = {
    start: vi.fn<HttpReply>(),
    status: vi.fn<HttpReply>(),
    consume: vi.fn<HttpReply>(),
    complete: vi.fn<HttpReply>(),
    currentness: vi.fn<HttpReply>(),
};
const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
let localStorage: ReturnType<typeof installLocalStorageMock> | null = null;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let expiresAt = '';

function json(status: number, body: unknown): Response {
    return Response.json(body, { status });
}

function bodyRecord(request: HttpRequest): Record<string, unknown> {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
        throw new Error('Expected a JSON request object');
    }
    return request.body as Record<string, unknown>;
}

function requestsFor(path: string): HttpRequest[] {
    return requests.filter(request => request.path.split('?')[0] === path);
}

const request: Parameters<typeof setRuntimeFetch>[0] = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const bearer = new Headers(init?.headers).get('Authorization');
    const observed: HttpRequest = {
        origin: url.origin,
        path: url.pathname + url.search,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) as unknown : null,
        token: bearer?.startsWith('Bearer ') ? bearer.slice(7) : null,
        signal: init?.signal,
    };
    requests.push(observed);
    const home = servedHomes.get(url.origin);
    if (!home) return json(404, {});
    let pending: Promise<Response>;
    if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return json(200, {});
    if (url.pathname === '/v1/features') return json(200, home.features);
    if (url.pathname === '/v1/features/authenticated') pending = home.authenticatedFeatures(observed);
    else if (url.pathname === '/v1/account/encryption/currentness') pending = http.currentness(observed);
    else if (url.pathname === '/v1/auth/pairing/start') pending = http.start(observed);
    else if (url.pathname === '/v1/auth/pairing/status') pending = http.status(observed);
    else if (url.pathname === '/v1/auth/pairing/consume') pending = http.consume(observed);
    else if (url.pathname === '/v1/auth/account/response') pending = http.complete(observed);
    else return createEmptyAccountBootstrapHttpResponse(observed.path, init) ?? homes.request(input, init);
    return await waitForNetworkResponseForTests(pending, init?.signal);
};

beforeEach(async () => {
    vi.useRealTimers();
    process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = 'pairing_hook_' + crypto.randomUUID();
    localStorage = installLocalStorageMock();
    await homes.reset();
    servedHomes.clear();
    requests.length = 0;
    reactNativeWebAppState.emit('active');
    resetServerFeaturesClientForTests();
    http.start.mockReset().mockImplementation(async () => {
        expiresAt = new Date(Date.now() + 60_000).toISOString();
        return json(200, { pairId: 'pair_123', expiresAt });
    });
    http.status.mockReset().mockImplementation(async () => json(200, { state: 'pending', pairId: 'pair_123', expiresAt }));
    http.consume.mockReset().mockImplementation(async () => json(200, { success: true }));
    http.complete.mockReset().mockImplementation(async () => json(200, {}));
    http.currentness.mockReset().mockImplementation(async () => json(200, createPlainAccountEncryptionCurrentnessFixture()));
    setRuntimeFetch(request);
});

afterEach(async () => {
    standardCleanup();
    vi.useRealTimers();
    await connection?.dispose();
    connection = null;
    await homes.reset();
    localStorage?.restore();
    localStorage = null;
    if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
    vi.restoreAllMocks();
});

async function addHome(options: Readonly<{
    serverUrl?: string;
    identity?: string | null;
    descriptor?: HomeConnectionDescriptorV1;
    retainDescriptor?: boolean;
    boundQrV2?: boolean;
    canonicalObservation?: string;
    accountId?: string;
}> = {}): Promise<PairingHome> {
    const serverUrl = options.serverUrl ?? 'https://home-a.test';
    const identity = options.identity === undefined ? 'srv_home_a' : options.identity;
    const descriptor = HomeConnectionDescriptorV1Schema.parse(options.descriptor ?? {
        v: 1, homeServerIdentityId: identity ?? 'srv_unverified', canonicalServerUrl: serverUrl,
        revision: 1, endpoints: [{ kind: 'https', url: serverUrl }],
    });
    const accountId = options.accountId ?? 'trusted-account';
    const token = createAccountTokenForTests(accountId, { currentAccount: true });
    const profileId = await homes.addHome({
        name: 'Pairing Home', serverUrl, accountId, currentAccount: true,
        credentials: { token }, active: false, ...(identity ? { serverIdentityId: identity } : {}),
    });
    if (identity && options.retainDescriptor !== false) {
        await profiles.adoptHomeProfile({ descriptor, source: 'qr', descriptorAuthority: 'current_connection_observation' });
    }
    const features = createRootLayoutFeaturesResponse();
    features.capabilities.serverIdentity.serverIdentityId = identity;
    features.capabilities.server.canonicalServerUrl = options.canonicalObservation ?? descriptor.canonicalServerUrl;
    if (!tryWriteServerEnabledBitInPlace(features, 'auth.pairing.boundQrV2', options.boundQrV2 !== false)) {
        throw new Error('Pairing feature fixture could not enable its canonical bit');
    }
    const exactFeatures = FeaturesResponseSchema.parse({ ...features, ...(identity ? { homeConnectionDescriptor: descriptor } : {}) });
    const home: PairingHome = {
        profileId,
        serverId: profiles.resolveServerProfileScopeIdForIdentifier(profileId),
        serverUrl,
        accountId,
        token,
        descriptor,
        features: exactFeatures,
        authenticatedFeatures: vi.fn(async () => json(200, exactFeatures)),
    };
    servedHomes.set(new URL(serverUrl).origin, home);
    for (const endpoint of descriptor.endpoints) {
        if (endpoint.kind === 'https') servedHomes.set(new URL(endpoint.url).origin, home);
    }
    setRuntimeFetch(request);
    await homes.setActionPolicy(profileId, 'machines.pairing.create', 'ui', 'allowed');
    return home;
}

async function restoreFocused(home: PairingHome): Promise<void> {
    connection = await restoreServerAccountForTest({
        serverUrl: home.serverUrl, serverIdentityId: home.descriptor.homeServerIdentityId,
        accountId: home.accountId, credentials: { token: home.token }, request,
    });
    setRuntimeFetch(request);
}

async function mountPairing(home: PairingHome, focused = false) {
    return renderHook(({ enabled }: { enabled: boolean }) => usePairingSession({
        enabled, isAuthenticated: true, ...(focused ? {} : { targetProfileId: home.profileId }),
    }), { initialProps: { enabled: true } });
}

async function start(hook: PairingHook): Promise<void> {
    let result: unknown;
    await act(async () => { result = await hook.getCurrent().startPairing(); });
    expect(result, JSON.stringify({
        presentation: hook.getCurrent().presentation.phase === 'invalid_request'
            ? hook.getCurrent().presentation : { phase: hook.getCurrent().presentation.phase },
        paths: requests.map(observed => observed.path.split('?')[0]),
    })).toEqual({ ok: true });
}

function inviteFor(hook: PairingHook): HomeQrInviteV2 {
    const parsed = parseHomeQrInviteDeepLink(hook.getCurrent().deepLink ?? '');
    if (!parsed) throw new Error('Expected a current strict V2 Home invite');
    return parsed.invite;
}

function boundRequest(invite: HomeQrInviteV2, override: Record<string, unknown> = {}) {
    const publicKey = new Uint8Array(32).fill(9);
    return {
        state: 'requested', pairId: invite.pairId, expiresAt: new Date(invite.expiresAtMs).toISOString(),
        requestedPublicKey: encodeBase64(publicKey), requestedDeviceLabel: 'Phone',
        homeServerIdentityId: invite.home.homeServerIdentityId,
        bindingProof: computeHomeQrBindingProofV2({
            direction: invite.direction, qrSecret: decodeBase64(invite.qrSecretBase64Url, 'base64url'),
            pairId: invite.pairId, homeServerIdentityId: invite.home.homeServerIdentityId,
            requesterPublicKey: publicKey, expiresAtMs: invite.expiresAtMs,
        }),
        ...override,
    };
}

/** Hold only the network response, then bind it to the real random invite the hook produced. */
async function requestedPair(hook: PairingHook, override: Record<string, unknown> = {}) {
    const ready = createDeferred<ReturnType<typeof boundRequest>>();
    http.status.mockImplementation(async () => json(200, await ready.promise));
    await start(hook);
    const invite = inviteFor(hook);
    return {
        invite,
        release: async () => { await act(async () => { ready.resolve(boundRequest(invite, override)); }); },
    };
}

describe('usePairingSession through real Home enrollment owners', () => {
    it('admits initial QR issuance through the pairing Action policy before contacting enrollment', async () => {
        const home = await addHome();
        const hook = await mountPairing(home);
        await homes.setActionPolicy(home.profileId, 'machines.pairing.create', 'ui', 'off');
        let result: unknown;
        await act(async () => { result = await hook.getCurrent().startPairing(); });
        expect(result).toMatchObject({ ok: false });
        expect(hook.getCurrent().presentation).toMatchObject({
            phase: 'invalid_request',
            cause: { ok: false, errorCode: 'action_disabled' },
        });
        expect(requestsFor('/v1/auth/pairing/start')).toHaveLength(0);
        expect(hook.getCurrent().deepLink).toBeNull();
    });

    it('issues the direct QR from the freshly authenticated exact descriptor instead of the retained profile descriptor', async () => {
        const retained = HomeConnectionDescriptorV1Schema.parse({
            v: 1, homeServerIdentityId: 'srv_home_a', canonicalServerUrl: 'https://home-a.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://old-ingress.example.test' }],
        });
        const home = await addHome({ descriptor: retained });
        const fresh = { ...retained, revision: 2, endpoints: [{ kind: 'https' as const, url: 'https://new-ingress.example.test' }] };
        servedHomes.set('https://new-ingress.example.test', home);
        home.authenticatedFeatures.mockImplementation(async () => json(200, { ...home.features, homeConnectionDescriptor: fresh }));
        const hook = await mountPairing(home);
        await start(hook);
        expect(inviteFor(hook).home).toEqual(fresh);
        expect(profiles.getServerProfileById(home.profileId)?.homeConnectionDescriptor).toEqual(fresh);
        expect(requestsFor('/v1/auth/pairing/start')).toMatchObject([{
            origin: 'https://new-ingress.example.test', token: home.token,
        }]);
    });

    it.each(['unavailable', 'public descriptor only', 'contradictory Home identity'])(
        'fails closed before direct QR creation when the authenticated observation is %s', async kind => {
            const home = await addHome();
            home.authenticatedFeatures.mockImplementation(async () => {
                if (kind === 'unavailable') return json(503, {});
                if (kind === 'public descriptor only') {
                    const { homeConnectionDescriptor: _descriptor, ...publicOnly } = home.features;
                    return json(200, publicOnly);
                }
                return json(200, {
                    ...home.features,
                    capabilities: { ...home.features.capabilities, serverIdentity: { serverIdentityId: 'srv_other_home' } },
                    homeConnectionDescriptor: { ...home.descriptor, homeServerIdentityId: 'srv_other_home', revision: 2 },
                });
            });
            const hook = await mountPairing(home);
            await act(async () => { await expect(hook.getCurrent().startPairing()).resolves.toEqual({ ok: false, status: 412 }); });
            expect(http.start).not.toHaveBeenCalled();
            expect(hook.getCurrent().deepLink).toBeNull();
        },
    );

    it('fails closed before direct QR creation when the exact descriptor contradicts retained profile authority', async () => {
        const home = await addHome();
        home.authenticatedFeatures.mockImplementation(async () => json(200, {
            ...home.features, homeConnectionDescriptor: {
                ...home.descriptor, endpoints: [{ kind: 'https', url: 'https://conflicting-ingress.test' }],
            },
        }));
        const hook = await mountPairing(home);
        await act(async () => { await expect(hook.getCurrent().startPairing()).resolves.toEqual({ ok: false, status: 412 }); });
        expect(profiles.getServerProfileById(home.profileId)?.homeConnectionDescriptor).toEqual(home.descriptor);
        expect(http.start).not.toHaveBeenCalled();
        expect(hook.getCurrent().presentation).toEqual({ phase: 'invalid_request', cause: 'home_identity_unverified' });
    });

    it('says the device is signed out of the Home when it holds no credential for it', async () => {
        const home = await addHome();
        expect(await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.serverId })).toBe(true);
        const hook = await mountPairing(home);
        await act(async () => { await expect(hook.getCurrent().startPairing()).resolves.toEqual({ ok: false, status: 412 }); });
        expect(http.start).not.toHaveBeenCalled();
        expect(hook.getCurrent().presentation).toEqual({ phase: 'invalid_request', cause: 'signed_out' });
    });

    it('starts from the ready active runtime snapshot when no profile-scoped cache entry exists', async () => {
        const home = await addHome();
        await restoreFocused(home);
        resetServerFeaturesClientForTests();
        expect(getCachedServerFeaturesSnapshot({ serverId: home.profileId })).toBeNull();
        const hook = await mountPairing(home, true);
        await start(hook);
        expect(http.start).toHaveBeenCalledOnce();
        expect(hook.getCurrent().presentation.phase).toBe('ready');
    });

    it('waits for canonical feature refresh to reconcile the active Home profile before starting', async () => {
        const home = await addHome({ retainDescriptor: false });
        expect(profiles.buildHomeConnectionDescriptorForProfile(profiles.getServerProfileById(home.profileId)!)).toBeNull();
        await restoreFocused(home);
        // Authenticated reconciliation and public readiness have separate caches.
        // Drive the public refresh this fixture promises before starting the QR.
        const publicSnapshot = await getServerFeaturesSnapshot({ serverId: home.profileId, force: true });
        expect(publicSnapshot.status).toBe('ready');
        await waitForHomeGovernance(() => expect(profiles.getServerProfileById(home.profileId)?.homeConnectionDescriptor).toEqual(home.descriptor));
        const hook = await mountPairing(home, true);
        await start(hook);
        expect(inviteFor(hook).home).toEqual(home.descriptor);
    });

    it('preserves the canonical profile descriptor revision and Iroh endpoint', async () => {
        const descriptor = HomeConnectionDescriptorV1Schema.parse({
            v: 1, homeServerIdentityId: 'srv_home_a', canonicalServerUrl: 'https://home-a.test', revision: 7,
            endpoints: [
                { kind: 'iroh', endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] },
                { kind: 'https', url: 'https://home-a.test' },
            ],
        });
        const home = await addHome({ descriptor });
        // The user's standard-transport policy chooses HTTPS without rewriting the advertised Iroh endpoint.
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ localSettings: { ...storage.getState().localSettings, homeApplicationCarrierEligibility: 'standard_only' } });
        const hook = await mountPairing(home);
        await start(hook);
        expect(inviteFor(hook).home).toEqual(descriptor);
    });

    it('keeps the pairing live with the exact secret-bearing link when a valid invite exceeds QR capacity', async () => {
        const home = await addHome({ descriptor: HomeConnectionDescriptorV1Schema.parse({
            v: 1, homeServerIdentityId: 'srv_home_a', canonicalServerUrl: 'https://home-a.test', revision: 1,
            endpoints: [
                { kind: 'iroh', endpointId: 'a'.repeat(64),
                    relayUrls: Array.from({ length: 4 }, (_, index) => 'https://relay-' + index + '.example.test/' + 'a'.repeat(470)),
                    directAddresses: ['192.0.2.10:443', '192.0.2.11:443'] },
                { kind: 'https', url: 'https://public.example.test' },
            ],
        }) });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ localSettings: { ...storage.getState().localSettings, homeApplicationCarrierEligibility: 'standard_only' } });
        const hook = await mountPairing(home);
        await start(hook);
        expect(inviteFor(hook).home).toEqual(home.descriptor);
        expect(hook.getCurrent().presentation).toMatchObject({ phase: 'ready', qrAvailable: false });
        expect(hook.getCurrent().completionState).toBe('pending');
        expect(http.consume).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(http.status).toHaveBeenCalled());
        await act(async () => { await expect(hook.getCurrent().cancelPairing()).resolves.toEqual({ ok: true }); });
    });

    it('cancels with a typed invalid invite when the invite cannot be encoded at all', async () => {
        const home = await addHome({ descriptor: HomeConnectionDescriptorV1Schema.parse({
            v: 1, homeServerIdentityId: 'srv_home_a', canonicalServerUrl: 'https://home-a.test', revision: 1,
            endpoints: [
                { kind: 'iroh', endpointId: 'b'.repeat(64), relayUrls: Array.from({ length: 34 }, (_, index) =>
                    `https://relay-${index}.example.test/${'r'.repeat(470)}`) },
                { kind: 'https', url: 'https://public.example.test' },
            ],
        }) });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ localSettings: { ...storage.getState().localSettings, homeApplicationCarrierEligibility: 'standard_only' } });
        const hook = await mountPairing(home);
        await act(async () => {
            await expect(hook.getCurrent().startPairing()).resolves.toEqual({ ok: false, status: 422, reason: 'invalid_invite' });
        });
        expect(http.consume).toHaveBeenCalledOnce();
        expect(bodyRecord(http.consume.mock.calls[0]![0])).toEqual({ pairId: 'pair_123', intent: 'cancel' });
        expect(hook.getCurrent().presentation).toEqual({ phase: 'invalid_request', cause: 'invite_too_large' });
        expect(hook.getCurrent().deepLink).toBeNull();
    });

    it('uses the post-start timestamp for the forward invite issuance window', async () => {
        const home = await addHome();
        vi.useFakeTimers({ now: 1_000_000 });
        http.start.mockImplementationOnce(async () => {
            vi.setSystemTime(1_001_500);
            expiresAt = new Date(Date.now() + 600_000).toISOString();
            return json(200, { pairId: 'pair_123', expiresAt });
        });
        const hook = await mountPairing(home);
        await start(hook);
        const invite = inviteFor(hook);
        expect(invite.issuedAtMs).toBe(1_001_500);
        expect(invite.expiresAtMs - invite.issuedAtMs).toBe(600_000);
    });

    it('builds the production Add Phone payload as one strict V2 Home invite and targets that Home', async () => {
        const home = await addHome();
        const hook = await mountPairing(home);
        await start(hook);
        const invite = inviteFor(hook);
        expect(invite).toMatchObject({ v: 2, intent: 'home_device', pairId: 'pair_123', home: home.descriptor });
        expect(http.start).toHaveBeenCalledOnce();
        const issued = http.start.mock.calls[0]![0];
        expect(issued.origin).toBe(home.serverUrl);
        expect(issued.token).toBe(home.token);
        expect(bodyRecord(issued)).toEqual({
            direction: 'trusted_home_displays',
            secretHash: encodeBase64(deriveHomeQrRendezvousVerifierV2(decodeBase64(invite.qrSecretBase64Url, 'base64url')), 'base64url'),
        });
    });

    it('fails closed when the focused Home has no verified stable identity', async () => {
        const home = await addHome({ identity: null });
        const hook = await mountPairing(home);
        await act(async () => { await expect(hook.getCurrent().startPairing()).resolves.toEqual({ ok: false, status: 412 }); });
        expect(http.start).not.toHaveBeenCalled();
        expect(hook.getCurrent().deepLink).toBeNull();
        expect(hook.getCurrent().isStarting).toBe(false);
        expect(hook.getCurrent().presentation).toEqual({ phase: 'invalid_request', cause: 'home_identity_unverified' });
        await act(async () => { hook.getCurrent().clearSession(); });
    });

    it('does not start or create a secret-bearing link when the Home lacks bound QR v2', async () => {
        const home = await addHome({ boundQrV2: false });
        const hook = await mountPairing(home);
        await act(async () => {
            await expect(hook.getCurrent().startPairing()).resolves.toEqual({ ok: false, status: 426, reason: 'update_required' });
        });
        expect(http.start).not.toHaveBeenCalled();
        expect(hook.getCurrent().deepLink).toBeNull();
        expect(hook.getCurrent().completionState).toBe('update_required');
        expect(hook.getCurrent().presentation).toEqual({ phase: 'update_required' });
    });

    it('prefers a canonical server URL when available', async () => {
        const home = await addHome({ serverUrl: 'https://api.example.test' });
        const hook = await mountPairing(home);
        await start(hook);
        expect(inviteFor(hook).home.canonicalServerUrl).toBe('https://api.example.test');
    });

    it('sanitizes credentials out of canonical server URLs before embedding', async () => {
        const home = await addHome({ serverUrl: 'https://api.example.test',
            canonicalObservation: 'https://user:pass@api.example.test' });
        const hook = await mountPairing(home);
        await start(hook);
        expect(inviteFor(hook).home.canonicalServerUrl).toBe('https://api.example.test');
        expect(requestsFor('/v1/auth/pairing/start').map(observed => observed.origin)).toEqual(['https://api.example.test']);
    });

    it('prefers the Home-published shareable relay endpoint over the canonical server URL', async () => {
        const home = await addHome({ descriptor: HomeConnectionDescriptorV1Schema.parse({
            v: 1, homeServerIdentityId: 'srv_home_a', canonicalServerUrl: 'https://home-a.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://relay.example.ts.net' }],
        }) });
        await profiles.setServerProfileShareableUrl(home.profileId, 'https://relay.example.ts.net', {
            validatedAgainstServerUrl: home.serverUrl,
        });
        const hook = await mountPairing(home);
        await start(hook);
        expect(inviteFor(hook).home.endpoints).toEqual([{ kind: 'https', url: 'https://relay.example.ts.net' }]);
        expect(requestsFor('/v1/auth/pairing/start').map(observed => observed.origin)).toEqual(['https://relay.example.ts.net']);
    });

    it('ignores an active shareable relay URL that was validated for a different upstream', async () => {
        const home = await addHome();
        await profiles.setServerProfileShareableUrl(home.profileId, 'https://wrong-relay.example.ts.net', {
            validatedAgainstServerUrl: 'https://other.example.test',
        });
        const hook = await mountPairing(home);
        await start(hook);
        expect(inviteFor(hook).home.endpoints).toEqual(home.descriptor.endpoints);
        expect(requestsFor('/v1/auth/pairing/start').map(observed => observed.origin)).toEqual([home.serverUrl]);
    });

    it('does not publish a start that resolves after the session is disabled', async () => {
        const home = await addHome();
        const held = createDeferred<Response>();
        http.start.mockImplementationOnce(async () => held.promise);
        const hook = await mountPairing(home);
        let starting: ReturnType<ReturnType<typeof usePairingSession>['startPairing']> | undefined;
        await act(async () => { starting = hook.getCurrent().startPairing(); });
        await vi.waitFor(() => expect(http.start).toHaveBeenCalledOnce());
        const signal = http.start.mock.calls[0]![0].signal;
        await hook.rerender({ enabled: false });
        expect(signal?.aborted).toBe(true);
        await act(async () => {
            held.resolve(json(200, { pairId: 'late-pair', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
            await expect(starting).resolves.toEqual({ ok: false, status: 409 });
        });
        expect(hook.getCurrent()).toMatchObject({ deepLink: null, status: null, pairingContext: null, isStarting: false });
    });

    it('pauses pairing status polling while backgrounded', async () => {
        const home = await addHome();
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        reactNativeWebAppState.emit('background');
        const hook = await mountPairing(home);
        await start(hook);
        await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
        expect(http.status).not.toHaveBeenCalled();
        expect(http.consume).not.toHaveBeenCalled();
        expect(hook.getCurrent().completionState).toBe('pending');
        reactNativeWebAppState.emit('active');
        await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
        expect(http.status).toHaveBeenCalled();
    });

    it('allows only one status request in flight and schedules the next poll after settlement', async () => {
        const home = await addHome();
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const held = createDeferred<Response>();
        http.status.mockImplementationOnce(async () => held.promise);
        const hook = await mountPairing(home);
        await start(hook);
        await vi.waitFor(() => expect(http.status).toHaveBeenCalledOnce());
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect(http.status).toHaveBeenCalledOnce();
        await act(async () => { held.resolve(json(200, { state: 'pending', pairId: 'pair_123', expiresAt })); });
        await act(async () => { await vi.advanceTimersByTimeAsync(999); });
        expect(http.status).toHaveBeenCalledOnce();
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(http.status).toHaveBeenCalledTimes(2);
    });

    it('uses bounded backoff after a transient status failure', async () => {
        const home = await addHome();
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.999);
        http.status.mockImplementationOnce(async () => json(503, {}));
        const hook = await mountPairing(home);
        await start(hook);
        await vi.waitFor(() => expect(http.status).toHaveBeenCalledOnce());
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        expect(http.status).toHaveBeenCalledOnce();
        await act(async () => { await vi.advanceTimersByTimeAsync(249); });
        expect(http.status).toHaveBeenCalledTimes(2);
    });

    it('expires locally at the hard TTL ceiling without another status request', async () => {
        const home = await addHome();
        vi.useFakeTimers();
        http.start.mockImplementationOnce(async () => {
            expiresAt = new Date(Date.now() + 500).toISOString();
            return json(200, { pairId: 'pair_123', expiresAt });
        });
        http.status.mockImplementation(async () => json(503, {}));
        const hook = await mountPairing(home);
        await start(hook);
        await vi.waitFor(() => expect(http.status).toHaveBeenCalledOnce());
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(hook.getCurrent().completionState).toBe('expired');
        expect(hook.getCurrent().deepLink).toBeNull();
        expect(http.status).toHaveBeenCalledOnce();
    });

    it('terminalizes a non-transient status rejection instead of polling again', async () => {
        const home = await addHome();
        vi.useFakeTimers();
        http.status.mockImplementation(async () => json(403, {}));
        const hook = await mountPairing(home);
        await start(hook);
        await vi.waitFor(() => expect(hook.getCurrent().completionState).toBe('invalid_request'));
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        expect(http.status).toHaveBeenCalledOnce();
        expect(hook.getCurrent().deepLink).toBeNull();
    });

    it('ignores a stale status completion and cancels future polling when disabled', async () => {
        const home = await addHome();
        vi.useFakeTimers();
        const hook = await mountPairing(home);
        const pairing = await requestedPair(hook);
        await vi.waitFor(() => expect(http.status).toHaveBeenCalledOnce());
        await hook.rerender({ enabled: false });
        await pairing.release();
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect(http.status).toHaveBeenCalledOnce();
        expect(http.complete).not.toHaveBeenCalled();
        expect(hook.getCurrent()).toMatchObject({ deepLink: null, status: null });
    });

    it('automatically completes the first valid bound request once and stops polling without creating a successor QR', async () => {
        const home = await addHome();
        vi.useFakeTimers();
        const hook = await mountPairing(home);
        const pairing = await requestedPair(hook);
        await pairing.release();
        await vi.waitFor(() => expect(hook.getCurrent().completionState).toBe('completed'));
        expect(http.complete).toHaveBeenCalledOnce();
        expect(http.complete.mock.calls[0]![0]).toMatchObject({ origin: home.serverUrl, token: home.token });
        expect(bodyRecord(http.complete.mock.calls[0]![0])).toMatchObject({
            pairId: 'pair_123', homeServerIdentityId: home.descriptor.homeServerIdentityId, responseKind: 'tokenOnly',
        });
        expect(hook.getCurrent().deepLink).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect(http.status).toHaveBeenCalledOnce();
        expect(http.complete).toHaveBeenCalledOnce();
        expect(http.start).toHaveBeenCalledOnce();
    });

    it('does not dispatch credential completion after the displaying screen unmounts', async () => {
        const home = await addHome();
        const held = createDeferred<Response>();
        const entered = createDeferred<void>();
        http.currentness.mockImplementationOnce(async () => { entered.resolve(); return held.promise; });
        const hook = await mountPairing(home);
        const pairing = await requestedPair(hook);
        await pairing.release();
        await entered.promise;
        await hook.unmount();
        await act(async () => { held.resolve(json(200, createPlainAccountEncryptionCurrentnessFixture())); });
        await flushHookEffects();
        expect(http.currentness.mock.calls[0]![0].signal?.aborted).toBe(true);
        expect(http.complete).not.toHaveBeenCalled();
    });

    it('treats already_completed as successful completion', async () => {
        const home = await addHome();
        http.complete.mockImplementationOnce(async () => json(409, { error: 'already_completed' }));
        const hook = await mountPairing(home);
        const pairing = await requestedPair(hook);
        await pairing.release();
        await vi.waitFor(() => expect(hook.getCurrent().completionState).toBe('completed'));
        expect(http.complete).toHaveBeenCalledOnce();
    });

    it.each([
        ['wrong Home', { homeServerIdentityId: 'srv_home_b' }],
        ['wrong pair', { pairId: 'pair_other' }],
        ['wrong expiry', { expiresAt: 'different' }],
        ['invalid requester key', { requestedPublicKey: encodeBase64(new Uint8Array(31)) }],
        ['wrong proof', { bindingProof: encodeBase64(new Uint8Array(32).fill(4), 'base64url') }],
    ] as const)('rejects %s before credential response and exposes one new-QR recovery', async (_label, override) => {
        const home = await addHome();
        const hook = await mountPairing(home);
        const pairing = await requestedPair(hook, 'expiresAt' in override && override.expiresAt === 'different'
            ? { expiresAt: new Date(Date.now() + 30_000).toISOString() }
            : override);
        await pairing.release();
        await vi.waitFor(() => expect(hook.getCurrent().completionState).toBe('invalid_request'));
        expect(http.complete).not.toHaveBeenCalled();
        expect(http.consume).toHaveBeenCalledOnce();
        expect(bodyRecord(http.consume.mock.calls[0]![0])).toEqual({ pairId: pairing.invite.pairId, intent: 'reject' });
        expect(hook.getCurrent()).toMatchObject({ pairingContext: null, deepLink: null });
        // A deliberate new code is the only recovery; no background successor is created.
        expect(http.start).toHaveBeenCalledOnce();
    });

    it('retries the same verified bound request after a transient completion failure', async () => {
        const home = await addHome();
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        http.complete.mockImplementationOnce(async () => { throw new Error('offline'); });
        const hook = await mountPairing(home);
        const pairing = await requestedPair(hook);
        await pairing.release();
        await vi.waitFor(() => expect(hook.getCurrent().completionState).toBe('retrying'));
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        await vi.waitFor(() => expect(hook.getCurrent().completionState).toBe('completed'));
        expect(http.complete).toHaveBeenCalledTimes(2);
        const first = bodyRecord(http.complete.mock.calls[0]![0]);
        const retry = bodyRecord(http.complete.mock.calls[1]![0]);
        expect(retry).toMatchObject({
            pairId: first.pairId, publicKey: first.publicKey, homeServerIdentityId: first.homeServerIdentityId,
            responseKind: first.responseKind,
        });
        expect(http.start).toHaveBeenCalledOnce();
    });

    it('allows cancellation only while pending and never submits a credential response', async () => {
        const home = await addHome();
        const hook = await mountPairing(home);
        await start(hook);
        await act(async () => { await expect(hook.getCurrent().cancelPairing()).resolves.toEqual({ ok: true }); });
        expect(http.consume).toHaveBeenCalledOnce();
        expect(bodyRecord(http.consume.mock.calls[0]![0])).toEqual({ pairId: 'pair_123', intent: 'cancel' });
        expect(http.consume.mock.calls[0]![0]).toMatchObject({ origin: home.serverUrl, token: home.token });
        expect(http.complete).not.toHaveBeenCalled();
        expect(hook.getCurrent().deepLink).toBeNull();
        await act(async () => { await expect(hook.getCurrent().cancelPairing()).resolves.toEqual({ ok: false, status: 409 }); });
    });

    it('honors a pending cancellation intent when requested status arrives concurrently', async () => {
        const home = await addHome();
        const cancelReply = createDeferred<Response>();
        http.consume.mockImplementationOnce(async () => cancelReply.promise);
        const hook = await mountPairing(home);
        const pairing = await requestedPair(hook);
        await vi.waitFor(() => expect(http.status).toHaveBeenCalledOnce());
        let cancelling: ReturnType<ReturnType<typeof usePairingSession>['cancelPairing']> | undefined;
        await act(async () => { cancelling = hook.getCurrent().cancelPairing(); });
        await pairing.release();
        expect(http.complete).not.toHaveBeenCalled();
        await act(async () => {
            cancelReply.resolve(json(200, { success: true }));
            await expect(cancelling).resolves.toEqual({ ok: true });
        });
        expect(http.complete).not.toHaveBeenCalled();
    });

    it('does not retry a terminal completion response and requires a new QR', async () => {
        const home = await addHome();
        vi.useFakeTimers();
        http.complete.mockImplementation(async () => json(403, {}));
        const hook = await mountPairing(home);
        const pairing = await requestedPair(hook);
        await pairing.release();
        await vi.waitFor(() => expect(hook.getCurrent().completionState).toBe('completion_failed'));
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect(http.complete).toHaveBeenCalledOnce();
        expect(hook.getCurrent()).toMatchObject({ deepLink: null, pairingContext: null });
    });

    it('pairs against an explicitly targeted saved Home instead of the focused one', async () => {
        const focused = await addHome();
        await restoreFocused(focused);
        const target = await addHome({ serverUrl: 'https://home-b.test', identity: 'srv_home_b', accountId: 'target-account' });
        const focusedId = profiles.getActiveServerId();
        const hook = await mountPairing(target);
        const pairing = await requestedPair(hook);
        await pairing.release();
        await vi.waitFor(() => expect(hook.getCurrent().completionState).toBe('completed'));
        expect(http.start).toHaveBeenCalledOnce();
        expect(http.start.mock.calls[0]![0]).toMatchObject({ origin: target.serverUrl, token: target.token });
        expect(http.start.mock.calls[0]![0].token).not.toBe(focused.token);
        expect(http.complete).toHaveBeenCalledOnce();
        expect(http.complete.mock.calls[0]![0]).toMatchObject({ origin: target.serverUrl, token: target.token });
        expect(profiles.getActiveServerId()).toBe(focusedId);
        expect(pairing.invite.home.homeServerIdentityId).toBe('srv_home_b');
    });
});
