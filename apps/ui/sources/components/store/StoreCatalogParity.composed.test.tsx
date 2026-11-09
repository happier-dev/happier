import * as React from 'react';
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { act, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createRegistryPluginCatalogFixture } from '@/dev/testkit/fixtures/registryPluginCatalog';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createNavigationPropMock } from '@/dev/testkit/mocks/reactNavigation';
import { deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace';
import type { RegistrySourceV1 } from '@happier-dev/protocol/registries';
import type { ActionInputForm } from '@/components/plugins/actions/actionInputForm';
import type { IModal } from '@/modal';

const dialogs = vi.hoisted(() => ({ show: vi.fn<IModal['show']>(() => 'action-form'), confirm: vi.fn<IModal['confirm']>(async () => true) }));
installPromptRegistriesCommonModuleMocks({ storage: original => original(), modal: async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: dialogs }).module });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
await Promise.all([import('@/auth/storage/tokenStorage'), import('@/sync/domains/server/serverRuntime'),
    import('@/sync/domains/state/storage'), import('@/utils/system/runtimeFetch'),
    import('@/sync/runtime/orchestration/appliedActiveServerRuntime')]);
const { StoreListingController } = await import('./StoreListingController');
const { StoreDiscoverItemMark } = await import('./discover/StoreDirectorySection');
const { StoreDiscover } = await import('./StoreDiscover');
const { StoreDiscoverRegistryIdentityScope } = await import('./catalog/StoreDiscoverRegistryIdentityScope');
const { StoreRegistryIdentityProvider } = await import('./catalog/StoreRegistryIdentity');
const { useRegistryItems } = await import('@/registries/useRegistryItems');
const { StoreItemMark } = await import('./catalog/StoreItemMark');
const { useRegistryItem } = await import('@/registries/useRegistryItem');
const { admitRegistrySummaryMark } = await import('@/registries/registryBrandMark');
const { HappierBrandMark } = await import('@/components/ui/media/HappierBrandMark');
const { PluginMark } = await import('@/components/settings/plugins/PluginMark');
const { NavigationContext } = await import('@react-navigation/native');
const { DestinationInstanceContext } = await import('@/components/appShell/workspace/destinationInstanceContext');
type ListingState = import('./StoreListingController').StoreListingState;

beforeEach(() => { dialogs.show.mockClear(); dialogs.confirm.mockClear(); });

function DiscoverMarkFromListing(props: React.ComponentProps<typeof StoreDiscoverItemMark>) {
    const reference = props.item.reference;
    const list = useRegistryItems({ kind: reference.type === 'registryItem' ? reference.kind : 'plugin',
        sourceIds: reference.type === 'registryItem' ? [reference.sourceId] : [] }, reference.type === 'registryItem');
    return <StoreRegistryIdentityProvider items={list.items}><StoreDiscoverItemMark {...props} /></StoreRegistryIdentityProvider>;
}

