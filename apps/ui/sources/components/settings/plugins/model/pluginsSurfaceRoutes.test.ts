import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveHref } from 'expo-router/build/link/href';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { DestinationInstanceHost, type DestinationNavigation } from '@/components/appShell/workspace/DestinationInstanceHost';
import { createWorkspaceNavigationAdapter } from '@/components/appShell/workspace/workspaceNavigationAdapter';
import { createWorkspaceState, reduceWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { hrefForDestinationRef, resolveCompactAppDestinations, resolveDestinationRefFromHref } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import { usePluginsOpenItem, useStoreDirectoryState } from './usePluginsOpenItem';
import { PluginListingRoute } from '../listing/PluginListingRoute';
import { useOpenStoreListing } from '@/components/store/StoreListing';

import {
    buildPluginDetailRoute,
    buildPluginListingRoute,
    buildPluginsHomeRoute,
    PLUGINS_HOME_TITLE_KEY,
    pluginsHomeTitleKey,
    readStoreOpenItem,
    readStoreListingRoute,
    buildStoreListingRoute,
    readStoreDirectoryRoute,
    readStoreProjectRoute,
    readStoreMachineRoute,
    storeMachineRouteParams,
    storeProjectRouteParams,
    pluginsOpenItemParams,
    readPluginDetailRoutePluginId,
    readPluginsOpenItem,
    readPluginListingRouteParams,
    resolvePluginsSurfaceHost,
    type PluginsOpenItem,
    type PluginsSurfaceHost,
    type StoreListingReference,
} from './pluginsSurfaceRoutes';

const boundary = vi.hoisted(() => ({ width: 1440, height: 1000 }));
// Dimensions, native composition and Expo URL transport are platform boundaries. The route
// selection hook, form-factor policy, destination catalog, workspace reducer and history stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const dimensions = () => ({ ...boundary, scale: 1, fontScale: 1 });
    return createReactNativeWebMock({
        Dimensions: { get: dimensions },
        useWindowDimensions: dimensions,
    });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

afterEach(() => {
    boundary.width = 1440;
    boundary.height = 1000;
    standardCleanup();
});

function PluginSelectionProbe() {
    const selection = usePluginsOpenItem();
    const directory = useStoreDirectoryState();
    const available = useDetailsPaneAvailable();
    return React.createElement('PluginSelectionProbe', { selection, directory, available });
}

function pluginSelectionHarness(host: PluginsSurfaceHost, item: PluginsOpenItem, preview = false) {
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
        externalSessions: false, inbox: false, workflows: false, friends: false,
    } });
    const home = buildPluginsHomeRoute(host, { view: item.kind === 'listing' ? 'browse' : 'installed' });
    const target = resolveDestinationRefFromHref(catalog, `${home}&anchor=kept`);
    if (!target) throw new Error('Plugins home is not registered in the real destination catalog');
    let state = createWorkspaceState({ id: 'plugins', target, pinned: false, preview });
    let nextTabId = 0;
    const adapter = createWorkspaceNavigationAdapter({
        getState: () => state,
        getCatalog: () => catalog,
        dispatch: (action) => { state = reduceWorkspaceState(state, action); },
        transport: { commit: () => {} },
        createId: () => `plugin-detail:${++nextTabId}`,
        onChange: () => {},
    });
    adapter.initialize(`${home}&anchor=kept`);
    const navigationForTab = (tabId: string): DestinationNavigation => ({
        push: (href) => { adapter.openHref(resolveHref(href), { tabId }); },
        pushRetainingCurrent: (href) => {
            adapter.dispatch({ type: 'promoteTab', tabId });
            adapter.openHref(resolveHref(href), { mode: 'newTab' });
        },
        replace: (href) => { adapter.openHref(resolveHref(href), { tabId, replace: true }); },
        back: () => adapter.step(-1),
        setParams: (values) => adapter.setParams(tabId, values),
    });
    const active = () => state.tabs[state.groups[state.focusedGroupId].activeTabId];
    const current = () => active().target;
    const href = () => hrefForDestinationRef(catalog, current());
    const tree = (children: React.ReactNode = React.createElement(PluginSelectionProbe)) => React.createElement(DestinationInstanceHost, {
        tabId: active().id, ref: current(), pathname: href()?.split('?')[0] ?? '',
        focused: true, visible: true, navigation: navigationForTab(active().id),
        children,
    });
    return { adapter, current, href, tree, catalog, parent: () => state.tabs.plugins };
}

