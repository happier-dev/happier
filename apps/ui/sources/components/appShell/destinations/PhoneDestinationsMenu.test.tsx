import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The harness installs the server socket boundary as it loads: import it before any runtime module.
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { createSessionListRenderableSessionFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { act } from 'react-test-renderer';
import { storage } from '@/sync/domains/state/storageStore';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { PluginPageLaunchInputScope } from '@/components/plugins/pages/pluginPageNavigation';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel, type PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import type { PluginPage } from '@/components/plugins/pages/pluginPages';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import { NavigationSurfacePlacementsV1Schema, type NavigationSurfacePlacementsV1 } from '@/sync/domains/settings/mobileSurfacePinning';

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
// The Home's real feature answer, through the transport boundary: Search and Bots are catalog destinations only when it enables them.
const runtime = installSessionPaneRuntimeTestHarness({
    scopeId: 'app',
    features: () => createRootLayoutFeaturesResponse({ features: { search: { enabled: true }, bots: { enabled: true } } }),
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
const RAIL = { requestedPlacement: { kind: 'rail' } } as const;
const reviewTab = placement('review-panel', 'rightSidebarTab', RAIL);

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
type Screen = Awaited<ReturnType<typeof renderScreen>>;
const menuOf = (screen: Screen) => screen.findByType(DropdownMenu);
const items = (screen: Screen): readonly DropdownMenuItem[] => menuOf(screen).props.items;
const groups = (screen: Screen) => {
    const byCategory: Record<string, string[]> = {};
    for (const item of items(screen)) (byCategory[item.category ?? ''] ??= []).push(String(item.testID));
    return byCategory;
};
const itemFor = (screen: Screen, testID: string) => items(screen).find(item => item.testID === testID);
async function select(screen: Screen, testID: string) {
    const item = itemFor(screen, testID);
    if (!item) throw new Error(`Expected the ${testID} item`);
    await act(async () => { menuOf(screen).props.onSelect(item.id); });
}
async function renderMenu() {
    const { PhoneDestinationsMenu } = await import('./PhoneDestinationsMenu');
    return render(<PhoneDestinationsMenu />);
}

describe('PhoneDestinationsMenu', () => {
    beforeEach(() => {
        routeState.push.mockReset();
        routeState.pathname = '/';
        surfaceState.windowWidth = 390;
        openUniversalSearch.mockReset();
        surfaceState.platformOS = 'web';
        surfaceState.isTablet = false;
        setCatalog({ pages: [page('notes', { requestedPlacement: { kind: 'column', column: 'sessions' } })] });
    });

    // The trigger is the tab bar's last slot, named More, so the menu rises from it and ends at its edge.
    it('is the tab bar More: named More and rising from its slot', async () => {
        const screen = await renderMenu();
        expect(screen.findByTestId('phone-launcher-button')!.props.accessibilityLabel).toBe(t('common.more'));
        expect(menuOf(screen).props.placement).toBe('top');
        expect(menuOf(screen).props.popoverAnchorAlign).toBe('end');
    });

    it("leads with the app's own shortcuts and keeps plugin destinations under the hairline, then Customize", async () => {
        setCatalog({
            // `quiet` asks for no placement: contextual (owner Q3), so it waits in Customize, not here.
            pages: [page('log', { requestedPlacement: { kind: 'column', column: 'sessions' } }), page('board', RAIL), page('quiet')],
            tabs: [reviewTab],
        });
        const menu = await renderMenu();
        expect(groups(menu)).toEqual({
            // Workflows is a phone tab now (owner Q4); Friends left the tabs for the shortcuts.
            // Home leads (owner 2026-11-04): the phone's one door to the Home the desktop opens on.
            pinned: [
                'phone-launcher-home',
                'sessions-search-all-button',
                'compact-app-destination:friends',
                'compact-app-destination:bots',
                'compact-app-destination:artifacts',
            ],
            more: [
                'compact-app-destination:boards',
                'external-sessions-browse-button',
                'compact-app-destination:plugin:acme.log:log',
                'compact-app-destination:plugins',
                'compact-app-destination:plugin:acme.board:board',
                'compact-app-destination:rightSidebarTab:plugin:acme.review:review-panel',
            ],
            customize: ['phone-launcher-customize'],
            recovery: ['plugin-app-pages-menu'],
        });
        expect(menuOf(menu).props.separateCategories).toBe(true);
    });

    it("honours the launcher's own placements, never the desktop rail's", async () => {
        setCatalog({
            pages: [page('board')],
            navigationPlacements: {
                phoneLauncher: { orderedIds: [], placements: { 'plugin:acme.board:board': 'pinned', boards: 'hidden', artifacts: 'overflow' } },
                appRail: { orderedIds: [], placements: { friends: 'hidden' } },
            },
        });
        const menu = await renderMenu();
        const { pinned = [], more = [] } = groups(menu);
        expect(pinned).toContain('compact-app-destination:plugin:acme.board:board');
        expect(pinned).toContain('compact-app-destination:friends');
        expect(more).toContain('compact-app-destination:artifacts');
        expect([...pinned, ...more]).not.toContain('compact-app-destination:boards');
    });

    it.each([
        { surface: 'phone', os: 'ios' },
        { surface: 'phone', os: 'android' },
        { surface: 'column', os: 'web' },
    ] as const)('recovers hidden and unavailable plugin pages through $surface on $os without rewriting placement or guessing routes', async ({ surface, os }) => {
        surfaceState.platformOS = os;
        const preferences = {
            phoneLauncher: { orderedIds: [], placements: { 'plugin:acme.notes:notes': 'hidden' as const } },
        };
        setCatalog({
            pages: [page('notes', { requestedPlacement: { kind: 'column', column: 'sessions' } }),
                page('offline', { disabledReason: 'feature_disabled' })],
            tabs: [reviewTab],
            navigationPlacements: preferences,
        });
        const { PluginAppPagesMenu } = await import('./PluginAppPagesMenu');
        const menu = surface === 'phone' ? await renderMenu() : await render(<PluginAppPagesMenu />);
        if (surface === 'phone') expect(itemFor(menu, 'compact-app-destination:plugin:acme.notes:notes')).toBeUndefined();
        const recoveryItems = surface === 'phone' ? itemFor(menu, 'plugin-app-pages-menu')?.submenu?.items : items(menu);
        expect(recoveryItems?.map(item => item.id)).toEqual([
            'plugin:acme.notes:notes', 'plugin:acme.offline:offline',
        ]);
        expect(recoveryItems?.find(item => item.id === 'plugin:acme.offline:offline')?.disabled).not.toBe(true);
        await act(async () => { menuOf(menu).props.onSelect('plugin:acme.offline:offline'); });
        await act(async () => { menuOf(menu).props.onSelect('plugin:acme.notes:notes'); });
        expect(routeState.push.mock.calls.map(([href]) => href)).toEqual([
            '/plugins/acme.offline/offline', '/plugins/acme.notes/notes',
        ]);
        if (surface === 'phone') expect(itemFor(menu, 'compact-app-destination:rightSidebarTab:plugin:acme.review:review-panel')?.disabled).toBe(false);
        expect(storage.getState().localSettings.navigationSurfacePlacementsV1).toEqual(
            NavigationSurfacePlacementsV1Schema.parse(preferences),
        );
    });

    it('names why a pinned destination is unavailable, and dims an unavailable one in More without repeating it', async () => {
        setCatalog({
            pages: [page('pinned', { ...RAIL, disabledReason: 'feature_disabled' }), page('later', { ...RAIL, disabledReason: 'feature_disabled' })],
            navigationPlacements: { phoneLauncher: { orderedIds: [], placements: { 'plugin:acme.pinned:pinned': 'pinned' } } },
        });
        const menu = await renderMenu();
        const pinned = itemFor(menu, 'compact-app-destination:plugin:acme.pinned:pinned');
        expect(pinned?.disabled).toBe(true);
        expect(pinned?.subtitle).toEqual(expect.any(String));
        expect(pinned?.subtitle).not.toBe('feature_disabled');
        const later = itemFor(menu, 'compact-app-destination:plugin:acme.later:later');
        expect(later?.disabled).toBe(true);
        expect(later?.subtitle).toBeUndefined();
    });

    it('opens Search over the page in the active Account, and navigates every other shortcut through the one activation', async () => {
        const menu = await renderMenu();
        await select(menu, 'sessions-search-all-button');
        const scope = captureActiveServerAccountScopeLifetime()?.scope;
        expect(openUniversalSearch).toHaveBeenCalledWith(undefined, {
            accountId: scope?.accountId, serverId: scope?.serverId, sessionId: null, machineId: null, rootPath: null,
        });
        expect(routeState.push).not.toHaveBeenCalled();

        await select(menu, 'compact-app-destination:plugins');
        await select(menu, 'compact-app-destination:plugin:acme.notes:notes');
        expect(routeState.push.mock.calls.map(([href]) => href)).toEqual(['/plugins', '/plugins/acme.notes/notes']);
    });

    it('opens Home as its own page, marked while it is open', async () => {
        const menu = await renderMenu();
        expect(itemFor(menu, 'phone-launcher-home')?.checked).toBe(false);
        await select(menu, 'phone-launcher-home');
        expect(routeState.push.mock.calls.map(([href]) => href)).toEqual(['/home']);

        routeState.pathname = '/home';
        const onHome = await renderMenu();
        expect(itemFor(onHome, 'phone-launcher-home')?.checked).toBe(true);
    });

    it("carries the Bots faces and what needs you on the phone's one Bots entry", async () => {
        // DF-B1: this is the phone's only way to the roster, so it says what the lab's My work entry
        // said (b-rail Ap): a few faces, then what needs you.
        const bots = ['alpha', 'beta'].map((id) => createSessionListRenderableSessionFixture({
            id, metadata: { path: '/home/happier', bot: { kind: 'bot' } },
        }));
        storage.setState({ sessionListRowsByServerId: {
            ...storage.getState().sessionListRowsByServerId,
            [runtime.serverId]: Object.fromEntries(bots.map((row) => [row.id, row])),
        } });
        const menu = await renderMenu();
        expect(itemFor(menu, 'compact-app-destination:bots')?.rightElement).toBeTruthy();
    });

    it('keeps a destination whose rail icon is hidden reachable from the phone', async () => {
        setCatalog({
            pages: [page('notes', { requestedPlacement: { kind: 'column', column: 'sessions' } })],
            navigationPlacements: { appRail: { orderedIds: ['plugin:acme.notes:notes'], placements: { 'plugin:acme.notes:notes': 'hidden' } } },
        });
        const menu = await renderMenu();
        expect(itemFor(menu, 'compact-app-destination:plugin:acme.notes:notes')).toBeTruthy();
    });
});
