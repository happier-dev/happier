import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthEntryProjectionV1 } from '@happier-dev/protocol/auth/entry';

import { createDeferred, createRootLayoutFeaturesResponse, renderScreen } from '@/dev/testkit';
import { profileDefaults, type Profile } from '@/sync/domains/profiles/profile';
import { installAccountCommonModuleMocks } from './accountTestHelpers';
import { ProviderIdentityItems } from './ProviderIdentityItems';

installAccountCommonModuleMocks();
// Images are a native rendering boundary; the catalog, transport, registry and rows stay real.
vi.mock('expo-image', () => ({ Image: 'Image' }));

const entryResponse = (providerId: string) => Response.json({
    v: 1,
    state: 'ready',
    scope: { kind: 'home' },
    actions: [{
        kind: 'authenticate',
        methodId: providerId,
        action: 'connect',
        mode: 'keyed',
        origin: 'home',
        presentation: { displayName: providerId },
    }],
    autoRedirect: null,
} satisfies AuthEntryProjectionV1);

describe('ProviderIdentityItems catalog recovery', () => {
    let readEntry: () => Promise<Response>;
    let features: ReturnType<typeof createRootLayoutFeaturesResponse>;
    let homeId: string;

    beforeEach(async () => {
        readEntry = async () => entryResponse('workforce');
        features = createRootLayoutFeaturesResponse();
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            if (url.endsWith('/v1/auth/entry')) return await readEntry();
            if (url.includes('/v1/features')) return Response.json(features);
            return new Response(null, { status: 404 });
        }));
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const home = await upsertAndActivateServer({ serverUrl: 'https://catalog-home-a.example.test', name: 'Home A' });
        homeId = home.id;
    });

    afterEach(() => vi.unstubAllGlobals());

    async function renderIdentities(profile: Profile = profileDefaults) {
        return await renderScreen(<ProviderIdentityItems
            profile={profile}
            credentials={null}
            applyProfile={() => {}}
            returnTo="/settings/account/security"
        />);
    }

    async function refreshHome() {
        const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
        await act(async () => { await setActiveServer({ serverId: homeId }); });
    }

    it('retains an eligible provider through a failed refresh and recovers through Retry', async () => {
        const screen = await renderIdentities();
        await vi.waitFor(() => expect(screen.findHostByTestId('settings-account-identity-workforce-connect')).not.toBeNull());

        readEntry = async () => new Response(null, { status: 503 });
        await refreshHome();

        await vi.waitFor(() => expect(screen.findHostByTestId('settings-account-identity-catalog-retry')).not.toBeNull());
        expect(screen.findHostByTestId('settings-account-identity-workforce-connect')).not.toBeNull();
        expect(screen.findHostByTestId('settings-account-identity-workforce-connect')?.props.accessibilityState?.disabled).not.toBe(true);

        const retry = createDeferred<Response>();
        readEntry = () => retry.promise;
        await screen.pressByTestIdAsync('settings-account-identity-catalog-retry');
        expect(screen.findHostByTestId('settings-account-identity-workforce-connect')).not.toBeNull();
        expect(screen.findHostByTestId('settings-account-identity-catalog-retry')?.props.accessibilityState?.disabled).toBe(true);

        await act(async () => { retry.resolve(entryResponse('replacement')); });
        await vi.waitFor(() => expect(screen.findHostByTestId('settings-account-identity-replacement-connect')).not.toBeNull());
        expect(screen.findHostByTestId('settings-account-identity-workforce-connect')).toBeNull();
        expect(screen.findHostByTestId('settings-account-identity-catalog-retry')).toBeNull();
    });

    it('exposes initial failure and retries the same Home without inventing provider availability', async () => {
        readEntry = async () => { throw new TypeError('Network unavailable'); };
        const screen = await renderIdentities();
        await vi.waitFor(() => expect(screen.findHostByTestId('settings-account-identity-catalog-retry')).not.toBeNull());
        expect(screen.findHostByTestId('settings-account-identity-workforce-connect')).toBeNull();

        readEntry = async () => entryResponse('workforce');
        await screen.pressByTestIdAsync('settings-account-identity-catalog-retry');
        await vi.waitFor(() => expect(screen.findHostByTestId('settings-account-identity-workforce-connect')).not.toBeNull());
    });

    it('clears the previous Home catalog while the next Home is loading', async () => {
        const screen = await renderIdentities();
        await vi.waitFor(() => expect(screen.findHostByTestId('settings-account-identity-workforce-connect')).not.toBeNull());
        const nextHome = createDeferred<Response>();
        readEntry = () => nextHome.promise;
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await act(async () => {
            await upsertAndActivateServer({ serverUrl: 'https://catalog-home-b.example.test', name: 'Home B' });
        });
        expect(screen.findHostByTestId('settings-account-identity-workforce-connect')).toBeNull();
        await act(async () => { nextHome.resolve(new Response(null, { status: 503 })); });
        await vi.waitFor(() => expect(screen.findHostByTestId('settings-account-identity-catalog-retry')).not.toBeNull());
        expect(screen.findHostByTestId('settings-account-identity-workforce-connect')).toBeNull();
    });

    it('holds the connections line while the catalog loads on a Home that released no method list, and the failure takes that same line', async () => {
        const first = createDeferred<Response>();
        readEntry = () => first.promise;
        // A Home whose features name no structured methods: only its live entry can say what connects.
        const { methods: _released, ...legacyAuth } = features.capabilities.auth;
        features = { ...features, capabilities: { ...features.capabilities, auth: legacyAuth } } as typeof features;
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://catalog-home-legacy.example.test', name: 'Home L' });
        const screen = await renderIdentities();
        // Nothing is inserted later: the row the connections will occupy is reserved while they load.
        await vi.waitFor(() => expect(screen.findHostByTestId('settings-account-identity-catalog')).not.toBeNull());
        expect(screen.findHostByTestId('settings-account-identity-catalog')?.props.accessibilityRole).toBe('progressbar');
        await act(async () => { first.resolve(new Response(null, { status: 503 })); });
        await vi.waitFor(() => expect(screen.findHostByTestId('settings-account-identity-catalog-retry')).not.toBeNull());
        // The failure replaced the reserved row rather than being added beside it.
        expect(screen.findHostByTestId('settings-account-identity-catalog-skeleton:0')).toBeNull();
    });

    it('keeps the explicit legacy classification and linked identity controls during a transient failure', async () => {
        readEntry = async () => new Response(null, { status: 404 });
        const screen = await renderIdentities({
            ...profileDefaults,
            linkedProviders: [{
                id: 'github', login: 'alice', displayName: 'Alice', avatarUrl: null,
                profileUrl: null, showOnProfile: true,
            }],
        });
        await vi.waitFor(() => expect(screen.findHostByTestId('settings-account-identity-github-disconnect')).not.toBeNull());
        readEntry = async () => new Response(null, { status: 503 });
        await refreshHome();
        await vi.waitFor(() => expect(screen.findHostByTestId('settings-account-identity-catalog-retry')).not.toBeNull());
        expect(screen.findHostByTestId('settings-account-identity-github-disconnect')).not.toBeNull();
    });

    it('replaces retained provider choices when the Home authoritatively reports no available entry', async () => {
        const screen = await renderIdentities();
        await vi.waitFor(() => expect(screen.findHostByTestId('settings-account-identity-workforce-connect')).not.toBeNull());
        readEntry = async () => Response.json({
            v: 1, state: 'unavailable', scope: { kind: 'home' },
            reason: 'entry_not_available', autoRedirect: null,
        } satisfies AuthEntryProjectionV1);
        await refreshHome();
        await vi.waitFor(() => expect(screen.findHostByTestId('settings-account-identity-workforce-connect')).toBeNull());
        expect(screen.findHostByTestId('settings-account-identity-catalog-retry')).not.toBeNull();
    });
});

