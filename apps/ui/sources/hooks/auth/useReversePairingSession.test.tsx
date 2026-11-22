import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    computeHomeQrBindingProofV2,
    deriveHomeQrBindingKeyV2,
    deriveHomeQrRendezvousSecretV2,
    type HomeQrInviteV2,
} from '@happier-dev/protocol/crypto/qrProvisioningV2';
import { HomeConnectionDescriptorV1Schema, type HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { sealTerminalProvisioningV3TokenOnlyPayload } from '@happier-dev/protocol/crypto/terminalProvisioningV2';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createHomeGovernanceHarness } from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { waitForNetworkResponseForTests } from '@/dev/testkit/mocks/runtimeFetch';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';

installTokenStorageWebPlatformMocks();
await initializeRealAppRuntimeForTests();
const profiles = await import('@/sync/domains/server/serverProfiles');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { buildHomeQrInviteDeepLink, parseHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
const { encryptBox } = await import('@/encryption/libsodium');
const { useReversePairingSession } = await import('./useReversePairingSession');

const descriptor = HomeConnectionDescriptorV1Schema.parse({
    v: 1,
    homeServerIdentityId: 'srv_home_known',
    canonicalServerUrl: 'https://known-home.example.test',
    revision: 7,
    endpoints: [{ kind: 'https', url: 'https://known-home.example.test' }],
});
const oversizedDescriptor = HomeConnectionDescriptorV1Schema.parse({
    ...descriptor, revision: descriptor.revision + 1,
    endpoints: [descriptor.endpoints[0], ...Array.from({ length: 15 }, (_, index) => ({
        kind: 'https', url: `https://endpoint-${index}.example.test/${'segment'.repeat(40)}`,
    }))],
});
type HttpRequest = Readonly<{
    origin: string;
    path: string;
    body: Record<string, unknown>;
    token: string | null;
    signal?: AbortSignal | null;
}>;
type HttpReply = (request: HttpRequest) => Promise<Response>;
const homes = createHomeGovernanceHarness();
const requests: HttpRequest[] = [];
const http = {
    features: vi.fn<HttpReply>(),
    register: vi.fn<HttpReply>(),
    poll: vi.fn<HttpReply>(),
};
const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
let localStorage: ReturnType<typeof installLocalStorageMock> | null = null;
let homeDescriptor = descriptor;
let profileId = '';
let features = createRootLayoutFeaturesResponse();
// Release holds after each test, including continuations that deliberately
// survive presentation teardown after the Home accepts their requester tuple.
const heldResponses: Array<ReturnType<typeof createDeferred<Response>>> = [];

function json(status: number, body: unknown): Response {
    return Response.json(body, { status });
}

function holdResponse(): ReturnType<typeof createDeferred<Response>> {
    const held = createDeferred<Response>();
    heldResponses.push(held);
    return held;
}

function requestsFor(path: string): HttpRequest[] {
    return requests.filter(request => request.path === path);
}

const request: Parameters<typeof setRuntimeFetch>[0] = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const bearer = new Headers(init?.headers).get('Authorization');
    const observed: HttpRequest = {
        origin: url.origin,
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
        token: bearer?.startsWith('Bearer ') ? bearer.slice(7) : null,
        signal: init?.signal,
    };
    requests.push(observed);
    if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return json(200, {});
    let pending: Promise<Response>;
    if (url.pathname === '/v1/features') pending = http.features(observed);
    else if (url.pathname === '/v1/auth/pairing/request') pending = http.register(observed);
    else if (url.pathname === '/v2/auth/account/request') {
        pending = 'pairId' in observed.body ? http.poll(observed) : Promise.resolve(json(200, { state: 'requested' }));
    } else return homes.request(input, init);
    return await waitForNetworkResponseForTests(pending, init?.signal);
};

