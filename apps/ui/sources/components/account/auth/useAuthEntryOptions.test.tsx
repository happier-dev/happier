import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { AuthEntryProjectionV1Schema } from '@happier-dev/protocol/auth/entry';
import { homeConnectionDescriptorFixture } from '@/dev/testkit/fixtures/homeConnectionFixtures';
import { ServerRetentionPolicyV2Schema } from '@happier-dev/protocol/retention/serverRetentionPolicyV2';
import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { getActiveServerSnapshot, setActiveServer, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { adoptPersonalHomeProfileAndComplete, captureActiveServerRuntimeTarget,
    publishActiveServerRuntimeOrigin, resetServerProfilesRuntimeForTests, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { expireServerFeaturesSnapshotForReconnect, primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { resetServerRetentionPolicyClientForTests } from '@/sync/api/capabilities/serverRetentionPolicyClient';
import { useAuthEntryOptions } from './useAuthEntryOptions';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

function signedOut({ children }: React.PropsWithChildren) {
    return <InjectedAuthProvider credentials={null}>{children}</InjectedAuthProvider>;
}
const endpoint = 'https://api.example.test';
const network = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
let features: () => Response | Promise<Response>;
let entry: () => Response | Promise<Response>;
let retention: () => Response | Promise<Response>;
function keyFeatures(provision = true, login = true) {
    return createRootLayoutFeaturesResponse({ capabilities: { auth: { methods: [{ id: 'key_challenge', actions: [
        { id: 'login', enabled: login, mode: 'keyed' }, { id: 'provision', enabled: provision, mode: 'keyed' },
    ] }] } } });
}
function calls(path: string) { return network.mock.calls.filter(([url]) => new URL(String(url)).pathname === path); }
async function settle() { await flushHookEffects({ cycles: 4, turns: 4 }); }
function mount() { return renderHook(() => useAuthEntryOptions(), { wrapper: signedOut }); }
function cache(value = keyFeatures(true, false)) {
    primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, snapshot: { status: 'ready', features: value } });
}

beforeEach(async () => {
    resetServerProfilesRuntimeForTests();
    resetServerFeaturesClientForTests();
    resetServerRetentionPolicyClientForTests();
    await upsertAndActivateServer({ serverUrl: endpoint, name: 'Example Home' });
    features = () => Response.json(keyFeatures());
    entry = () => new Response('', { status: 404 });
    retention = () => new Response('', { status: 503 });
    network.mockReset();
    network.mockImplementation(async (input) => {
        switch (new URL(String(input)).pathname) {
            case '/v1/features': return await features();
            case '/v1/auth/entry': return await entry();
            case '/v2/retention-policy': return await retention();
            default: return new Response('', { status: 404 });
        }
    });
    setRuntimeFetch(network);
});
afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
    resetRuntimeFetch();
    resetServerProfilesRuntimeForTests();
});

