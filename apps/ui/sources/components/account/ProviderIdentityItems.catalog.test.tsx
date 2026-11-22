import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthEntryProjectionV1 } from '@happier-dev/protocol/auth/entry';

import { View } from 'react-native';

import { createDeferred, createRootLayoutFeaturesResponse, renderScreen } from '@/dev/testkit';
import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { profileDefaults, type Profile } from '@/sync/domains/profiles/profile';
import { installAccountCommonModuleMocks } from './accountTestHelpers';
import { ProviderIdentityItems, resetProviderCatalogForTests } from './ProviderIdentityItems';

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
        resetProviderCatalogForTests();
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

// Account sign-in rows while the Home's live entry is read (TH-VISUAL-FIX-19): only the live entry says which
// connections the Home offers, so nothing is drawn from the released features that the entry may remove, and a
// return visit starts from the Home's last settled live answer instead of a skeleton.
describe('ProviderIdentityItems while the live entry is read', () => {
    let methods: unknown[];
    let entry: ReturnType<typeof createDeferred<Response>>;

    beforeEach(async () => {
        resetProviderCatalogForTests();
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

    async function activateHome(serverUrl: string) {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl, name: 'Northwind Home' });
        // The page opens after the Home's features were read, as in the app.
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        await getServerFeaturesSnapshot();
    }

    async function renderSection() {
        // The Recovery key row follows the connections in the Account sign-in section.
        return await renderScreen(<>
            <ProviderIdentityItems
                profile={profileDefaults}
                credentials={null}
                applyProfile={() => {}}
                returnTo="/settings/account"
            />
            <View testID="recovery-key-row" />
        </>);
    }

    const rowsAbove = (screen: Awaited<ReturnType<typeof renderSection>>) => {
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        return ids.slice(0, ids.indexOf('recovery-key-row')).filter((id) => id.startsWith('settings-account-identity-'));
    };

    it('reserves no line when the Home offers no sign-in to connect', async () => {
        methods = [{ id: 'key_challenge', actions: [{ id: 'login', enabled: true, mode: 'keyed' }] }];
        await activateHome('https://reserve-none.example.test');
        const screen = await renderSection();
        expect(screen.findHostByTestId('settings-account-identity-catalog')).toBeNull();
        await act(async () => { entry.resolve(Response.json({
            v: 1, state: 'ready', scope: { kind: 'home' }, actions: [], autoRedirect: null,
        } satisfies AuthEntryProjectionV1)); });
        expect(screen.findHostByTestId('settings-account-identity-catalog')).toBeNull();
    });

    it('never draws a connection the released features advertise but the live entry omits, and nothing above Recovery key changes', async () => {
        methods = [
            { id: 'key_challenge', actions: [{ id: 'login', enabled: true, mode: 'keyed' }] },
            { id: 'github', actions: [{ id: 'connect', enabled: true, mode: 'keyed' }] },
        ];
        await activateHome('https://features-ahead.example.test');
        const screen = await renderSection();
        const first = rowsAbove(screen);
        expect(first).not.toContain('settings-account-identity-github-connect');
        await act(async () => { entry.resolve(Response.json({
            v: 1, state: 'ready', scope: { kind: 'home' }, actions: [], autoRedirect: null,
        } satisfies AuthEntryProjectionV1)); });
        expect(rowsAbove(screen)).toEqual(first);
        expect(screen.findHostByTestId('settings-account-identity-github-connect')).toBeNull();
    });

    it('starts a return visit from the Home\'s last settled live answer, with no skeleton', async () => {
        methods = [{ id: 'key_challenge', actions: [{ id: 'login', enabled: true, mode: 'keyed' }] }];
        await activateHome('https://return-visit.example.test');
        const firstVisit = await renderSection();
        await act(async () => { entry.resolve(entryResponse('workforce')); });
        await vi.waitFor(() => expect(firstVisit.findHostByTestId('settings-account-identity-workforce-connect')).not.toBeNull());
        const settled = rowsAbove(firstVisit);
        await firstVisit.unmount();

        // Back on the page: the live entry is read again and has not answered yet.
        entry = createDeferred<Response>();
        const returnVisit = await renderSection();
        expect(rowsAbove(returnVisit)).toEqual(settled);
        expect(returnVisit.findHostByTestId('settings-account-identity-catalog')).toBeNull();
        await act(async () => { entry.resolve(entryResponse('workforce')); });
        expect(rowsAbove(returnVisit)).toEqual(settled);
    });
});