it('D7 draws curated app marks from one source listing without acquiring app payloads', async () => {
    const commit = 'b'.repeat(40);
    const sourceId = 'builtin:compose-catalog';
    const choices = [{ itemId: 'uptime-kuma', title: 'Uptime Kuma', logo: 'svgs/uptime-kuma.svg' },
        { itemId: 'healthchecks', title: 'Healthchecks', logo: 'svgs/healthchecks.svg' }];
    const payloadReads: string[] = [];
    let indexReads = 0;
    const { answer, sourceId: curatedSource, sourceUrl } = await setup('curated-list-marks', 'plugin', async url => {
        if (url === 'https://api.github.com/repos/coollabsio/coolify/commits/HEAD') return Response.json({ sha: commit });
        if (url.endsWith('/templates/service-templates.json')) {
            indexReads += 1;
            return Response.json(Object.fromEntries(choices.map(choice => [choice.itemId, { name: choice.title, logo: choice.logo }])));
        }
        if (url.endsWith('.yaml') || url.endsWith('.yml')) {
            payloadReads.push(url);
            return new Response(null, { status: 429 });
        }
        return null;
    });
    const { MarketplaceIndexSourceSnapshotV1Schema } = await import('@happier-dev/protocol/marketplace');
    const items = choices.map(choice => ({ id: choice.itemId, title: choice.title,
        reference: { type: 'registryItem' as const, kind: 'app' as const, sourceId, itemId: choice.itemId } }));
    answer('/catalog.json', { body: MarketplaceIndexSourceSnapshotV1Schema.parse({
        source: { id: curatedSource, title: 'Picks', kind: 'curated', sourceUrl },
        freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [],
        discovery: { items, categories: [], jobs: [] },
    }) });
    const screen = await renderScreen(<StoreDiscover demand={{ presented: true }} project={null}>
        {({ presented }) => <StoreDiscoverRegistryIdentityScope items={items} presented={presented}>
            {items.map(item => <StoreDiscoverItemMark key={item.id} item={{ ...item, key: item.id,
                sourceId: curatedSource, kind: 'app', description: null }} />)}
        </StoreDiscoverRegistryIdentityScope>}
    </StoreDiscover>);
    await waitForHomeGovernance(() => expect(indexReads).toBeGreaterThan(0));
    await flushHookEffects();
    expect(payloadReads).toEqual([]);
    expect(indexReads).toBe(1);
    expect(screen.findAllByType(HappierBrandMark).map(mark => mark.props.brand.light)).toEqual(
        choices.map(choice => ({ uri: `https://raw.githubusercontent.com/coollabsio/coolify/${commit}/public/${choice.logo}` })));
});

async function setup(suffix: string, kind: 'browserExtension' | 'mcpServer' | 'plugin' | 'app',
    handleExternalRequest?: (url: string, init?: RequestInit) => Promise<Response | null>) {
    const serverUrl = `https://store-parity-${suffix}.test`;
    const sourceUrl = `${serverUrl}/catalog.json`;
    const sourceId = deriveMarketplaceSourceId(sourceUrl);
    const source: RegistrySourceV1 = { id: sourceId, title: 'Catalog', url: sourceUrl,
        format: kind === 'mcpServer' ? 'mcp-registry' : 'happier-catalog', kinds: [kind], enabled: true, addedAt: 1 };
    const serverIdentityId = `srv_store_parity_${suffix}`;
    const { upsertServerProfile, setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
    await upsertServerProfile({ serverUrl, name: 'Store' });
    await setServerProfileIdentityForUrl(serverUrl, serverIdentityId);
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources',
        value: { v: 2, sources: [source], disabledSourceIds: [] } }] });
    type Answer = { body: unknown };
    type Route = Answer | { select: (input: unknown) => Answer | Promise<Answer> };
    const routes = new Map<string, Route>();
    let transport: ((path: string, init?: RequestInit) => Promise<Response | null>) | undefined;
    const fixture = await createPlainArtifactHomeFixture(serverUrl, { accountId: 'alice', currentAccount: true, handleExternalRequest,
        handleRequest: async (path, init) => {
            const catalogResponse = await catalog.handle(path, init);
            if (catalogResponse) return catalogResponse;
            const transported = await transport?.(path, init);
            if (transported) return transported;
            const route = routes.get(`${init?.method ?? 'GET'} ${path}`) ?? routes.get(path);
            if (!route) return null;
            const response = 'select' in route ? await route.select(JSON.parse(String(init?.body ?? 'null'))) : route;
            return Response.json(response.body);
        } });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    await fixture.hydrateAccountSettings();
    return { sourceId, sourceUrl, serverUrl, serverIdentityId,
        serve: (handler: NonNullable<typeof transport>) => { transport = handler; },
        answer: (path: string, route: Route) => { routes.set(path, route); } };
}

