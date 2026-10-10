import * as React from 'react';
import type { HomeGovernanceProjectionV1 } from '@happier-dev/protocol/home/governance';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Imported from their own testkit modules rather than the `@/dev/testkit` barrel: see
// `HomeAdministrationPeopleScreen.test.tsx` for why the barrel would bind the real transports first.
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { homeAccountRowFixture, homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { renderInCollectionLayout } from '@/dev/testkit/render/renderInCollectionLayout';
import { renderScreen, type RenderScreenResult } from '@/dev/testkit/render/renderScreen';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const route = vi.hoisted(() => ({ pathname: '/settings/home' }));
const windowState = vi.hoisted(() => ({ width: 1440, height: 1000 }));
const navigation = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    dismissTo: vi.fn(),
}));

vi.mock('@/components/ui/lists/virtualized', () => ({
    VirtualizedList: (props: Record<string, any>) => React.createElement(
        'VirtualizedList',
        props,
        ...(props.data ?? []).map((item: unknown, index: number) => props.renderItem({ item, index })),
    ),
}));

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const dimensions = () => ({ width: windowState.width, height: windowState.height, scale: 1, fontScale: 1 });
        return createReactNativeWebMock({ useWindowDimensions: dimensions, Dimensions: { get: dimensions } });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: () => route.pathname,
            params: () => ({ serverId: route.pathname.split('/')[3] ?? '' }),
            navigation: { setOptions: vi.fn() },
            router: { push: navigation.push, replace: navigation.replace, dismissTo: navigation.dismissTo },
        }).module;
    },
});

// Only the network and the device credential store are replaced; the Home binding, engine, store and
// the collection's split geometry below them are the production ones.
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const GOVERNANCE_PATH = '/v1/home/governance/get';
const LIST_PATH = '/v1/home/accounts/list';

/** The page beside the rail and a 280px column at a 1100 window. */
const MID_PANE_PX = 764;

const OWNER_RAIL = [
    'overview', 'people', 'teams', 'policies', 'sign-in-providers',
    'reach', 'email', 'features', 'data', 'runtime', 'server-settings',
    'activity',
];

async function addHome(projection: HomeGovernanceProjectionV1 = homeGovernanceProjectionFixture()): Promise<string> {
    const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-ada' });
    harness.answer(home, GOVERNANCE_PATH, { body: projection });
    harness.answer(home, LIST_PATH, { body: { items: [homeAccountRowFixture('account-ada')], nextCursor: null } });
    return home;
}

async function resetEngine() {
    const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
    resetHomeGovernanceEngineForTests();
}

async function renderConsole(pathname: string): Promise<RenderScreenResult> {
    route.pathname = pathname;
    const { HomeConsoleLayout } = await import('./HomeConsoleLayout');
    await resetEngine();
    return renderScreen(<HomeConsoleLayout />);
}

async function renderColumn(pathname: string, serverId: string): Promise<RenderScreenResult> {
    route.pathname = pathname;
    const { HomeConsoleSidebar } = await import('./HomeConsoleNavigation');
    await resetEngine();
    return renderScreen(<HomeConsoleSidebar serverId={serverId} />);
}

async function measure(screen: RenderScreenResult, width: number) {
    const container = screen.root.findAll((node) => (
        node.props.testID === 'settings-home-console-layout' && typeof node.props.onLayout === 'function'
    ))[0];
    if (!container) throw new Error('the console did not mount its split geometry');
    await act(async () => {
        (container.props.onLayout as (event: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 0, width, height: 800 } } });
    });
}

const ids = (screen: RenderScreenResult) => collectRenderedTestIds(screen.tree.toJSON());
const railRows = (screen: RenderScreenResult) => ids(screen)
    .filter((id) => id.startsWith('home-console-rail:'))
    .map((id) => id.slice('home-console-rail:'.length));