// Account › Sign-in & security on a return visit (TH-VISUAL-ACCEPT-16 D5): the Home's released methods are already
// known, so the connections stand from them while the Home's live entry is read, and nothing below them moves.
describe('ProviderIdentityItems while the live entry is read', () => {
    let methods: unknown[];
    let entry: ReturnType<typeof createDeferred<Response>>;

    beforeEach(async () => {
        entry = createDeferred<Response>();
        const features = () => createRootLayoutFeaturesResponse({ capabilities: { auth: { methods: methods as never } } });
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            if (url.endsWith('/v1/auth/entry')) return await entry.promise;
            if (url.includes('/v1/features')) return Response.json(features());
            return new Response(null, { status: 404 });
        }));
    });

    afterEach(() => vi.unstubAllGlobals());

    async function renderOnHome(serverUrl: string) {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl, name: 'Northwind Home' });
        return await renderScreen(<ProviderIdentityItems
            profile={profileDefaults}
            credentials={null}
            applyProfile={() => {}}
            returnTo="/settings/account"
        />);
    }

    it('reserves no line when the Home offers no sign-in to connect', async () => {
        methods = [{ id: 'key_challenge', actions: [{ id: 'login', enabled: true, mode: 'keyed' }] }];
        const screen = await renderOnHome('https://reserve-none.example.test');
        await vi.waitFor(() => expect(screen.findHostByTestId('settings-account-identity-catalog')).toBeNull());
        await act(async () => { entry.resolve(Response.json({
            v: 1, state: 'ready', scope: { kind: 'home' }, actions: [], autoRedirect: null,
        } satisfies AuthEntryProjectionV1)); });
        expect(screen.findHostByTestId('settings-account-identity-catalog')).toBeNull();
    });

    it('shows the connection the Home already advertises before its live entry answers', async () => {
        methods = [
            { id: 'key_challenge', actions: [{ id: 'login', enabled: true, mode: 'keyed' }] },
            { id: 'github', actions: [{ id: 'connect', enabled: true, mode: 'keyed' }] },
        ];
        const screen = await renderOnHome('https://reserve-github.example.test');
        await vi.waitFor(() => expect(screen.findHostByTestId('settings-account-identity-github-connect')).not.toBeNull());
        expect(screen.findHostByTestId('settings-account-identity-catalog')).toBeNull();
    });
});
