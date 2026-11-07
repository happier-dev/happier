// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { DeploymentEnvironmentDestinationV1 } from '@happier-dev/deployments';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
// Test renderer has no ReactDOM portal target; keep the real menus and their content inline.
vi.mock('@/utils/web/reactDomCjs', () => {
    const dom = { createPortal: (content: React.ReactNode) => content };
    return { requireReactDOM: () => dom, preloadReactDOM: async () => dom };
});
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const catalog = await import('@/components/appShell/rightSidebar/detailNavigationItems');
const { useNavigationSurfacePlacement } = await import('@/components/ui/navigation/useNavigationSurfacePlacement');
const { navigationPlacementStorageBinding: binding } = await import('@/components/settings/appearance/navigationPlacementSettingBinding');
const { useEnvironmentNavigation } = await import('./environmentNavigation');
const { PresentedDetailNavigationProvider, usePresentedDetailNavigationChrome } = await import('@/components/appShell/rightSidebar/usePresentedDetailNavigation');
const { EnvironmentPageNavigation, useEnvironmentCockpitBarPresentation, environmentNavigationCustomizer } = await import('./EnvironmentNavigationViews');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { invokeScopeAction } = await import('@/sync/ops/actions/scopeActionFamily');
const { AppPaneScopeControls } = await import('@/components/appShell/panes/AppPaneScopeControls');
const { ProjectShellHeader } = await import('@/components/projects/shell/ProjectShellHeader');
const initial = storage.getState();
const scope = { serverId: 'home', accountId: 'qa-owner' };
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); storage.setState(initial, true); });

it('detail-navigation.T1/T3/T4 resolves once, commits an Environment edit once and leaves Project desktop idle', async () => {
    const resolve = vi.spyOn(catalog, 'resolveDetailNavigationItems');
    const project = { orderedIds: ['overview', 'changes'], placements: {} };
    storage.setState(state => ({ localSettings: { ...state.localSettings, navigationSurfacePlacementsV1: { projectTabBar: project } } }));
    let projectRenders = 0;
    function Project() { projectRenders++; useNavigationSurfacePlacement({ pageKind: 'project', device: 'desktop', section: 'pages' }); return null; }
    let bump = () => {};
    let model: ReturnType<typeof useEnvironmentNavigation>['model'] | undefined;
    let presentation: ReturnType<typeof useEnvironmentCockpitBarPresentation> | undefined;
    const navigate = vi.fn();
    function Environment() {
        const [, rerender] = React.useReducer(n => n + 1, 0);
        bump = rerender;
        const navigation = useEnvironmentNavigation({ scope, environmentId: 'staging', destination: { tab: 'variables', section: null },
            phone: true, presented: true, navigate });
        model = navigation.model;
        presentation = useEnvironmentCockpitBarPresentation({ model, onSelect: () => {} }, true);
        return <EnvironmentPageNavigation navigation={navigation} phone onSelect={() => {}} />;
    }
    const screen = await renderScreen(<PresentedDetailNavigationProvider><Project /><Environment /></PresentedDetailNavigationProvider>);
    expect(resolve).toHaveBeenCalledTimes(1);
    const items = model!.items;
    const originalModel = model;
    const projectBefore = projectRenders;
    await act(async () => bump());
    expect(model).toBe(originalModel);
    const patch = binding.parse({ pageTabs: { environment: 'top' }, detailPages: { environment: { phone: { items: {
        orderedIds: ['settings', 'overview', 'variables'], placements: { variables: 'overflow' },
    } } } } });
    expect(patch.success).toBe(true);
    if (!patch.success) throw new Error('Expected valid addressed placement');
    const write = vi.fn((delta: Partial<typeof initial.localSettings>) => storage.getState().applyLocalSettings(delta));
    await act(async () => binding.commit(storage.getState().localSettings, patch.value, write));
    await act(async () => binding.commit(storage.getState().localSettings, patch.value, write));
    expect(write).toHaveBeenCalledTimes(1);
    expect(projectRenders).toBe(projectBefore);
    expect(storage.getState().localSettings.navigationSurfacePlacementsV1.projectTabBar).toBe(project);
    expect(model!.items).toBe(items);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(presentation!.shown).toEqual([]);
    expect(presentation!.behindMore.map(item => item.id)).toContain('variables');
    expect(await invokeScopeAction('shell.column.get', { column: 'main' })).toMatchObject({ activeTab: 'variables',
        items: expect.arrayContaining([{ id: 'variables', label: expect.any(String), available: true, pageKind: 'environment', placement: 'overflow' }]) });
    expect(navigate).not.toHaveBeenCalled();
    await screen.unmount();
});

