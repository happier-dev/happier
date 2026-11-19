// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { PluginUiPageNavigationV1 } from '@happier-dev/protocol/plugins/ui/pageNavigation';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
// ReactDOM portals are the renderer boundary; menu logic stays real.
vi.mock('@/utils/web/reactDomCjs', () => {
    const dom = { createPortal: (content: React.ReactNode) => content };
    return { requireReactDOM: () => dom, preloadReactDOM: async () => dom };
});
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { usePluginDetailNavigation } = await import('./pluginDetailNavigation');
const { PluginDetailNavigationRail } = await import('./PluginDetailNavigationViews');
const { RightSidebarActionRail } = await import('@/components/appShell/rightSidebar/RightSidebarActionRail');
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); });

it('keeps an open both companion and its saved placement while its active-page launcher disappears and returns', async () => {
    const descriptor: PluginUiPageNavigationV1 = { pageKind: { pluginId: 'acme.review', localId: 'detail' }, value: 'overview', items: [
        { value: 'overview', title: 'Overview', kind: 'page', phonePlacement: 'bar' },
        { value: 'notes', title: 'Notes', kind: 'both', companion: { pluginId: 'acme.review', localId: 'notes' }, phonePlacement: 'bar' },
    ] };
    const lifetime = {};
    let host!: ReturnType<typeof usePluginDetailNavigation>;
    let pane!: ReturnType<typeof useAppPaneScope>;
    function Fixture() {
        pane = useAppPaneScope('t-close-plugin');
        host = usePluginDetailNavigation({ identity: 'acme.review/detail', lifetime, scope: null, live: true, presented: true, title: 'Review' });
        return host.model ? <PluginDetailNavigationRail model={host.model} pane={pane} /> : null;
    }
    const screen = await renderScreen(<AppPaneProvider><Fixture /></AppPaneProvider>);
    await act(async () => { host.owner.setPageNavigation({ navigation: descriptor }); });
    const pageKind = host.model!.pageKind;
    await act(async () => { storage.setState(state => ({ localSettings: { ...state.localSettings,
        navigationSurfacePlacementsV1: { detailPages: { [pageKind]: { desktop: { companions: { orderedIds: ['notes'], placements: { notes: 'overflow' } } } } } },
    } })); });
    const preferences = storage.getState().localSettings.navigationSurfacePlacementsV1;
    const launchers = () => screen.findAllByType(RightSidebarActionRail)[0]!.props.actions.map((item: { id: string }) => item.id);
    expect(launchers()).toContain('notes');
    await act(async () => { pane.selectRightDestination({ kind: 'plugin', destination: { pluginId: 'acme.review', localId: 'notes' } }); });
    const opened = pane.scopeState!.right;
    expect(opened.isOpen).toBe(true);
    await act(async () => { host.owner.setPageNavigation({ navigation: { ...descriptor, value: 'notes' } }); });
    expect(launchers()).not.toContain('notes');
    expect(pane.scopeState!.right).toBe(opened);
    expect(host.model!.readColumn('side').tabs).toContain('notes');
    expect(host.model!.readColumn('side').items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'notes', placement: 'overflow' })]));
    expect(storage.getState().localSettings.navigationSurfacePlacementsV1).toBe(preferences);
    await act(async () => { host.owner.setPageNavigation({ navigation: descriptor }); });
    expect(launchers()).toContain('notes');
    expect(pane.scopeState!.right).toBe(opened);
    await screen.unmount();
});

