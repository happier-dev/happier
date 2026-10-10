import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks();
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View' });
});
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());

/**
 * With no machine chosen nothing has been read or searched: the page says what to do next instead
 * of an empty list or "No plugins matched this search".
 */
describe('Plugins page without a chosen machine', () => {
    afterEach(standardCleanup);

    it('shows the shared loading mark while catalog discovery is active and removes it when loading ends', async () => {
        const { DiscoverStatusSummary } = await import('./PluginMarketplaceSections');
        const props = { error: null, stale: false, entryCount: 0, sourceStatuses: [], diagnostics: [], nonInstallable: [], selectedSourceTitle: null };
        const screen = await renderScreen(<DiscoverStatusSummary {...props} loading />);
        const marks = () => screen.findAll((node) => node.type === 'span' && node.props?.['data-happier-activity-spinner'] !== undefined);
        expect(marks()).toHaveLength(1);
        await screen.update(<DiscoverStatusSummary {...props} loading={false} />);
        expect(marks()).toHaveLength(0);
    });


    it('asks for a machine instead of claiming Browse found nothing', async () => {
        const { DiscoverStatusSummary } = await import('./PluginMarketplaceSections');
        const screen = await renderScreen(<DiscoverStatusSummary loading={false} error={null} stale={false} entryCount={0}
            sourceStatuses={[]} diagnostics={[]} nonInstallable={[]} selectedSourceTitle={null} noTarget />);
        const text = screen.getTextContent();
        expect(text).toContain('settingsPlugins.surfaces.chooseMachineBrowse');
        expect(text).not.toContain('settingsPlugins.discover.status.empty');
    });

    it('asks for a machine instead of rendering an empty Installed list', async () => {
        const { InstalledPluginsSection } = await import('./PluginMarketplaceSections');
        const screen = await renderScreen(<InstalledPluginsSection collectionState="noTarget" installedPlugins={[]}
            presentation="grid" searchText="" onClearSearch={() => {}} onRetry={() => {}}
            onDiscover={() => {}} canRunActions={false} isPluginActionInFlight={() => false}
            onNavigateToPlugin={() => {}} onRunAction={() => {}} />);
        expect(screen.findByTestId('settings.plugins.marketplace.installed.noTarget')).not.toBeNull();
        expect(screen.findByTestId('settings.plugins.marketplace.installed.loading')).toBeNull();
    });

    it('never says a search matched nothing when nothing was searched', async () => {
        const { DiscoverStatusSummary } = await import('./PluginMarketplaceSections');
        const screen = await renderScreen(<DiscoverStatusSummary loading={false} error={null} stale={false} entryCount={0}
            sourceStatuses={[]} diagnostics={[]} nonInstallable={[]} selectedSourceTitle={null} searchText="" />);
        const text = screen.getTextContent();
        expect(text).toContain('settingsPlugins.surfaces.browseEmpty');
        expect(text).not.toContain('settingsPlugins.discover.status.empty');
    });

    it('claims an empty catalog only after a query returned an empty result', async () => {
        const { DiscoverStatusSummary } = await import('./PluginMarketplaceSections');
        const props = { loading: false, error: null, stale: false, entryCount: 0, sourceStatuses: [], diagnostics: [], nonInstallable: [], selectedSourceTitle: null };
        const screen = await renderScreen(<DiscoverStatusSummary {...props} searchText={null} />);
        expect(screen.findByTestId('settings.plugins.marketplace.discover.status.summary')).toBeNull();
        await screen.update(<DiscoverStatusSummary {...props} searchText={null} loading />);
        expect(screen.findByTestId('settings.plugins.marketplace.discover.status.summary')).not.toBeNull();
        await screen.update(<DiscoverStatusSummary {...props} searchText={null} error="read failed" />);
        expect(screen.getTextContent()).toContain('settingsPlugins.discover.status.errorTitle');
        await screen.update(<DiscoverStatusSummary {...props} searchText="" />);
        expect(screen.getTextContent()).toContain('settingsPlugins.surfaces.browseEmpty');
    });

    it('answers a search with no results inline, naming the query, with a way to clear it', async () => {
        const { DiscoverStatusSummary } = await import('./PluginMarketplaceSections');
        const onClearSearch = vi.fn();
        const screen = await renderScreen(<DiscoverStatusSummary loading={false} error={null} stale={false} entryCount={0}
            sourceStatuses={[]} diagnostics={[]} nonInstallable={[]} selectedSourceTitle={null} searchText="jira"
            onClearSearch={onClearSearch} />);
        expect(screen.getTextContent()).toContain('settingsPlugins.surfaces.noMatch');
        // A changed query has one quiet status announcement, not another page-sized empty state.
        const announcements = screen.findAll((node) => node.props.accessibilityRole === 'status' || node.props.role === 'status');
        expect(announcements).toHaveLength(1);
        await screen.pressByTestIdAsync('settings.plugins.marketplace.discover.clearSearch');
        expect(onClearSearch).toHaveBeenCalledTimes(1);
    });

    it('defers an empty Browse summary to the page cause but keeps retained result counts', async () => {
        const { DiscoverStatusSummary } = await import('./PluginMarketplaceSections');
        const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');
        const props = { loading: false, error: null, stale: false, entryCount: 0, sourceStatuses: [], diagnostics: [], nonInstallable: [], selectedSourceTitle: null, searchText: '' };
        const view = (entryCount: number, pageNoticeActive: boolean) => (
            <ListPresentationProvider value="page" pageNoticeActive={pageNoticeActive}>
                <DiscoverStatusSummary {...props} entryCount={entryCount} />
            </ListPresentationProvider>
        );
        const screen = await renderScreen(view(0, true));
        expect(screen.findByTestId('settings.plugins.marketplace.discover.status.summary')).toBeNull();
        await screen.update(view(3, true));
        expect(screen.findByTestId('settings.plugins.marketplace.discover.status.summary')).not.toBeNull();
        await screen.update(view(0, false));
        expect(screen.findByTestId('settings.plugins.marketplace.discover.status.summary')).not.toBeNull();
    });
});