it('detail-navigation.T4 floating/native top mode share one More and Customize without selecting a page', async () => {
    storage.setState(state => ({ localSettings: { ...state.localSettings, navigationSurfacePlacementsV1: {
        pageTabs: { environment: 'top' }, detailPages: { environment: { phone: { items: { orderedIds: [], placements: { variables: 'overflow' } } } } },
    } } }));
    const select = vi.fn();
    let floating: ReturnType<typeof useEnvironmentCockpitBarPresentation> | undefined;
    let native: ReturnType<typeof useEnvironmentCockpitBarPresentation> | undefined;
    function Fixture() {
        const { model } = useEnvironmentNavigation({ scope, environmentId: 'staging', destination: { tab: 'settings', section: 'controller' },
            phone: true, presented: true, navigate: select });
        floating = useEnvironmentCockpitBarPresentation({ model, onSelect: select });
        native = useEnvironmentCockpitBarPresentation({ model, onSelect: select }, true);
        expect(environmentNavigationCustomizer(model, 'phone').desktop).toHaveLength(1);
        return <>{floating.menu}{native.menu}</>;
    }
    const screen = await renderScreen(<Fixture />);
    expect(floating!.shown).toEqual(native!.shown);
    expect(floating!.shown).toEqual([]);
    expect(floating!.behindMore.map(item => item.id)).toEqual(['variables']);
    expect(native!.behindMore.map(item => item.id)).toEqual(['variables']);
    const menus = screen.findAllByType(DropdownMenu);
    expect(menus).toHaveLength(2);
    for (const menu of menus) expect(menu.props.items.filter((item: { id: string }) => item.id === 'customize')).toHaveLength(1);
    await act(async () => { floating!.openMore(); native!.openMore(); });
    expect(select).not.toHaveBeenCalled();
    await screen.unmount();
});

it('detail-navigation.T4 Environment desktop stays idle during a phone placement edit', async () => {
    let commits = 0;
    function Fixture() {
        const navigation = useEnvironmentNavigation({ scope, environmentId: 'staging', destination: { tab: 'variables', section: null },
            phone: false, presented: true, navigate: () => {} });
        return <React.Profiler id="environment-desktop" onRender={() => commits++}>
            <EnvironmentPageNavigation navigation={navigation} phone={false} onSelect={() => {}} />
        </React.Profiler>;
    }
    const screen = await renderScreen(<Fixture />);
    const before = commits;
    expect(before).toBeGreaterThan(0);
    await act(async () => storage.getState().applyLocalSettings({ navigationSurfacePlacementsV1: {
        detailPages: { environment: { phone: { items: { orderedIds: [], placements: { variables: 'overflow' } } } } },
    } }));
    expect(commits).toBe(before);
    await screen.unmount();
});

it('retains current route/Settings section at a retained Action port and withdraws hidden nested chrome', async () => {
    let change: (destination: DeploymentEnvironmentDestinationV1) => void = () => {};
    let show: (value: boolean) => void = () => {};
    let model: ReturnType<typeof useEnvironmentNavigation>['model'] | undefined;
    let published: ReturnType<typeof usePresentedDetailNavigationChrome> = null;
    const select = vi.fn();
    function Observer() { published = usePresentedDetailNavigationChrome(); return null; }
    function Fixture() {
        const [destination, setDestination] = React.useState<DeploymentEnvironmentDestinationV1>({ tab: 'variables', section: null });
        const [presented, setPresented] = React.useState(true);
        change = setDestination; show = setPresented;
        ({ model } = useEnvironmentNavigation({ scope, environmentId: 'staging', destination, phone: true, presented, navigate: select }));
        return null;
    }
    const screen = await renderScreen(<PresentedDetailNavigationProvider><Fixture /><Observer /></PresentedDetailNavigationProvider>);
    const retained = model!;
    expect(published).toMatchObject({ activeId: 'variables' });
    await act(async () => change({ tab: 'settings', section: 'controller' }));
    expect(retained.readColumn('main').activeTab).toBe('settings');
    retained.readColumn('main').selectTab?.('settings');
    expect(select).not.toHaveBeenCalled();
    retained.readColumn('main').selectTab?.('variables');
    expect(select).toHaveBeenCalledExactlyOnceWith({ tab: 'variables', section: null });
    select.mockClear();
    retained.readColumn('main', 'backups').selectTab?.('settings');
    expect(select).toHaveBeenCalledExactlyOnceWith({ tab: 'settings', section: 'backups' });
    await act(async () => show(false));
    expect(published).toBeNull();
    await act(async () => show(true));
    expect(published).toMatchObject({ activeId: 'settings' });
    await screen.unmount();
});