it('opens a both companion with the page own launch input and publishes the page as its opener', async () => {
    const descriptor: PluginUiPageNavigationV1 = { pageKind: { pluginId: 'acme.review', localId: 'detail' }, value: 'overview', items: [
        { value: 'overview', title: 'Overview', kind: 'page', phonePlacement: 'bar' },
        { value: 'notes', title: 'Notes', kind: 'both', companion: { pluginId: 'acme.review', localId: 'notes' }, phonePlacement: 'bar' },
    ] };
    const opened: unknown[] = [];
    const lifetime = {};
    let host!: ReturnType<typeof usePluginDetailNavigation>;
    let setPage!: (page: Readonly<{ launchInput?: { reviewId: string }; subPath: string | null }>) => void;
    function Fixture() {
        const [page, update] = React.useState<Readonly<{ launchInput?: { reviewId: string }; subPath: string | null }>>(
            { launchInput: { reviewId: 'r-1' }, subPath: 'reviews/r-1' });
        setPage = update;
        host = usePluginDetailNavigation({ identity: 'acme.review/detail', lifetime, scope: null, live: true, presented: true,
            title: 'Review', surfaceInput: page,
            openSurface: request => { opened.push(request); return { ok: true }; } });
        return null;
    }
    const screen = await renderScreen(<AppPaneProvider><Fixture /></AppPaneProvider>);
    await act(async () => { host.owner.setPageNavigation({ navigation: descriptor }); });
    expect(host.model?.openedFrom).toEqual({ pageKind: { pluginId: 'acme.review', localId: 'detail' }, launchInput: { reviewId: 'r-1' }, subPath: 'reviews/r-1' });
    await act(async () => { host.readColumn('side').selectTab!('notes'); });
    // The page moved to another entity: the companion's opener follows the page as it is now.
    await act(async () => { setPage({ subPath: 'reviews/r-2' }); });
    expect(host.model?.openedFrom).toEqual({ pageKind: { pluginId: 'acme.review', localId: 'detail' }, subPath: 'reviews/r-2' });
    await act(async () => { host.readColumn('side').selectTab!('notes'); });
    expect(opened).toEqual([
        { destination: { pluginId: 'acme.review', localId: 'notes' }, input: { reviewId: 'r-1' } },
        { destination: { pluginId: 'acme.review', localId: 'notes' } },
    ]);
    await screen.unmount();
});

it('follows the mounted page’s private companion input without publishing it in navigation chrome', async () => {
    const descriptor: PluginUiPageNavigationV1 = { pageKind: { pluginId: 'acme.review', localId: 'detail' }, value: 'overview', items: [
        { value: 'overview', title: 'Overview', kind: 'page', phonePlacement: 'bar' },
        { value: 'notes', title: 'Notes', kind: 'both', companion: { pluginId: 'acme.review', localId: 'notes' }, phonePlacement: 'bar' },
    ] };
    const lifetime = {};
    const opened = vi.fn(() => ({ ok: true as const }));
    const surfaceInput = { subPath: 'reviews/r-1' };
    let host!: ReturnType<typeof usePluginDetailNavigation>;
    function Fixture() {
        host = usePluginDetailNavigation({ identity: 'acme.review/detail', lifetime, scope: null, live: true, presented: true,
            title: 'Review', surfaceInput, openSurface: opened });
        return null;
    }
    const screen = await renderScreen(<AppPaneProvider><Fixture /></AppPaneProvider>);
    const firstInput = { reviewId: 'r-1', connection: 'first' };
    const secondInput = { reviewId: 'r-1', connection: 'second' };
    await act(async () => { host.owner.setPageNavigation({ navigation: { ...descriptor, companionInput: firstInput } }); });
    expect(host.model?.openedFrom).toEqual({ pageKind: descriptor.pageKind, launchInput: firstInput, subPath: surfaceInput.subPath });
    const projection = host.projection;
    expect(projection).not.toHaveProperty('companionInput');
    await act(async () => { host.owner.setPageNavigation({ navigation: { ...descriptor, companionInput: secondInput } }); });
    expect(host.model?.openedFrom).toEqual({ pageKind: descriptor.pageKind, launchInput: secondInput, subPath: surfaceInput.subPath });
    expect(host.projection).toBe(projection);
    await act(async () => { host.readColumn('side').selectTab!('notes'); });
    expect(opened).toHaveBeenCalledWith({ destination: { pluginId: 'acme.review', localId: 'notes' }, input: secondInput });
    await act(async () => { host.owner.clear(); });
    expect(host.model?.openedFrom).toBeUndefined();
    await screen.unmount();
});