function readSelection(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.root.findByType('PluginSelectionProbe').props as {
        selection: ReturnType<typeof usePluginsOpenItem>;
        directory: ReturnType<typeof useStoreDirectoryState>;
        available: boolean;
    };
}

describe('plugins surface routes', () => {
    it('retains a curated native Software choice before a browse Machine is selected', () => {
        const reference = { type: 'software', value: { kind: 'toolchain', adapterId: 'mise', tool: 'python' } } as const;
        expect(readStoreOpenItem({ selection: JSON.stringify(reference) })).toEqual(reference);
        const route = buildStoreListingRoute(reference);
        expect(readStoreListingRoute(route.params)).toEqual({ kind: 'store', reference });
    });
    it('keeps the originating phone directory tab alive when a listing is pushed from a preview', async () => {
        boundary.width = 390;
        const h = pluginSelectionHarness('app', { kind: 'installed', pluginId: 'tools' }, true);
        h.adapter.setParams('plugins', { view: 'search', q: 'tool', plugin: undefined,
            filters: JSON.stringify({ kind: { include: ['mcpServer'], exclude: [] } }) });
        const before = h.current();
        function OpenListingProbe() {
            return React.createElement('OpenListingProbe', { open: useOpenStoreListing() });
        }
        const screen = await renderScreen(h.tree(React.createElement(OpenListingProbe)));
        const reference = { type: 'registryItem', kind: 'mcpServer', sourceId: 'builtin:mcp-registry', itemId: 'example/tool', version: '1' } as const;
        await act(async () => { screen.root.findByType('OpenListingProbe').props.open(reference); });
        // A replacement preview retires the mounted directory (including its scroll/focus); retained navigation keeps it.
        expect(h.parent()?.target).toEqual(before);
        expect(h.parent()?.preview).toBe(false);
        expect(readStoreOpenItem(h.current().params)).toEqual(reference);
        h.adapter.step(-1);
        expect(h.current()).toEqual(before);
    });
    it('admits exact Software option and target through the same selection and listing route without registry fabrication', () => {
        const target = { scope: { serverId: 'software-home', accountId: 'alice' },
            machine: { serverIdentityId: 'srv_software', machineId: 'same-id' } };
        // A stopped Setup run's Edit reopens its recipe with the inputs it proposed.
        for (const [value, inputs] of [[{ pluginId: 'example.software', recipeId: 'package', revision: '3' }, undefined],
            [{ kind: 'toolchain', adapterId: 'mise', tool: 'node' }, undefined],
            [{ pluginId: 'example.software', recipeId: 'package', revision: '3' }, { packages: ['ripgrep', 'fd-find'] }]] as const) {
            const reference = { type: 'software' as const, target, value, ...(inputs ? { inputs } : {}) };
            expect(readStoreOpenItem({ selection: JSON.stringify(reference) })).toEqual(reference);
            expect(readStoreListingRoute({ selection: JSON.stringify(reference) })).toEqual({ kind: 'store', reference });
            const route = buildStoreListingRoute(reference);
            expect(readStoreOpenItem(route.params)).toEqual(reference);
            const h = pluginSelectionHarness('app', { kind: 'installed', pluginId: 'tools' });
            expect(h.adapter.openHref(resolveHref(route), { tabId: 'plugins' })).toBe(true);
            expect(readStoreOpenItem(h.current().params)).toEqual(reference);
        }
        for (const reference of [
            { type: 'software', target: { ...target, machine: null }, value: { pluginId: 'example.software', recipeId: 'package', revision: '3' } },
            { type: 'software', target, value: { label: 'Package' } },
            { type: 'software', target, value: { kind: 'toolchain', adapterId: 'mise' } },
            { type: 'software', target, value: { pluginId: 'example.software', recipeId: 'package', revision: '3' }, inputs: ['ripgrep'] },
        ]) expect(readStoreListingRoute({ selection: JSON.stringify(reference), sourceId: 'wrong', pluginId: 'fallback' })).toBeNull();
    });
    it('admits every Store view through workspace navigation without losing narrowing or grouping', () => {
        const h = pluginSelectionHarness('app', { kind: 'installed', pluginId: 'tools' });
        const filters = { source: { include: ['catalog:team'], exclude: [] }, kind: { include: ['skill'], exclude: [] } };
        const hrefs = [
            '/plugins',
            ...['discover', 'jobs', 'updates'].map(view => `/plugins?view=${view}`),
            buildPluginsHomeRoute('app', { view: 'job', job: 'browser', catalogSourceId: 'catalog:team' }),
            buildPluginsHomeRoute('app', { view: 'category', category: 'developer-tools', catalogSourceId: 'catalog:team' }),
            ...(['mcpServer', 'skill', 'agent', 'provider', 'plugin', 'software'] as const)
                .map(kind => buildPluginsHomeRoute('app', { view: 'kind', kind })),
            buildPluginsHomeRoute('app', { view: 'search', query: 'docs & review', sourceId: 'catalog:team', filters }),
            `${buildPluginsHomeRoute('app', { view: 'installed', query: 'docs', filters })}&group=machine`,
        ];
        for (const href of hrefs) {
            expect(h.adapter.openHref(href, { tabId: 'plugins' }), href).toBe(true);
            expect(h.current().kind, href).toBe('plugins');
            expect(h.current().params, href).toMatchObject(Object.fromEntries(new URL(href, 'https://happier.test').searchParams));
        }
        const reference = { type: 'registryItem', kind: 'skill', sourceId: 'catalog:team', itemId: 'docs/review', version: 'revision-one' } as const;
        expect(h.adapter.openHref(resolveHref(buildStoreListingRoute(reference)), { tabId: 'plugins' })).toBe(true);
        expect(readStoreListingRoute(h.current().params)).toEqual({ kind: 'store', reference });
    });
    it('refuses ambiguous qualified listing selections at the canonical reader', () => {
        const reference = { type: 'registryItem', kind: 'skill', sourceId: 'catalog:team', itemId: 'docs/review' } as const;
        const selection = JSON.stringify(reference);
        for (const value of [[selection], [selection, '{'], ['{', selection]]) {
            expect(readStoreOpenItem({ selection: value })).toBeNull();
            expect(readStoreListingRoute({ selection: value, sourceId: 'legacy', pluginId: 'wrong-fallback' })).toBeNull();
        }
    });
    it('keeps the Machine chosen at Deploy an app here through the Store destination', () => {
        const machine = { serverId: 'home:a', machineId: 'vps/web & api' };
        const options = { view: 'kind' as const, kind: 'app' as const, machine };
        const href = buildPluginsHomeRoute('app', options);
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
        const target = resolveDestinationRefFromHref(catalog, href);
        expect(target?.kind).toBe('plugins');
        expect(target?.params.machine).toBe(JSON.stringify(machine));
        expect(Object.fromEntries(new URL(hrefForDestinationRef(catalog, target!)!, 'https://happier.test').searchParams))
            .toEqual(Object.fromEntries(new URL(href, 'https://happier.test').searchParams));
    });
    it('refuses malformed and ambiguous Machine hints without selecting another Machine', () => {
        const machine = { serverId: 'home', machineId: 'vps' };
        expect(readStoreMachineRoute(storeMachineRouteParams(machine))).toEqual(machine);
        expect(storeMachineRouteParams(null)).toEqual({ machine: undefined });
        for (const value of [undefined, '', '{', JSON.stringify({ machineId: 'vps' }),
            JSON.stringify({ ...machine, accountId: 'other' }), JSON.stringify({ ...machine, machineId: '' }),
            [JSON.stringify(machine)], [JSON.stringify(machine), JSON.stringify(machine)]]) {
            expect(readStoreMachineRoute({ machine: value })).toBeNull();
        }
    });
    it('round trips an explicit qualified Project scope through the real Store destination', () => {
        const project = { serverId: 'home:a', projectKey: 'client/web & api' };
        const href = buildPluginsHomeRoute('app', { view: 'discover', project });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
        const target = resolveDestinationRefFromHref(catalog, href);
        expect(target?.kind).toBe('plugins');
        expect(target?.params.project).toBe(JSON.stringify(project));
        expect(Object.fromEntries(new URL(hrefForDestinationRef(catalog, target!)!, 'https://happier.test').searchParams))
            .toEqual(Object.fromEntries(new URL(href, 'https://happier.test').searchParams));
        expect(readStoreProjectRoute(target!.params)).toEqual(project);
        for (const value of [undefined, '', '{', JSON.stringify({ projectKey: project.projectKey }),
            JSON.stringify({ ...project, account: 'other' }), [JSON.stringify(project), JSON.stringify(project)]]) {
            expect(readStoreProjectRoute({ project: value })).toBeNull();
        }
        expect(storeProjectRouteParams(null)).toEqual({ project: undefined });
        expect(readStoreProjectRoute(buildPluginListingRoute('app', { sourceId: 'catalog', pluginId: 'tools' }, project).params)).toEqual(project);
        expect(readStoreProjectRoute(buildPluginDetailRoute('app', 'tools', project).params)).toEqual(project);
        expect(readStoreProjectRoute(buildPluginDetailRoute('settings', 'tools', project).params)).toBeNull();
    });
    it('admits selection at the real listing route and refuses malformed identity before invoking the Store renderer', async () => {
        const h = pluginSelectionHarness('app', { kind: 'listing', sourceId: 'one', pluginId: 'tools' });
        const reference = { type: 'registryItem', kind: 'skill', sourceId: 'catalog:one', itemId: 'team/review', version: 'commit-one' } as const;
        h.adapter.openHref(resolveHref(buildStoreListingRoute(reference)), { tabId: 'plugins' });
        const renderStoreListing = (ref: StoreListingReference) =>
            React.createElement('StoreListingProbe', { reference: ref });
        const tree = () => h.tree(React.createElement(PluginListingRoute, { renderStoreListing }));
        const screen = await renderScreen(tree());
        expect(screen.root.findByType('StoreListingProbe').props.reference).toEqual(reference);
        h.adapter.setParams('plugins', { selection: '{', sourceId: 'legacy', pluginId: 'wrong-fallback' });
        await screen.update(tree());
        expect(screen.root.findAllByType('StoreListingProbe')).toHaveLength(0);
        expect(screen.findByTestId('store.listing.unavailable')).not.toBeNull();
    });
    it('returns to the unselected directory after Open as page, phone resize and Back', async () => {
        const h = pluginSelectionHarness('app', { kind: 'listing', sourceId: 'catalog-a', pluginId: 'tools' });
        const ref = { type: 'registryItem', kind: 'mcpServer', sourceId: 'catalog:team', itemId: 'docs/server', version: '1.2.3' } as const;
        const project = { serverId: 'home', projectKey: 'web' };
        const machine = { serverId: 'home', machineId: 'vps' };
        h.adapter.setParams('plugins', { machine: JSON.stringify(machine), ...storeProjectRouteParams(project), selection: JSON.stringify(ref), source: 'catalog:team', q: 'docs', filters: '{"source":{"include":["catalog:team"],"exclude":[]}}', scroll: '420', focus: 'docs-row' });
        const screen = await renderScreen(h.tree());
        expect(readSelection(screen).selection.storeOpenItem).toEqual(ref);
        expect(readSelection(screen).directory.state).toMatchObject({ query: 'docs', filters: {
            source: { include: ['catalog:team'], exclude: [] },
        } });
        await act(async () => { readSelection(screen).directory.setQuery(' docs '); });
        await screen.update(h.tree());
        await act(async () => { readSelection(screen).selection.openStoreAsPage(); });
        await screen.update(h.tree());
        expect(h.href()).toContain('/plugins/listing?selection=');
        expect(readStoreProjectRoute(h.current().params)).toEqual(project);
        expect(h.current().params.machine).toBe(JSON.stringify(machine));
        expect(h.parent().target.params).toMatchObject({ q: ' docs ', scroll: '420', focus: 'docs-row' });
        expect(h.parent().target.params).not.toHaveProperty('selection');
        boundary.width = 390;
        h.adapter.step(-1);
        await screen.update(h.tree());
        expect(readSelection(screen).selection.storeOpenItem).toBeNull();
        expect(h.current().params).toMatchObject({ q: ' docs ', scroll: '420', focus: 'docs-row' });
        expect(h.current().params).not.toHaveProperty('source');
        expect(h.current().params.filters).toContain('catalog:team');
        expect(readSelection(screen).directory.state?.query).toBe(' docs ');
    });
    it('rejects malformed Store identities and narrowing without substituting a legacy item or unrestricted directory', () => {
        const ref = { type: 'registryItem', kind: 'agent', sourceId: 'catalog:team', itemId: '@team/agent', version: '1.2.3' } as const;
        expect(readStoreOpenItem(buildStoreListingRoute(ref).params)).toEqual(ref);
        expect(readStoreOpenItem({ selection: JSON.stringify({ ...ref, install: true }) })).toBeNull();
        expect(readStoreOpenItem({ selection: '{' })).toBeNull();
        expect(readPluginsOpenItem({ selection: '{', plugin: 'legacy', source: 'other' })).toBeNull();
        expect(readStoreDirectoryRoute({ q: 'docs', filters: '{' })).toBeNull();
        expect(readStoreDirectoryRoute({ filters: '{"source":{"include":true,"exclude":[]}}' })).toBeNull();
        expect(Object.hasOwn(readStoreDirectoryRoute({ filters: '{"__proto__":{"include":["future"],"exclude":[]}}' })!.filters, '__proto__')).toBe(true);
    });
    it('round trips domain-qualified listing refs and pins, admitting legacy plugin links once at the route owner', () => {
        const references = [
            { type: 'registryItem', kind: 'skill', sourceId: 'catalog:one', itemId: 'team/review' },
            { type: 'registryItem', kind: 'agent', sourceId: 'catalog:two', itemId: '@team/agent', version: '1.2.3' },
            { type: 'registryItem', kind: 'plugin', sourceId: 'catalog:two', itemId: '@team/tools', version: '2.0.0' },
            { type: 'agentContribution', targetKey: 'agent:happier.agent.claude/claude' },
        ] as const;
        for (const reference of references) {
            expect(readStoreListingRoute(buildStoreListingRoute(reference).params)).toEqual({ kind: 'store', reference });
        }
        const legacy = { sourceId: 'catalog:two', pluginId: 'team.tools', itemId: '@team/tools', version: '2.0.0' };
        expect(readStoreListingRoute(legacy)).toEqual({ kind: 'plugin', listing: legacy });
        for (const selection of ['', '{', JSON.stringify({ type: 'registryItem', kind: 'skill', title: 'review' }),
            JSON.stringify({ type: 'registryItem', kind: 'skill', sourceId: 'one' })]) {
            expect(readStoreListingRoute({ selection, ...legacy })).toBeNull();
        }
    });
    it('clears legacy and qualified selections together while preserving directory state', async () => {
        const h = pluginSelectionHarness('app', { kind: 'listing', sourceId: 'legacy', pluginId: 'tools' });
        h.adapter.setParams('plugins', { source: 'legacy', itemId: '@team/tools', version: '2.0.0',
            selection: '{', q: 'review', filters: '{"kind":{"include":["skill"],"exclude":[]}}' });
        const screen = await renderScreen(h.tree());
        await act(async () => { readSelection(screen).selection.closeStore(); });
        await screen.update(h.tree());
        expect(h.current().params).not.toHaveProperty('selection');
        for (const field of ['plugin', 'source', 'itemId', 'version']) expect(h.current().params).not.toHaveProperty(field);
        expect(readSelection(screen).directory.state?.query).toBe('review');
        expect(readSelection(screen).directory.state?.filters.kind?.include).toEqual(['skill']);
    });
    it('opens Installed with a Machine condition the directory reads back unchanged', () => {
        const filters = { machine: { include: ['srv:acct:machine:a'], exclude: [] } };
        const href = buildPluginsHomeRoute('app', { view: 'installed', filters });
        const params = Object.fromEntries(new URL(href, 'https://happier.test').searchParams);
        expect(params.view).toBe('installed');
        expect(readStoreDirectoryRoute(params)).toEqual({ query: '', filters });
        expect(buildPluginsHomeRoute('app', { view: 'installed', filters: {} })).toBe('/plugins?view=installed');
    });
    it('retains the directory query and qualified editorial selection in the existing app destination', () => {
        expect(buildPluginsHomeRoute('app', { view: 'job', job: 'browser', catalogSourceId: 'catalog:team', query: 'docs' }))
            .toBe('/plugins?view=job&q=docs&job=browser&catalogSource=catalog%3Ateam');
        expect(buildPluginsHomeRoute('app', { view: 'category', category: 'tools', catalogSourceId: 'catalog:team', query: 'docs' }))
            .toBe('/plugins?view=category&q=docs&category=tools&catalogSource=catalog%3Ateam');
    });
    it('round trips native package locators and pins, and clears every listing-only field on installed selection', () => {
        const listing = { sourceId: 'marketplace:community-npm', pluginId: 'acme.tools', itemId: '@acme/tools', version: '1.2.3' };
        expect(readPluginListingRouteParams(buildPluginListingRoute('app', listing).params)).toEqual(listing);
        expect(readPluginsOpenItem(pluginsOpenItemParams({ kind: 'listing', ...listing }))).toEqual({ kind: 'listing', ...listing });
        expect(buildPluginsHomeRoute('app', { view: 'browse', open: { kind: 'listing', ...listing } }))
            .toContain('itemId=%40acme%2Ftools&version=1.2.3');
        expect(pluginsOpenItemParams({ kind: 'installed', pluginId: listing.pluginId })).toEqual({
            plugin: listing.pluginId, source: undefined, itemId: undefined, version: undefined, selection: undefined,
        });
        // Legacy npm links carry no native package coordinate; the reader must not invent one.
        expect(readPluginListingRouteParams({ sourceId: listing.sourceId, pluginId: listing.pluginId }))
            .toEqual({ sourceId: listing.sourceId, pluginId: listing.pluginId });
    });
    it('keeps the user in the host they are in: Settings or the app page', () => {
        expect(resolvePluginsSurfaceHost('/settings/plugins')).toBe('settings');
        expect(resolvePluginsSurfaceHost('/settings/plugins/listing')).toBe('settings');
        expect(resolvePluginsSurfaceHost('/plugins')).toBe('app');
        expect(resolvePluginsSurfaceHost('/plugins/listing')).toBe('app');
        // A sibling prefix is not Settings.
        expect(resolvePluginsSurfaceHost('/settingsx/plugins')).toBe('app');
    });

    it('builds home, Browse and listing routes within each host', () => {
        expect(buildPluginsHomeRoute('settings')).toBe('/settings/plugins');
        expect(buildPluginsHomeRoute('settings', { view: 'browse' })).toBe('/settings/plugins?view=browse');
        expect(buildPluginsHomeRoute('app')).toBe('/plugins');
        expect(buildPluginsHomeRoute('app', { view: 'browse' })).toBe('/plugins?view=browse');

        const listing = { sourceId: 'marketplace:curated', pluginId: 'acme.tools' };
        expect(buildPluginListingRoute('settings', listing).pathname).toBe('/(app)/settings/plugins/listing');
        expect(buildPluginListingRoute('app', listing).pathname).toBe('/(app)/plugins/listing');
    });

    it('opens a plugin page within the host, and reads its id back from either spelling', () => {
        expect(buildPluginDetailRoute('settings', 'acme.tools')).toEqual({
            pathname: '/(app)/settings/plugins/[pluginId]',
            params: { pluginId: 'acme.tools' },
        });
        expect(buildPluginDetailRoute('app', 'acme.tools')).toEqual({
            pathname: '/(app)/plugins/[pluginId]',
            params: { pluginId: 'acme.tools' },
        });
        expect(readPluginDetailRoutePluginId([' acme.tools '])).toBe('acme.tools');
        expect(readPluginDetailRoutePluginId('  ')).toBeNull();
    });

    it('names the home by the host it is in, for the listing breadcrumb', () => {
        expect(PLUGINS_HOME_TITLE_KEY).toBe('settingsPlugins.surfaces.navigationTitle');
        expect(pluginsHomeTitleKey('settings')).toBe(PLUGINS_HOME_TITLE_KEY);
        expect(pluginsHomeTitleKey('app')).toBe('settingsPlugins.surfaces.storeTitle');
    });

    it('round-trips a source-qualified listing through its route params', () => {
        const route = buildPluginListingRoute('app', { sourceId: 'marketplace:curated', pluginId: 'acme.tools' });
        expect(readPluginListingRouteParams(route.params)).toEqual({ sourceId: 'marketplace:curated', pluginId: 'acme.tools' });
    });

    it('names the plugin open beside the Plugins page in the home route, and reads it back', () => {
        const installed = { kind: 'installed', pluginId: 'acme.tools' } as const;
        const listing = { kind: 'listing', sourceId: 'marketplace:curated', pluginId: 'acme.notes' } as const;
        expect(buildPluginsHomeRoute('app', { view: 'installed', open: installed })).toBe('/plugins?view=installed&plugin=acme.tools');
        expect(buildPluginsHomeRoute('settings', { view: 'browse', open: listing }))
            .toBe('/settings/plugins?view=browse&plugin=acme.notes&source=marketplace%3Acurated');

        expect(readPluginsOpenItem(pluginsOpenItemParams(installed))).toEqual(installed);
        expect(readPluginsOpenItem(pluginsOpenItemParams(listing))).toEqual(listing);
        // Closing clears both params, so a later Installed selection never inherits a listing's source.
        expect(pluginsOpenItemParams(null)).toEqual({ plugin: undefined, source: undefined, itemId: undefined, version: undefined, selection: undefined });
        expect(readPluginsOpenItem({ plugin: ['  '] })).toBeNull();
        expect(readPluginsOpenItem({ view: 'browse' })).toBeNull();
    });

    it('rejects a deep link that does not name both the source and the plugin', () => {
        expect(readPluginListingRouteParams({ pluginId: 'acme.tools' })).toBeNull();
        expect(readPluginListingRouteParams({ sourceId: ['s1'], pluginId: ['  '] })).toBeNull();
    });

    it.each([
        ['settings', { kind: 'installed', pluginId: 'acme.tools' }],
        ['app', { kind: 'listing', sourceId: 'marketplace:curated', pluginId: 'acme.notes' }],
    ] satisfies Array<[PluginsSurfaceHost, PluginsOpenItem]>)('retains the route-selected %s plugin across width changes and clears it without losing the collection location', async (host, item) => {
        const h = pluginSelectionHarness(host, item);
        const screen = await renderScreen(h.tree());
        expect(readSelection(screen).available).toBe(true);
        await act(async () => { readSelection(screen).selection.open(item); });
        await screen.update(h.tree());
        expect(readSelection(screen).selection.openItem).toEqual(item);

        boundary.width = 390;
        boundary.height = 844;
        await screen.update(h.tree());
        expect(readSelection(screen).available).toBe(false);
        // Presentation changes belong to the pane layout owner. Selection and the collection's
        // location remain in the same route rather than navigating to a newly mounted editor.
        expect(readSelection(screen).selection.openItem).toEqual(item);
        expect(h.current().params).toMatchObject({ view: item.kind === 'listing' ? 'browse' : 'installed', anchor: 'kept' });
        boundary.width = 1440;
        boundary.height = 1000;
        await screen.update(h.tree());
        expect(readSelection(screen).selection.openItem).toEqual(item);
        expect(readSelection(screen).available).toBe(true);

        await act(async () => { readSelection(screen).selection.close(); });
        await screen.update(h.tree());
        expect(h.current().params).toMatchObject({ view: item.kind === 'listing' ? 'browse' : 'installed', anchor: 'kept' });
        expect(readSelection(screen).selection.openItem).toBeNull();
        await screen.update(h.tree());
        expect(readSelection(screen).selection.openItem).toBeNull();
        expect(h.href()?.split('?')[0]).toBe(host === 'settings' ? '/settings/plugins' : '/plugins');
    });
});