describe('useAuthEntryOptions', () => {
    it('uses current auth-entry presentation for a dynamic provider absent from static features', async () => {
        features = () => Response.json(createRootLayoutFeaturesResponse({ capabilities: {
            serverIdentity: { serverIdentityId: 'srv_current' }, auth: { methods: [], keyChallenge: { v2: true } }, oauth: { providers: {} },
        } }));
        entry = () => Response.json(AuthEntryProjectionV1Schema.parse({ v: 1, state: 'ready', scope: { kind: 'home' },
            actions: [{ kind: 'authenticate', methodId: 'acme', action: 'login', mode: 'keyless', origin: 'home',
                presentation: { displayName: 'Acme Workforce' } }], autoRedirect: null }));
        const hook = await mount();
        await settle();
        expect(hook.getCurrent().serverAvailability).toBe('ready');
        expect(hook.getCurrent().authenticationActions).toEqual([expect.objectContaining({
            execution: { kind: 'oauth', providerId: 'acme', mode: 'keyless' },
            method: expect.objectContaining({ presentation: { displayName: 'Acme Workforce' } }),
        })]);
        expect(hook.getCurrent().keyChallengeV2Available).toBe(true);
    });

    it('renders the active Home cached feature catalog on first paint while live probes are pending', async () => {
        const pendingFeatures = createDeferred<Response>();
        const pendingEntry = createDeferred<Response>();
        cache();
        // Expiry retains the last-known catalog while the real cache starts a live read.
        expireServerFeaturesSnapshotForReconnect({ serverId: getActiveServerSnapshot().serverId });
        features = () => pendingFeatures.promise;
        entry = () => pendingEntry.promise;
        const hook = await mount();
        expect(hook.getCurrent()).toMatchObject({ serverAvailability: 'ready', showAuthActions: true,
            authenticationActions: [expect.objectContaining({ execution: { kind: 'generated_key' } })] });
        await hook.unmount();
        pendingFeatures.resolve(new Response('', { status: 503 }));
        pendingEntry.resolve(new Response('', { status: 404 }));
    });

    it('falls back to the active Home cached catalog when live feature refresh fails', async () => {
        cache();
        expireServerFeaturesSnapshotForReconnect({ serverId: getActiveServerSnapshot().serverId });
        features = () => new Response('', { status: 503 });
        entry = () => new Response('', { status: 503 });
        const hook = await mount();
        await settle();
        expect(hook.getCurrent()).toMatchObject({ serverAvailability: 'ready', showAuthActions: true,
            authenticationActions: [expect.objectContaining({ execution: { kind: 'generated_key' } })], authEntryUnavailable: true });
    });

    it('keeps valid Home actions visible while a forced live probe is pending', async () => {
        features = () => Response.json(keyFeatures(true, false));
        const hook = await mount();
        await settle();
        expect(hook.getCurrent().serverAvailability).toBe('ready');
        const pending = createDeferred<Response>();
        features = () => pending.promise;
        await act(async () => hook.getCurrent().retryServerCheck());
        await settle();
        expect(hook.getCurrent()).toMatchObject({ serverAvailability: 'ready', showAuthActions: true,
            authenticationActions: [expect.objectContaining({ execution: { kind: 'generated_key' } })] });
        await hook.unmount();
        pending.resolve(new Response('', { status: 503 }));
    });

    it('derives ready-state auth options from server features', async () => {
        features = () => Response.json(createRootLayoutFeaturesResponse({ capabilities: { auth: { methods: [
            { id: 'key_challenge', actions: [{ id: 'provision', enabled: true, mode: 'keyed' }] },
            { id: 'github', actions: [{ id: 'provision', enabled: true, mode: 'keyed' }] },
            { id: 'mtls', actions: [{ id: 'login', enabled: true, mode: 'keyless' }] },
        ] }, oauth: { providers: { github: { enabled: true, configured: true } } } } }));
        const hook = await mount();
        await settle();
        expect(hook.getCurrent()).toMatchObject({ serverAvailability: 'ready', serverUrlForCopy: endpoint, showAuthActions: true });
        expect(hook.getCurrent().authenticationActions).toEqual(expect.arrayContaining([
            expect.objectContaining({ execution: { kind: 'generated_key' } }),
            expect.objectContaining({ execution: { kind: 'oauth', providerId: 'github', mode: 'keyed' } }),
            expect.objectContaining({ execution: { kind: 'mtls' } }),
        ]));
    });

    it('says it could not check the Home\'s data retention, with a retry, instead of saying nothing', async () => {
        const hook = await mount();
        await settle();
        expect(hook.getCurrent().serverAvailability).toBe('ready');
        const unreadable = hook.getCurrent().retentionDisclosure;
        expect(unreadable).toMatchObject({ kind: 'unreadable' });
        retention = () => Response.json(ServerRetentionPolicyV2Schema.parse({ version: 2, enabled: true, complete: true,
            domains: [{ id: 'sessionSidechainMessages', policy: { mode: 'delete_older_than', days: 7 } }] }));
        if (unreadable?.kind !== 'unreadable') throw new Error('Expected actionable unreadable disclosure');
        await act(async () => unreadable.retry());
        await settle();
        expect(calls('/v2/retention-policy')).toHaveLength(2);
        expect(hook.getCurrent().retentionDisclosure).toMatchObject({ kind: 'summary', summary: expect.any(String) });
    });

    it('projects the active Home carrier as the exact authentication transport', async () => {
        // The byte carrier is a genuine transport boundary, published through the real runtime owner.
        const homeCarrier = { endpointId: 'a'.repeat(64), readObservedPath: () => 'relay' as const,
            request: async (url: string, init: RequestInit) => network(url, init), createWebSocket: vi.fn() };
        expect(publishActiveServerRuntimeOrigin({ target: captureActiveServerRuntimeTarget(), leaseId: 'carrier-a',
            homeCarrier, carrier: 'iroh' })).toBe(true);
        const hook = await mount();
        await settle();
        expect(hook.getCurrent().homeTransport).toEqual({ homeCarrier });
    });

    it('distinguishes a seeded fallback Home from an explicitly requested Home', async () => {
        resetServerProfilesRuntimeForTests();
        const profile = await upsertServerProfile({ serverUrl: 'https://seeded.example.test', name: 'Seeded Home' });
        await seedPersistedHomeProfilesForTests({ profiles: [profile], activeServerId: profile.id, activeServerIdIsExplicit: false });
        const hook = await mount();
        await settle();
        expect(hook.getCurrent().homeTarget).toEqual({ kind: 'saved_profile', profileRef: profile.id });
        expect(hook.getCurrent().requestedHomeTarget).toBeUndefined();
        await act(async () => setActiveServer({ serverId: profile.id, scope: 'device' }));
        await settle();
        expect(hook.getCurrent().requestedHomeTarget).toEqual({ kind: 'saved_profile', profileRef: profile.id });
    });

    it('clears target A policy and identity as soon as target B observation starts', async () => {
        features = () => Response.json(createRootLayoutFeaturesResponse({ signInService: { v: 1, mode: 'external', endpoint: 'https://accounts-a.example.test' },
            capabilities: { serverIdentity: { serverIdentityId: 'srv_a' }, auth: { methods: [] } } }));
        const hook = await mount();
        await settle();
        expect(hook.getCurrent().observedHomeServerIdentityId).toBe('srv_a');
        expect(hook.getCurrent().signInServicePolicy).toBeTruthy();
        const pending = createDeferred<Response>();
        features = () => pending.promise;
        await act(async () => { await upsertAndActivateServer({ serverUrl: 'https://home-b.example.test', name: 'Home B' }); });
        await settle();
        expect(hook.getCurrent()).toMatchObject({ serverAvailability: 'loading', showAuthActions: false });
        expect(hook.getCurrent().observedHomeServerIdentityId).toBeUndefined();
        expect(hook.getCurrent().signInServicePolicy).toBeUndefined();
        await hook.unmount();
        pending.resolve(Response.json({ invalid: true }));
    });

    it('removes stale provisioning while retaining login after a forced policy refresh', async () => {
        const hook = await mount();
        await settle();
        expect(hook.getCurrent().authenticationActions).toEqual(expect.arrayContaining([
            expect.objectContaining({ execution: { kind: 'generated_key' } }), expect.objectContaining({ execution: { kind: 'key_entry' } }),
        ]));
        features = () => Response.json(keyFeatures(false));
        await act(async () => hook.getCurrent().retryServerCheck());
        await settle();
        expect(calls('/v1/features')).toHaveLength(2);
        expect(hook.getCurrent().authenticationActions).toEqual([expect.objectContaining({ execution: { kind: 'key_entry' } })]);
    });

    it('marks invalid server payloads as incompatible and hides auth actions', async () => {
        features = () => Response.json({ invalid: true });
        const hook = await mount();
        await settle();
        expect(hook.getCurrent()).toMatchObject({ serverAvailability: 'incompatible', showAuthActions: false, retryServerCheck: expect.any(Function) });
    });

    it('re-checks auth options when the active server changes', async () => {
        const hook = await mount();
        await settle();
        expect(hook.getCurrent()).toMatchObject({ serverAvailability: 'ready', serverUrlForCopy: endpoint });
        features = () => Response.json({ invalid: true });
        await act(async () => { await upsertAndActivateServer({ serverUrl: 'https://other.example.test', name: 'Other Home' }); });
        await settle();
        expect(hook.getCurrent()).toMatchObject({ serverUrlForCopy: 'https://other.example.test', serverAvailability: 'incompatible', showAuthActions: false });
        expect(calls('/v1/features').map(([url]) => new URL(String(url)).origin)).toEqual([endpoint, 'https://other.example.test']);
    });

    it('does not schedule an automatic retry and reconciles only when the canonical feature cache reports recovery', async () => {
        features = () => new Response('', { status: 503 });
        vi.useFakeTimers();
        const hook = await mount();
        await settle();
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        await settle();
        expect(hook.getCurrent()).toMatchObject({ serverAvailability: 'unavailable', showAuthActions: false });
        expect(calls('/v1/features')).toHaveLength(1);
        features = () => Response.json(keyFeatures());
        await act(async () => cache());
        await settle();
        expect(hook.getCurrent()).toMatchObject({ serverAvailability: 'ready', showAuthActions: true });
        expect(calls('/v1/features')).toHaveLength(1);
    });

    it('issues both probes concurrently and keeps the observed feature catalog when auth-entry is unavailable', async () => {
        const pending = createDeferred<Response>();
        features = () => pending.promise;
        entry = () => new Response('', { status: 503 });
        const hook = await mount();
        await settle();
        expect(calls('/v1/features')).toHaveLength(1);
        expect(calls('/v1/auth/entry')).toHaveLength(1);
        expect(hook.getCurrent().serverAvailability).toBe('loading');
        pending.resolve(Response.json(createRootLayoutFeaturesResponse({ capabilities: { auth: {
            methods: [{ id: 'github', actions: [{ id: 'provision', enabled: true, mode: 'keyed' }] }],
        }, oauth: { providers: { github: { enabled: true, configured: true } } } } })));
        await settle();
        expect(hook.getCurrent()).toMatchObject({ serverAvailability: 'ready', authEntryUnavailable: true, showAuthActions: true });
        expect(hook.getCurrent().authenticationActions).toEqual([expect.objectContaining({ execution: { kind: 'oauth', providerId: 'github', mode: 'keyed' } })]);
    });

    it('keeps a Home-denied auth entry blocked instead of substituting the feature catalog', async () => {
        entry = () => Response.json(AuthEntryProjectionV1Schema.parse({ v: 1, scope: { kind: 'home' }, state: 'denied',
            reason: 'entry_not_available', autoRedirect: null }));
        const hook = await mount();
        await settle();
        expect(hook.getCurrent()).toMatchObject({ serverAvailability: 'unavailable', showAuthActions: false });
    });

    it('consumes a forced retry once when a successful identity-bearing response advances the server generation', async () => {
        features = () => new Response('', { status: 503 });
        const hook = await mount();
        await settle();
        await act(async () => hook.getCurrent().retryServerCheck());
        await settle();
        expect(hook.getCurrent().serverAvailability).toBe('unavailable');
        const before = getActiveServerSnapshot().generation;
        features = () => Response.json(createRootLayoutFeaturesResponse({ capabilities: {
            serverIdentity: { serverIdentityId: 'srv_observed' }, auth: { methods: [] },
        } }));
        const beforeRetry = calls('/v1/features').length;
        await act(async () => hook.getCurrent().retryServerCheck());
        await settle();
        expect(getActiveServerSnapshot().generation).toBeGreaterThan(before);
        expect(hook.getCurrent()).toMatchObject({ serverAvailability: 'ready', showAuthActions: true, authenticationActions: [] });
        expect(calls('/v1/features')).toHaveLength(beforeRetry + 1);
    });

    it('projects the identity-bound Personal Home receipt into auth presentation context', async () => {
        features = () => Response.json(createRootLayoutFeaturesResponse({ capabilities: {
            serverIdentity: { serverIdentityId: 'srv_personal_home' },
        } }));
        const profile = await adoptPersonalHomeProfileAndComplete({ source: 'desktop-personal-home', descriptorAuthority: 'current_connection_observation',
            descriptor: homeConnectionDescriptorFixture({ v: 1, homeServerIdentityId: 'srv_personal_home', canonicalServerUrl: endpoint,
                revision: 1, endpoints: [{ kind: 'https', url: endpoint }] }) });
        await setActiveServer({ serverId: profile.id, scope: 'device' });
        const hook = await mount();
        await settle();
        expect(hook.getCurrent().isPersonalHome).toBe(true);
    });
});
