import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { measureMountedCollections, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import type { PluginMarketplaceCatalogEntry } from './readPluginMarketplaceCatalog';
import type { InstalledPluginEntry } from './model/pluginMarketplaceModel';

installSettingsViewCommonModuleMocks();
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());

const entry: PluginMarketplaceCatalogEntry = {
    id: 'acme.plugin', sourceId: 'community', sourceKind: 'community-npm', sourceTitle: 'Community',
    reviewStatus: 'unreviewed', updatePolicy: 'pinned', publisher: { id: 'acme', displayName: 'Acme' },
    categories: ['tools'], contributions: ['tools'], links: {}, executableRealms: ['daemon'], platforms: ['linux'],
    title: 'Acme plugin', description: 'Organize your work', version: '1.0.0', packageName: '@acme/plugin',
    installable: true, registrySelectionOrigin: null, warning: 'unreviewed',
};
const installed: InstalledPluginEntry = {
    pluginId: entry.id, title: entry.title, description: entry.description, version: '1.0.0', enabled: true,
    source: { kind: 'npm', locator: entry.packageName }, install: { mode: 'copy', manifestVersion: '1.0.0' },
    compatibility: { status: 'compatible', diagnostics: [] }, diagnostics: [],
};

/** Browse is one Collection: it lays its grid out at the width it measured, as the page does on its first layout. */
async function renderMeasured(element: React.ReactElement) {
    const screen = await renderScreen(element);
    await measureMountedCollections(screen);
    return screen;
}

