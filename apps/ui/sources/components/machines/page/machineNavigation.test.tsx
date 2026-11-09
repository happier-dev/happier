// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const catalog = await import('@/components/appShell/rightSidebar/detailNavigationItems');
const { useMachinePageNavigation } = await import('./machineNavigation');
const { PresentedDetailNavigationProvider } = await import('@/components/appShell/rightSidebar/usePresentedDetailNavigation');
const { useMachineCockpitBarPresentation } = await import('@/components/navigation/mobile/chrome/bars/MachineCockpitTabBar');
const { MachinePhonePageStrip } = await import('./MachinePhonePageStrip');
const { invokeScopeAction } = await import('@/sync/ops/actions/scopeActionFamily');
import type { MachinePageTabEntry } from './machinePageTabs';

beforeEach(() => { installReactDomPortalBoundaryForTests(); });
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); });

const tabs: readonly MachinePageTabEntry[] = [
    { id: 'overview', label: 'Overview', Body: () => null, parseParams: () => ({ id: 'overview' }) },
    { id: 'storage', label: 'Storage', Body: () => null, parseParams: () => ({ id: 'storage' }) },
    { id: 'plugin', key: 'plugin:["acme.tools","storage"]', label: 'Plugin storage', Body: () => null,
        parseParams: () => ({ id: 'plugin', pluginId: 'acme.tools', localId: 'storage' }) },
];

it('detail-navigation.Machine: resolves once per changed catalog input and lends the same list to phone/native placement', async () => {
    // Call-through instrumentation measures the real canonical owner, never substitutes its decision.
    const resolve = vi.spyOn(catalog, 'resolveDetailNavigationItems');
    let rerender = () => {};
    let changeCatalog = () => {};
    let presentation: ReturnType<typeof useMachineCockpitBarPresentation> | undefined;
    let model: ReturnType<typeof useMachinePageNavigation>['model'] | undefined;
    const selectTab = vi.fn();
    function Fixture() {
        const [, bump] = React.useReducer(n => n + 1, 0);
        const [entries, setEntries] = React.useState(tabs);
        rerender = bump;
        changeCatalog = () => setEntries([...tabs, { id: 'guard', label: 'Guard', Body: () => null, parseParams: () => ({ id: 'guard' }) }]);
        const navigation = useMachinePageNavigation({ serverId: 'home', machineId: 'stopped', scope: null,
            tabs: entries, activeId: 'storage', phone: true, presented: true, selectTab });
        model = navigation.model;
        presentation = useMachineCockpitBarPresentation({ machineId: 'stopped', items: model.items,
            activeId: model.activeId, onSelect: () => {} }, true);
        return <MachinePhonePageStrip model={model} onSelect={() => {}} />;
    }
    const screen = await renderScreen(<PresentedDetailNavigationProvider><Fixture /></PresentedDetailNavigationProvider>);
    expect(model!.readColumn('main').openNavigationCustomizer).toBeTypeOf('function');
    expect(resolve).toHaveBeenCalledTimes(1);
    const items = model!.items;
    await act(async () => rerender());
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(model!.items).toBe(items);
    expect(presentation!.shown.map(item => item.id)).toEqual(tabs.map(tab => tab.key ?? tab.id));
    await act(async () => storage.setState(state => ({ localSettings: { ...state.localSettings,
        navigationSurfacePlacementsV1: { pageTabs: { machine: 'top' }, detailPages: { machine: { phone: { items: {
            orderedIds: ['storage', 'overview'], placements: { storage: 'overflow' },
        } } } } },
    } })));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(presentation!.shown).toEqual([]);
    expect(presentation!.behindMore.map(item => item.id)).toEqual(['storage']);
    expect(screen.findHostByTestId('machine-phone-page-strip')).not.toBeNull();
    expect((await invokeScopeAction('shell.column.get', { column: 'main' }))).toMatchObject({ activeTab: 'storage' });
    expect((await invokeScopeAction('shell.column.get', { column: 'side' }))).toMatchObject({ available: false });
    await invokeScopeAction('shell.column.set', { column: 'main', visible: true, tab: 'storage' });
    // Reselecting Storage keeps its nested route/scroll instead of replacing it with the tab root.
    expect(selectTab).not.toHaveBeenCalled();
    await invokeScopeAction('shell.column.set', { column: 'main', visible: true, tab: tabs[2]!.key! });
    expect(selectTab).toHaveBeenCalledExactlyOnceWith(tabs[2]!.key!);
    await act(async () => changeCatalog());
    expect(resolve).toHaveBeenCalledTimes(2);
});

it('keeps floating and native Machine presenters on the same preferences, qualified selection and single More in top mode', async () => {
    const { MachineCockpitTabBar } = await import('@/components/navigation/mobile/chrome/bars/MachineCockpitTabBar');
    const { CockpitTabBar } = await import('@/components/navigation/mobile/chrome/bars/CockpitTabBar');
    const { SystemMobileBottomChrome } = await import('@/components/navigation/mobile/chrome/SystemMobileBottomChrome');
    const { SystemTabBar } = await import('@/components/navigation/mobile/chrome/SystemTabBar');
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const pluginId = tabs[2]!.key!;
    storage.setState(state => ({ localSettings: { ...state.localSettings, navigationSurfacePlacementsV1: {
        detailPages: { machine: { phone: { items: { orderedIds: [pluginId, 'overview', 'storage'], placements: { storage: 'overflow' } } } } },
    } } }));
    const items = catalog.resolveDetailNavigationItems({ scope: 'machine', pages: tabs.map(tab => ({
        id: tab.key ?? tab.id, title: tab.label!, icon: 'desktop', disabledReason: null,
    })) });
    const onSelect = vi.fn();
    const props = { machineId: 'offline', items, activeId: 'storage', onSelect };
    const screen = await renderScreen(<><MachineCockpitTabBar {...props} />
        <SystemMobileBottomChrome model={{ kind: 'machineCockpit', props }} hidden={false} /></>);
    const native = screen.findByType(SystemTabBar);
    const floating = screen.findByType(CockpitTabBar);
    expect(native.props.items.map((item: { id: string }) => item.id)).toEqual([...floating.props.tabs.map((item: { id: string }) => item.id), 'more']);
    expect(native.props.selectedId).toBe('more');
    await act(async () => native.props.onPress(pluginId));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(pluginId);
    await act(async () => storage.setState(state => ({ localSettings: { ...state.localSettings,
        navigationSurfacePlacementsV1: { ...state.localSettings.navigationSurfacePlacementsV1, pageTabs: { machine: 'top' } },
    } })));
    expect(screen.findByType(CockpitTabBar).props.tabs).toEqual([]);
    expect(screen.findByType(SystemTabBar).props.items.map((item: { id: string }) => item.id)).toEqual(['more']);
    await act(async () => screen.findByType(SystemTabBar).props.onPress('more'));
    const menus = screen.findAllByType(DropdownMenu);
    expect(menus.filter(menu => menu.props.open)).toHaveLength(1);
    expect(menus.find(menu => menu.props.open)!.props.items.map((item: { id: string }) => item.id)).toEqual(['storage', 'customize']);
});