async function seedHome(connectionDescriptor: HomeConnectionDescriptorV1 = descriptor): Promise<void> {
    homeDescriptor = connectionDescriptor;
    profileId = await homes.addHome({
        name: 'Known Home', serverUrl: connectionDescriptor.canonicalServerUrl,
        serverIdentityId: connectionDescriptor.homeServerIdentityId,
        accountId: null, active: false,
    });
    const profile = await profiles.adoptHomeProfile({
        descriptor: connectionDescriptor, source: 'manual', descriptorAuthority: 'current_connection_observation',
    });
    profileId = profile.id;
    features = createRootLayoutFeaturesResponse();
    features.capabilities.serverIdentity.serverIdentityId = connectionDescriptor.homeServerIdentityId;
    features.capabilities.server.canonicalServerUrl = connectionDescriptor.canonicalServerUrl;
    if (!tryWriteServerEnabledBitInPlace(features, 'auth.pairing.boundQrV2', true)) {
        throw new Error('Expected the bound QR feature fixture');
    }
}

async function mount(beforeAdoption?: (signal: AbortSignal) => Promise<(() => void) | undefined>) {
    return renderHook(() => useReversePairingSession({ enabled: true, targetProfileId: profileId, beforeAdoption }));
}

function readyInvite(hook: Awaited<ReturnType<typeof mount>>): HomeQrInviteV2 {
    const presentation = hook.getCurrent().presentation;
    if (presentation.phase !== 'ready') throw new Error('Expected a ready reverse invite');
    const parsed = parseHomeQrInviteDeepLink(presentation.link, {
        homeServerIdentityId: homeDescriptor.homeServerIdentityId, direction: 'requester_displays',
    });
    if (!parsed) throw new Error('Expected the real link to contain a valid target-bound invite');
    return parsed.invite;
}

function authorized(invite: HomeQrInviteV2, token: string): Response {
    if (invite.direction !== 'requester_displays') throw new Error('Expected requester-displayed invite');
    const publicKey = decodeBase64(invite.requesterPublicKeyBase64Url, 'base64url');
    return json(200, {
        state: 'authorized',
        tokenEncrypted: encodeBase64(encryptBox(new TextEncoder().encode(token), publicKey)),
        response: encodeBase64(sealTerminalProvisioningV3TokenOnlyPayload({
            terminalEphemeralPublicKey: publicKey,
            pairingSecret: deriveHomeQrBindingKeyV2(decodeBase64(invite.qrSecretBase64Url, 'base64url')),
            createdAtMs: invite.issuedAtMs, expiresAtMs: invite.expiresAtMs,
            randomBytes: tweetnacl.randomBytes,
        })),
    });
}

beforeEach(async () => {
    vi.useRealTimers();
    process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = 'reverse_pairing_' + crypto.randomUUID();
    localStorage = installLocalStorageMock();
    await homes.reset();
    requests.length = 0;
    heldResponses.length = 0;
    resetServerFeaturesClientForTests();
    http.features.mockReset().mockImplementation(async () => json(200, { ...features, homeConnectionDescriptor: homeDescriptor }));
    http.register.mockReset().mockImplementation(async () => json(200, { state: 'requested' }));
    const poll = holdResponse();
    http.poll.mockReset().mockImplementation(() => poll.promise);
    setRuntimeFetch(request);
    await seedHome();
});

afterEach(async () => {
    await standardCleanup();
    for (const held of heldResponses) held.resolve(json(410, { error: 'expired' }));
    await flushHookEffects();
    vi.useRealTimers();
    await homes.reset();
    localStorage?.restore();
    localStorage = null;
    if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
    vi.restoreAllMocks();
});

