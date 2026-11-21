import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { DEFAULT_CURATED_MARKETPLACE_SOURCE_URL, COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1 } from '@happier-dev/protocol/marketplace';
import { HAPPIER_PICKS_SOURCE_ID } from '@happier-dev/protocol/registries';
import { installTimerCensus, renderHook, standardCleanup } from '@/dev/testkit';
import { createRegistryPluginCatalogFixture, createRegistryNpmPackageFixture } from '@/dev/testkit/fixtures/registryPluginCatalog';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';

installPromptRegistriesCommonModuleMocks({ storage: original => original(), modal: async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module });
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { createPlainPromptLibraryCatalogHomeFixture } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
await Promise.all([import('@/auth/storage/tokenStorage'), import('@/sync/domains/server/serverRuntime'),
    import('@/sync/domains/state/storage'), import('@/utils/system/runtimeFetch'),
    import('@/sync/runtime/orchestration/appliedActiveServerRuntime')]);
const { usePluginSettingsScreenState } = await import('./model/usePluginSettingsScreenState');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { renderSettingsView } = await import('@/dev/testkit/harness/settingsViewHarness');
const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
const { PluginListingScreen } = await import('./listing/PluginListingScreen');
const { PluginAddModal } = await import('./add/openPluginAddModal');
const { CorePluginUiPresentationScope } = await import('@/components/plugins/surfaces/CorePluginUiPresentationScope');
function renderAddDialog(params: React.ComponentProps<typeof PluginAddModal>['params']) {
    return renderSettingsView(<CorePluginUiPresentationScope>
        <PluginAddModal onClose={() => {}} params={params} />
    </CorePluginUiPresentationScope>);
}

const { CapabilityAddModalBody } = await import('@/components/capabilities/add/CapabilityAddModal');
const actionFrontDoor = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { usePluginCatalog } = await import('./model/usePluginCatalog');
const { storeKinds } = await import('@/components/store/catalog/storeKinds');
const { StorePluginKind } = await import('@/components/store/StoreKindScreen');
const { StoreListingController } = await import('@/components/store/StoreListingController');
import type { StoreListingState } from '@/components/store/StoreListingController';

it('resolves a Store npm itemId to its admitted Plugin id and pin without listing or a title lookup', async () => {
    await setup('store-listing-pointer', { handleExternalRequest: npmBoundary() });
    const reads = observeRegistryReads();
    let current: StoreListingState = { kind: 'unavailable' };
    const screen = await renderSettingsView(<StoreListingController reference={{ type: 'registryItem', kind: 'plugin',
        sourceId: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1, itemId: '@sample/one', version: '1.0.0',
    }} onClose={() => {}}>{state => { current = state; return null; }}</StoreListingController>);
    await waitForHomeGovernance(() => expect(current).toMatchObject({ kind: 'plugin', resolving: false, listing: {
        sourceId: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1, itemId: '@sample/one', pluginId: 'sample.one', version: '1.0.0',
    } }));
    expect(reads.filter(read => read.action === 'registries.items.list')).toHaveLength(0);
    expect(reads.filter(read => read.action === 'registries.items.read')).toEqual([{ action: 'registries.items.read',
        input: { kind: 'plugin', sourceId: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1, itemId: '@sample/one', version: '1.0.0' } }]);
    await screen.unmount();
});

