import * as React from 'react';
import { StyleSheet } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The static storage graph reaches the Socket.IO transport; register its external boundary before any import.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// The harness installs the server socket boundary as it loads: import it before any runtime module.
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { createAccountSettingsHttpBoundary } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { PluginPageLaunchInputScope } from '@/components/plugins/pages/pluginPageNavigation';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel, type PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import type { PluginPage } from '@/components/plugins/pages/pluginPages';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { resolveSessionListDensityViewState } from '@/components/sessions/shell/resolveSessionListDensityViewState';
import { NavigationSurfacePlacementsV1Schema, type NavigationSurfacePlacementsV1 } from '@/sync/domains/settings/navigationPlacement';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE, resolveHappierMinimumInteractiveTargetSize } from '@happier-dev/plugin-ui/environment';

const routeState = vi.hoisted(() => ({ push: vi.fn(), pathname: '/' }));
const openUniversalSearch = vi.hoisted(() => vi.fn());
const surfaceState = vi.hoisted(() => ({
    platformOS: 'web' as 'web' | 'ios' | 'android',
    isTablet: false,
    windowWidth: 390,
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
    const dimensions = () => ({ width: surfaceState.isTablet ? 840 : surfaceState.windowWidth, height: 900, scale: 1, fontScale: 1 });
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
const settingsHttp = createAccountSettingsHttpBoundary({ serverUrl: 'https://session-pane.test', initialAccounts: [] });
beforeEach(() => {
    settingsHttp.replaceAccountSettings('account-a', { content: { t: 'plain', v: { sessionListDensity: 'narrow' } }, version: 0 });
});
const runtime = installSessionPaneRuntimeTestHarness({
    scopeId: 'app',
    request: async (url, init) => settingsHttp.handle(url, init) ?? null,
});
let projection: PluginUiProjectionModel;

function placement(localId: string, container: 'appPage' | 'rightSidebarTab',
    extra: Partial<Pick<PluginPage, 'requestedPlacement' | 'disabledReason'>> = {}): PluginUiSurfacePlacementProjection {
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
function page(localId: string, extra: Partial<Pick<PluginPage, 'requestedPlacement' | 'disabledReason'>> = {}) {
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
        accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
        reloadConnectedAccountProjection: () => {},
    }}><PluginPageLaunchInputScope target={{ kind: 'app' }} pluginUiProjection={projection}>
        <UniversalSearchRuntimeProvider value={{ open: openUniversalSearch, buildCommands: () => [] }}>
            {children}
        </UniversalSearchRuntimeProvider>
    </PluginPageLaunchInputScope></AppShellPluginUiProjectionValueProvider></runtime.Wrapper>;
}
async function render(element: React.ReactElement) {
    const screen = await renderScreen(element, { wrapper: Wrapper });
    await flushHookEffects();
    return screen;
}
const rowIds = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen
    .findAllByType(Item).map(node => String(node.props.testID));
function rowFor(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    return screen.findAllByType(Item).find(node => node.props.testID === testID);
}
async function renderActionRowStyle() {
    const { ColumnDestinationRows } = await import('./ColumnDestinationRows');
    const screen = await render(<ColumnDestinationRows column="sessions" />);
    const row = rowFor(screen, 'compact-app-destination:plugin:acme.notes:notes');
    if (!row) throw new Error('Expected the notes destination row');
    const style = StyleSheet.flatten(row.props.style);
    if (!style) throw new Error('Expected the notes destination row-size style');
    return style;
}

describe('ColumnDestinationRows', () => {
    beforeEach(() => {
        routeState.push.mockReset();
        routeState.pathname = '/';
        surfaceState.windowWidth = 390;
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
        expect(sessions.findByType(ItemGroup).props.surface).toBe('none');

        // The plugins column lists its own built-in entry (Bots), never a page placed in another column.
        const plugins = await render(<ColumnDestinationRows column="plugins" />);
        expect(rowIds(plugins)).toEqual(['compact-app-destination:store.bots']);

        // A column with nothing placed in it draws no rows at all.
        const discussions = await render(<ColumnDestinationRows column="discussions" />);
        expect(rowIds(discussions)).toEqual([]);
    });

    it.each([
        { platformOS: 'ios' as const, isTablet: true },
        { platformOS: 'ios' as const, isTablet: false },
        { platformOS: 'android' as const, isTablet: true },
    ])('keeps the density row height on $platformOS (tablet: $isTablet); a finger reaches it through the hit area', async (surface) => {
        surfaceState.platformOS = surface.platformOS;
        surfaceState.isTablet = surface.isTablet;
        const densityHeight = resolveSessionListDensityViewState('narrow', {
            isTablet: surface.isTablet,
            platform: surface.platformOS,
        }).rowHeight;
        const style = await renderActionRowStyle();

        expect(style.height).toBe(densityHeight);
        expect(style.minHeight).toBe(densityHeight);
    });

    it('applies the Account Sessions Lines choice to the sidebar without replacing its legacy key', async () => {
        surfaceState.windowWidth = 1440;
        const { act } = await import('react-test-renderer');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { ColumnDestinationRows } = await import('./ColumnDestinationRows');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'agent' as const, serverId: runtime.serverId, expectedAccountId: 'account-a' };
        const screen = await render(<ColumnDestinationRows column="sessions" />);
        try {
            const height = () => StyleSheet.flatten(rowFor(screen, 'compact-app-destination:plugin:acme.notes:notes')?.props.style)?.height;
            const compactHeight = height();
            expect(compactHeight).toBe(resolveSessionListDensityViewState('narrow', { isTablet: false, platform: 'web', windowWidth: 1440 }).rowHeight);
            await act(async () => {
                expect(await executor.execute('settings.set', {
                    anchor: 'appearance.collectionDisplay', value: { kind: 'sessionWork', lines: 3, details: { currentWork: false } },
                }, context)).toMatchObject({ ok: true });
            });
            expect(storage.getState().settings.sessionListDensity).toBe('detailed');
            expect(await executor.execute('settings.set', {
                anchor: 'appearance.collectionDisplay', value: { kind: 'sessionWork', details: { progress: false } },
            }, context)).toMatchObject({ ok: true });
            expect(await executor.execute('settings.get', {
                anchor: 'appearance.collectionDisplay',
            }, context)).toMatchObject({ ok: true, result: { value: { sessionWork: {
                lines: 3, details: { currentWork: false, progress: false },
            } } } });
            expect(height()).toBeGreaterThan(compactHeight!);
        } finally {
            await screen.unmount();
        }
    });

    it('keeps the desktop-web row on the session-list density grid', async () => {
        surfaceState.platformOS = 'web';
        surfaceState.isTablet = false;
        surfaceState.windowWidth = 800;
        const densityHeight = resolveSessionListDensityViewState('narrow', {
            isTablet: false,
            platform: 'web',
            windowWidth: 800,
        }).rowHeight;
        // A precise pointer only owes the WCAG pointer floor, which the density grid already clears;
        // the touch floor must not lift the desktop row.
        const pointerFloor = HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE;
        expect(densityHeight).toBeGreaterThanOrEqual(pointerFloor);
        expect(densityHeight).toBeLessThan(resolveHappierMinimumInteractiveTargetSize('ios'));

        const style = await renderActionRowStyle();

        expect(style.height).toBe(densityHeight);
        expect(style.minHeight).toBe(densityHeight);
    });

    it('grows with the text scale exactly like the session rows beneath it', async () => {
        surfaceState.platformOS = 'web';
        surfaceState.windowWidth = 1440;
        storage.setState({ localSettings: { ...storage.getState().localSettings, uiFontScale: 2 } });
        try {
            const scaledHeight = resolveSessionListDensityViewState('narrow', {
                isTablet: false,
                platform: 'web',
                windowWidth: 1440,
                uiFontScale: 2,
            }).rowHeight;
            expect(scaledHeight).toBeGreaterThan(resolveSessionListDensityViewState('narrow', {
                isTablet: false, platform: 'web', windowWidth: 1440,
            }).rowHeight);

            const style = await renderActionRowStyle();

            expect(style.height).toBe(scaledHeight);
            expect(style.minHeight).toBe(scaledHeight);
        } finally {
            storage.setState({ localSettings: { ...storage.getState().localSettings, uiFontScale: 1 } });
        }
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

    it('keeps column discovery visible when the rail icon is hidden', async () => {
        setCatalog({
            pages: [page('notes', { requestedPlacement: { kind: 'column', column: 'sessions' } })],
            navigationPlacements: { appRail: { orderedIds: ['plugin:acme.notes:notes'], placements: { 'plugin:acme.notes:notes': 'hidden' } } },
        });
        const { ColumnDestinationRows } = await import('./ColumnDestinationRows');
        const screen = await render(<ColumnDestinationRows column="sessions" />);

        expect(screen.findByTestId('compact-app-destination:plugin:acme.notes:notes')).not.toBeNull();
        expect(rowIds(screen)[0]).toBe('external-sessions-browse-button');
    });
});