it.each([true, false])('R6 Add reaches the existing install Action and preserves permission consent (%s)', async accepted => {
    dialogs.confirm.mockResolvedValue(accepted);
    const { answer, serve, sourceId, sourceUrl, serverUrl, serverIdentityId } = await setup(`extension-${accepted}`, 'browserExtension');
    const extensionId = 'a'.repeat(32);
    answer('/catalog.json', { body: { ...createRegistryPluginCatalogFixture({ sourceUrl, entries: [] }),
        browserExtensions: [{ itemId: 'passwords', title: 'Passwords', extension: { kind: 'webStore', extensionId } }] } });
    const machineId = 'machine-a';
    const review = { version: '1.0', permissions: ['storage'], hostPermissions: ['https://example.com/*'] };
    const requests: unknown[] = [];
    // The canonical boundary keeps own-Account admission and external Action transport real.
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId: 'alice',
        machineId, actionId: 'browser.extensions.install', tokenEpoch: 0, requesterInvocation: 'none',
        execute: (input, { target }) => {
        expect(target).toEqual({ kind: 'machine', machineId });
        requests.push(input);
        return requests.length === 1 ? { status: 'needs_review', review, restartRequired: true } : {
            status: 'updated', restartRequired: true, entry: { profileId: 'work', restartRequired: true, extension: {
                id: extensionId, name: 'Passwords', ...review, enabled: true, directory: '/browser/extensions/passwords',
                source: { kind: 'webStore', extensionId },
            } },
        };
    } });
    serve((path, init) => boundary.handle(new URL(path, serverUrl), init));
    let state: ListingState = { kind: 'unavailable' };
    await renderScreen(<StoreListingController reference={{ type: 'registryItem', kind: 'browserExtension', sourceId, itemId: 'passwords' }}
        onClose={() => {}}>{value => { state = value; return null; }}</StoreListingController>);
    await waitForHomeGovernance(() => expect(state).toMatchObject({ kind: 'browserExtension', item: expect.anything() }));
    // Keep this check at the controller's public detail contract: no internal hook or Action executor is mocked.
    const selected = state as Extract<ListingState, { kind: 'browserExtension' }>;
    if (!selected.item) throw new Error('Expected the selected extension');
    await act(async () => { await selected.config.detailFooter(selected.item!).primary.onPress(); });
    const presented = dialogs.show.mock.calls.at(-1)?.[0] as unknown as { props: { form: ActionInputForm } };
    const form = presented.props.form;
    expect(form.getFields().map(field => field.path)).toEqual(['machineId', 'profileId']);
    form.replaceInput({ ...form.getInput(), machineId, profileId: 'work' });
    let outcome: Awaited<ReturnType<typeof form.submit>> | undefined;
    await act(async () => { outcome = await form.submit(); });
    expect(outcome).toMatchObject({ kind: 'settled', outcome: { ok: accepted } });
    expect(requests[0], JSON.stringify(outcome)).toMatchObject({ machineId, profileId: 'work', source: { kind: 'webStore', extensionId } });
    expect(requests).toHaveLength(accepted ? 2 : 1);
    if (accepted) expect(requests[1]).toMatchObject({ reviewedPermissions: review });
    expect(dialogs.confirm).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('storage'), expect.anything());
});

it('R8/H5 uses the same catalog identity fallback in Store, Settings and Discover', async () => {
    const { answer, sourceId, sourceUrl } = await setup('plugin-identity', 'plugin');
    answer('/catalog.json', { body: createRegistryPluginCatalogFixture({ sourceUrl,
        entries: [{ pluginId: 'some.plugin', title: 'Some Plugin' }] }) });
    const reference = { type: 'registryItem', kind: 'plugin', sourceId, itemId: 'some.plugin' } as const;
    let listing: ReturnType<typeof useRegistryItem> | undefined;
    function ListingMark() {
        const { type: _type, ...pointer } = reference;
        listing = useRegistryItem(pointer);
        return listing.item ? <StoreItemMark facts={{ kind: 'plugin', title: listing.item.summary.title,
            brand: admitRegistrySummaryMark(listing.item.summary).brandMark }} size={26} /> : null;
    }
    const screen = await renderScreen(<><ListingMark /><PluginMark title="Some Plugin" pluginId="some.plugin" />
        <DiscoverMarkFromListing item={{ key: 'some.plugin', id: 'some.plugin', sourceId, reference,
            kind: 'plugin', title: 'Old name', description: null }} /></>);
    await waitForHomeGovernance(() => expect(listing?.item, JSON.stringify(listing)).toMatchObject({ summary: { title: 'Some Plugin' } }));
    const marks = screen.findAllByType(HappierBrandMark);
    expect(marks).toHaveLength(3);
    await waitForHomeGovernance(() => expect(screen.findAllByType(HappierBrandMark).map(mark => mark.props.brand))
        .toEqual(Array.from({ length: 3 }, () => ({ displayName: 'Some Plugin' }))));
});

