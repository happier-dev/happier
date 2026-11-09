import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';
import { resolveProjectPageCatalogState } from '@/components/projects/detail/projectPageCatalog';
import { createPluginPagePlacementFixture } from '@/dev/testkit/fixtures/pluginPageProjectionFixture';
import { storage } from '@/sync/domains/state/storageStore';
import { invokeScopeAction } from '@/sync/ops/actions/scopeActionFamily';
import { usePresentedDetailNavigation } from './usePresentedDetailNavigation';
import type { DetailPageNavigationItem, ProjectDetailNavigationItem } from './detailNavigationItems';

installUiListsCommonModuleMocks();
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
const initial = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(initial, true); });

const companionId = (item: DetailPageNavigationItem) => item.navigation.kind === 'page' ? item.id : item.navigation.companion;

async function mount(items: readonly ProjectDetailNavigationItem[], effects: string[], activeTab = 'overview', activePage = 'overview') {
    let navigation: ReturnType<typeof usePresentedDetailNavigation>;
    const companions = items.flatMap(item => item.companion ? [{ ...item,
        defaultPlacement: item.companion.defaultPlacement, allowedPlacements: item.companion.allowedPlacements }] : []);
    function Fixture(props: { phone: boolean }) {
        navigation = usePresentedDetailNavigation({ pageKind: 'project', identity: 'checkout', scope: null,
            items, activeId: activePage, phone: props.phone, presented: false,
            selectPage: id => effects.push(`page:${id}`),
            columnState: column => ({ visible: true, activeTab: column === 'main' ? activeTab : undefined, setVisible: () => {} }),
            companion: { items: companions, idForItem: companionId, activeId: null,
                select: id => effects.push(`pane:${id}`), close: () => {} } });
        return null;
    }
    const screen = await renderScreen(<Fixture phone={false} />);
    return { get navigation() { return navigation!; }, phone: (phone: boolean) => screen.update(<Fixture phone={phone} />) };
}

it('keeps Project Changes/Git Action addresses and reacts to independent phone and desktop preferences', async () => {
    const { items } = resolveProjectPageCatalogState({ target: { kind: 'project', workspaceRefId: 'checkout', serverId: 'home' } });
    storage.setState(state => ({ localSettings: { ...state.localSettings, navigationSurfacePlacementsV1: {
        projectTabBar: { orderedIds: [], placements: { changes: 'hidden' } },
        workspaceRail: { orderedIds: [], placements: { git: 'pinned' } },
        detailPages: { project: { phone: { items: { orderedIds: [], placements: { changes: 'overflow' } } } } },
    } } }));
    const effects: string[] = [];
    const fixture = await mount(items, effects);
    const read = (column: 'main' | 'side') => invokeScopeAction('shell.column.get', { column }, undefined,
        { kind: 'shell.column', column, read: () => fixture.navigation.readColumn(column) });
    expect(await read('main')).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: 'changes', placement: 'hidden' })]) });
    expect(await read('side')).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: 'git', placement: 'pinned' })]) });
    for (const column of ['main', 'side'] as const) {
        await invokeScopeAction('shell.column.set', { column, visible: true, tab: column === 'main' ? 'changes' : 'git' }, undefined,
            { kind: 'shell.column', column, read: () => fixture.navigation.readColumn(column) });
    }
    expect(effects).toEqual(['page:changes', 'pane:git']);
    await fixture.phone(true);
    expect(await read('side')).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: 'git', placement: 'overflow' })]) });
    await act(async () => storage.setState(state => ({ localSettings: { ...state.localSettings, navigationSurfacePlacementsV1: {
        ...state.localSettings.navigationSurfacePlacementsV1,
        projectTabBar: { orderedIds: [], placements: { changes: 'pinned' } },
        detailPages: { project: { phone: { items: { orderedIds: [], placements: { changes: 'hidden' } } } } },
    } } })));
    expect(await read('side')).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: 'git', placement: 'hidden' })]) });
    await fixture.phone(false);
    expect(await read('main')).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: 'changes', placement: 'pinned' })]) });
});

it.each([['overview', 'git'], ['services', 'browser']])('returns to retained Project %s from %s through the main Action', async (page, surface) => {
    const { items } = resolveProjectPageCatalogState({ target: { kind: 'project', workspaceRefId: 'checkout', serverId: 'home' } });
    const effects: string[] = [];
    const fixture = await mount(items, effects, surface, page);
    await fixture.phone(true);
    await invokeScopeAction('shell.column.set', { column: 'main', visible: true, tab: page }, undefined,
        { kind: 'shell.column', column: 'main', read: () => fixture.navigation.readColumn('main') });
    expect(effects).toEqual([`page:${page}`]);
});

it('keeps an admitted disabled Project page unavailable to Actions', async () => {
    const placement = createPluginPagePlacementFixture({ pluginId: 'acme.tools', localId: 'builds', title: 'Builds' });
    const { items } = resolveProjectPageCatalogState({ target: { kind: 'project', workspaceRefId: 'checkout', serverId: 'home' },
        placements: [{ ...placement, availability: { state: 'disabled', reason: 'plugin_disabled', diagnostics: [] } }] });
    const effects: string[] = [];
    const fixture = await mount(items, effects);
    expect(await invokeScopeAction('shell.column.set', { column: 'main', visible: true, tab: 'plugin:acme.tools:builds' }, undefined,
        { kind: 'shell.column', column: 'main', read: () => fixture.navigation.readColumn('main') }))
        .toMatchObject({ ok: false, errorCode: 'client_control_unavailable' });
    expect(effects).toEqual([]);
});
