import * as React from 'react';
import { expect, it, vi } from 'vitest';
import { PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { act, renderScreen, flushHookEffects } from '@/dev/testkit';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

// Native layout boundary: the test renderer has no host layout, so the page viewport is reported below.
vi.mock('@/components/ui/popover/measure', () => ({ measureInWindow: async () => ({ x: 0, y: 0, width: 800, height: 600 }) }));
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { StoreSoftwarePage } = await import('../StoreSoftwarePage');
const { StoreSearchPage } = await import('../StoreSearchPage');

it.each(['directory', 'search'] as const)('shows Software %s for an Account with no Machine, and reads no Machine to do it', async surface => {
    const bridge = await loadSyncSingletonForTests();
    const http = createHomeHubArtifactHttpBoundary('viewer');
    let machineReads = 0;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://store-software-browse.test', accountId: 'viewer',
        request: (url, init) => { if (new URL(String(url)).pathname.startsWith('/v1/machines')) machineReads++; return http.request(url, init); } });
    const previous = storage.getState();
    const account = await captureLazyActionAccountContext(connection.home.id);
    const disposeLoader = await installRealActionExecutorModuleLoader();
    try {
        storage.setState({ machines: {}, sessions: {}, settingsScope: account.accountLifetime.scope, profileScope: account.accountLifetime.scope });
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/machine-recipes/src/manifest');
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1, hostingCapability: { enabled: false },
            intent: { pluginId: PLUGIN_MANIFEST.id, desiredVersion: PLUGIN_MANIFEST.version, enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-1' },
            release: { ref: { pluginId: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                normalizedManifest: PLUGIN_MANIFEST, collectionContracts: [], uiSlots: [],
                packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
            packageAssets: [], uiArtifacts: [] });
        // Connection restoration starts the ordinary Sync census asynchronously. Its request belongs to
        // bootstrap, not this page: wait for issuance before measuring browse's additional demand.
        await waitForHomeGovernance(() => expect(machineReads).toBe(1));
        machineReads = 0;
        const navigation = { push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} };
        const content = {};
        const params: Record<string, string> = surface === 'directory' ? { view: 'kind', kind: 'software' } : { view: 'search', q: 'Google Chrome',
            filters: JSON.stringify({ kind: { include: ['software'], exclude: [] } }) };
        const screen = await renderScreen(<DestinationInstanceHost tabId="software" ref={{ kind: 'plugins', params }}
            pathname="/plugins" focused visible navigation={navigation}><AppPaneProvider>{surface === 'directory'
                ? <StoreSoftwarePage presented /> : <StoreSearchPage presented />}</AppPaneProvider></DestinationInstanceHost>,
            { createNodeMock: node => (node.type === 'ScrollView' ? { getInnerViewRef: () => content, scrollTo: () => {} } : node.type === 'View' ? {} : null) });
        // A directory opened before the Account's plugins arrive waits for them; it never reads as a failed catalog.
        await flushHookEffects();
        expect(screen.findHostByTestId('store.kind.software.state')).toBeNull();
        await act(async () => { replacePluginAccountAvailabilityProjection({ scope: account.accountLifetime.scope, snapshot: { availabilityCursor: 1,
            intentReads: [{ pluginId: PLUGIN_MANIFEST.id, response }], materializations: [], snapshots: [] } }); });
        for (let attempt = 0; attempt < 50 && !screen.getTextContent().includes('Google Chrome'); attempt++) {
            await act(async () => {
                for (const node of screen.root.findAll(candidate => typeof candidate.props.onScroll === 'function' && typeof candidate.props.onLayout === 'function')) {
                    node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 900 } } });
                    node.props.onContentSizeChange?.(800, 4000 + attempt);
                }
            });
            await flushHookEffects();
        }
        expect(screen.getTextContent()).toContain('Google Chrome');
        expect(screen.findHostByTestId('store.kind.software.noMachine')).toBeNull();
        expect(screen.findHostByTestId('store.kind.software.machine')).toBeNull();
        expect(screen.findHostByTestId('store.search.software.machine')).toBeNull();
        expect(machineReads).toBe(0);
    } finally {
        disposeLoader(); account.dispose(); storage.setState(previous, true); await connection.dispose(); bridge.dispose();
    }
});