it('consumes stable Store rows across equal/changed refresh, selected exact read and hidden demand with 128 held Machines', async () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({ pluginId: `sample.store${index}`, title: `Store ${index}` }));
    const { fixture, sourceId, catalog, requests } = await setupCatalog('store-consumer-lifecycle', { entries });
    const { storage } = await import('@/sync/domains/state/storage');
    const { createMachineFixture } = await import('@/dev/testkit');
    const machines = Array.from({ length: 128 }, (_, index) => createMachineFixture({ id: `recorded-${index}` }));
    storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [fixture.home.id]: machines } });
    // Observe real timer boundaries. Attribute to the first app callsite, not a consumer
    // higher in the stack of a Registry/Action-owned deadline.
    const timers = installTimerCensus(stack => {
        const owner = stack.split('\n').find(line => line.includes('/sources/') && !line.includes('/dev/testkit/'));
        return owner && /\/components\/store\/|\/plugins\/model\/usePluginCatalog/.test(owner) ? 'store' : null;
    });
    onTestFinished(() => timers.stop());
    const reads = observeRegistryReads();
    let list!: ReturnType<typeof storeKinds.plugin.useList>;
    const input = { query: '', sourceIds: [sourceId] };
    const tree = (presented: boolean) => <StorePluginKind input={input} demand={{ presented }}>{value => {
        list = value;
        return null;
    }}</StorePluginKind>;
    const screen = await renderSettingsView(tree(false));
    expect(reads).toHaveLength(0);
    await screen.update(tree(true));
    await waitForHomeGovernance(() => expect(list.items).toHaveLength(100));
    const before = list.items;
    let requestCount = requests.length;
    await act(async () => { list.refresh(); });
    await waitForHomeGovernance(() => expect(requests.length).toBeGreaterThan(requestCount));
    await waitForHomeGovernance(() => expect(list.loading).toBe(false));
    expect.soft(list.items.filter((row, index) => row !== before[index])).toHaveLength(0);
    catalog.entries[42]!.display.title = 'Changed Store 42';
    requestCount = requests.length;
    await act(async () => { list.refresh(); });
    await waitForHomeGovernance(() => expect(requests.length).toBeGreaterThan(requestCount));
    await waitForHomeGovernance(() => expect(list.items[42]?.title).toBe('Changed Store 42'));
    expect.soft(list.items.filter((row, index) => row !== before[index])).toHaveLength(1);
    expect(reads.filter(read => read.action === 'registries.items.read')).toHaveLength(0);
    expect(timers.read().filter(timer => timer.consumer === 'store')).toHaveLength(0);
    const beforePreference = list.items;
    const beforePreferenceReads = reads.length;
    await act(async () => { storage.setState({ localSettings: { ...storage.getState().localSettings,
        pluginsCollectionViewV1: { installed: 'grid', discover: 'list' } } }); });
    expect(list.items).toBe(beforePreference);
    expect(reads).toHaveLength(beforePreferenceReads);
    await screen.update(tree(false));
    expect(timers.read().filter(timer => timer.consumer === 'store')).toHaveLength(0);
    const listsBeforeExact = reads.filter(read => read.action === 'registries.items.list').length;
    const selected = await renderHook(() => usePluginCatalog({ selection: {
        sourceId, pluginId: 'sample.store42', itemId: 'sample.store42', version: '1.2.3',
    } }));
    await waitForHomeGovernance(() => expect(selected.getCurrent().selectedItem?.summary.title).toBe('Changed Store 42'));
    expect(reads.filter(read => read.action === 'registries.items.list')).toHaveLength(listsBeforeExact);
    expect(reads.filter(read => read.action === 'registries.items.read')).toHaveLength(1);
    expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    await selected.unmount();
    await screen.unmount();
});

function observeRegistryReads(includeSources = false) {
    const reads: { action: string; input: unknown }[] = [];
    const create = actionFrontDoor.createFrontDoorActionExecute;
    // Observe real Action dispatches; all admission, transport and projection remain real.
    const observation = vi.spyOn(actionFrontDoor, 'createFrontDoorActionExecute').mockImplementation((...args) => {
        const execute = create(...args);
        return Object.assign((...invocation: Parameters<typeof execute>) => {
            if (invocation[0] === 'registries.items.read' || invocation[0] === 'registries.items.list'
                || includeSources && invocation[0] === 'registries.sources.list') {
                reads.push({ action: invocation[0], input: invocation[1] });
            }
            return execute(...invocation);
        }, { prepare: execute.prepare });
    });
    onTestFinished(() => observation.mockRestore());
    return reads;
}

it('shares one Plugin Add source acquisition across selector, catalog and selected detail', async () => {
    const { sourceId } = await setupCatalog('add-shared-source');
    // Count one presented source revision, independently of the Home's initial catalog hydration.
    const { usePromptLibraryCatalogValue } = await import('@/sync/store/usePromptLibraryCatalog');
    const accountCatalog = await renderHook(() => usePromptLibraryCatalogValue('registry-sources'));
    await waitForHomeGovernance(() => expect(accountCatalog.getCurrent().status).toBe('ready'));
    const reads = observeRegistryReads(true);
    const screen = await renderAddDialog({ initialSelection: {
        sourceId, itemId: 'sample.plugin', version: '1.2.3',
    } });
    const config = () => screen.findAll(node => node.type === CapabilityAddModalBody)[0]!.props.config;
    await waitForHomeGovernance(() => expect(config().catalog.items).toHaveLength(1));
    expect(reads.filter(read => read.action === 'registries.sources.list')).toHaveLength(1);
    const { useRegistrySourceMutations } = await import('@/registries/useRegistrySourceMutations');
    const mutation = await renderHook(() => useRegistrySourceMutations());
    await waitForHomeGovernance(() => expect(mutation.getCurrent().ready).toBe(true));
    const before = reads.length;
    await act(async () => { await mutation.getCurrent().update({ sourceId, title: 'Renamed shared source' }); });
    await waitForHomeGovernance(() => expect(config().catalog.items[0]?.sourceTitle).toBe('Renamed shared source'));
    expect(reads.slice(before).filter(read => read.action === 'registries.sources.list')).toHaveLength(1);
    await mutation.unmount();
    await screen.unmount();
    await accountCatalog.unmount();
});

