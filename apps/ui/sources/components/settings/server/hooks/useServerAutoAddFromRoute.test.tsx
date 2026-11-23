import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRootLayoutFeaturesResponse, createSignInServiceFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';

const boundary = vi.hoisted(() => ({
    fetch: vi.fn(),
}));

installTokenStorageWebPlatformMocks();
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
// Collection pays source compilation; per-case deadlines measure the real connection behavior.
await import('./useServerAutoAddFromRoute');
describe('route-supplied Home connection', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    let storage: ReturnType<typeof installLocalStorageMock>;
    let locks: ReturnType<typeof installWebLockManagerMock>;

    beforeEach(async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `auto_add_home_${Date.now()}_${Math.random()}`;
        storage = installLocalStorageMock();
        locks = installWebLockManagerMock();
        vi.stubGlobal('window', { location: { origin: 'https://client.example.test' } });
        const features = createRootLayoutFeaturesResponse({ capabilities: {
            server: { canonicalServerUrl: 'https://canonical.example.test' },
            serverIdentity: { serverIdentityId: 'srv_route_home_identity' },
        } });
        boundary.fetch.mockReset().mockImplementation(async (url: string) => new Response(
            JSON.stringify(url.endsWith('/health') ? { status: 'ok' } : features),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
        (await import('@/utils/system/runtimeFetch')).setRuntimeFetch((input) => boundary.fetch(String(input)));
        (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
    });

    afterEach(() => {
        locks.restore();
        storage.restore();
        vi.unstubAllGlobals();
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        vi.resetModules();
    });

    async function owner() {
        const [{ useServerAutoAddFromRoute }, profiles, { renderHook }] = await Promise.all([
            import('./useServerAutoAddFromRoute'),
            import('@/sync/domains/server/serverProfiles'),
            import('@/dev/testkit'),
        ]);
        return {
            useServerAutoAddFromRoute, profiles, renderHook,
            before: snapshot(profiles.listServerProfiles()),
            beforeActiveId: profiles.getActiveServerId(),
        };
    }

    function snapshot(profiles: readonly ServerProfile[]) {
        return profiles.map(({ id, serverUrl, name, source }) => ({ id, serverUrl, name, source }));
    }

    function input(url: string) {
        return {
            enabled: true, address: url, url, source: 'url' as const,
            confirmInsecureHttp: vi.fn(async () => true),
            confirmCanonicalUrl: vi.fn(async () => true),
            // Existing callers used a second readiness decision. This sentinel must become unused.
            validateServerReachable: vi.fn(async () => true),
            onSwitchServerById: vi.fn(async () => {}),
        };
    }

    it('does not persist or finish an insecure route address when confirmation is declined', async () => {
        const { useServerAutoAddFromRoute, profiles, renderHook, before, beforeActiveId } = await owner();
        const props = input('http://home.example.test');
        props.confirmInsecureHttp.mockResolvedValue(false);
        const hook = await renderHook(() => useServerAutoAddFromRoute(props));
        expect(snapshot(profiles.listServerProfiles())).toEqual(before);
        expect(profiles.getActiveServerId()).toBe(beforeActiveId);
        expect(hook.getCurrent()).toEqual({ isConnecting: false, result: { kind: 'declined' }, error: null });
    });

    it('asks before using a different canonical address and preserves the entered address when kept', async () => {
        const { useServerAutoAddFromRoute, profiles, renderHook, before, beforeActiveId } = await owner();
        const props = input('https://entered.example.test');
        props.confirmCanonicalUrl.mockResolvedValue(false);
        const hook = await renderHook(() => useServerAutoAddFromRoute(props));
        expect(props.confirmCanonicalUrl).toHaveBeenCalled();
        const { resolveHomeConnectionAddress } = await import('@/sync/domains/server/homeAddressSelection');
        const added = profiles.listServerProfiles().filter((profile) => !before.some((saved) => saved.id === profile.id));
        expect(added.map(resolveHomeConnectionAddress)).toEqual(['https://entered.example.test']);
        expect(hook.getCurrent().result).toMatchObject({ kind: 'connected', profile: { id: added[0]?.id } });
        expect(profiles.getActiveServerId()).toBe(beforeActiveId);
        expect(props.validateServerReachable).not.toHaveBeenCalled();
        expect(props.onSwitchServerById).not.toHaveBeenCalled();
    });

    it('keeps an unreachable address out of the saved Homes and reports the failure', async () => {
        const { useServerAutoAddFromRoute, profiles, renderHook, before } = await owner();
        boundary.fetch.mockRejectedValue(new TypeError('offline'));
        const props = input('https://offline.example.test');
        const hook = await renderHook(() => useServerAutoAddFromRoute(props));
        expect(snapshot(profiles.listServerProfiles())).toEqual(before);
        expect(hook.getCurrent()).toEqual({
            isConnecting: false,
            result: { kind: 'unreachable', remediation: null },
            error: 'homesJourneys.homeUnreachable',
        });
    });

    it('returns the typed outcome when mounted with only the draft route inputs', async () => {
        const { useServerAutoAddFromRoute, profiles, renderHook, before } = await owner();
        boundary.fetch.mockRejectedValue(new TypeError('offline'));
        const hook = await renderHook(() => useServerAutoAddFromRoute({
            enabled: true,
            address: 'https://offline.example.test',
            source: 'url',
        }));
        expect(hook.getCurrent()).toEqual({
            isConnecting: false,
            result: { kind: 'unreachable', remediation: null },
            error: 'homesJourneys.homeUnreachable',
        });
        expect(snapshot(profiles.listServerProfiles())).toEqual(before);
    });

    it('adopts a Directory-capable Home with disabled sign-in delegation without switching focus', async () => {
        const address = 'https://accounts.example.test';
        boundary.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(
            url.endsWith('/health') ? { status: 'ok' } : createSignInServiceFeaturesResponse(address),
        ), { status: url.endsWith('/health') || url.endsWith('/v1/features') ? 200 : 404, headers: { 'content-type': 'application/json' } }));
        const { useServerAutoAddFromRoute, profiles, renderHook, before, beforeActiveId } = await owner();
        const hook = await renderHook(() => useServerAutoAddFromRoute(input(address)));
        expect(hook.getCurrent()).toMatchObject({ isConnecting: false, result: { kind: 'connected', profile: { serverUrl: address } }, error: null });
        expect(profiles.listServerProfiles()).toHaveLength(before.length + 1);
        expect(profiles.getActiveServerId()).toBe(beforeActiveId);
    });
});
