import * as React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderSettingsView, standardCleanup } from '@/dev/testkit';

vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

const mocks = vi.hoisted(() => ({
    activeView: 'installed' as 'installed' | 'discover',
    installedPlugins: [] as readonly unknown[],
    targetKind: 'unselected' as 'unselected' | 'online',
}));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    View: 'View',
    Text: 'Text',
    TextInput: 'TextInput',
    ScrollView: 'ScrollView',
    Pressable: React.forwardRef((props: Readonly<Record<string, unknown>>, ref: unknown) => (
        React.createElement('Pressable', { ...props, ref }, (props as { children?: React.ReactNode }).children)
    )),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => false }));
// This lane owns the segmented controls' interactive targets, not the daemon
// administration environment beneath the screen's state facade, so the facade is
// replaced whole while the real SegmentedTabBar keeps rendering its own sizing.
vi.mock('./model/usePluginSettingsScreenState', () => ({
    usePluginSettingsScreenState: () => ({
        activeView: mocks.activeView,
        setActiveView: () => {},
        readOnlySnapshotNotice: null,
        pendingPluginChanges: [],
        daemonOperationsAvailable: true,
        isPluginActionInFlight: () => false,
        decidePendingPluginChange: () => {},
        administrationTargetSelection: { state: { kind: mocks.targetKind }, candidates: [], selectedTarget: null, canExecute: false, resolveExecutionTarget: () => null },
        installedPlugins: mocks.installedPlugins,
        installedPluginById: new Map(),
        canRefreshInstalledPlugins: true,
        runInstalledPluginAction: () => {},
        discoverSources: [
            { id: 'marketplace:user', title: 'My source', kind: 'user' },
            { id: 'community-npm', title: 'Community npm', kind: 'community-npm' },
        ],
        selectedDiscoverSourceId: null,
        setSelectedDiscoverSourceId: () => {},
        discoverSearchText: '',
        setDiscoverSearchText: () => {},
        refreshDiscover: () => {},
        canRefreshDiscover: true,
        loadingDiscover: false,
        loadingMoreDiscover: false,
        discoverEntries: [],
        discoverError: null,
        discoverStale: false,
        discoverSourceStatuses: [],
        discoverDiagnostics: [],
        discoverNonInstallable: [],
        discoverNextCursor: null,
        loadMoreDiscover: () => {},
        runCatalogAction: () => {},
        canRunDiscoverActions: true,
        developmentPlugins: [],
        developmentCreateAvailable: false,
        developmentSourceInstallAvailable: false,
        runDevelopmentAction: () => {},
        runDevelopmentCreate: () => {},
        runDevelopmentSourceInstall: () => {},
        currentDiagnostics: [],
        refreshPluginTruth: () => {},
        installedPluginsRead: true,
        pluginProjectionById: {},
        discoverResultsSearchText: '',
        clearDiscoverSearch: () => {},
    }),
}));
vi.mock('./detail/PluginDetailScreen', async () => ({
    PluginDetailView: (await import('@/dev/testkit/mocks/components')).createPassThroughComponent('PluginDetailView'),
}));
vi.mock('./listing/PluginListingScreen', async () => ({
    PluginListingView: (await import('@/dev/testkit/mocks/components')).createPassThroughComponent('PluginListingView'),
}));
vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', async () => ({
    MachineAdministrationTargetSelector: (await import('@/dev/testkit/mocks/components')).createPassThroughComponent('MachineAdministrationTargetSelector'),
}));
vi.mock('./machines/PluginMachineMatrixSection', async () => ({
    PluginMachineMatrixSection: (await import('@/dev/testkit/mocks/components')).createPassThroughComponent('PluginMachineMatrixSection'),
}));
vi.mock('./PluginAccountDataEraseRecoverySection', async () => ({
    PluginAccountDataEraseRecoverySection: (await import('@/dev/testkit/mocks/components')).createPassThroughComponent('PluginAccountDataEraseRecoverySection'),
}));
vi.mock('./NativeAppPluginPanelsSettingsEntry', async () => ({
    NativeAppPluginPanelsSettingsEntry: (await import('@/dev/testkit/mocks/components')).createPassThroughComponent('NativeAppPluginPanelsSettingsEntry'),
}));
vi.mock('./PluginAppPagesSettingsEntry', async () => ({
    PluginAppPagesSettingsEntry: (await import('@/dev/testkit/mocks/components')).createPassThroughComponent('PluginAppPagesSettingsEntry'),
}));
vi.mock('./PluginMarketplaceSections', async () => {
    const { createPassThroughComponent } = await import('@/dev/testkit/mocks/components');
    return {
        DevelopmentPluginsSection: createPassThroughComponent('DevelopmentPluginsSection'),
        // A collection section is the page: it draws the page's header and footer around its items.
        DiscoverListingsSection: (props: Readonly<{ header?: React.ReactNode; footer?: React.ReactNode }>) => React.createElement(
            React.Fragment, null, props.header, React.createElement('DiscoverListingsSection', props), props.footer,
        ),
        DiscoverStatusSummary: createPassThroughComponent('DiscoverStatusSummary'),
        InstalledPluginsSection: (props: Readonly<{ header?: React.ReactNode; footer?: React.ReactNode }>) => React.createElement(
            React.Fragment, null, props.header, React.createElement('InstalledPluginsSection', props), props.footer,
        ),
        PendingPluginChangesSection: createPassThroughComponent('PendingPluginChangesSection'),
        PluginRoutineOperationSettlementRow: createPassThroughComponent('PluginRoutineOperationSettlementRow'),
        PluginDiagnosticsSnapshotSection: createPassThroughComponent('PluginDiagnosticsSnapshotSection'),
    };
});
import { PluginSettingsHomeScreen } from './PluginSettingsHomeScreen';

