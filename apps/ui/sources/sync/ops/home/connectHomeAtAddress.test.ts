import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { RELEASED_SERVER_V0_2_1_FEATURES_JSON } from '@/dev/testkit/fixtures/releasedServerV021Compatibility';

const boundary = vi.hoisted(() => ({ fetch: vi.fn() }));

installTokenStorageWebPlatformMocks();
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: boundary.fetch ,
    get runtimeFetchManualResponse() { return this.runtimeFetch; },
}));

// Compile the real Action entry graph before per-test deadlines. Its first
// dynamic import must not consume the behavior budget under shared-host load.
await import('@/sync/ops/actions/machineConnectionActionDeps');

const enteredUrl = 'https://home.example.test';
const canonicalUrl = 'https://canonical.example.test';
const homeIdentity = 'srv_home_connect_1';

function featurePayload(input?: { serviceMode?: 'self' | 'disabled' | 'external' }) {
    const base = createRootLayoutFeaturesResponse({
        capabilities: {
            server: { canonicalServerUrl: canonicalUrl },
            serverIdentity: { serverIdentityId: homeIdentity },
        },
    });
    if (!input?.serviceMode) return base;
    return {
        ...createRootLayoutFeaturesResponse({
            capabilities: {
                server: { canonicalServerUrl: canonicalUrl },
                serverIdentity: { serverIdentityId: homeIdentity },
                accountDirectory: {
                    version: 1,
                    homeDirectory: true,
                    homeEnrollment: true,
                    homeLoginAssertion: {
                        keyId: 'a'.repeat(64),
                        publicKeyBase64Url: 'A'.repeat(43),
                    },
                },
                auth: {
                    ...base.capabilities.auth,
                    methods: [{ id: 'key_challenge', actions: [{ id: 'login', enabled: true, mode: 'keyed' }] }],
                    keyChallenge: { v2: true },
                },
            },
        }),
        signInService: input.serviceMode === 'external'
            ? { v: 1, mode: 'external', endpoint: 'https://selected-service.example.test' }
            : { v: 1, mode: input.serviceMode },
        accountServicePresentation: { v: 1, displayName: 'Example Accounts' },
    };
}