function selectedRailRows(screen: RenderScreenResult): string[] {
    return screen.root
        .findAll((node: ReactTestInstance) => typeof node.props.testID === 'string'
            && node.props.testID.startsWith('home-console-rail:')
            && node.props.selected === true)
        .map((node) => String(node.props.testID).slice('home-console-rail:'.length))
        .filter((id, index, all) => all.indexOf(id) === index);
}

beforeEach(async () => {
    const { resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
    resetHomeGovernanceSnapshotsForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
    windowState.width = 1440;
    windowState.height = 1000;
    navigation.push.mockReset();
    navigation.replace.mockReset();
    navigation.dismissTo.mockReset();
});

afterEach(() => {
    standardCleanup();
});

describe('Home console shell', () => {
    it('lists the console pages as a second sidebar in the settings navigation style, marking the open page', async () => {
        const home = await addHome();
        const screen = await renderColumn(`/settings/home/${home}/sign-in-providers/identity/provider-1`, home);

        await waitForHomeGovernance(() => expect(railRows(screen)).toEqual(OWNER_RAIL));
        // An identity provider belongs to Sign-in providers.
        expect(selectedRailRows(screen)).toEqual(['sign-in-providers']);

        await act(async () => screen.pressByTestId('home-console-rail:email'));
        expect(navigation.replace).toHaveBeenCalledWith(`/settings/home/${home}/email`);
        // The settings navigation stands beside it, so it has no way back of its own.
        expect(ids(screen)).not.toContain('home-console-rail-back');
        // Flat rows from the settings navigation's own row owner: no sheets behind its groups.
        const { CollectionNavigationRow } = await import('@/components/ui/lists/collection/CollectionList');
        const { ItemGroup } = await import('@/components/ui/lists/ItemGroup');
        const ofType = (type: unknown) => screen.root.findAll((node) => (
            node.type === type || node.type === (type as { type?: unknown }).type
        ));
        expect(ofType(CollectionNavigationRow)).toHaveLength(OWNER_RAIL.length);
        expect(ofType(ItemGroup)).toHaveLength(0);
    });

    it('offers admin-readable Sign-in providers, and only Overview on a Home without an owner', async () => {
        const admin = await addHome(homeGovernanceProjectionFixture({
            viewer: { accountId: 'account-ada', homeRole: 'admin', status: 'active' },
            capabilities: {
                ...homeGovernanceProjectionFixture().capabilities,
                manageAuthentication: false,
                manageHomeSettings: false,
            },
        }));
        const adminColumn = await renderColumn(`/settings/home/${admin}`, admin);
        await waitForHomeGovernance(() => expect(railRows(adminColumn)).toContain('activity'));
        expect(railRows(adminColumn)).toContain('sign-in-providers');
        act(() => adminColumn.tree.unmount());

        await harness.reset();
        const unowned = await addHome(homeGovernanceProjectionFixture({ setupState: 'setup_required', activeOwnerCount: 0 }));
        const unownedColumn = await renderColumn(`/settings/home/${unowned}`, unowned);
        await waitForHomeGovernance(() => expect(ids(unownedColumn)).toContain('home-console-rail-role'));
        expect(railRows(unownedColumn)).toEqual(['overview']);
    });

    it("stands People's rail beside an open person, and no rail beside the other pages", async () => {
        const home = await addHome();
        const page = await renderConsole(`/settings/home/${home}/reach`);
        await measure(page, MID_PANE_PX);
        await waitForHomeGovernance(() => expect(ids(page)).toContain('settings-home-console-detail-pane'));
        expect(ids(page)).not.toContain('home-people-rail');
        act(() => page.tree.unmount());

        const person = await renderConsole(`/settings/home/${home}/people/account-ada`);
        await measure(person, MID_PANE_PX);
        await waitForHomeGovernance(() => expect(ids(person)).toContain('home-people-rail'));
    });

    it('stands the console sidebar beside the page from 1280px and folds it into a header menu below', async () => {
        const home = await addHome();
        const wide = await renderConsole(`/settings/home/${home}/reach`);
        await measure(wide, MID_PANE_PX);
        await waitForHomeGovernance(() => expect(ids(wide)).toContain('home-console-sidebar'));
        expect(ids(wide)).not.toContain('home-console-menu.trigger');
        act(() => wide.tree.unmount());

        windowState.width = 1100;
        const narrow = await renderConsole(`/settings/home/${home}/reach`);
        await measure(narrow, MID_PANE_PX);
        await waitForHomeGovernance(() => expect(ids(narrow)).toContain('settings-home-console-detail-pane'));
        expect(ids(narrow)).not.toContain('home-console-sidebar');
    });

    it('offers the same pages, and the way back to all Homes, in the header menu', async () => {
        windowState.width = 1100;
        const home = await addHome();
        route.pathname = `/settings/home/${home}/features`;
        const { HomeConsoleShell } = await import('./HomeConsoleNavigation');
        const { HomeAdministrationSection } = await import('./HomeAdministrationSection');
        await resetEngine();
        const page = () => (
            <HomeConsoleShell serverId={home} rail="console">
                <HomeAdministrationSection serverId={home} title="Features">{() => null}</HomeAdministrationSection>
            </HomeConsoleShell>
        );
        const menuOf = (screen: RenderScreenResult) => screen.root.findAll((node) => (
            node.props.testID === 'home-console-menu' && Array.isArray(node.props.items)
        ))[0] ?? null;

        const hidden = await renderInCollectionLayout(page(), 'split');
        await waitForHomeGovernance(() => expect(menuOf(hidden)).not.toBeNull());
        const menu = menuOf(hidden)!;
        expect((menu.props.items as Array<{ id: string }>).map((item) => item.id)).toEqual([...OWNER_RAIL, 'all-homes']);
        expect(menu.props.selectedId).toBe('features');
        await act(async () => (menu.props.onSelect as (id: string) => void)('email'));
        expect(navigation.replace).toHaveBeenCalledWith(`/settings/home/${home}/email`);
        await act(async () => (menuOf(hidden)!.props.onSelect as (id: string) => void)('all-homes'));
        expect(navigation.dismissTo).toHaveBeenCalledWith('/settings/home');
        act(() => hidden.tree.unmount());

        // From 1280px the console's sidebar holds the pages: no menu above the page.
        windowState.width = 1440;
        const wide = await renderInCollectionLayout(page(), 'split');
        await waitForHomeGovernance(() => expect(ids(wide)).toContain('home-admin-page-header'));
        expect(menuOf(wide)).toBeNull();
    });

    it('lists the pages on the phone Overview and pushes each one, with no header menu', async () => {
        windowState.width = 390;
        windowState.height = 844;
        const home = await addHome();
        route.pathname = `/settings/home/${home}`;
        const { HomeConsoleShell } = await import('./HomeConsoleNavigation');
        const { HomeAdministrationOverviewScreen } = await import('./HomeAdministrationOverviewScreen');
        await resetEngine();
        const screen = await renderInCollectionLayout(
            <HomeConsoleShell serverId={home} rail="console"><HomeAdministrationOverviewScreen serverId={home} /></HomeConsoleShell>,
            'stacked',
        );

        await waitForHomeGovernance(() => expect(ids(screen)).toContain('home-admin-server-settings-link'));
        expect(ids(screen).filter((id) => /^home-admin-[a-z-]+-link$/.test(id)))
            .toEqual(OWNER_RAIL.filter((id) => id !== 'overview').map((id) => `home-admin-${id}-link`));
        expect(ids(screen)).not.toContain('home-console-menu.trigger');
        await act(async () => screen.pressByTestId('home-admin-server-settings-link'));
        expect(navigation.push).toHaveBeenCalledWith(`/settings/home/${home}/server-settings`);
    });
});