/**
 * The page renders under the app root's pane state: its details pane stands in the app's pane host
 * (`AppScopePaneHost`), exactly as in the app.
 */
async function renderInAppPanes(
    element: React.ReactElement,
    options: Parameters<typeof renderSettingsView>[1] = {},
): ReturnType<typeof renderSettingsView> {
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    const Outer = options?.wrapper;
    return renderSettingsView(element, {
        ...options,
        wrapper: (props: React.PropsWithChildren) => React.createElement(
            AppPaneProvider,
            null,
            Outer ? React.createElement(Outer, null, props.children) : props.children,
        ),
    });
}


/**
 * The plugin-management controls are drawn at their dense design size under every
 * pointer (DESIGN.md: a touch target is a hit area, not a drawn size). The
 * segmented bars reach 44pt/48dp with their transparent press frame; the
 * selects reach it through the shared pressable's hit area. Neither draws
 * the target, so no measured width or height may reach it.
 */
async function readSegmentMinimumWidths(testID: string, dimension: 'minWidth' | 'minHeight' = 'minWidth'): Promise<readonly string[]> {
    const { Platform } = await import('react-native');
    const previousPlatform = Platform.OS;
    const observed: string[] = [];
    try {
        for (const platform of ['ios', 'android'] as const) {
            (Platform as { OS: string }).OS = platform;
            const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
            const drawn = flattenTestStyle(screen.findByTestId(testID)?.props.style)[dimension];
            observed.push(`${platform}: ${typeof drawn === 'number' && drawn >= (platform === 'android' ? 48 : 44) ? 'target' : 'dense'}`);
        }
    } finally {
        (Platform as { OS: string }).OS = previousPlatform;
    }
    return observed;
}

const DISABLED_PLUGIN = {
    pluginId: 'off', title: 'Off', description: null, version: '1.0.0', enabled: false,
    source: { kind: 'npm', locator: '@acme/off' }, install: { mode: 'copy', manifestVersion: '1.0.0' },
    compatibility: { status: 'compatible', diagnostics: [] }, diagnostics: [],
};

describe('PluginSettingsHomeScreen segmented controls', () => {
    beforeEach(() => {
        mocks.activeView = 'installed';
        mocks.installedPlugins = [DISABLED_PLUGIN];
        mocks.targetKind = 'unselected';
    });

    afterEach(() => {
        standardCleanup();
    });

    it('draws the management view selector at its dense width', async () => {
        expect(await readSegmentMinimumWidths('settings.plugins.management.view:installed'))
            .toEqual(['ios: dense', 'android: dense']);
    });

    it('draws the Discover source filter at its dense height', async () => {
        mocks.activeView = 'discover';
        expect(await readSegmentMinimumWidths('settings.plugins.marketplace.sourceFilter.trigger', 'minHeight'))
            .toEqual(['ios: dense', 'android: dense']);
    });

    it('draws Grid | List and the Installed status filter at their dense size', async () => {
        expect(await readSegmentMinimumWidths('settings.plugins.collectionView:grid'))
            .toEqual(['ios: dense', 'android: dense']);
        expect(await readSegmentMinimumWidths('settings.plugins.marketplace.installed.statusFilter', 'minHeight'))
            .toEqual(['ios: dense', 'android: dense']);
    });

    it('offers the Installed status filter only when it can narrow the list', async () => {
        mocks.installedPlugins = [{ ...DISABLED_PLUGIN, pluginId: 'on', enabled: true }];
        const healthy = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        expect(healthy.findByTestId('settings.plugins.marketplace.installed.statusFilter')).toBeNull();
        standardCleanup();
        mocks.installedPlugins = [DISABLED_PLUGIN];
        const mixed = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        expect(mixed.findByTestId('settings.plugins.marketplace.installed.statusFilter')).not.toBeNull();
    });

    it('counts installed plugins only once a machine is chosen, never beside "choose a machine"', async () => {
        const installedTabText = async () => (await renderInAppPanes(React.createElement(PluginSettingsHomeScreen)))
            .findByTestId('settings.plugins.management.view:installed')?.props.accessibilityLabel;
        expect(await installedTabText()).not.toMatch(/\b1$/);
        standardCleanup();
        mocks.targetKind = 'online';
        expect(await installedTabText()).toMatch(/\b1$/);
    });

    it('discloses the administration target above the pending decision controls', async () => {
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        // An approve/reject is a consequential machine-scoped operation, so the
        // exact target it would land on is disclosed above the decision rows —
        // the screen reads target first, decision second, in traversal order.
        const ordered = screen
            .findAll((node) => String(node.type) === 'MachineAdministrationTargetSelector'
                || String(node.type) === 'PendingPluginChangesSection')
            .map((node) => String(node.type));
        expect(ordered).toEqual(['MachineAdministrationTargetSelector', 'PendingPluginChangesSection']);
    });
});