describe('DiscoverListingsSection', () => {
    // The section's module graph is imported once, outside each case's budget.
    let DiscoverListingsSection: typeof import('./PluginMarketplaceSections').DiscoverListingsSection;
    beforeAll(async () => {
        ({ DiscoverListingsSection } = await import('./PluginMarketplaceSections'));
    }, 600_000);
    afterEach(standardCleanup);

    it('opens the listing page from the card body without installing', async () => {
        const onOpenListing = vi.fn();
        const onAction = vi.fn();
        const screen = await renderMeasured(<DiscoverListingsSection entries={[entry]} loading={false} loadingMore={false}
            canLoadMore={false} installedPluginById={new Map()} canRunActions isPluginActionInFlight={() => false}
            onAction={onAction} onLoadMore={() => {}} onNavigateToPlugin={() => {}} onOpenListing={onOpenListing} />);
        await screen.pressByTestIdAsync('settings.plugins.marketplace.entry.community.acme.plugin');
        expect(onOpenListing).toHaveBeenCalledWith(entry);
        expect(onAction).not.toHaveBeenCalled();
    });

    it('sections cards by category, one row each, with All to show a whole section', async () => {
        const curated = (id: string, categories: string[]) => ({
            ...entry, id, sourceId: 'curated', sourceKind: 'curated' as const, reviewStatus: 'approved' as const, warning: undefined, categories,
        });
        const entries = [curated('a.one', ['code']), curated('a.two', ['agents']), curated('a.three', ['code']), curated('a.four', ['code']), curated('a.five', ['code'])];
        const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');
        // Browse always renders inside the Plugins page, where sections carry their actions.
        const screen = await renderMeasured(<ListPresentationProvider value="page"><DiscoverListingsSection entries={entries} loading={false} loadingMore={false}
            canLoadMore={false} installedPluginById={new Map()} canRunActions isPluginActionInFlight={() => false}
            onAction={() => {}} onLoadMore={() => {}} onNavigateToPlugin={() => {}} onOpenListing={() => {}} /></ListPresentationProvider>);
        const cards = () => entries.filter((e) => screen.findByTestId(`settings.plugins.marketplace.entry.curated.${e.id}`) !== null).map((e) => e.id);
        expect(cards()).toEqual(['a.one', 'a.two', 'a.three', 'a.four']);

        await screen.pressByTestIdAsync('settings.plugins.marketplace.discover:group:category:code:action');
        expect(cards()).toEqual(['a.one', 'a.three', 'a.four', 'a.five']);
    });

    it('keeps benefit and source visible and opens installed listings without installation', async () => {
        const openListing = vi.fn();
        const action = vi.fn();
        const screen = await renderMeasured(<DiscoverListingsSection entries={[entry]} loading={false} loadingMore={false}
            canLoadMore={false} installedPluginById={new Map([[entry.id, installed]])} canRunActions={false}
            isPluginActionInFlight={() => false} onAction={action} onLoadMore={() => {}} onNavigateToPlugin={() => {}}
            onOpenListing={openListing} />);
        expect(screen.getTextContent()).toContain(entry.description);
        // Installed is the card's status and it has no install action: the trust decision was already made.
        expect(screen.findByTestId('settings.plugins.marketplace.installedStatus.community.acme.plugin')).not.toBeNull();
        expect(screen.findByTestId('settings.plugins.marketplace.action.install.community.acme.plugin')).toBeNull();
        expect(screen.getTextContent()).toContain('Community');
        await screen.pressByTestIdAsync('settings.plugins.marketplace.entry.community.acme.plugin');
        expect(openListing).toHaveBeenCalledWith(entry);
        expect(action).not.toHaveBeenCalled();
    });

    it('keeps install review reachable without expanding details and blocks new withdrawn installs', async () => {
        const action = vi.fn();
        const screen = await renderMeasured(<DiscoverListingsSection
            entries={[entry, { ...entry, id: 'withdrawn.plugin', installable: false, warning: 'withdrawn', reviewStatus: 'withdrawn' }]}
            loading={false} loadingMore={false} canLoadMore={false} installedPluginById={new Map()} canRunActions
            isPluginActionInFlight={() => false} onAction={action} onLoadMore={() => {}} onNavigateToPlugin={() => {}}
            onOpenListing={() => {}} />);
        expect(screen.findByTestId('settings.plugins.marketplace.reviewStatus.community.withdrawn.plugin')).not.toBeNull();
        expect(screen.findByTestId('settings.plugins.marketplace.action.install.community.withdrawn.plugin')).toBeNull();
        expect(screen.getTextContent()).toContain('Community');
        await screen.pressByTestIdAsync('settings.plugins.marketplace.action.install.community.acme.plugin');
        expect(action).toHaveBeenCalledWith({ method: 'install', pluginId: entry.id, sourceId: entry.sourceId });
    });
    it('lists the same listings as rows, with the same open and install targets', async () => {
        const onOpenListing = vi.fn();
        const onAction = vi.fn();
        const screen = await renderMeasured(<DiscoverListingsSection entries={[entry]} presentation="list" loading={false}
            loadingMore={false} canLoadMore={false} installedPluginById={new Map()} canRunActions
            isPluginActionInFlight={() => false} onAction={onAction} onLoadMore={() => {}} onNavigateToPlugin={() => {}}
            onOpenListing={onOpenListing} />);
        await screen.pressByTestIdAsync('settings.plugins.marketplace.entry.community.acme.plugin');
        expect(onOpenListing).toHaveBeenCalledWith(entry);
        await screen.pressByTestIdAsync('settings.plugins.marketplace.action.install.community.acme.plugin');
        expect(onAction).toHaveBeenCalledWith({ method: 'install', pluginId: entry.id, sourceId: entry.sourceId });
    });

    it('does not snap back to a stale "All" when the results change and change back', async () => {
        const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');
        const curated = (id: string, categories: string[]) => ({
            ...entry, id, sourceId: 'curated', sourceKind: 'curated' as const, reviewStatus: 'approved' as const, warning: undefined, categories,
        });
        const curatedResults = [curated('a.one', ['agents']), curated('a.two', ['agents']), curated('a.three', ['agents']), curated('a.four', ['agents'])];
        const communityResults = [{ ...entry, id: 'n.one', categories: [] }];
        const render = (entries: readonly PluginMarketplaceCatalogEntry[]) => (
            <ListPresentationProvider value="page"><DiscoverListingsSection entries={entries} loading={false} loadingMore={false}
                canLoadMore={false} installedPluginById={new Map()} canRunActions isPluginActionInFlight={() => false}
                onAction={() => {}} onLoadMore={() => {}} onNavigateToPlugin={() => {}} onOpenListing={() => {}} /></ListPresentationProvider>
        );
        const screen = await renderMeasured(render(curatedResults));
        await screen.pressByTestIdAsync('settings.plugins.marketplace.discover:group:category:agents:action');

        await act(async () => { screen.update(render(communityResults)); });
        expect(screen.findByTestId('settings.plugins.marketplace.entry.community.n.one')).not.toBeNull();

        await act(async () => { screen.update(render(curatedResults)); });
        // The section is compact again with its "All"; the old focus is gone.
        expect(screen.findByTestId('settings.plugins.marketplace.discover:group:category:agents:action')).not.toBeNull();
        expect(screen.findByTestId('settings.plugins.marketplace.entry.curated.a.four')).toBeNull();
    });
});
