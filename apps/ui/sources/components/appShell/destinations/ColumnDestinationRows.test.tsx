import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { PluginAppPage } from '@/components/appShell/plugins/pluginAppPages';
import type { RightSidebarPluginTabDefinition } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { resolveSessionListDensityViewState } from '@/components/sessions/shell/resolveSessionListDensityViewState';
import { NavigationSurfacePlacementsV1Schema, type NavigationSurfacePlacementsV1 } from '@/sync/domains/settings/mobileSurfacePinning';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';

import {
    resolveCompactAppDestinations,
    type CompactAppDestination,
} from './compactAppDestinationCatalog';

const routeState = vi.hoisted(() => ({
    push: vi.fn(),
    pathname: '/',
}));
const openUniversalSearch = vi.hoisted(() => vi.fn());
const surfaceState = vi.hoisted(() => {
    const localSettings: Pick<LocalSettings, 'navigationSurfacePlacementsV1'> = { navigationSurfacePlacementsV1: {} };
    return {
        platformOS: 'web' as 'web' | 'ios' | 'android',
        isTablet: false,
        sessionListDensity: 'narrow' as string,
        localSettings,
    };
});
const catalogState = vi.hoisted(() => ({ value: [] as readonly CompactAppDestination[] }));

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
    // One runtime that can report either surface, so the desktop-web row and the native touch
    // floor are asserted against the same rendered component rather than two harnesses.
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return surfaceState.platformOS;
            },
            select: <T,>(choices: { web?: T; default?: T; native?: T; ios?: T; android?: T }) => (
                surfaceState.platformOS === 'web'
                    ? choices?.web ?? choices?.default
                    : choices?.[surfaceState.platformOS] ?? choices?.native ?? choices?.default
            ),
        },
    });
});
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/platform/responsive')>()),
    useIsTablet: () => surfaceState.isTablet,
}));
vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock, createUseLocalSettingMock, createUseLocalSettingMutableMock } = await import('@/dev/testkit/mocks/storage');
    const useLocalSetting = createUseLocalSettingMock({ values: surfaceState.localSettings });
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useLocalSetting,
            useLocalSettingMutable: createUseLocalSettingMutableMock(useLocalSetting),
            useSetting: ((key: string) => (
                key === 'sessionListDensity' ? surfaceState.sessionListDensity : undefined
            )) as typeof import('@/sync/domains/state/storage')['useSetting'],
        },
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('ItemGroup', props, props.children),
}));
// The catalog's projection-backed hook is replaced by the real catalog resolver over fixed inputs.
vi.mock('./compactAppDestinationCatalog', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./compactAppDestinationCatalog')>()),
    useCompactAppDestinations: () => catalogState.value,
}));

function page(localId: string, extra: Partial<PluginAppPage> = {}): PluginAppPage {
    return {
        id: `plugin:acme.${localId}:${localId}`,
        pluginId: `acme.${localId}`,
        descriptorId: localId,
        localId,
        label: localId,
        icon: 'note',
        order: 10,
        disabledReason: null,
        placement: {} as PluginAppPage['placement'],
        routePath: `/plugins/acme.${localId}/${localId}`,
        ...extra,
    } as PluginAppPage;
}

const reviewTab = {
    id: 'plugin:acme.review:review-panel',
    owner: 'plugin',
    label: 'Review',
    icon: 'check-square',
    order: 50,
    scopes: ['app'],
    placement: { binding: { destination: { pluginId: 'acme.review', localId: 'review-panel' } } },
} as unknown as RightSidebarPluginTabDefinition;

function setCatalog(input: Readonly<{
    pages?: readonly PluginAppPage[];
    externalSessions?: boolean;
    tabs?: readonly RightSidebarPluginTabDefinition[];
    navigationPlacements?: NavigationSurfacePlacementsV1;
}>) {
    surfaceState.localSettings.navigationSurfacePlacementsV1 = NavigationSurfacePlacementsV1Schema.parse(input.navigationPlacements ?? {});
    catalogState.value = resolveCompactAppDestinations({
        builtins: { externalSessions: input.externalSessions ?? true, inbox: true, workflows: true, friends: true },
        pages: input.pages ?? [],
        ...(input.tabs ? { rightSidebarTabs: input.tabs } : {}),
    });
}

async function render(element: React.ReactElement) {
    return renderScreen(
        <UniversalSearchRuntimeProvider value={{ open: openUniversalSearch, buildCommands: () => [] }}>
            {element}
        </UniversalSearchRuntimeProvider>,
    );
}

const rowIds = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.root
    .findAll((node) => node.type === ('Item' as never))
    .map((node) => String(node.props.testID));

async function renderActionRowStyle(): Promise<Record<string, number>> {
    const { ColumnDestinationRows } = await import('./ColumnDestinationRows');
    const screen = await render(<ColumnDestinationRows column="sessions" />);
    const row = screen.findByTestId('compact-app-destination:plugin:acme.notes:notes');
    return row?.props.style as Record<string, number>;
}

describe('ColumnDestinationRows', () => {
    beforeEach(() => {
        routeState.push.mockReset();
        routeState.pathname = '/';
        openUniversalSearch.mockReset();
        surfaceState.platformOS = 'web';
        surfaceState.isTablet = false;
        surfaceState.sessionListDensity = 'narrow';
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
        expect(sessions.findByTestId('compact-app-destination:plugin:acme.log:log')?.props.selected).toBe(true);
        expect(sessions.findByTestId('external-sessions-browse-button')?.props.selected).toBe(false);
        // Destinations are not sessions: quiet navigation rows on the column's surface, never a sheet.
        expect(sessions.root.findByType('ItemGroup' as never).props.surface).toBe('none');

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

        screen.findByTestId('sessions-search-all-button')?.props.onPress();
        expect(openUniversalSearch).toHaveBeenCalledWith(undefined, scope);
        expect(routeState.push).not.toHaveBeenCalled();

        screen.findByTestId('compact-app-destination:plugins')?.props.onPress();
        screen.findByTestId('compact-app-destination:plugin:acme.notes:notes')?.props.onPress();
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
        const row = screen.findByTestId('compact-app-destination:plugin:acme.notes:notes');

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