it('opens a scale-shaped Browse with zero body reads and reads only the selected native listing', async () => {
    const reads = observeRegistryReads();
    const entries = Array.from({ length: 100 }, (_, index) => ({ pluginId: `sample.plugin${index}`, title: `Plugin ${index}` }));
    const { hook, sourceId } = await setup('summary-cost', { entries });
    await act(async () => { hook.getCurrent().setActiveView('discover'); hook.getCurrent().setSelectedDiscoverSourceId(sourceId); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toHaveLength(100));
    expect(reads.filter(read => read.action === 'registries.items.read')).toHaveLength(0);
    const listing = { sourceId, pluginId: 'sample.plugin42', itemId: 'sample.plugin42', version: '1.2.3' };
    await act(async () => { hook.getCurrent().openDiscoverListing(listing); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toHaveLength(1));
    expect(hook.getCurrent().discoverEntries[0]).toMatchObject({ id: 'sample.plugin42', version: '1.2.3' });
    expect(reads.filter(read => read.action === 'registries.items.read')).toHaveLength(1);
});

it('narrows the Store Plugin adapter at acquisition by all selected source ids', async () => {
    const { fixture, sourceId } = await setup('store-source-scope', { curatedEntries: [
        { pluginId: 'curated.only', title: 'Curated only', review: 'approved' },
    ] });
    const reads = observeRegistryReads();
    const input = { query: '', sourceIds: [sourceId] };
    let presented = false;
    const hook = await renderHook(() => storeKinds.plugin.useList(input, { presented }));
    expect(hook.getCurrent().items).toEqual([]);
    expect(reads).toHaveLength(0);
    presented = true;
    await hook.rerender();
    await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
    await waitForHomeGovernance(() => expect(hook.getCurrent().items).toHaveLength(1));
    expect(hook.getCurrent().items[0]?.sourceId).toBe(sourceId);
    const summary = storeKinds.plugin.summary(hook.getCurrent().items[0]!);
    expect(summary.ref).toMatchObject({ sourceId, itemId: 'sample.plugin', version: '1.2.3' });
    expect(reads.filter(read => read.action === 'registries.items.list').every(read =>
        JSON.stringify(read.input).includes(sourceId))).toBe(true);
    expect(reads.filter(read => read.action === 'registries.items.read')).toHaveLength(0);
    expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
});

it('opens a cold npm native pointer without any list-for-location and refuses mismatched Plugin identity', async () => {
    const reads = observeRegistryReads();
    const { hook } = await setup('npm-exact-cost', { handleExternalRequest: npmBoundary() });
    const listing = { sourceId: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1,
        pluginId: 'sample.one', itemId: '@sample/one', version: '1.0.0' };
    await act(async () => { hook.getCurrent().setActiveView('discover'); hook.getCurrent().openDiscoverListing(listing); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toHaveLength(1));
    expect(hook.getCurrent().discoverEntries[0]).toMatchObject({ id: 'sample.one', itemId: '@sample/one', version: '1.0.0' });
    expect(reads.filter(read => read.action === 'registries.items.list')).toHaveLength(0);
    expect(reads.filter(read => read.action === 'registries.items.read')).toHaveLength(1);
    await act(async () => { hook.getCurrent().openDiscoverListing({ ...listing, pluginId: 'sample.two' }); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().loadingDiscover).toBe(false));
    expect(hook.getCurrent().discoverEntries).toEqual([]);
});

it.each(['available', 'unavailable pin', 'withdrawn source'] as const)('opens an exact Add seed without browsing or substituting a different item: %s', async state => {
    const { sourceId } = await setup(`add-seed-${state.replaceAll(' ', '-')}`);
    const reads = observeRegistryReads();
    const screen = await renderAddDialog({ initialSelection: {
        sourceId: state === 'withdrawn source' ? 'removed-source' : sourceId,
        itemId: 'sample.plugin', version: state === 'unavailable pin' ? '9.9.9' : '1.2.3',
    } });
    const catalog = () => screen.findAll(node => node.type === CapabilityAddModalBody)[0]?.props.config.catalog;
    await waitForHomeGovernance(() => expect(catalog()?.loading).toBe(false));
    expect(catalog().items).toHaveLength(state === 'available' ? 1 : 0);
    expect(reads.filter(read => read.action === 'registries.items.list')).toHaveLength(0);
    expect(reads.filter(read => read.action === 'registries.items.read')).toHaveLength(state === 'withdrawn source' ? 0 : 1);
    if (state === 'withdrawn source') {
        const sourceSelect = screen.findAll(node => node.props.filter?.testID === 'plugins.add.registries.select')[0];
        await act(async () => { sourceSelect!.props.filter.renderPopoverContent({ close() {}, maxHeight: 400 }).props.onSelect('all'); });
    } else {
        await act(async () => { catalog().onQueryChange('sample'); });
    }
    await waitForHomeGovernance(() => expect(catalog().items).toHaveLength(1));
    expect(reads.some(read => read.action === 'registries.items.list')).toBe(true);
});

it.each([false, true])('withdraws Plugin Add catalog reads during registry administration and resumes current results (seed=%s)', async seeded => {
    const { sourceId, catalog } = await setupCatalog(`add-registry-demand-${seeded}`);
    const reads = observeRegistryReads();
    const { useRegistrySourceMutations } = await import('@/registries/useRegistrySourceMutations');
    const mutation = await renderHook(() => useRegistrySourceMutations());
    const screen = await renderAddDialog(seeded ? { initialSelection: {
        sourceId, itemId: 'sample.plugin', version: '1.2.3',
    } } : {});
    const config = () => screen.findAll(node => node.type === CapabilityAddModalBody)[0]!.props.config;
    await waitForHomeGovernance(() => expect(config().catalog.items).toHaveLength(1));
    const select = screen.findAll(node => node.props.filter?.testID === 'plugins.add.registries.select')[0]!;
    await act(async () => select.props.filter.renderPopoverContent({ close() {}, maxHeight: 400 }).props.onSelect('action:manage'));
    await waitForHomeGovernance(() => expect(screen.findByTestId('plugins.add:registries')).not.toBeNull());
    const before = reads.length;
    catalog.entries[0]!.display.title = 'Updated while managing sources';
    await waitForHomeGovernance(() => expect(mutation.getCurrent().ready).toBe(true));
    await act(async () => { await mutation.getCurrent().update({ sourceId, title: 'Updated source title' }); });
    // The visible source detail reads its own page for count/status. Hidden Browse/seed reads must stay withdrawn.
    expect(reads.slice(before)).toEqual([{ action: 'registries.items.list',
        input: expect.objectContaining({ kind: 'plugin', sourceIds: [sourceId] }) }]);
    const beforeReturn = reads.length;
    await screen.pressByTestIdAsync('plugins.add:back');
    await waitForHomeGovernance(() => expect(config().catalog.items[0]?.title).toBe('Updated while managing sources'));
    expect(reads.length).toBeGreaterThan(beforeReturn);
    await mutation.unmount();
});

it('keeps closed catalogs idle and settles cold legacy npm links as unresolved without guessing a package or scanning', async () => {
    const reads = observeRegistryReads();
    await setup('legacy-npm-cost', { handleExternalRequest: npmBoundary() });
    const closed = await renderHook(() => usePluginCatalog({ enabled: false, browse: true }));
    expect(closed.getCurrent().discoverEntries).toEqual([]);
    expect(reads).toHaveLength(0);
    const legacy = await renderHook(() => usePluginCatalog({ selection: {
        sourceId: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1, pluginId: 'sample.one',
    } }));
    await waitForHomeGovernance(() => expect(legacy.getCurrent().unresolvedListing).toBe(true));
    expect(legacy.getCurrent().loadingDiscover).toBe(false);
    expect(legacy.getCurrent().discoverEntries).toEqual([]);
    expect(reads).toHaveLength(0);
});

it('refuses an unavailable reviewed npm pin without substituting latest or searching the source', async () => {
    const reads = observeRegistryReads();
    await setup('npm-pin-refusal', { handleExternalRequest: npmBoundary() });
    const selected = await renderHook(() => usePluginCatalog({ selection: {
        sourceId: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1, pluginId: 'sample.one', itemId: '@sample/one', version: '9.9.9',
    } }));
    await waitForHomeGovernance(() => expect(selected.getCurrent().discoverError).not.toBeNull());
    expect(selected.getCurrent().discoverEntries).toEqual([]);
    expect(selected.getCurrent().selectedItem).toBeNull();
    expect(reads.filter(read => read.action === 'registries.items.list')).toHaveLength(0);
});

async function setupCatalog(suffix: string, options: Readonly<{
    entries?: Parameters<typeof createRegistryPluginCatalogFixture>[0]['entries'];
    curatedEntries?: Parameters<typeof createRegistryPluginCatalogFixture>[0]['entries'];
    handleExternalRequest?: (url: string) => Promise<Response | null>;
}> = {}) {
    const serverUrl = `https://plugin-discovery-${suffix}.test`;
    const sourceUrl = `${serverUrl}/catalog.json`;
    const catalog = createRegistryPluginCatalogFixture({ sourceUrl, entries: options.entries });
    const sourceId = catalog.source.id;
    const curated = createRegistryPluginCatalogFixture({ sourceUrl: DEFAULT_CURATED_MARKETPLACE_SOURCE_URL,
        kind: 'curated', entries: options.curatedEntries ?? [] });
    let unavailable = false;
    let pending: Promise<void> | null = null;
    const requests: string[] = [];
    const fixture = await createPlainPromptLibraryCatalogHomeFixture(serverUrl, {
        key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [{ id: sourceId, title: 'Private catalog',
            format: 'happier-catalog', kinds: ['plugin'], url: sourceUrl, enabled: true, addedAt: 1 }] },
    }, 'updated', {
        handleRequest: async path => {
            if (path !== '/catalog.json') return null;
            requests.push(sourceUrl);
            await pending;
            return unavailable ? new Response(null, { status: 503 }) : Response.json(catalog);
        },
        handleExternalRequest: async url => {
            requests.push(url);
            const response = await options.handleExternalRequest?.(url);
            if (response) return response;
            if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return Response.json(curated);
            if (url.startsWith('https://registry.npmjs.org/-/v1/search')) return Response.json({ total: 0, objects: [] });
            return null;
        },
    });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ localSettings: { ...storage.getState().localSettings,
        pluginsCollectionViewV1: { installed: 'list', discover: 'list' } } });
    return { fixture, sourceId, sourceUrl, requests, catalog,
        fail: () => { unavailable = true; }, recover: () => { unavailable = false; }, hold: (value: Promise<void> | null) => { pending = value; } };
}