it('H5 resolves Discover artwork through the same selected catalog and mark owners as the listing', async () => {
    const { answer, sourceId } = await setup('artwork', 'mcpServer');
    const reference = { type: 'registryItem', kind: 'mcpServer', sourceId, itemId: 'example', version: '1.0' } as const;
    answer('/catalog.json/v0.1/servers/example/versions/1.0', { body: { server: {
        name: 'example', title: 'Example', description: 'Example server', version: '1.0',
        icons: [{ src: 'https://artwork.test/example.png' }], remotes: [{ type: 'streamable-http', url: 'https://example.test/mcp' }],
    } } });
    answer('/catalog.json/v0.1/servers?limit=100&version=latest', { body: { servers: [{ server: {
        name: 'example', title: 'Example', description: 'Example server', version: '1.0',
        icons: [{ src: 'https://artwork.test/example.png' }], remotes: [{ type: 'streamable-http', url: 'https://example.test/mcp' }],
    } }], metadata: { count: 1 } } });
    let listing: ReturnType<typeof useRegistryItem> | undefined;
    function ListingMark() {
        const { type: _type, ...pointer } = reference;
        const selected = useRegistryItem(pointer);
        listing = selected;
        return selected.item ? <StoreItemMark facts={{ kind: 'mcpServer', title: selected.item.summary.title,
            brand: admitRegistrySummaryMark(selected.item.summary).brandMark }} size={26} /> : null;
    }
    const screen = await renderScreen(<><ListingMark /><DiscoverMarkFromListing item={{ key: 'example', id: 'example', sourceId,
        reference, kind: 'mcpServer', title: 'Example', description: null }} /></>);
    await waitForHomeGovernance(() => expect(listing?.item, JSON.stringify(listing)).toMatchObject({ summary: { iconUrl: 'https://artwork.test/example.png' } }));
    await waitForHomeGovernance(() => expect(screen.findAllByType(HappierBrandMark)).toHaveLength(2));
    const marks = screen.findAllByType(HappierBrandMark);
    expect(marks[0].props.brand).toEqual(marks[1].props.brand);
    expect(marks[1].props.brand.light).toEqual({ uri: 'https://artwork.test/example.png' });
});