describe('useReversePairingSession', () => {
    it('owns and aborts target verification from the beginning of the generation', async () => {
        const pending = holdResponse();
        http.features.mockImplementation(() => pending.promise);
        const hook = await mount();
        await vi.waitFor(() => expect(http.features).toHaveBeenCalledOnce());
        const signal = requestsFor('/v1/features')[0]?.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        await hook.unmount();
        expect(signal?.aborted).toBe(true);
        expect(requestsFor('/v2/auth/account/request')).toEqual([]);
    });

    it('does not acquire a carrier without an explicit known target profile', async () => {
        const hook = await renderHook(() => useReversePairingSession({ enabled: true, targetProfileId: null }));
        await vi.waitFor(() => expect(hook.getCurrent().presentation.phase).toBe('invalid'));
        expect(requests).toEqual([]);
        await hook.unmount();
    });

    it('does not create a requester invite when the exact Home lacks bound QR v2', async () => {
        tryWriteServerEnabledBitInPlace(features, 'auth.pairing.boundQrV2', false);
        const hook = await mount();
        await vi.waitFor(() => expect(hook.getCurrent().presentation.phase).toBe('update_required'));
        expect(requestsFor('/v2/auth/account/request')).toEqual([]);
        expect(requestsFor('/v1/auth/pairing/start')).toEqual([]);
        expect(requestsFor('/v1/auth/pairing/request')).toEqual([]);
        await hook.unmount();
    });

    it('displays the requester invite before the authenticated scanner creates the Home pairing row', async () => {
        const pending = holdResponse();
        http.register.mockImplementation(() => pending.promise);
        const hook = await mount();
        await vi.waitFor(() => expect(hook.getCurrent().presentation.phase).toBe('ready'));
        readyInvite(hook);
        expect(requestsFor('/v1/auth/pairing/start')).toEqual([]);
        expect(requestsFor('/v2/auth/account/request')).toHaveLength(1);
        expect(requestsFor('/v1/auth/pairing/request')).toHaveLength(1);
        expect(hook.getCurrent().canCancel).toBe(true);
        await hook.unmount();
    });

    it('keeps the invite visible but transfers cancellation authority after requester registration', async () => {
        const hook = await mount();
        await vi.waitFor(() => expect(http.poll).toHaveBeenCalledOnce());
        expect(hook.getCurrent().presentation.phase).toBe('ready');
        expect(hook.getCurrent().canCancel).toBe(false);
        const signal = requestsFor('/v2/auth/account/request')[1]?.signal;
        await act(async () => hook.getCurrent().cancel());
        expect(signal?.aborted).toBe(false);
        expect(hook.getCurrent().presentation.phase).toBe('ready');
        await hook.unmount();
    });

    it('uses one exact known HTTPS target through claim, polling, and non-focusing adoption', async () => {
        const hook = await mount();
        await vi.waitFor(() => expect(http.poll).toHaveBeenCalledOnce());
        const invite = readyInvite(hook);
        expect(hook.getCurrent().canCancel).toBe(false);
        expect(requestsFor('/v1/auth/pairing/start')).toEqual([]);
        const focused = await profiles.upsertServerProfile({ serverUrl: 'https://another-home.example.test', source: 'manual' });
        await profiles.setActiveServerId(focused.id);
        const focusBefore = profiles.getActiveServerSnapshot();
        await act(async () => heldResponses[0]!.resolve(authorized(invite, 'known-home-token')));
        await vi.waitFor(() => expect(hook.getCurrent().presentation.phase).toBe('succeeded'));
        const qrSecret = decodeBase64(invite.qrSecretBase64Url, 'base64url');
        if (invite.direction !== 'requester_displays') throw new Error('Expected reverse invite');
        const publicKey = decodeBase64(invite.requesterPublicKeyBase64Url, 'base64url');
        expect(requestsFor('/v1/auth/pairing/request')[0]).toMatchObject({
            origin: descriptor.canonicalServerUrl, token: null,
            body: {
                pairId: invite.pairId, homeServerIdentityId: descriptor.homeServerIdentityId,
                expiresAtMs: invite.expiresAtMs, publicKey: encodeBase64(publicKey),
                secret: encodeBase64(deriveHomeQrRendezvousSecretV2(qrSecret), 'base64url'),
                bindingProof: computeHomeQrBindingProofV2({
                    direction: invite.direction, qrSecret, pairId: invite.pairId,
                    homeServerIdentityId: descriptor.homeServerIdentityId, requesterPublicKey: publicKey,
                    expiresAtMs: invite.expiresAtMs,
                }),
            },
        });
        expect(requestsFor('/v2/auth/account/request').every(request => request.origin === descriptor.canonicalServerUrl && request.token === null)).toBe(true);
        await expect(TokenStorage.getCredentialsForServerUrl(descriptor.canonicalServerUrl, { serverId: descriptor.homeServerIdentityId }))
            .resolves.toEqual({ token: 'known-home-token' });
        expect(profiles.getServerProfileById(profileId)?.name).toBe('Known Home');
        expect(profiles.getActiveServerSnapshot()).toEqual(focusBefore);
        expect(hook.getCurrent().presentation).toEqual({ phase: 'succeeded', descriptor, profileId });
        await hook.unmount();
    });

    it('captures the settled Approved presentation before writing the Home credential', async () => {
        let captureApproved: () => void = () => {};
        const painted = new Promise<undefined>(resolve => { captureApproved = () => resolve(undefined); });
        const hook = await mount(() => painted);
        await vi.waitFor(() => expect(http.poll).toHaveBeenCalledOnce());
        const invite = readyInvite(hook);
        await act(async () => heldResponses[0]!.resolve(authorized(invite, 'known-home-token')));
        await vi.waitFor(() => expect(hook.getCurrent().presentation.phase).toBe('adding'));
        const readCredentials = () => TokenStorage.getCredentialsForServerUrl(descriptor.canonicalServerUrl, { serverId: descriptor.homeServerIdentityId });
        await expect(readCredentials()).resolves.toBeNull();
        await act(async () => captureApproved());
        await vi.waitFor(() => expect(hook.getCurrent().presentation.phase).toBe('succeeded'));
        await expect(readCredentials()).resolves.toEqual({ token: 'known-home-token' });
        await hook.unmount();
    });

    it('detaches presentation without aborting server-authoritative completion and adoption', async () => {
        const hook = await mount();
        await vi.waitFor(() => expect(http.poll).toHaveBeenCalledOnce());
        const invite = readyInvite(hook);
        const signal = requestsFor('/v2/auth/account/request')[1]?.signal;
        await hook.unmount();
        expect(signal?.aborted).toBe(false);
        await act(async () => heldResponses[0]!.resolve(authorized(invite, 'immutable-home-token')));
        await vi.waitFor(async () => expect(await TokenStorage.getCredentialsForServerUrl(descriptor.canonicalServerUrl, {
            serverId: descriptor.homeServerIdentityId,
        })).toEqual({ token: 'immutable-home-token' }));
        expect(profiles.getServerProfileById(profileId)?.homeConnectionDescriptor).toEqual(descriptor);
    });

    it('keeps an oversized valid invite live as an exact warned link without a QR image', async () => {
        await seedHome(oversizedDescriptor);
        const pending = holdResponse();
        http.register.mockImplementation(() => pending.promise);
        const hook = await mount();
        await vi.waitFor(() => expect(hook.getCurrent().presentation.phase).toBe('ready'));
        const invite = readyInvite(hook);
        expect(hook.getCurrent().presentation).toMatchObject({
            phase: 'ready', qrAvailable: false, link: buildHomeQrInviteDeepLink({ invite }), descriptor: oversizedDescriptor,
        });
        expect(hook.getCurrent().canCancel).toBe(true);
        await hook.unmount();
    });

    it('cancels the one pre-claim attempt without allowing it to continue', async () => {
        await seedHome(oversizedDescriptor);
        const pending = holdResponse();
        http.register.mockImplementation(() => pending.promise);
        const hook = await mount();
        await vi.waitFor(() => expect(hook.getCurrent().canCancel).toBe(true));
        expect(hook.getCurrent().presentation).toMatchObject({ qrAvailable: false });
        const signal = requestsFor('/v1/auth/pairing/request')[0]?.signal;
        await act(async () => hook.getCurrent().cancel());
        expect(signal?.aborted).toBe(true);
        expect(requestsFor('/v1/auth/pairing/start')).toEqual([]);
        expect(requestsFor('/v1/auth/pairing/consume')).toEqual([]);
        expect(hook.getCurrent().presentation).toEqual({ phase: 'retryable_error', descriptor: oversizedDescriptor, partialCommit: null });
        expect(http.poll).not.toHaveBeenCalled();
        await act(async () => pending.resolve(json(200, { state: 'requested' })));
        expect(http.poll).not.toHaveBeenCalled();
        const retry = holdResponse();
        http.register.mockImplementation(() => retry.promise);
        await act(async () => { void hook.getCurrent().start(); });
        await vi.waitFor(() => expect(hook.getCurrent().presentation.phase).toBe('ready'));
        expect(requestsFor('/v1/auth/pairing/request')).toHaveLength(2);
        await hook.unmount();
    });

    it('waits through a missing pre-row response and retries the same bound request after the scanner starts it', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        http.register.mockResolvedValueOnce(json(404, { error: 'not_found' }));
        const hook = await mount();
        await vi.waitFor(() => expect(http.register).toHaveBeenCalledOnce());
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        expect(requestsFor('/v1/auth/pairing/request')).toHaveLength(2);
        expect(requestsFor('/v1/auth/pairing/request')[1]?.body).toEqual(requestsFor('/v1/auth/pairing/request')[0]?.body);
        expect(requestsFor('/v1/auth/pairing/start')).toEqual([]);
        expect(hook.getCurrent().presentation.phase).toBe('ready');
        expect(hook.getCurrent().canCancel).toBe(false);
        await hook.unmount();
    });

    it('treats a malformed or target-rejected request as terminal instead of retrying', async () => {
        http.register.mockResolvedValueOnce(json(403, { error: 'invalid_target' }));
        const hook = await mount();
        await vi.waitFor(() => expect(hook.getCurrent().presentation.phase).toBe('invalid'));
        expect(requestsFor('/v1/auth/pairing/request')).toHaveLength(1);
        expect(http.poll).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('distinguishes the canonical target-qualified adoption partial commit', async () => {
        const { MMKV } = await import('react-native-mmkv');
        const profileStorage: { current: InstanceType<typeof MMKV> | null } = { current: null };
        const getString = MMKV.prototype.getString;
        // The Node fixture has no DOM, so the profile owner uses its native
        // MMKV port even though the credential owner uses the web storage port.
        vi.spyOn(MMKV.prototype, 'getString').mockImplementation(function (this: InstanceType<typeof MMKV>, key) {
            if (key === 'server-state-v1') profileStorage.current = this;
            return getString.call(this, key);
        });
        const hook = await mount();
        await vi.waitFor(() => expect(http.poll).toHaveBeenCalledOnce());
        expect(profileStorage.current).not.toBeNull();
        const invite = readyInvite(hook);
        const storage = localStorage!;
        const credential = { token: 'partial-home-token' };
        const concurrentWinner = { token: 'concurrent-home-token' };
        let ownershipChanged = false;
        // A second storage writer changes descriptor content and credential
        // ownership between the two commits. Conflict detection and rollback stay real.
        storage.setItemMock.mockImplementation((key, value) => {
            storage.store.set(key, value);
            if (value !== JSON.stringify(credential)) return;
            const raw = profileStorage.current?.getString('server-state-v1');
            if (!raw) throw new Error('Expected the persisted Home profile boundary');
            const persisted: unknown = JSON.parse(raw);
            if (!persisted || typeof persisted !== 'object' || !('servers' in persisted)) {
                throw new Error('Expected stored Home profiles');
            }
            const state = persisted as { servers: Record<string, { homeConnectionDescriptor?: HomeConnectionDescriptorV1 }> };
            const profile = state.servers[profileId];
            if (!profile?.homeConnectionDescriptor) throw new Error('Expected the target Home descriptor');
            profile.homeConnectionDescriptor = {
                ...descriptor,
                endpoints: [...descriptor.endpoints, { kind: 'https', url: 'https://conflicting-endpoint.example.test' }],
            };
            profileStorage.current!.set('server-state-v1', JSON.stringify(state));
            storage.store.set(key, JSON.stringify(concurrentWinner));
            ownershipChanged = true;
        });
        await act(async () => heldResponses[0]!.resolve(authorized(invite, credential.token)));
        await vi.waitFor(() => expect(hook.getCurrent().presentation.phase).toBe('retryable_error'));
        expect(ownershipChanged).toBe(true);
        expect(hook.getCurrent().presentation).toMatchObject({
            phase: 'retryable_error', descriptor,
            partialCommit: {
                canonicalServerUrl: descriptor.canonicalServerUrl,
                serverIdentityId: descriptor.homeServerIdentityId,
                rollbackOutcome: { kind: 'not_applied', reason: 'ownership_changed' },
            },
        });
        await expect(TokenStorage.getCredentialsForServerUrl(descriptor.canonicalServerUrl, { serverId: descriptor.homeServerIdentityId }))
            .resolves.toEqual(concurrentWinner);
        await hook.unmount();
    });
});