async function setup(suffix: string, options: Parameters<typeof setupCatalog>[1] = {}) {
    const catalog = await setupCatalog(suffix, options);
    const { fixture, requests } = catalog;
    const hook = await renderHook(() => usePluginSettingsScreenState());
    onTestFailed(() => {
        const state = hook.getCurrent();
        console.error('Registry discovery boundary:', JSON.stringify({ requests, homeRequests: fixture.requests,
            sourceId: state.selectedDiscoverSourceId, entries: state.discoverEntries.map(entry => ({ id: entry.id, version: entry.version })),
            loading: state.loadingDiscover, loadingMore: state.loadingMoreDiscover, nextCursor: state.discoverNextCursor, error: state.discoverError }));
    });
    await waitForHomeGovernance(() => expect(hook.getCurrent().canRefreshDiscover).toBe(true));
    return { ...catalog, hook };
}

async function browse(hook: Awaited<ReturnType<typeof setup>>['hook']) {
    await act(async () => { hook.getCurrent().setActiveView('discover'); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toContainEqual(expect.objectContaining({ id: 'sample.plugin' })));
    await waitForHomeGovernance(() => expect(hook.getCurrent().loadingDiscover).toBe(false));
}

it('browses the Account source union without a Machine and keeps each source-qualified listing and reviewed version', async () => {
    const { hook, fixture, sourceId } = await setup('union', { curatedEntries: [{ pluginId: 'sample.plugin', title: 'Curated Sample', version: '2.0.0', review: 'approved' }] });
    await browse(hook);
    expect(hook.getCurrent().discoverSources.map(source => source.id)).toEqual(expect.arrayContaining([sourceId, HAPPIER_PICKS_SOURCE_ID, COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1]));
    expect(hook.getCurrent().discoverSources.filter(source => source.id === COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1)).toHaveLength(1);
    expect(hook.getCurrent().selectedDiscoverSourceId).toBeNull();
    expect(hook.getCurrent().discoverEntries).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'sample.plugin', sourceId, version: '1.2.3', installable: true, warning: 'unreviewed' }),
        expect.objectContaining({ id: 'sample.plugin', sourceId: HAPPIER_PICKS_SOURCE_ID, version: '2.0.0', installable: true }),
    ]));
    expect(hook.getCurrent().executionMachineId).toBeNull();
    expect(hook.getCurrent().canRunDiscoverActions).toBe(false);
    expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
    await act(async () => { hook.getCurrent().setSelectedDiscoverSourceId(sourceId); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toHaveLength(1));
    expect(hook.getCurrent().discoverEntries[0]?.sourceId).toBe(sourceId);
    expect(fixture.mutations).toEqual([]);
});

