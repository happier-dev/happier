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
import { usePluginsOpenItem } from './usePluginsOpenItem';

import {
    buildPluginDetailRoute,
    buildPluginListingRoute,
    buildPluginsHomeRoute,
    pluginsHomeTitleKey,
    pluginsOpenItemParams,
    readPluginDetailRoutePluginId,
    readPluginsOpenItem,
    readPluginListingRouteParams,
    resolvePluginsSurfaceHost,
    type PluginsOpenItem,
    type PluginsSurfaceHost,
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
    const available = useDetailsPaneAvailable();
    return React.createElement('PluginSelectionProbe', { selection, available });
}

function pluginSelectionHarness(host: PluginsSurfaceHost, item: PluginsOpenItem) {
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
        externalSessions: false, inbox: false, workflows: false, friends: false,
    } });
    const home = buildPluginsHomeRoute(host, { view: item.kind === 'listing' ? 'browse' : 'installed' });
    const target = resolveDestinationRefFromHref(catalog, `${home}&anchor=kept`);
    if (!target) throw new Error('Plugins home is not registered in the real destination catalog');
    let state = createWorkspaceState({ id: 'plugins', target, pinned: false, preview: false });
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
    const tree = () => React.createElement(DestinationInstanceHost, {
        tabId: active().id, ref: current(), pathname: href()?.split('?')[0] ?? '',
        focused: true, visible: true, navigation: navigationForTab(active().id),
        children: React.createElement(PluginSelectionProbe),
    });
    return { adapter, current, href, tree, catalog, parent: () => state.tabs.plugins };
}

function readSelection(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.root.findByType('PluginSelectionProbe').props as {
        selection: ReturnType<typeof usePluginsOpenItem>;
        available: boolean;
    };
}

describe('plugins surface routes', () => {
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
        expect(pluginsHomeTitleKey('settings')).toBe('settingsPlugins.title');
        expect(pluginsHomeTitleKey('app')).toBe('settingsPlugins.surfaces.navigationTitle');
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
        expect(pluginsOpenItemParams(null)).toEqual({ plugin: undefined, source: undefined });
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