it.each([
    { itemId: 'uptime-kuma', title: 'Uptime Kuma', logo: 'svgs/uptime-kuma.svg' },
    { itemId: 'healthchecks', title: 'Healthchecks', logo: 'svgs/healthchecks.webp' },
])('H5 retains the native Coolify artwork for $title in catalog rows, listing and Discover', async ({ itemId, title, logo }) => {
    const commit = 'a'.repeat(40);
    const sourceId = 'builtin:compose-catalog';
    const { useRegistryItems } = await import('@/registries/useRegistryItems');
    const { answer } = await setup(`native-${itemId}`, 'app', async url => {
        if (url === 'https://api.github.com/repos/coollabsio/coolify/commits/HEAD') return Response.json({ sha: commit });
        if (url === `https://raw.githubusercontent.com/coollabsio/coolify/${commit}/templates/service-templates.json`)
            return Response.json({ [itemId]: { name: title, slogan: 'Monitoring', logo } });
        if (url === `https://raw.githubusercontent.com/coollabsio/coolify/${commit}/templates/compose/${itemId}.yaml`)
            return new Response('services:\n  monitor:\n    image: example/monitor:1\n');
        return null;
    });
    answer('/catalog.json', { body: { schemaVersion: 1, apps: [] } });
    const reference = { type: 'registryItem', kind: 'app', sourceId, itemId } as const;
    let listing: ReturnType<typeof useRegistryItem> | undefined;
    function CatalogMarks() {
        const rows = useRegistryItems({ kind: 'app', sourceIds: [sourceId] });
        listing = useRegistryItem({ kind: 'app', sourceId, itemId });
        const row = rows.items.find(item => item.itemId === itemId);
        return <>{row ? <StoreItemMark facts={{ kind: 'app', title: row.title, brand: row.brandMark }} size={26} /> : null}
            {listing.item ? <StoreItemMark facts={{ kind: 'app', title: listing.item.summary.title,
                brand: admitRegistrySummaryMark(listing.item.summary).brandMark }} size={26} /> : null}</>;
    }
    // A retained workspace destination has its own presentation owner. The enclosing native
    // navigator can be unfocused while this Store pane remains visible.
    const screen = await renderScreen(<><CatalogMarks />
        <NavigationContext.Provider value={createNavigationPropMock({ isFocused: () => false })}>
            <DestinationInstanceContext.Provider value={{ tabId: 'store', ref: { kind: 'store', params: {} },
                pathname: '/plugins', focused: true, visible: true, isFocused: () => true,
                navigation: { push: () => {}, replace: () => {}, back: () => {} } }}>
                <DiscoverMarkFromListing item={{ key: itemId, id: itemId, sourceId,
                    reference, kind: 'app', title, description: null }} />
            </DestinationInstanceContext.Provider>
        </NavigationContext.Provider></>);
    const iconUrl = `https://raw.githubusercontent.com/coollabsio/coolify/${commit}/public/${logo}`;
    await waitForHomeGovernance(() => expect(listing?.item, JSON.stringify(listing)).toMatchObject({ summary: { iconUrl } }));
    await waitForHomeGovernance(() => expect(screen.findAllByType(HappierBrandMark).map(mark => mark.props.brand.light))
        .toEqual(Array.from({ length: 3 }, () => ({ uri: iconUrl }))));
});

it('a pasted Chrome Web Store link in Store search installs that extension through the same install form', async () => {
    dialogs.confirm.mockResolvedValue(true);
    const { serve, serverUrl, serverIdentityId } = await setup('extension-link', 'browserExtension');
    const { StoreBrowserExtensionLinkResult } = await import('./StoreBrowserExtensionLinkResult');
    const extensionId = 'c'.repeat(32);
    const machineId = 'machine-a';
    const requests: unknown[] = [];
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId: 'alice',
        machineId, actionId: 'browser.extensions.install', tokenEpoch: 0, requesterInvocation: 'none',
        execute: input => {
            requests.push(input);
            return { status: 'updated', restartRequired: true, entry: { profileId: 'work', restartRequired: true, extension: {
                id: extensionId, name: 'Reader', version: '2.0', enabled: true, permissions: [], hostPermissions: [],
                directory: '/browser/extensions/reader', source: { kind: 'webStore', extensionId } } } };
        } });
    serve((path, init) => boundary.handle(new URL(path, serverUrl), init));
    // Ordinary search text is not a link and adds nothing.
    const plain = await renderScreen(<StoreBrowserExtensionLinkResult query="Reader" />);
    expect(plain.findHostByTestId('store.browserExtension.link.add')).toBeNull();
    await plain.unmount();
    const screen = await renderScreen(<StoreBrowserExtensionLinkResult query={` https://chromewebstore.google.com/detail/reader/${extensionId}?hl=en `} />);
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('store.browserExtension.link.add')?.props.accessibilityState?.disabled).not.toBe(true));
    await screen.pressByTestIdAsync('store.browserExtension.link.add');
    const presented = dialogs.show.mock.calls.at(-1)?.[0] as unknown as { props: { form: ActionInputForm } };
    const form = presented.props.form;
    expect(form.getFields().map(field => field.path)).toEqual(['machineId', 'profileId']);
    form.replaceInput({ ...form.getInput(), machineId, profileId: 'work' });
    let outcome: Awaited<ReturnType<typeof form.submit>> | undefined;
    await act(async () => { outcome = await form.submit(); });
    expect(outcome).toMatchObject({ kind: 'settled', outcome: { ok: true } });
    expect(requests).toEqual([expect.objectContaining({ machineId, profileId: 'work', source: { kind: 'webStore', extensionId } })]);
});