it('keeps shown results while a search draft changes, submits the requested query, and clears an empty search', async () => {
    const { hook } = await setup('search');
    await browse(hook);
    const shown = hook.getCurrent().discoverEntries;
    await act(async () => { hook.getCurrent().setDiscoverSearchText('absent plugin'); });
    expect(hook.getCurrent().discoverEntries).toBe(shown);
    expect(hook.getCurrent().discoverStale).toBe(true);
    await act(async () => { hook.getCurrent().refreshDiscover(); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toEqual([]));
    expect(hook.getCurrent().discoverError).toBeNull();
    await act(async () => { hook.getCurrent().clearDiscoverSearch(); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toHaveLength(1));
    expect(hook.getCurrent().discoverSearchText).toBe('');
    expect(hook.getCurrent().discoverStale).toBe(false);
});

it('retains a known listing while refresh is pending, exposes the failed source, and recovers through Retry', async () => {
    const { hook, sourceId, fail, recover, hold } = await setup('outage');
    await browse(hook);
    const known = hook.getCurrent().discoverEntries;
    let release!: () => void;
    hold(new Promise<void>(resolve => { release = resolve; }));
    onTestFinished(() => { release(); });
    await act(async () => { hook.getCurrent().refreshDiscover(); });
    expect(hook.getCurrent().discoverEntries).toBe(known);
    fail();
    await act(async () => { release(); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverSourceStatuses).toContainEqual(expect.objectContaining({ id: sourceId, freshness: 'unavailable' })));
    expect(hook.getCurrent().discoverDiagnostics).toContainEqual(expect.objectContaining({ sourceId, code: 'unreachable' }));
    recover(); hold(null);
    await act(async () => { hook.getCurrent().refreshDiscover(); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toContainEqual(expect.objectContaining({ id: 'sample.plugin', sourceId })));
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverSourceStatuses).toContainEqual(expect.objectContaining({ id: sourceId, freshness: 'fresh' })));
});

it('keeps a withdrawn curated listing inspectable and exposes blocked listings separately from installable metadata', async () => {
    const { hook } = await setup('review', { curatedEntries: [
        { pluginId: 'withdrawn.plugin', title: 'Withdrawn', review: 'withdrawn' },
        { pluginId: 'blocked.plugin', title: 'Blocked', review: 'blocked' },
    ] });
    await browse(hook);
    expect(hook.getCurrent().discoverEntries).toContainEqual(expect.objectContaining({ id: 'withdrawn.plugin', warning: 'withdrawn', installable: false }));
    expect(hook.getCurrent().discoverNonInstallable).toContainEqual(expect.objectContaining({ pluginId: 'blocked.plugin', reason: 'notApproved' }));
    await act(async () => { hook.getCurrent().openDiscoverListing({ sourceId: HAPPIER_PICKS_SOURCE_ID, pluginId: 'withdrawn.plugin' }); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toHaveLength(1));
    expect(hook.getCurrent().discoverEntries[0]).toMatchObject({ id: 'withdrawn.plugin', sourceId: HAPPIER_PICKS_SOURCE_ID, installable: false });
});

function npmBoundary() {
    const packages = [
        createRegistryNpmPackageFixture({ packageName: '@sample/one', pluginId: 'sample.one', title: 'First Plugin', version: '1.0.0' }),
        createRegistryNpmPackageFixture({ packageName: '@sample/two', pluginId: 'sample.two', title: 'Second Plugin', version: '2.0.0' }),
    ];
    return async (url: string): Promise<Response | null> => {
        const parsed = new URL(url);
        if (parsed.origin !== 'https://registry.npmjs.org') return null;
        if (parsed.pathname === '/-/v1/search') {
            if (parsed.searchParams.get('text')?.includes('absent')) return Response.json({ total: 0, objects: [] });
            const exact = packages.find(candidate => parsed.searchParams.get('text')?.includes(candidate.name));
            const metadata = exact ?? packages[Number(parsed.searchParams.get('from') ?? '0')];
            return Response.json({ total: exact ? 1 : packages.length, objects: metadata ? [{ package: {
                name: metadata.name, version: metadata.version, publisher: { username: 'sample' },
            } }] : [] });
        }
        const metadata = packages.find(candidate => decodeURIComponent(parsed.pathname.slice(1)) === candidate.name);
        return metadata ? Response.json({ name: metadata.name, versions: { [metadata.version]: metadata }, 'dist-tags': { latest: metadata.version } }) : null;
    };
}

it('pages Community npm through the real format reader and clears its continuation when the query changes', async () => {
    const { hook, requests } = await setup('npm-paging', { handleExternalRequest: npmBoundary() });
    await act(async () => { hook.getCurrent().setActiveView('discover'); hook.getCurrent().setSelectedDiscoverSourceId(COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries, 'Community npm first page').toHaveLength(1));
    expect(hook.getCurrent().discoverEntries[0]).toMatchObject({ id: 'sample.one', version: '1.0.0', sourceId: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1 });
    expect(hook.getCurrent().discoverNextCursor).not.toBeNull();
    await act(async () => { hook.getCurrent().loadMoreDiscover(); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries, 'Community npm continuation').toHaveLength(2));
    expect(hook.getCurrent().discoverEntries.map(entry => entry.id)).toEqual(['sample.one', 'sample.two']);
    expect(requests.some(url => new URL(url).searchParams.get('from') === '1')).toBe(true);
    await act(async () => { hook.getCurrent().setDiscoverSearchText('absent'); });
    await act(async () => { hook.getCurrent().refreshDiscover(); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toEqual([]));
    expect(hook.getCurrent().discoverNextCursor).toBeNull();
});

it('settles the latest selected source while an earlier catalog response is still pending', async () => {
    const { hook, sourceId, hold } = await setup('source-race', { handleExternalRequest: npmBoundary() });
    let release!: () => void;
    hold(new Promise<void>(resolve => { release = resolve; }));
    onTestFinished(() => { release(); });
    await act(async () => { hook.getCurrent().setActiveView('discover'); hook.getCurrent().setSelectedDiscoverSourceId(sourceId); });
    await act(async () => { hook.getCurrent().setSelectedDiscoverSourceId(COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().discoverEntries).toHaveLength(1));
    expect(hook.getCurrent().discoverEntries[0]?.sourceId).toBe(COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1);
    await act(async () => { release(); });
    expect(hook.getCurrent().selectedDiscoverSourceId).toBe(COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1);
    expect(hook.getCurrent().discoverEntries[0]?.sourceId).toBe(COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1);
});

it('renders current registry listings and a single polite status region through the Plugins page', async () => {
    const { sourceId } = await setup('screen');
    const screen = await renderSettingsView(<AppPaneProvider><PluginSettingsHomeScreen /></AppPaneProvider>);
    await act(async () => { screen.pressByTestId('settings.plugins.management.view:discover'); });
    await waitForHomeGovernance(() => expect(screen.findByTestId(`settings.plugins.marketplace.entry.${sourceId}.sample.plugin`)).not.toBeNull());
    const status = screen.findHostByTestId('settings.plugins.marketplace.discover.status');
    expect(status).not.toBeNull();
    expect(status?.findAll(node => typeof node.type === 'string' && node.props.accessibilityLiveRegion === 'polite')).toHaveLength(1);
    expect(screen.getTextContent()).toContain('Sample Plugin');
    const search = screen.findAll(node => node.props.testID === 'settings.plugins.marketplace.search'
        && typeof node.props.onChangeText === 'function')[0];
    expect(search).toBeDefined();
    await act(async () => { search!.props.onChangeText('absent'); });
    // Typing is a draft: the current result remains until the real submit path runs.
    expect(screen.findByTestId(`settings.plugins.marketplace.entry.${sourceId}.sample.plugin`)).not.toBeNull();
    const submittedSearch = screen.findAll(node => node.props.testID === 'settings.plugins.marketplace.search'
        && typeof node.props.onSubmitEditing === 'function')[0];
    await act(async () => { submittedSearch!.props.onSubmitEditing(); });
    await waitForHomeGovernance(() => expect(screen.findByTestId(`settings.plugins.marketplace.entry.${sourceId}.sample.plugin`)).toBeNull());
    // The loading view also has no rows; Clear belongs to the settled no-match
    // result, so wait for that actual recovery control before pressing it.
    await waitForHomeGovernance(() => expect(screen.findByTestId('settings.plugins.marketplace.discover.clearSearch')).not.toBeNull());
    await act(async () => { screen.pressByTestId('settings.plugins.marketplace.discover.clearSearch'); });
    await waitForHomeGovernance(() => expect(screen.findByTestId(`settings.plugins.marketplace.entry.${sourceId}.sample.plugin`)).not.toBeNull());
});

it('reads a source-qualified listing page without installing or writing Account state', async () => {
    const { fixture, sourceId } = await setup('listing');
    const screen = await renderSettingsView(<AppPaneProvider><PluginListingScreen sourceId={sourceId} pluginId="sample.plugin" /></AppPaneProvider>);
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Sample Plugin'));
    expect(screen.getTextContent()).toContain('1.2.3');
    expect(fixture.mutations).toEqual([]);
    expect(fixture.requests.some(request => request.path.startsWith('/v1/machines'))).toBe(false);
});

it('announces the real pending catalog once and renders its source failure outside the live region', async () => {
    const { sourceId, hold, fail } = await setup('screen-pending');
    let release!: () => void;
    hold(new Promise<void>(resolve => { release = resolve; }));
    onTestFinished(() => { release(); });
    const screen = await renderSettingsView(<AppPaneProvider><PluginSettingsHomeScreen /></AppPaneProvider>);
    await act(async () => { screen.pressByTestId('settings.plugins.management.view:discover'); });
    await waitForHomeGovernance(() => {
        const status = screen.findHostByTestId('settings.plugins.marketplace.discover.status');
        expect(status?.findAll(node => typeof node.type === 'string' && node.props.accessibilityLiveRegion === 'polite')).toHaveLength(1);
    });
    fail();
    await act(async () => { release(); });
    await waitForHomeGovernance(() => expect(screen.findByTestId('settings.plugins.marketplace.discover.sources')).not.toBeNull());
    expect(screen.getTextContent()).not.toContain('HTTP 503');
});

it('previews a Git link before Review and installs only from Review (Add from GitHub)', async () => {
    await setupCatalog('git-preview');
    const preview = {
        ok: true as const, source: { locator: 'https://github.com/acme/tools' }, resolvedCommit: 'a'.repeat(40),
        release: { kind: 'stableRelease' as const, tag: 'v1.4.0' },
        summary: { sourceId: 'git-preview', kind: 'plugin' as const, itemId: 'acme.tools', title: 'Acme tools',
            vendorPlugin: { contentCounts: { skills: 8, mcpServers: 1 }, notImported: { commands: 3 } } },
    };
    // The host's preview and install capabilities are the dialog's contract; their Actions are covered by their owners.
    const onPreviewGit = vi.fn(async () => ({ kind: 'preview' as const, preview }));
    const onInstallGit = vi.fn(() => true);
    const screen = await renderAddDialog({ onInstallGit, onPreviewGit });
    const gitTab = screen.findAll(node => typeof node.props.testID === 'string' && node.props.testID.endsWith(':mode:git'))[0];
    await screen.pressByTestIdAsync(gitTab!.props.testID);
    await waitForHomeGovernance(() => expect(screen.findByTestId('plugins.add.git.url')).not.toBeNull());
    await act(async () => { screen.changeTextByTestId('plugins.add.git.url', 'https://github.com/acme/tools'); });
    expect(screen.findByTestId('plugins.add.git.review')?.props.disabled).toBe(true);
    await screen.pressByTestIdAsync('plugins.add.git.preview');
    await waitForHomeGovernance(() => expect(screen.findByTestId('plugins.add.git.previewSummary')).not.toBeNull());
    expect(onPreviewGit).toHaveBeenCalledExactlyOnceWith({ locator: 'https://github.com/acme/tools' });
    expect(onInstallGit).not.toHaveBeenCalled();
    const text = screen.getTextContent();
    expect(text).toContain('Acme tools');
    // Where it resolves: the repository, then its release and the short commit it would install.
    const header = screen.findAll(node => node.props.testID === 'plugins.add.git.previewHeader' && node.props.facts !== undefined)[0];
    expect(header?.props.facts).toMatchObject({ source: { label: 'https://github.com/acme/tools' } });
    expect(header?.props.facts.extra).toHaveLength(2);
    expect(screen.findByTestId('plugins.add.git.notImported')).not.toBeNull();
    await screen.pressByTestIdAsync('plugins.add.git.review');
    expect(onInstallGit).toHaveBeenCalledExactlyOnceWith({ locator: 'https://github.com/acme/tools' });
    await screen.unmount();
});
