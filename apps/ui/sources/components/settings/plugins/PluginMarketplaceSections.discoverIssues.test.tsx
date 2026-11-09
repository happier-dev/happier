import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureMountedCollections, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import type { PluginMarketplaceCatalogEntry, PluginMarketplaceDiscoverSourceStatus } from './readPluginMarketplaceCatalog';

installSettingsViewCommonModuleMocks();
const { DiscoverListingsSection, DiscoverStatusSummary } = await import('./PluginMarketplaceSections');

const unreachable: PluginMarketplaceDiscoverSourceStatus = {
    id: 'happier-curated',
    title: 'Happier curated marketplace',
    kind: 'curated',
    freshness: 'unavailable',
    diagnostics: [{
        id: 'source:happier-curated:marketplace_source_unavailable:0',
        sourceId: 'happier-curated',
        sourceTitle: 'Happier curated marketplace',
        code: 'marketplace_source_unavailable',
        message: 'getaddrinfo ENOTFOUND marketplace.happier.dev',
    }],
};

/** Browse with one marketplace source that did not answer. */
describe('Browse source issues', () => {
    afterEach(standardCleanup);

    it('presents a failed read as a named source issue with recovery and no transport text', async () => {
        const retry = vi.fn();
        const raw = 'Scoped RPC socket disconnected during Machine preparation';
        const screen = await renderScreen(<DiscoverStatusSummary loading={false} error={raw} stale={false} entryCount={0}
            sourceStatuses={[]} diagnostics={[]} nonInstallable={[]} selectedSourceTitle="Happier marketplace"
            onRetry={retry} />);
        expect(screen.findByTestId('settings.plugins.marketplace.discover.status.summary')).toBeNull();
        expect(screen.getTextContent()).not.toContain(raw);
        expect(screen.getTextContent()).toContain('Happier marketplace');
        await screen.pressByTestIdAsync('settings.plugins.marketplace.discover.issue.index.action');
        expect(retry).toHaveBeenCalledTimes(1);
    });

    it.each(['', 'missing plugin'])('does not infer an empty search from an unanswered source (%s)', async (searchText) => {
        const screen = await renderScreen(<DiscoverStatusSummary loading={false} error={null} stale={false} entryCount={0}
            sourceStatuses={[unreachable]} diagnostics={[]} nonInstallable={[]} selectedSourceTitle={null}
            searchText={searchText} onRetry={() => {}} onOpenSources={() => {}} />);
        expect(screen.findByTestId('settings.plugins.marketplace.discover.status.summary')).toBeNull();
        expect(screen.findByTestId('settings.plugins.marketplace.discover.noMatch')).toBeNull();
        expect(screen.findByTestId('settings.plugins.marketplace.discover.sources')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('settingsPlugins.discover.diagnostic.otherSourcesShown');
    });

    it('says an unreachable source once, on the quiet outage line, and keeps the technical detail behind Details', async () => {
        const screen = await renderScreen(<DiscoverStatusSummary loading={false} error={null} stale={false} entryCount={3}
            sourceStatuses={[unreachable]} diagnostics={[]} nonInstallable={[]} selectedSourceTitle={null}
            onRetry={() => {}} onOpenSources={() => {}} />);
        expect(screen.findByTestId('settings.plugins.marketplace.discover.issue.happier-curated')).toBeNull();
        const before = screen.getTextContent();
        expect(screen.findByTestId('settings.plugins.marketplace.discover.status.summary')).not.toBeNull();
        expect(before).toContain('settingsPlugins.discover.diagnostic.unreachableTitle');
        expect(before).not.toContain('getaddrinfo ENOTFOUND');
        expect(before).not.toContain('settingsPlugins.diagnosticsTechnicalCode');
        await screen.pressByTestIdAsync('settings.plugins.marketplace.discover.sources.details');
        const after = screen.getTextContent();
        expect(after).toContain('getaddrinfo ENOTFOUND marketplace.happier.dev');
        expect(after).toContain('settingsPlugins.diagnosticsTechnicalCode');
    });

    it.each(['grid', 'list'] as const)('keeps one independent Install control in the %s presentation', async (presentation) => {
        const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');
        const entry: PluginMarketplaceCatalogEntry = {
            id: 'sample.plugin', title: 'Sample plugin', description: null, version: '1.2.3',
            sourceId: 'curated', sourceKind: 'curated', sourceTitle: 'Happier marketplace', reviewStatus: 'approved',
            updatePolicy: 'allowed', publisher: { id: 'sample', displayName: 'Sample' }, categories: [],
            contributions: ['agents'], links: {}, executableRealms: ['daemon'], platforms: ['web'],
            packageName: 'sample-plugin', installable: true, registrySelectionOrigin: null,
        };
        const onAction = vi.fn();
        const onOpenListing = vi.fn();
        const screen = await renderScreen(<ListPresentationProvider value="page"><DiscoverListingsSection
            entries={[entry]} presentation={presentation} loading={false} loadingMore={false} canLoadMore={false}
            installedPluginById={new Map()} canRunActions isPluginActionInFlight={() => false}
            onAction={onAction} onLoadMore={() => {}} onNavigateToPlugin={() => {}} onOpenListing={onOpenListing}
        /></ListPresentationProvider>);
        await measureMountedCollections(screen);
        if (presentation === 'grid') {
            expect(screen.findByTestId('settings.plugins.marketplace.entry.curated.sample.plugin:description')).toBeNull();
        }
        const actionTestID = 'settings.plugins.marketplace.action.install.curated.sample.plugin';
        expect(screen.findAllHostsByTestId(actionTestID)).toHaveLength(1);
        await screen.pressByTestIdAsync('settings.plugins.marketplace.entry.curated.sample.plugin');
        expect(onOpenListing).toHaveBeenCalledWith(entry);
        expect(onAction).not.toHaveBeenCalled();
        onOpenListing.mockClear();
        await screen.pressByTestIdAsync(actionTestID);
        expect(onAction).toHaveBeenCalledWith({ method: 'install', pluginId: entry.id, sourceId: entry.sourceId });
        expect(onOpenListing).not.toHaveBeenCalled();
    });
});
