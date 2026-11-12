import * as React from 'react';
import { expect, it, onTestFinished, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace';
import { createRegistryPluginCatalogFixture } from '@/dev/testkit/fixtures/registryPluginCatalog';
import { installPromptRegistriesCommonModuleMocks, promptRegistriesRouterPushSpy } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';

vi.mock('@/components/ui/popover/measure', () => ({ measureInWindow: async () => ({ x: 0, y: 0, width: 800, height: 600 }) }));
installPromptRegistriesCommonModuleMocks({ storage: original => original() });
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const { createPlainPromptLibraryCatalogHomeFixture } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { Directory } = await import('./StoreKindPage');
const { default: StoreBotsKindSurface } = await import('./StoreBotsKindSurface');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { resolveCompactAppDestinations, resolveDestinationRefFromHref } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');

it.each(['open', 'add'] as const)('browses metadata and reaches the shared preview from package %s without installation', async path => {
    const serverUrl = `https://store-bot-${path}.test`;
    const sourceUrl = `${serverUrl}/catalog.json`;
    const sourceId = deriveMarketplaceSourceId(sourceUrl);
    const catalog = createRegistryPluginCatalogFixture({ sourceUrl, entries: [
        { pluginId: 'garden.bot', title: 'Garden', botTemplates: [{ id: 'gardener', path: './templates/garden.json' }] },
        { pluginId: 'ordinary.plugin', title: 'Ordinary' },
    ] });
    const fixture = await createPlainPromptLibraryCatalogHomeFixture(serverUrl, { key: 'registry-sources',
        value: { v: 2, disabledSourceIds: [], sources: [{ id: sourceId, title: 'Garden catalog', format: 'happier-catalog',
            kinds: ['plugin'], url: sourceUrl, enabled: true, addedAt: 1 }] } }, 'updated', {
        handleRequest: async href => href === '/catalog.json' ? Response.json(catalog) : null,
    });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    promptRegistriesRouterPushSpy.mockClear();
    const destinations = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
    const resolved = resolveDestinationRefFromHref(destinations, '/plugins/bots')!;
    const target = { ...resolved, params: { ...resolved.params, filters: JSON.stringify({ source: { include: [sourceId], exclude: [] } }) } };
    // A real ScrollView retains its content host; the tracker rejects a host that changed during measurement.
    const content = {};
    const screen = await renderScreen(<DestinationInstanceHost tabId="bots" ref={target} pathname="/plugins/bots" focused visible
        navigation={{ push: promptRegistriesRouterPushSpy, replace: () => {}, back: () => {}, setParams: () => {} }}>
        <AppPaneProvider><StoreBotsKindSurface kind="bot" input={{ mode: 'browse', presented: true }} /></AppPaneProvider>
    </DestinationInstanceHost>, { createNodeMock: node => node.type === 'ScrollView'
        ? { getInnerViewRef: () => content, scrollTo: () => {} } : node.type === 'View' ? {} : null });
    // The physical pane owner mounts its page only after the native layout boundary reports width.
    await act(async () => {
        for (const node of screen.root.findAll(candidate => typeof candidate.type === 'string' && typeof candidate.props.onLayout === 'function')) {
            node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 900, height: 900 } } });
        }
    });
    await waitForHomeGovernance(() => expect(screen.findAllByType(Directory).flatMap(node => node.props.rows).map(row => row.title)).toEqual(['Garden']))
        .catch(error => {
            console.error('Store boundary evidence', JSON.stringify({ requests: fixture.requests.map(request => request.path),
                directories: screen.findAllByType(Directory).map(node => ({ label: node.props.label, loading: node.props.list.loading,
                    error: node.props.list.error, status: node.props.list.status })), tree: screen.tree.toJSON() }));
            throw error;
        });
    const row = screen.findAllByType(Directory).flatMap(node => node.props.rows).find(row => row.title === 'Garden')!;
    expect(screen.findAllByType(Directory).map(node => node.props.label)).toEqual(['botTemplates.sharedWithYou', 'botTemplates.fromStore']);
    expect(row.facts?.extra).toEqual(['Sample', '1.2.3']);
    expect(fixture.requests.some(request => request.path.includes('.tgz'))).toBe(false);
    await act(async () => {
        for (const node of screen.root.findAll(candidate => typeof candidate.props.onScroll === 'function' && typeof candidate.props.onLayout === 'function')) {
            node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 900, height: 900 } } });
            node.props.onContentSizeChange?.(900, 4000);
        }
    });
    await waitForHomeGovernance(() => {
        expect(screen.getTextContent()).toContain('Sample');
        expect(screen.getTextContent()).toContain('1.2.3');
    });
    // Nothing shared with this viewer: that section explains templates under its own title, never the page's "Nothing here yet".
    expect(screen.findAllByTestId('store.kind.bot.empty')).toHaveLength(0);
    expect(screen.findByTestId('store.kind.bot.shared.empty')).toBeTruthy();
    // A healthy page still offers Refresh: it asks the received reader again, nothing else.
    const sharedReads = () => fixture.requests.filter(request => request.path.includes('artifact')).length;
    const readsBefore = sharedReads();
    await screen.pressByTestIdAsync('store.kind.bot.shared.refresh');
    await waitForHomeGovernance(() => expect(sharedReads()).toBeGreaterThan(readsBefore));
    const rowId = `store.kind.bot.row.${row.key}`;
    await screen.pressByTestIdAsync(path === 'add' ? `${rowId}.add` : rowId);
    await waitForHomeGovernance(() => expect(promptRegistriesRouterPushSpy).toHaveBeenCalled());
    const href = promptRegistriesRouterPushSpy.mock.lastCall![0];
    expect(href.pathname).toBe('/bot-template');
    expect(JSON.parse(href.params.source)).toEqual({ kind: 'plugin', registryItem: { sourceId, itemId: 'garden.bot', version: '1.2.3' }, contributionId: 'gardener' });
    expect(fixture.requests.some(request => request.method !== 'GET' && request.path.includes('plugins'))).toBe(false);
});
