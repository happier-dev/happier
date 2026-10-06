import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { act } from 'react-test-renderer';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { PluginAppPageLaunchInputScope } from '@/components/appShell/plugins/pluginAppPageNavigation';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel, type PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import type { PluginAppPage } from '@/components/appShell/plugins/pluginAppPages';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { resolveSessionListDensityViewState } from '@/components/sessions/shell/resolveSessionListDensityViewState';
import { NavigationSurfacePlacementsV1Schema, type NavigationSurfacePlacementsV1 } from '@/sync/domains/settings/mobileSurfacePinning';

const routeState = vi.hoisted(() => ({ push: vi.fn(), pathname: '/' }));
const openUniversalSearch = vi.hoisted(() => vi.fn());
const surfaceState = vi.hoisted(() => ({
    platformOS: 'web' as 'web' | 'ios' | 'android',
    isTablet: false,
}));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: () => routeState.pathname,
        router: { push: (href: unknown) => routeState.push(href) },
    }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const dimensions = () => ({ width: surfaceState.isTablet ? 840 : 390, height: 900, scale: 1, fontScale: 1 });
    return createReactNativeWebMock({
        Platform: {
            get OS() { return surfaceState.platformOS; },
            get isPad() { return surfaceState.isTablet; },
            select: <T,>(choices: { web?: T; default?: T; native?: T; ios?: T; android?: T }) => (
                surfaceState.platformOS === 'web' ? choices.web ?? choices.default
                    : choices[surfaceState.platformOS] ?? choices.native ?? choices.default
            ),
        },
        useWindowDimensions: dimensions,
        Dimensions: { get: dimensions },
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
const runtime = installSessionPaneRuntimeTestHarness({ scopeId: 'app' });
let projection: PluginUiProjectionModel;

function placement(localId: string, container: 'appPage' | 'rightSidebarTab',
    extra: Partial<Pick<PluginAppPage, 'requestedPlacement' | 'disabledReason'>> = {}): PluginUiSurfacePlacementProjection {
    const pluginId = container === 'rightSidebarTab' ? 'acme.review' : `acme.${localId}`;
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId, destinationId: localId, rendererId: localId, container, target: { kind: 'app' },
    });
    if (!binding) throw new Error('invalid destination fixture');
    return {
        id: `surfacePlacement:${pluginId}:${localId}`, pluginId, occurrenceId: `${pluginId}-occurrence`,
        contributionKind: 'surfacePlacement', descriptorId: localId, binding, target: { kind: 'app' },
        renderer: { kind: 'host', rendererId: localId },
        display: { developerFallback: localId, ...(extra.requestedPlacement ? { placement: extra.requestedPlacement } : {}) },
        availability: extra.disabledReason
            ? { state: 'disabled', reason: extra.disabledReason, diagnostics: [] }
            : { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
        ...(container === 'rightSidebarTab' ? { rightSidebar: { tabId: localId, scopes: ['app'] } } : {}),
    };
}
function page(localId: string, extra: Partial<Pick<PluginAppPage, 'requestedPlacement' | 'disabledReason'>> = {}) {
    return placement(localId, 'appPage', extra);
}
const reviewTab = placement('review-panel', 'rightSidebarTab');

function setCatalog(input: Readonly<{
    pages?: readonly PluginUiSurfacePlacementProjection[];
    externalSessions?: boolean;
    tabs?: readonly PluginUiSurfacePlacementProjection[];
    navigationPlacements?: NavigationSurfacePlacementsV1;
}>) {
    const placements = [...(input.pages ?? []), ...(input.tabs ?? [])];
    projection = { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
        surfacePlacementsById: Object.fromEntries(placements.map(entry => [entry.id, entry])) };
    storage.setState({
        settings: { ...storage.getState().settings, sessionListDensity: 'narrow',
            featureToggles: { ...storage.getState().settings.featureToggles, 'sessions.direct': input.externalSessions ?? true } },
        localSettings: { ...storage.getState().localSettings,
            navigationSurfacePlacementsV1: NavigationSurfacePlacementsV1Schema.parse(input.navigationPlacements ?? {}) },
    });
}
function Wrapper({ children }: React.PropsWithChildren) {
    return <runtime.Wrapper><AppShellPluginUiProjectionValueProvider value={{
        pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current',
        interactionEnabled: true, machineId: null, serverId: runtime.serverId, platform: surfaceState.platformOS,
        clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
        reloadConnectedAccountProjection: () => {},
    }}><PluginAppPageLaunchInputScope pluginUiProjection={projection}>
        <UniversalSearchRuntimeProvider value={{ open: openUniversalSearch, buildCommands: () => [] }}>
            {children}
        </UniversalSearchRuntimeProvider>
    </PluginAppPageLaunchInputScope></AppShellPluginUiProjectionValueProvider></runtime.Wrapper>;
}
async function render(element: React.ReactElement) {
    const screen = await renderScreen(element, { wrapper: Wrapper });
    await flushHookEffects();
    return screen;
}
const rowIds = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.root
    .findAllByType(Item).map(node => String(node.props.testID));
function rowFor(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    return screen.root.findAllByType(Item).find(node => node.props.testID === testID);
}
async function renderActionRowStyle(): Promise<Record<string, number>> {
    const { ColumnDestinationRows } = await import('./ColumnDestinationRows');
    const screen = await render(<ColumnDestinationRows column="sessions" />);
    // Renderer props are untyped; this reads the real Item's public row-size input.
    return rowFor(screen, 'compact-app-destination:plugin:acme.notes:notes')?.props.style;
}

describe('ColumnDestinationRows', () => {
    beforeEach(() => {
        routeState.push.mockReset();
        routeState.pathname = '/';
        openUniversalSearch.mockReset();
        surfaceState.platformOS = 'web';
        surfaceState.isTablet = false;
        setCatalog({ pages: [page('notes', { requestedPlacement: { kind: 'column', column: 'sessions' } })] });
    });

    it('lists only the entries placed in its column, selected while their page is open', async () => {
        routeState.pathname = '/plugins/acme.log/log/today';
        setCatalog({
            pages: [
                page('log', { requestedPlacement: { kind: 'column', column: 'sessions' } }),
                page('board'),
                page('later', { requestedPlacement: { kind: 'column', column: 'workflows' } }),
            ],
        });
        const { ColumnDestinationRows } = await import('./ColumnDestinationRows');

        const sessions = await render(<ColumnDestinationRows column="sessions" />);
        expect(rowIds(sessions)).toEqual(['external-sessions-browse-button', 'compact-app-destination:plugin:acme.log:log']);
        expect(rowFor(sessions, 'compact-app-destination:plugin:acme.log:log')?.props.selected).toBe(true);
        expect(rowFor(sessions, 'external-sessions-browse-button')?.props.selected).toBe(false);
        // Destinations are not sessions: quiet navigation rows on the column's surface, never a sheet.
        expect(sessions.root.findByType(ItemGroup).props.surface).toBe('none');

        // A column with nothing placed in it draws no rows at all.
        const plugins = await render(<ColumnDestinationRows column="plugins" />);
        expect(rowIds(plugins)).toEqual([]);
    });

    it('gives the phone launcher every destination its tab bar does not show', async () => {
        setCatalog({
            pages: [page('log', { requestedPlacement: { kind: 'column', column: 'sessions' } }), page('board')],
            tabs: [reviewTab],
        });
        const { ColumnDestinationRows } = await import('./ColumnDestinationRows');
        const launcher = await render(<ColumnDestinationRows />);
        expect(rowIds(launcher)).toEqual([
            'sessions-search-all-button',
            'compact-app-destination:workflows',
            'compact-app-destination:boards',
            'compact-app-destination:artifacts',
            'external-sessions-browse-button',
            'compact-app-destination:plugin:acme.log:log',
            'compact-app-destination:plugins',
            'compact-app-destination:plugin:acme.board:board',
            'compact-app-destination:rightSidebarTab:plugin:acme.review:review-panel',
        ]);
    });

    it('opens Search over the page with the column scope, and navigates every other row through the one activation', async () => {
        const { ColumnDestinationRows } = await import('./ColumnDestinationRows');
        const scope = { accountId: 'account-b', serverId: 'home-b', sessionId: null, machineId: null, rootPath: null } as const;
        const screen = await render(<ColumnDestinationRows universalSearchScope={scope} />);

        await act(async () => { rowFor(screen, 'sessions-search-all-button')?.props.onPress(); });
        expect(openUniversalSearch).toHaveBeenCalledWith(undefined, scope);
        expect(routeState.push).not.toHaveBeenCalled();

        await act(async () => {
            rowFor(screen, 'compact-app-destination:plugins')?.props.onPress();
            rowFor(screen, 'compact-app-destination:plugin:acme.notes:notes')?.props.onPress();
        });
        expect(routeState.push.mock.calls.map(([href]) => href)).toEqual(['/plugins', '/plugins/acme.notes/notes']);
    });

    it.each([
        { platformOS: 'ios' as const, isTablet: true },
        { platformOS: 'ios' as const, isTablet: false },
        { platformOS: 'android' as const, isTablet: true },
    ])('holds the native touch floor on $platformOS (tablet: $isTablet)', async (surface) => {
        surfaceState.platformOS = surface.platformOS;
        surfaceState.isTablet = surface.isTablet;
        const minimumTargetSize = resolveMinimumInteractiveTargetSize(surface.platformOS);
        const densityHeight = resolveSessionListDensityViewState('narrow', {
            isTablet: surface.isTablet,
            platform: surface.platformOS,
        }).rowHeight;
        // The case only discriminates while the density row is genuinely below the floor.
        expect(densityHeight).toBeLessThan(minimumTargetSize);

        const style = await renderActionRowStyle();

        expect(style.height).toBe(minimumTargetSize);
        expect(style.minHeight).toBe(minimumTargetSize);
    });

    it('keeps the desktop-web row on the session-list density grid', async () => {
        surfaceState.platformOS = 'web';
        surfaceState.isTablet = false;
        const densityHeight = resolveSessionListDensityViewState('narrow', {
            isTablet: false,
            platform: 'web',
        }).rowHeight;
        // The approved desktop decision is exactly the case a blanket floor would undo.
        expect(densityHeight).toBeLessThan(resolveMinimumInteractiveTargetSize('web'));

        const style = await renderActionRowStyle();

        expect(style.height).toBe(densityHeight);
        expect(style.minHeight).toBe(densityHeight);
    });

    it('shows a localized unavailable reason instead of a silent disabled row', async () => {
        setCatalog({ pages: [page('notes', { requestedPlacement: { kind: 'column', column: 'sessions' }, disabledReason: 'feature_disabled' })] });
        const { ColumnDestinationRows } = await import('./ColumnDestinationRows');
        const screen = await render(<ColumnDestinationRows column="sessions" />);
        const row = rowFor(screen, 'compact-app-destination:plugin:acme.notes:notes');

        expect(row?.props.disabled).toBe(true);
        expect(row?.props.subtitle).toEqual(expect.any(String));
        expect(row?.props.subtitle).not.toBe('feature_disabled');
    });

    it('keeps column and phone discovery visible when the rail icon is hidden', async () => {
        setCatalog({
            pages: [page('notes', { requestedPlacement: { kind: 'column', column: 'sessions' } })],
            navigationPlacements: { appRail: { orderedIds: ['plugin:acme.notes:notes'], placements: { 'plugin:acme.notes:notes': 'hidden' } } },
        });
        const { ColumnDestinationRows } = await import('./ColumnDestinationRows');
        const screen = await render(<ColumnDestinationRows column="sessions" />);

        expect(screen.findByTestId('compact-app-destination:plugin:acme.notes:notes')).not.toBeNull();
        expect(rowIds(screen)[0]).toBe('external-sessions-browse-button');
        const launcher = await render(<ColumnDestinationRows />);
        expect(launcher.findByTestId('compact-app-destination:plugin:acme.notes:notes')).not.toBeNull();
    });
});
