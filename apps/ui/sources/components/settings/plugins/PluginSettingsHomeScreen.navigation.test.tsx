import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';

vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

const mocks = vi.hoisted(() => ({
    pathname: '/settings/plugins',
    params: {} as Record<string, string>,
    deviceType: 'tablet' as 'phone' | 'tablet',
    installedPlugins: [] as unknown[],
    activeView: 'installed' as 'installed' | 'discover',
    setActiveView: vi.fn(),
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

const routerMock = vi.hoisted(() => ({ value: null as ReturnType<typeof createRouterMock> | null }));
function createRouterMock() {
    return { push: vi.fn(), back: vi.fn(), replace: vi.fn(), setParams: vi.fn(), dismissTo: vi.fn(), dismissAll: vi.fn() };
}
vi.mock('expo-router', () => ({
    useRouter: () => routerMock.value,
    useLocalSearchParams: () => mocks.params,
    useGlobalSearchParams: () => mocks.params,
    usePathname: () => mocks.pathname,
    Stack: Object.assign(() => null, { Screen: () => null }),
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => false }));
// Whether a side pane exists is the platform's answer (phone or not); the shared details pane itself is real.
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useDeviceType: () => mocks.deviceType,
    useHeaderHeight: () => 56,
}));
// The animated column host draws what the pane owner decided; render its panes in place.
vi.mock('@/components/ui/panels/MultiPaneHostWithBottom', () => ({
    MultiPaneHostWithBottom: (props: Readonly<{ main: React.ReactNode; detailsPane?: React.ReactNode }>) => (
        React.createElement('MultiPaneHostStub', null, props.main, props.detailsPane ?? null)
    ),
}));
vi.mock('./model/usePluginSettingsScreenState', () => ({
    usePluginSettingsScreenState: () => ({
        activeView: mocks.activeView,
        setActiveView: mocks.setActiveView,
        readOnlySnapshotNotice: null,
        pendingPluginChanges: [],
        daemonOperationsAvailable: true,
        isPluginActionInFlight: () => false,
        decidePendingPluginChange: () => {},
        administrationTargetSelection: { state: { kind: 'unselected' }, candidates: [], selectedTarget: null, canExecute: false, resolveExecutionTarget: () => null },
        installedPlugins: mocks.installedPlugins,
        installedPluginById: new Map(),
        canRefreshInstalledPlugins: true,
        runInstalledPluginAction: () => {},
        discoverSources: [],
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


const MANAGEMENT_VIEW_TEST_ID_PREFIX = 'settings.plugins.management.view:';

async function readManagementSegmentIds(wrap?: (element: React.ReactElement) => React.ReactElement): Promise<readonly string[]> {
    const element = React.createElement(PluginSettingsHomeScreen);
    const screen = await renderInAppPanes(wrap ? wrap(element) : element);
    return [...new Set(screen
        .findAll((node) => typeof node.props?.testID === 'string'
            && node.props.testID.startsWith(MANAGEMENT_VIEW_TEST_ID_PREFIX)
            && node.props.testID !== `${MANAGEMENT_VIEW_TEST_ID_PREFIX}thumb`)
        .map((node) => String(node.props.testID).slice(MANAGEMENT_VIEW_TEST_ID_PREFIX.length)))];
}

describe('Settings > Plugins information architecture', () => {
    beforeEach(() => {
        mocks.activeView = 'installed';
        mocks.pathname = '/settings/plugins';
        mocks.params = {};
        mocks.deviceType = 'tablet';
        mocks.installedPlugins = [];
        mocks.setActiveView.mockClear();
        routerMock.value = createRouterMock();
    });

    afterEach(() => {
        standardCleanup();
    });

    /**
     * The home screen previously split the four destinations across two
     * segmented controls, so whichever bar did not own the active value
     * rendered with nothing selected. One navigation owner means the active
     * value is always one of the segments the reader can see.
     */
    it('renders one management navigation owner whose segments contain the active view', async () => {
        for (const activeView of ['installed', 'discover'] as const) {
            mocks.activeView = activeView;
            const segmentIds = await readManagementSegmentIds();
            expect(segmentIds).toEqual(['installed', 'discover']);
            expect(segmentIds).toContain(activeView);
            standardCleanup();
        }
    });

    it('leaves the Installed | Browse choice to the Plugins column beside the app rail, and keeps it where there is no column', async () => {
        const { AppShellColumnContext } = await import('@/components/navigation/shell/appRail/appShellColumnContext');
        const inShell = (columnVisible: boolean) => (element: React.ReactElement) => React.createElement(
            AppShellColumnContext.Provider,
            { value: { present: true, columnVisible } },
            element,
        );
        mocks.pathname = '/plugins';
        expect(await readManagementSegmentIds(inShell(true))).toEqual([]);
        standardCleanup();
        // The column is hidden: the page offers the choice itself.
        expect(await readManagementSegmentIds(inShell(false))).toEqual(['installed', 'discover']);
        standardCleanup();
        // Settings' Plugin marketplace sits beside the settings column, not the Plugins one.
        mocks.pathname = '/settings/plugins';
        expect(await readManagementSegmentIds(inShell(true))).toEqual(['installed', 'discover']);
    });

    it('keeps the single installed-plugins search on the page beside the navigation-only Plugins column', async () => {
        const { AppShellColumnContext } = await import('@/components/navigation/shell/appRail/appShellColumnContext');
        const { setPluginsInstalledQuery } = await import('./model/pluginsInstalledSearch');
        mocks.pathname = '/plugins';
        mocks.installedPlugins = [
            { pluginId: 'acme.alpha', title: 'Alpha', description: null, version: '1', enabled: true, source: { kind: 'npm', locator: 'a' } },
            { pluginId: 'acme.beta', title: 'Beta', description: null, version: '1', enabled: true, source: { kind: 'npm', locator: 'b' } },
        ];
        const screen = await renderInAppPanes(React.createElement(
            AppShellColumnContext.Provider,
            { value: { present: true, columnVisible: true } },
            React.createElement(PluginSettingsHomeScreen),
        ));
        expect(screen.findByTestId('settings.plugins.marketplace.installed.search')).not.toBeNull();
        await act(async () => { setPluginsInstalledQuery('bet'); });
        const installedSection = screen.findAll((node) => typeof node.props?.onNavigateToPlugin === 'function')[0];
        expect(installedSection?.props.installedPlugins.map((entry: { pluginId: string }) => entry.pluginId)).toEqual(['acme.beta']);
        await act(async () => { setPluginsInstalledQuery(''); });
    });

    it('opens a plugin in the details pane by naming it in the route, keeping the collection mounted', async () => {
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        const installedSection = screen.findAll((node) => typeof node.props?.onNavigateToPlugin === 'function')[0];
        await act(async () => { installedSection?.props.onNavigateToPlugin('acme.plugin'); });
        expect(routerMock.value?.setParams).toHaveBeenCalledWith({ plugin: 'acme.plugin', source: undefined });
        expect(routerMock.value?.push).not.toHaveBeenCalled();
    });

    it('shows the plugin the route names in the shared details pane, and closing clears it', async () => {
        mocks.params = { plugin: 'acme.plugin' };
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        const pane = screen.findByTestId('settings.plugins.detailPane');
        expect(pane).not.toBeNull();
        const detail = screen.findAll((node) => (node.type as unknown) === 'PluginDetailView')[0];
        expect(detail?.props.pluginId).toBe('acme.plugin');
        // The collection beside it marks the same plugin as the open one.
        const installedSection = screen.findAll((node) => typeof node.props?.onNavigateToPlugin === 'function')[0];
        expect(installedSection?.props.selectedPluginId).toBe('acme.plugin');
        await act(async () => { screen.pressByTestId('settings.plugins.detailPane.header.close'); });
        expect(routerMock.value?.setParams).toHaveBeenCalledWith({ plugin: undefined, source: undefined });
    });

    it('opens a plugin as its own page where there is no side pane (phones)', async () => {
        mocks.deviceType = 'phone';
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        const installedSection = screen.findAll((node) => typeof node.props?.onNavigateToPlugin === 'function')[0];
        await act(async () => { installedSection?.props.onNavigateToPlugin('acme.plugin'); });
        expect(screen.findByTestId('settings.plugins.detailPane.header')).toBeNull();
        expect(routerMock.value?.push).toHaveBeenCalledWith(expect.objectContaining({
            params: expect.objectContaining({ pluginId: 'acme.plugin' }),
        }));
    });

    it('reaches Development and Diagnostics as their own addressable routes', async () => {
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));

        screen.pressByTestId('settings.plugins.development');
        screen.pressByTestId('settings.plugins.diagnostics');

        expect(routerMock.value?.push.mock.calls.map(([route]) => route)).toEqual([
            '/settings/plugins/development',
            '/settings/plugins/diagnostics',
        ]);
        // Navigating away from the two primary tasks must not silently retarget
        // the tab owner, which still answers only Installed and Discover.
        expect(mocks.setActiveView).not.toHaveBeenCalled();
    });
});