function response(status: number, payload: unknown = {}): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('connectHomeAtAddress', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    let storage: ReturnType<typeof installLocalStorageMock>;
    let locks: ReturnType<typeof installWebLockManagerMock>;
    let advertisedFeatures: unknown = featurePayload();
    let healthStatus = 200;
    let featuresStatus = 200;
    let onFeaturesRequest: (() => void) | null = null;

    beforeEach(() => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `connect_home_${Date.now()}_${Math.random()}`;
        storage = installLocalStorageMock();
        locks = installWebLockManagerMock();
        vi.stubGlobal('window', { location: { origin: 'https://client.example.test' } });
        vi.stubGlobal('location', { protocol: 'https:' });
        advertisedFeatures = featurePayload();
        healthStatus = 200;
        featuresStatus = 200;
        onFeaturesRequest = null;
        boundary.fetch.mockReset().mockImplementation(async (url: RequestInfo | URL) => {
            const path = String(url);
            if (path.endsWith('/health')) return response(healthStatus, { status: 'ok' });
            if (path.endsWith('/v1/features') || path.endsWith('/v1/features/authenticated')) {
                onFeaturesRequest?.();
                return response(featuresStatus, advertisedFeatures);
            }
            if (path.endsWith('/v1/auth/entry')) return response(404);
            throw new Error(`Unexpected request: ${path}`);
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        locks.restore();
        storage.restore();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        vi.resetModules();
    });

    async function owner() {
        const [operation, profiles] = await Promise.all([
            import('./connectHomeAtAddress'),
            import('@/sync/domains/server/serverProfiles'),
        ]);
        const profileFacts = () => profiles.listServerProfiles().map((profile) => ({
            id: profile.id,
            serverUrl: profile.serverUrl,
            canonicalServerUrl: profile.canonicalServerUrl,
            serverIdentityId: profile.serverIdentityId,
            source: profile.source,
            addressSelection: profile.addressSelection,
        }));
        return { operation, profiles, before: profileFacts(), profileFacts };
    }

    function input(overrides: Partial<{
        serverUrl: string;
        source: 'manual' | 'url' | 'notification';
        signal: AbortSignal;
        confirmInsecureHttp: () => Promise<boolean>;
        confirmCanonicalUrl: () => Promise<boolean>;
    }> = {}) {
        return {
            serverUrl: enteredUrl,
            confirmInsecureHttp: vi.fn(async () => true),
            confirmCanonicalUrl: vi.fn(async () => true),
            ...overrides,
        };
    }

    it('rejects an invalid address without probing or saving', async () => {
        const { operation, before, profileFacts } = await owner();
        expect(await operation.connectHomeAtAddress(input({ serverUrl: 'ftp://home.example.test' })))
            .toEqual({ kind: 'invalid_address' });
        expect(boundary.fetch).not.toHaveBeenCalled();
        expect(profileFacts()).toEqual(before);
    });

    it('asks before insecure remote HTTP and leaves declined addresses unsaved', async () => {
        const { operation, before, profileFacts } = await owner();
        const attempt = input({ serverUrl: 'http://home.example.test', confirmInsecureHttp: async () => false });
        expect(await operation.connectHomeAtAddress(attempt)).toEqual({ kind: 'declined' });
        expect(boundary.fetch).not.toHaveBeenCalled();
        expect(profileFacts()).toEqual(before);
    });

    it('returns unreachable without saving, with the owning remediation when applicable', async () => {
        const { operation, before, profileFacts } = await owner();
        boundary.fetch.mockImplementation(async () => response(404));
        expect(await operation.connectHomeAtAddress(input({ serverUrl: 'https://home.tailnet.ts.net' })))
            .toMatchObject({ kind: 'unreachable', remediation: { kind: 'tailscale_unreachable' } });
        expect(profileFacts()).toEqual(before);
    });

    it('does not save browser-blocked mixed content', async () => {
        const { operation, before, profileFacts } = await owner();
        expect(await operation.connectHomeAtAddress(input({ serverUrl: 'http://home.example.test' })))
            .toEqual({ kind: 'mixed_content' });
        expect(boundary.fetch).not.toHaveBeenCalled();
        expect(profileFacts()).toEqual(before);
    });

    it.each(['disabled', 'external'] as const)('adopts a Directory-capable Home with %s sign-in delegation without changing the selected service', async (serviceMode) => {
        advertisedFeatures = featurePayload({ serviceMode });
        const { operation, profiles, before, profileFacts } = await owner();
        await profiles.setAccountServiceEndpoint({
            url: 'https://selected-service.example.test', displayName: 'Selected service', source: 'user',
        });
        const selectedService = profiles.resolveSelectedAccountServiceEndpoint();
        expect((await operation.connectHomeAtAddress(input())).kind).toBe('connected');
        expect(profileFacts().length).toBe(before.length + 1);
        expect(profiles.resolveSelectedAccountServiceEndpoint()).toEqual(selectedService);
    });

    it('connects a sign-in service that hosts its own Home', async () => {
        advertisedFeatures = featurePayload({ serviceMode: 'self' });
        const { operation, profiles, before } = await owner();
        expect((await operation.connectHomeAtAddress(input())).kind).toBe('connected');
        expect(profiles.listServerProfiles().length).toBe(before.length + 1);
    });

    it.each([401, 403])('connects when /health requires authentication (%i) but public features are readable', async (status) => {
        healthStatus = status;
        const { operation, before, profileFacts } = await owner();
        expect((await operation.connectHomeAtAddress(input())).kind).toBe('connected');
        expect(profileFacts().length).toBe(before.length + 1);
    });

    it('learns identity and canonical address before one save without switching focus', async () => {
        const { operation, profiles, before } = await owner();
        const activeBefore = profiles.getActiveServerSnapshot();
        const result = await operation.connectHomeAtAddress(input({ source: 'notification' }));
        expect(result.kind).toBe('connected');
        const added = profiles.listServerProfiles().filter((profile) => !before.some((saved) => saved.id === profile.id));
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({
            serverIdentityId: homeIdentity,
            canonicalServerUrl: canonicalUrl,
            source: 'notification',
        });
        expect(profiles.getActiveServerSnapshot().serverId).toBe(activeBefore.serverId);
        expect(boundary.fetch.mock.calls.filter(([url]) => String(url).endsWith('/health'))).toHaveLength(1);
    });

    it.each([false, true])('uses the query Home descriptor on a borrowed origin with saved Home=%s', async (saved) => {
        const origin = 'https://borrowed.example.test';
        vi.stubGlobal('window', { location: { origin, href: `${origin}/?server=${encodeURIComponent(enteredUrl)}` } });
        vi.stubGlobal('document', {});
        const descriptor = { v: 1 as const, homeServerIdentityId: homeIdentity, canonicalServerUrl: enteredUrl,
            revision: 10, endpoints: [{ kind: 'https' as const, url: enteredUrl }] };
        advertisedFeatures = { ...createRootLayoutFeaturesResponse({ capabilities: {
            server: { canonicalServerUrl: enteredUrl }, serverIdentity: { serverIdentityId: homeIdentity },
        } }), homeConnectionDescriptor: descriptor };
        const fetch = boundary.fetch.getMockImplementation()!;
        boundary.fetch.mockImplementation(async (url: RequestInfo | URL) => String(url).startsWith(`${origin}/v1/features`)
            ? response(200, createRootLayoutFeaturesResponse({ capabilities: {
                server: { canonicalServerUrl: origin }, serverIdentity: { serverIdentityId: 'srv_borrowed_origin' },
            } }))
            : fetch(url));
        const { operation, profiles } = await owner();
        const servingHome = await profiles.adoptHomeProfile({ descriptor: {
            v: 1, homeServerIdentityId: 'srv_borrowed_origin', canonicalServerUrl: origin,
            revision: 1, endpoints: [{ kind: 'https', url: origin }],
        }, source: 'manual' });
        if (saved) await profiles.adoptHomeProfile({ descriptor, source: 'manual' });
        await profiles.setActiveServerId(servingHome.id);
        const servingHomeBefore = profiles.getServerProfileById(servingHome.id);
        const { readWebServerUrlOverrideFromLocation } = await import('@/sync/domains/server/url/bootstrapActiveServerFromWebLocation');
        const override = readWebServerUrlOverrideFromLocation();
        expect(override?.serverUrl).toBe(enteredUrl);
        const attempt = input({ serverUrl: override!.serverUrl, confirmCanonicalUrl: vi.fn(async () => false) });
        expect(await operation.connectHomeAtAddress(attempt)).toMatchObject({ kind: 'connected', profile: {
            serverUrl: enteredUrl, canonicalServerUrl: enteredUrl, serverIdentityId: homeIdentity,
        } });
        expect(attempt.confirmCanonicalUrl).not.toHaveBeenCalled();
        expect(profiles.getServerProfileById(servingHome.id)).toEqual(servingHomeBefore);
    });

    it.each(['manual', 'url'] as const)('keeps the explicit %s address ahead of an unbound configured Home', async (source) => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SERVER_URL', canonicalUrl);
        vi.stubEnv('EXPO_PUBLIC_HAPPY_SERVER_CONTEXT', 'stack');
        const location = new URL('http://happier-repo-dev.localhost:19364/');
        if (source === 'url') location.searchParams.set('server', enteredUrl);
        vi.stubGlobal('window', { location });
        vi.stubGlobal('document', {});
        const { operation, profiles } = await owner();
        const configured = profiles.resolveUniqueServerProfileByUrl(canonicalUrl);
        expect(configured?.serverIdentityId).toBeUndefined();
        const { readWebServerUrlOverrideFromLocation } = await import('@/sync/domains/server/url/bootstrapActiveServerFromWebLocation');
        const serverUrl = source === 'url' ? readWebServerUrlOverrideFromLocation()!.serverUrl : enteredUrl;
        const result = await operation.connectHomeAtAddress(input({ serverUrl, source, confirmCanonicalUrl: async () => false }));
        const requests = boundary.fetch.mock.calls.map(([url]) => new URL(String(url)));
        expect(requests.some((url) => url.origin === enteredUrl && url.pathname === '/health')).toBe(true);
        expect(requests.some((url) => url.origin === enteredUrl && url.pathname === '/v1/features')).toBe(true);
        expect(requests.every((url) => url.origin === enteredUrl)).toBe(true);
        expect(result).toMatchObject({ kind: 'connected', profile: { serverIdentityId: homeIdentity } });
        if (result.kind !== 'connected') throw new Error('Expected Home connection');
        await profiles.setActiveServerId(result.profile.id);
        const { resolveActiveServerRuntimeOrigin } = await import('@/sync/runtime/nativeLoopbackTunnels/runtimeOrigin');
        expect(resolveActiveServerRuntimeOrigin(profiles.getActiveServerSnapshot())).toBe(enteredUrl);
        vi.resetModules();
        const reloaded = await owner();
        const { resolveActiveServerRuntimeOrigin: resolveReloadedOrigin } = await import('@/sync/runtime/nativeLoopbackTunnels/runtimeOrigin');
        expect(resolveReloadedOrigin(reloaded.profiles.getActiveServerSnapshot())).toBe(enteredUrl);
    });

    it('keeps the entered URL when canonical adoption is declined', async () => {
        const { operation, profiles, before } = await owner();
        const attempt = input({ confirmCanonicalUrl: async () => false });
        expect((await operation.connectHomeAtAddress(attempt)).kind).toBe('connected');
        const added = profiles.listServerProfiles().filter((profile) => !before.some((saved) => saved.id === profile.id));
        expect(added).toHaveLength(1);
        const { resolveHomeConnectionAddress } = await import('@/sync/domains/server/homeAddressSelection');
        expect(resolveHomeConnectionAddress(added[0]!)).toBe(enteredUrl);
        expect(added[0]?.serverIdentityId).toBe(homeIdentity);

        const { acquireAccountServiceAuthTransport } = await import('@/auth/accountDirectory/accountDirectoryAuthClient');
        const { fetchHomeAuthEntry } = await import('@/auth/entry/authEntryClient');
        const acquired = await acquireAccountServiceAuthTransport({
            serverIdentityId: homeIdentity,
            canonicalServerUrl: canonicalUrl,
        });
        try {
            boundary.fetch.mockClear();
            await fetchHomeAuthEntry({ endpointUrl: canonicalUrl, serverId: homeIdentity, ...acquired.transport });
            expect(boundary.fetch.mock.calls.map(([url]) => new URL(String(url)).origin)).toEqual([enteredUrl]);
        } finally {
            await acquired.close();
        }

        // The direct Home sign-in catalog reads this saved Home before focusing it.
        // Its feature read must honor the same Keep answer as auth entry.
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        boundary.fetch.mockClear();
        expect(await getServerFeaturesSnapshot({ serverId: added[0]!.id, force: true })).toMatchObject({ status: 'ready' });
        const featureRequests = boundary.fetch.mock.calls.map(([url]) => new URL(String(url)))
            .filter((url) => url.pathname === '/v1/features');
        expect(featureRequests.map((url) => url.origin)).toEqual([enteredUrl]);
    });

    it.each([false, true])('keeps a signed-in Home credential and the chosen alias with descriptor=%s', async (hasDescriptor) => {
        const { operation, profiles } = await owner();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const descriptor = { v: 1 as const, homeServerIdentityId: homeIdentity, canonicalServerUrl: canonicalUrl,
            revision: 7, endpoints: [{ kind: 'https' as const, url: canonicalUrl }] };
        if (hasDescriptor) advertisedFeatures = { ...featurePayload(), homeConnectionDescriptor: descriptor };
        const existing = await profiles.adoptHomeProfile({
            descriptor: hasDescriptor ? descriptor : { serverUrl: canonicalUrl, canonicalServerUrl: canonicalUrl, homeServerIdentityId: homeIdentity },
            source: 'manual',
        });
        await profiles.setActiveServerId(existing.id);
        const credentials = { token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhY2NvdW50X2EifQ.sig' };
        await TokenStorage.setCredentialsForServerUrl(canonicalUrl, { serverId: homeIdentity }, credentials);
        const confirmCanonicalUrl = vi.fn(async (addressChange?: { previousUrl: string; nextUrl: string }) => Boolean(addressChange));
        const attempt = input({ confirmCanonicalUrl });
        expect((await operation.connectHomeAtAddress(attempt)).kind).toBe('connected');
        expect(confirmCanonicalUrl).toHaveBeenCalledWith({ previousUrl: canonicalUrl, nextUrl: enteredUrl });
        expect(await TokenStorage.getCredentials()).toEqual(credentials);
        if (hasDescriptor) {
            const { acquireEligibleHomeCarrier } = await import('@/sync/runtime/homeCarrierPolicy');
            const acquired = await acquireEligibleHomeCarrier({ descriptor,
                verification: { kind: 'authenticated', token: credentials.token }, credentials });
            expect(acquired).toEqual({ kind: 'https', runtimeOrigin: enteredUrl });
            profiles.publishActiveServerRuntimeOrigin({ target: profiles.captureActiveServerRuntimeTarget(),
                leaseId: 'test-alias-selection', carrier: 'https', runtimeOrigin: enteredUrl });
        }
        const { resolveActiveServerRuntimeOrigin } = await import('@/sync/runtime/nativeLoopbackTunnels/runtimeOrigin');
        expect(resolveActiveServerRuntimeOrigin(profiles.getActiveServerSnapshot())).toBe(enteredUrl);
        const { resolveHomeAuthenticationTarget } = await import('@/auth/flows/resolveHomeAuthenticationTarget');
        expect(resolveHomeAuthenticationTarget({ kind: 'saved_profile', profileRef: existing.id })).toMatchObject({
            endpointUrl: canonicalUrl, canonicalServerUrl: canonicalUrl, serverIdentityId: homeIdentity,
        });
        const { resolveServerScopedTransport } = await import('@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport');
        const transport = await resolveServerScopedTransport({ profile: profiles.getServerProfileById(existing.id)!, credentials });
        expect(transport).toMatchObject({ runtimeOrigin: enteredUrl, canonicalServerUrl: canonicalUrl });
        await transport.release();
        const minimalTransport = await resolveServerScopedTransport({ profile: { serverUrl: canonicalUrl }, credentials });
        expect(minimalTransport).toMatchObject({ runtimeOrigin: enteredUrl, canonicalServerUrl: canonicalUrl });
        await minimalTransport.release();
        const unrelatedTransport = await resolveServerScopedTransport({ profile: {
            serverUrl: canonicalUrl, serverIdentityId: 'srv_unrelated_home',
        }, credentials: { token: 'unrelated-account-token' } });
        expect(unrelatedTransport.runtimeOrigin).toBe(canonicalUrl);
        await unrelatedTransport.release();
        const { resolveHomeEnrollmentTransport, buildEstablishedHomeTransportDescriptor } = await import('@/auth/enrollment/homeEnrollmentTransport');
        const enrollment = await resolveHomeEnrollmentTransport(hasDescriptor ? descriptor : buildEstablishedHomeTransportDescriptor({
            canonicalServerUrl: canonicalUrl, homeServerIdentityId: homeIdentity,
        })!);
        expect(enrollment).toMatchObject({ ok: true, transport: { runtimeOrigin: enteredUrl, canonicalServerUrl: canonicalUrl } });
        if (enrollment.ok) await enrollment.transport.close();
        vi.resetModules();
        const reloaded = await owner();
        const tokenStorage = await import('@/auth/storage/tokenStorage');
        expect(await tokenStorage.TokenStorage.getCredentials()).toEqual(credentials);
        expect(reloaded.profiles.resolveSavedServerProfileByUrl(enteredUrl)).toMatchObject({ kind: 'resolved', profile: { id: existing.id } });
    });

    it.each([false, true])('remembers the canonical address answer %s across a cold reload', async (answer) => {
        const { operation, profiles } = await owner();
        const confirmCanonicalUrl = vi.fn(async (change?: { previousUrl: string; nextUrl: string }) => change ? true : answer);
        expect((await operation.connectHomeAtAddress(input({ confirmCanonicalUrl }))).kind).toBe('connected');
        const changed = vi.fn();
        const unsubscribe = profiles.subscribeServerProfiles(changed);
        expect((await operation.connectHomeAtAddress(input({ confirmCanonicalUrl }))).kind).toBe('connected');
        expect(changed).not.toHaveBeenCalled();
        unsubscribe();
        vi.resetModules();
        const reloaded = await owner();
        expect((await reloaded.operation.connectHomeAtAddress(input({ confirmCanonicalUrl }))).kind).toBe('connected');
        expect(confirmCanonicalUrl).toHaveBeenCalledTimes(1);
        advertisedFeatures = createRootLayoutFeaturesResponse({ capabilities: {
            server: { canonicalServerUrl: 'https://moved.example.test' }, serverIdentity: { serverIdentityId: homeIdentity },
        } });
        vi.resetModules();
        const moved = await owner();
        expect((await moved.operation.connectHomeAtAddress(input({ confirmCanonicalUrl }))).kind).toBe('connected');
        expect(confirmCanonicalUrl.mock.calls.filter(([change]) => change === undefined)).toHaveLength(2);
    });

    it('does not save a reachable address whose public features cannot be read', async () => {
        featuresStatus = 503;
        const { operation, before, profileFacts } = await owner();
        expect(await operation.connectHomeAtAddress(input())).toEqual({ kind: 'unreachable', remediation: null });
        expect(profileFacts()).toEqual(before);
    });

    it('waits for valid slow public features before adopting the Home', async () => {
        const { operation, before, profileFacts } = await owner();
        const immediateFetch = boundary.fetch.getMockImplementation()!;
        vi.useFakeTimers();
        boundary.fetch.mockImplementation(async (url: RequestInfo | URL) => {
            if (String(url).endsWith('/v1/features')) {
                await new Promise<void>((resolve) => setTimeout(resolve, 1_600));
            }
            return immediateFetch(url);
        });

        const connection = operation.connectHomeAtAddress(input());
        await vi.advanceTimersByTimeAsync(800);
        expect(profileFacts()).toEqual(before);
        await vi.advanceTimersByTimeAsync(800);
        expect((await connection).kind).toBe('connected');
        expect(profileFacts().length).toBe(before.length + 1);
    });

    it('does not redirect a signed-out saved Home without explicit address-change consent', async () => {
        const { operation, profiles, profileFacts } = await owner();
        const existing = await profiles.adoptHomeProfile({
            descriptor: {
                v: 1,
                homeServerIdentityId: homeIdentity,
                canonicalServerUrl: canonicalUrl,
                revision: 7,
                endpoints: [{ kind: 'https', url: canonicalUrl }],
            },
            source: 'qr',
            suggestedName: 'My saved Home',
        });
        const before = profileFacts();
        const confirmCanonicalUrl = vi.fn(async () => false);
        expect(await operation.connectHomeAtAddress(input({ confirmCanonicalUrl }))).toEqual({ kind: 'declined' });
        expect(confirmCanonicalUrl).toHaveBeenCalledWith({ previousUrl: canonicalUrl, nextUrl: enteredUrl });
        expect(profileFacts()).toEqual(before);
        expect(profiles.getServerProfileById(existing.id)).toEqual(existing);
    });

    it('changes only the local selection after a signed-out saved Home explicitly approves Keep', async () => {
        const { operation, profiles } = await owner();
        const existing = await profiles.adoptHomeProfile({ descriptor: {
            v: 1, homeServerIdentityId: homeIdentity, canonicalServerUrl: canonicalUrl,
            revision: 7, endpoints: [{ kind: 'https', url: canonicalUrl }],
        }, source: 'qr', descriptorAuthority: 'advisory' });
        const confirmCanonicalUrl = vi.fn(async (change?: { previousUrl: string; nextUrl: string }) => Boolean(change));
        const result = await operation.connectHomeAtAddress(input({ confirmCanonicalUrl }));
        expect(result).toEqual({ kind: 'connected', profile: { ...existing, addressSelection: {
            serverIdentityId: homeIdentity, enteredUrl, canonicalServerUrl: canonicalUrl, useCanonical: false,
        } } });
        expect(confirmCanonicalUrl).toHaveBeenCalledWith({ previousUrl: canonicalUrl, nextUrl: enteredUrl });
    });

    it('does not let an Action canonical-address boolean approve forwarding a saved credential', async () => {
        const { profiles } = await owner();
        const oldUrl = 'https://old-home.example.test';
        const existing = await profiles.adoptHomeProfile({ descriptor: {
            serverUrl: oldUrl, canonicalServerUrl: oldUrl, homeServerIdentityId: homeIdentity,
        }, source: 'manual' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await TokenStorage.setCredentialsForServerUrl(oldUrl, { serverId: homeIdentity }, { token: 'saved-action-token' });
        const { createMachineConnectionActionDeps } = await import('@/sync/ops/actions/machineConnectionActionDeps');
        expect(await createMachineConnectionActionDeps().homeConnect?.({
            address: enteredUrl, acceptCanonicalUrl: true, acceptInsecureHttp: true,
        }, { surface: 'ui' })).toEqual({ kind: 'declined' });
        expect(boundary.fetch.mock.calls.some(([, init]) => new Headers(init?.headers).has('Authorization'))).toBe(false);
        expect(profiles.getServerProfileById(existing.id)).toEqual(existing);
    });

    it.each([
        { oldUrl: 'https://old-home.example.test', newUrl: canonicalUrl },
        { oldUrl: 'http://qa-home.localhost:3010', newUrl: 'http://qa-home.localhost:3012' },
    ])('reconnects the signed-in Home after its address changes from $oldUrl', async ({ oldUrl, newUrl }) => {
        if (newUrl.startsWith('http:')) vi.stubGlobal('location', { protocol: 'http:' });
        const features = createRootLayoutFeaturesResponse({ capabilities: {
            server: { canonicalServerUrl: newUrl }, serverIdentity: { serverIdentityId: homeIdentity },
        } });
        advertisedFeatures = features;
        const { operation, profiles } = await owner();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const existing = await profiles.adoptHomeProfile({
            descriptor: { v: 1, homeServerIdentityId: homeIdentity, canonicalServerUrl: oldUrl,
                revision: 7, endpoints: [{ kind: 'https', url: oldUrl }] },
            source: 'qr', suggestedName: 'My saved Home',
        });
        await profiles.setActiveServerId(existing.id);
        const activeBefore = profiles.getActiveServerId();
        const credentials = { token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhY2NvdW50X2EifQ.sig' };
        await TokenStorage.setCredentialsForServerUrl(oldUrl, { serverId: homeIdentity }, credentials);

        const descriptor = { v: 1 as const, homeServerIdentityId: homeIdentity, canonicalServerUrl: newUrl,
            revision: 8, endpoints: [{ kind: 'https' as const, url: newUrl }] };
        const immediateFetch = boundary.fetch.getMockImplementation()!;
        boundary.fetch.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
            if (String(url).endsWith('/v1/features/authenticated')) {
                expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${credentials.token}`);
                return response(200, { ...features, homeConnectionDescriptor: descriptor });
            }
            return immediateFetch(url, init);
        });
        const countBefore = profiles.listServerProfiles().length;
        const result = await operation.connectHomeAtAddress(input({ serverUrl: newUrl }));
        expect(result).toMatchObject({ kind: 'connected', profile: {
            id: existing.id, name: 'My saved Home', serverIdentityId: homeIdentity,
            canonicalServerUrl: newUrl, homeConnectionDescriptor: descriptor,
        } });
        expect(profiles.listServerProfiles()).toHaveLength(countBefore);
        expect(profiles.getActiveServerId()).toBe(activeBefore);
        expect(await TokenStorage.getCredentialsForServerUrl(newUrl, { serverId: homeIdentity })).toEqual(credentials);
    });

    it('retains URL-only predecessor Home admission without requiring an exact-descriptor endpoint', async () => {
        const { operation, profiles } = await owner();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const oldUrl = 'https://legacy-home.example.test';
        const existing = await profiles.upsertServerProfile({ serverUrl: oldUrl, name: 'Legacy Home', source: 'manual' });
        await profiles.setServerProfileIdentityForUrl(oldUrl, homeIdentity);
        const credentials = { token: 'legacy-account-token' };
        await TokenStorage.setCredentialsForServerUrl(oldUrl, { serverId: homeIdentity }, credentials);
        expect(await operation.connectHomeAtAddress(input({ serverUrl: canonicalUrl })))
            .toMatchObject({ kind: 'connected', profile: {
                id: existing.id, name: 'Legacy Home', serverIdentityId: homeIdentity, canonicalServerUrl: canonicalUrl,
            } });
        expect(await TokenStorage.getCredentialsForServerUrl(canonicalUrl, { serverId: homeIdentity })).toEqual(credentials);
    });

    it.each(['https://old-home.example.test', canonicalUrl])('does not forward a saved credential from %s until the new address is confirmed', async (oldUrl) => {
        const { operation, profiles } = await owner();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const nextUrl = oldUrl === canonicalUrl ? enteredUrl : canonicalUrl;
        const existing = await profiles.adoptHomeProfile({
            descriptor: { v: 1, homeServerIdentityId: homeIdentity, canonicalServerUrl: oldUrl,
                revision: 7, endpoints: [{ kind: 'https', url: oldUrl }] }, source: 'qr',
        });
        const credentials = { token: 'saved-account-token' };
        await TokenStorage.setCredentialsForServerUrl(oldUrl, { serverId: homeIdentity }, credentials);
        const confirmCanonicalUrl = vi.fn(async () => false);
        expect(await operation.connectHomeAtAddress(input({ serverUrl: nextUrl, confirmCanonicalUrl })))
            .toEqual({ kind: 'declined' });
        expect(confirmCanonicalUrl).toHaveBeenCalledWith({ previousUrl: oldUrl, nextUrl });
        expect(boundary.fetch.mock.calls.some(([, init]) => new Headers(init?.headers).has('Authorization'))).toBe(false);
        expect(profiles.getServerProfileById(existing.id)).toEqual(existing);
        expect(await TokenStorage.getCredentialsForServerUrl(oldUrl, { serverId: homeIdentity })).toEqual(credentials);
    });

    it('rejects a different authenticated Home claiming the incumbent identity publicly when Keep is chosen', async () => {
        const { operation, profiles } = await owner();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const existing = await profiles.adoptHomeProfile({
            descriptor: { v: 1, homeServerIdentityId: homeIdentity, canonicalServerUrl: canonicalUrl,
                revision: 7, endpoints: [{ kind: 'https', url: canonicalUrl }] }, source: 'qr',
        });
        const credentials = { token: 'saved-account-token' };
        await TokenStorage.setCredentialsForServerUrl(canonicalUrl, { serverId: homeIdentity }, credentials);
        const immediateFetch = boundary.fetch.getMockImplementation()!;
        boundary.fetch.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
            if (String(url).endsWith('/v1/features/authenticated')) return response(200, createRootLayoutFeaturesResponse({
                capabilities: { serverIdentity: { serverIdentityId: 'srv_other_home' } },
            }));
            return immediateFetch(url, init);
        });
        const confirmCanonicalUrl = async (change?: { previousUrl: string; nextUrl: string }) => Boolean(change);
        expect(await operation.connectHomeAtAddress(input({ confirmCanonicalUrl })))
            .toMatchObject({ kind: 'identity_mismatch' });
        expect(profiles.getServerProfileById(existing.id)).toEqual(existing);
        expect(await TokenStorage.getCredentialsForServerUrl(canonicalUrl, { serverId: homeIdentity })).toEqual(credentials);
    });

    it('requires alias consent even for a retained pre-fix profile whose canonical credential URL is incoherent', async () => {
        const { operation, profiles } = await owner();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await profiles.adoptHomeProfile({ descriptor: { serverUrl: canonicalUrl, canonicalServerUrl: canonicalUrl,
            homeServerIdentityId: homeIdentity }, source: 'manual' });
        await TokenStorage.setCredentialsForServerUrl(canonicalUrl, { serverId: homeIdentity }, { token: 'retained-home-token' });
        const retained = await profiles.adoptHomeProfile({ descriptor: { serverUrl: enteredUrl,
            homeServerIdentityId: homeIdentity }, source: 'manual' });
        expect(await TokenStorage.getCredentialsForServerUrl(canonicalUrl, { serverId: homeIdentity })).toBeNull();
        expect(await operation.connectHomeAtAddress(input({ serverUrl: 'https://new-alias.example.test',
            confirmCanonicalUrl: async () => false }))).toEqual({ kind: 'declined' });
        expect(profiles.getServerProfileById(retained.id)).toEqual(retained);
        expect(boundary.fetch.mock.calls.some(([, init]) => new Headers(init?.headers).has('Authorization'))).toBe(false);
    });

    it('uses the saved canonical Home without forwarding its credential to an unchosen alias', async () => {
        const { operation, profiles } = await owner();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const existing = await profiles.adoptHomeProfile({ descriptor: {
            v: 1, homeServerIdentityId: homeIdentity, canonicalServerUrl: canonicalUrl,
            revision: 7, endpoints: [{ kind: 'https', url: canonicalUrl }],
        }, source: 'qr' });
        advertisedFeatures = { ...featurePayload(), homeConnectionDescriptor: {
            ...existing.homeConnectionDescriptor!, revision: 8, endpoints: [{ kind: 'https', url: enteredUrl }],
        } };
        const credentials = { token: 'canonical-home-token' };
        await TokenStorage.setCredentialsForServerUrl(canonicalUrl, { serverId: homeIdentity }, credentials);
        const confirmCanonicalUrl = vi.fn(async () => true);
        expect((await operation.connectHomeAtAddress(input({ confirmCanonicalUrl }))).kind).toBe('connected');
        expect(confirmCanonicalUrl).toHaveBeenCalledTimes(1);
        expect(boundary.fetch.mock.calls.some(([, init]) => new Headers(init?.headers).has('Authorization'))).toBe(false);
        expect(await TokenStorage.getCredentialsForServerUrl(canonicalUrl, { serverId: homeIdentity })).toEqual(credentials);
        expect(profiles.getServerProfileById(existing.id)).toEqual({ ...existing, addressSelection: {
            serverIdentityId: homeIdentity, enteredUrl, canonicalServerUrl: canonicalUrl, useCanonical: true,
        } });
    });

    it.each(['identity_mismatch', 'missing_descriptor', 'cancelled'] as const)('preserves the saved Home and credential when the fresh observation is %s', async (failure) => {
        const { operation, profiles } = await owner();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const oldUrl = 'https://old-home.example.test';
        const existing = await profiles.adoptHomeProfile({
            descriptor: { v: 1, homeServerIdentityId: homeIdentity, canonicalServerUrl: oldUrl,
                revision: 7, endpoints: [{ kind: 'https', url: oldUrl }] }, source: 'qr',
        });
        const credentials = { token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhY2NvdW50X2EifQ.sig' };
        await TokenStorage.setCredentialsForServerUrl(oldUrl, { serverId: homeIdentity }, credentials);
        const controller = new AbortController();
        const immediateFetch = boundary.fetch.getMockImplementation()!;
        boundary.fetch.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
            if (String(url).endsWith('/v1/features/authenticated')) {
                if (failure === 'cancelled') controller.abort();
                const identity = failure === 'identity_mismatch' ? 'srv_other_home' : homeIdentity;
                return response(200, createRootLayoutFeaturesResponse({
                    capabilities: { server: { canonicalServerUrl: canonicalUrl }, serverIdentity: { serverIdentityId: identity } },
                    ...(failure !== 'missing_descriptor' ? { homeConnectionDescriptor: {
                        v: 1, homeServerIdentityId: identity, canonicalServerUrl: canonicalUrl,
                        revision: 8, endpoints: [{ kind: 'https', url: canonicalUrl }],
                    } } : {}),
                }));
            }
            return immediateFetch(url, init);
        });
        if (failure === 'cancelled') {
            await expect(operation.connectHomeAtAddress(input({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
        } else {
            expect(await operation.connectHomeAtAddress(input())).toMatchObject({
                kind: failure === 'identity_mismatch' ? 'identity_mismatch' : 'unreachable',
            });
            if (failure === 'identity_mismatch') {
                const { createMachineConnectionActionDeps } = await import('@/sync/ops/actions/machineConnectionActionDeps');
                expect(await createMachineConnectionActionDeps().homeConnect?.({
                    address: enteredUrl, acceptCanonicalUrl: true, acceptInsecureHttp: true,
                }, { surface: 'ui' })).toMatchObject({ kind: 'declined' });
            }
        }
        expect(profiles.getServerProfileById(existing.id)).toEqual(existing);
        expect(await TokenStorage.getCredentialsForServerUrl(oldUrl, { serverId: homeIdentity })).toEqual(credentials);
    });

    it('connects a Home advertising released 0.2.1 features without an update requirement', async () => {
        advertisedFeatures = RELEASED_SERVER_V0_2_1_FEATURES_JSON;
        const { operation, before, profileFacts } = await owner();
        expect((await operation.connectHomeAtAddress(input())).kind).toBe('connected');
        expect(profileFacts().length).toBe(before.length + 1);
    });

    it('aborts before persistence when cancelled during feature discovery', async () => {
        const controller = new AbortController();
        onFeaturesRequest = () => controller.abort();
        const { operation, before, profileFacts } = await owner();
        await expect(operation.connectHomeAtAddress(input({ signal: controller.signal })))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(profileFacts()).toEqual(before);
    });
});