it('nested Environment owns desktop column Actions and leaving restores its enclosing Project', async () => {
    let show: (value: boolean) => void = () => {};
    const projectActions = { current: { tabs: [], selectTab: () => {}, main: {
        tabs: ['project-overview'], activeTab: 'project-overview', selectTab: () => {},
    } } };
    function Environment() {
        useEnvironmentNavigation({ scope, environmentId: 'staging', destination: { tab: 'variables', section: null },
            phone: false, presented: true, navigate: () => {} });
        return null;
    }
    function Fixture() {
        const [shown, setShown] = React.useState(true);
        show = setShown;
        return <AppPaneScopeControls scopeId="project" focused rightOpen={false} detailsOpen={false}
            sideAvailable={false} arrangementHonoured={false} setHidden={() => {}} setSideVisible={() => {}} sideActions={projectActions}>
            <ProjectShellHeader projectName="Project" checkout={null}
                pages={[{ id: 'overview', title: 'Overview', icon: 'folder', disabledReason: null }]}
                activePage="overview" onSelectPage={() => {}} onNewSession={null} menuActions={[]} />
            {shown ? <Environment /> : null}
        </AppPaneScopeControls>;
    }
    const screen = await renderScreen(<PresentedDetailNavigationProvider><Fixture /></PresentedDetailNavigationProvider>);
    expect(await invokeScopeAction('shell.column.get', { column: 'main' })).toMatchObject({ activeTab: 'variables' });
    expect(screen.findByTestId('project-shell-header')).not.toBeNull();
    expect(screen.findByTestId('project-shell-header.pages:overview')).toBeNull();
    await act(async () => show(false));
    expect(await invokeScopeAction('shell.column.get', { column: 'main' })).toMatchObject({ activeTab: 'project-overview' });
    expect(screen.findByTestId('project-shell-header.pages:overview')).not.toBeNull();
    await screen.unmount();
});

it('detail-navigation.T2 a declared Environment companion is one side item: it opens and closes beside the page, never as a page', async () => {
    let navigation: ReturnType<typeof useEnvironmentNavigation> | undefined;
    let published: ReturnType<typeof usePresentedDetailNavigationChrome> = null;
    const navigate = vi.fn();
    function Observer() { published = usePresentedDetailNavigationChrome(); return null; }
    function Environment(props: Readonly<{ phone: boolean }>) {
        navigation = useEnvironmentNavigation({ scope, environmentId: 'staging', destination: { tab: 'overview', section: null },
            phone: props.phone, presented: true, navigate, companions: ['logs'] });
        return <EnvironmentPageNavigation navigation={navigation} phone={props.phone} onSelect={() => {}} />;
    }
    const screen = await renderScreen(<PresentedDetailNavigationProvider><Environment phone={false} /><Observer /></PresentedDetailNavigationProvider>);
    expect(navigation!.model.items.find(item => item.id === 'logs')).toMatchObject({ navigation: { kind: 'companion', companion: 'logs' }, phonePlacement: 'more' });
    expect(published!.companionItems.map(item => item.id)).toEqual(['logs']);
    expect(screen.findByTestId('project-deployments.environment.tab:logs')).toBeNull();
    expect(navigation!.companion.activeId).toBeNull();
    expect(await invokeScopeAction('shell.column.get', { column: 'side' })).toMatchObject({ present: true, visible: false,
        items: [expect.objectContaining({ id: 'logs', pageKind: 'environment' })] });
    await act(async () => { await invokeScopeAction('shell.column.set', { column: 'side', visible: true, tab: 'logs' }); });
    expect(navigation!.companion.activeId).toBe('logs');
    expect(navigate).not.toHaveBeenCalled();
    expect(await invokeScopeAction('shell.column.get', { column: 'side' })).toMatchObject({ visible: true, activeTab: 'logs' });
    await act(async () => navigation!.companion.close());
    expect(navigation!.companion.activeId).toBeNull();
    await act(async () => navigation!.companion.open('logs'));
    expect(navigation!.companion.activeId).toBe('logs');
    await screen.unmount();
});
