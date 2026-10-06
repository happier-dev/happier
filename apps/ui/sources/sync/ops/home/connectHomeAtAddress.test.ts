import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { RELEASED_SERVER_V0_2_1_FEATURES_JSON } from '@/dev/testkit/fixtures/releasedServerV021Compatibility';

const boundary = vi.hoisted(() => ({ fetch: vi.fn() }));

installTokenStorageWebPlatformMocks();
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: boundary.fetch }));

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
            if (path.endsWith('/v1/features')) {
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

    it('keeps the entered URL when canonical adoption is declined', async () => {
        const { operation, profiles, before } = await owner();
        const attempt = input({ confirmCanonicalUrl: async () => false });
        expect((await operation.connectHomeAtAddress(attempt)).kind).toBe('connected');
        const added = profiles.listServerProfiles().filter((profile) => !before.some((saved) => saved.id === profile.id));
        expect(added).toHaveLength(1);
        expect(added[0]?.serverUrl).toBe(enteredUrl);
        expect(added[0]?.serverIdentityId).toBe(homeIdentity);
    });

    it('does not save a reachable address whose public features cannot be read', async () => {
        featuresStatus = 503;
        const { operation, before, profileFacts } = await owner();
        expect(await operation.connectHomeAtAddress(input())).toEqual({ kind: 'unreachable', remediation: null });
        expect(profileFacts()).toEqual(before);
    });

    it('waits for valid public features beyond the foreground fallback budget before adopting the Home', async () => {
        const { operation, before, profileFacts } = await owner();
        const { FOREGROUND_FEATURE_PROBE_WAIT_BUDGET_MS } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const immediateFetch = boundary.fetch.getMockImplementation()!;
        vi.useFakeTimers();
        boundary.fetch.mockImplementation(async (url: RequestInfo | URL) => {
            if (String(url).endsWith('/v1/features')) {
                await new Promise<void>((resolve) => setTimeout(resolve, FOREGROUND_FEATURE_PROBE_WAIT_BUDGET_MS * 2));
            }
            return immediateFetch(url);
        });

        const connection = operation.connectHomeAtAddress(input());
        await vi.advanceTimersByTimeAsync(FOREGROUND_FEATURE_PROBE_WAIT_BUDGET_MS);
        expect(profileFacts()).toEqual(before);
        await vi.advanceTimersByTimeAsync(FOREGROUND_FEATURE_PROBE_WAIT_BUDGET_MS);
        expect((await connection).kind).toBe('connected');
        expect(profileFacts().length).toBe(before.length + 1);
    });

    it('reuses the exact saved descriptor unchanged when canonical adoption is declined', async () => {
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
        expect(await operation.connectHomeAtAddress(input({ confirmCanonicalUrl: async () => false })))
            .toEqual({ kind: 'connected', profile: existing });
        expect(profileFacts()).toEqual(before);
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

    it('does not forward a saved credential to a changed address until that move is confirmed', async () => {
        const { operation, profiles } = await owner();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const oldUrl = 'https://old-home.example.test';
        const existing = await profiles.adoptHomeProfile({
            descriptor: { v: 1, homeServerIdentityId: homeIdentity, canonicalServerUrl: oldUrl,
                revision: 7, endpoints: [{ kind: 'https', url: oldUrl }] }, source: 'qr',
        });
        const credentials = { token: 'saved-account-token' };
        await TokenStorage.setCredentialsForServerUrl(oldUrl, { serverId: homeIdentity }, credentials);
        const confirmCanonicalUrl = vi.fn(async () => false);
        expect(await operation.connectHomeAtAddress(input({ serverUrl: canonicalUrl, confirmCanonicalUrl })))
            .toEqual({ kind: 'declined' });
        expect(confirmCanonicalUrl).toHaveBeenCalledWith({ previousUrl: oldUrl, nextUrl: canonicalUrl });
        expect(boundary.fetch.mock.calls.some(([, init]) => new Headers(init?.headers).has('Authorization'))).toBe(false);
        expect(profiles.getServerProfileById(existing.id)).toEqual(existing);
        expect(await TokenStorage.getCredentialsForServerUrl(oldUrl, { serverId: homeIdentity })).toEqual(credentials);
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
                }, { surface: 'ui' })).toMatchObject({ ok: false, errorCode: 'home_identity_mismatch' });
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
