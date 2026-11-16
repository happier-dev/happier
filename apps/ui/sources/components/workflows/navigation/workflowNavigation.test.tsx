// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// Radix owns DOM portals; keep the real menu logic beneath its canonical SDK boundary.
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
// The host renderer cannot mount ReactDOM portals; preserve the real menu content inline.
vi.mock('@/utils/web/reactDomCjs', () => {
    const dom = { createPortal: (content: React.ReactNode) => content };
    return { requireReactDOM: () => dom, preloadReactDOM: async () => dom };
});
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const catalog = await import('@/components/appShell/rightSidebar/detailNavigationItems');
const { useWorkflowNavigation } = await import('./workflowNavigation');
const { PresentedDetailNavigationProvider } = await import('@/components/appShell/rightSidebar/usePresentedDetailNavigation');
const { useWorkflowCockpitBarPresentation, useWorkflowPageNavigationShown, WorkflowPageNavigation } = await import('./WorkflowNavigationViews');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { invokeScopeAction } = await import('@/sync/ops/actions/scopeActionFamily');

afterEach(() => { standardCleanup(); vi.restoreAllMocks(); });

it.each(['workflowEditor', 'workflowRun'] as const)('reserves the %s primary on desktop and phone against saved hidden/More placements', async pageKind => {
    const { resolveNavigationPlacements } = await import('@/sync/domains/settings/mobileSurfacePinning');
    const items = catalog.resolveDetailNavigationItems({ scope: pageKind });
    const primary = pageKind === 'workflowEditor' ? 'steps' : 'flow';
    for (const placement of ['hidden', 'overflow'] as const) {
        const preferences = { orderedIds: [], placements: { [primary]: placement } };
        for (const candidates of [items, items.map(catalog.resolveDetailPhoneNavigationItem)]) {
            expect(resolveNavigationPlacements(candidates, preferences).pinned.map(item => item.id)).toContain(primary);
        }
    }
});

it.each(['workflowEditor', 'workflowRun'] as const)('detail-navigation.%s resolves once; equal renders have no effects and Actions select the requested page', async pageKind => {
    const resolve = vi.spyOn(catalog, 'resolveDetailNavigationItems');
    const selectPage = vi.fn();
    const selectCompanion = vi.fn();
    const closeCompanion = vi.fn();
    let rerender = () => {};
    let model: ReturnType<typeof useWorkflowNavigation>['model'] | undefined;
    let presentation: ReturnType<typeof useWorkflowCockpitBarPresentation> | undefined;
    const activeId = pageKind === 'workflowEditor' ? 'steps' : 'flow';
    function Fixture() {
        const [, bump] = React.useReducer(n => n + 1, 0);
        rerender = bump;
        const navigation = useWorkflowNavigation({ pageKind, identity: 'one', scope: null, phone: true, presented: true,
            activeId, agentAvailable: pageKind === 'workflowEditor', selectPage, companion: pageKind === 'workflowEditor' ? { activeId: null, select: selectCompanion, close: closeCompanion } : undefined });
        model = navigation.model;
        presentation = useWorkflowCockpitBarPresentation({ model, onSelect: () => {} }, true);
        return <WorkflowPageNavigation navigation={navigation} phone onSelect={() => {}} testIDPrefix="workflow-pages" />;
    }
    const screen = await renderScreen(<PresentedDetailNavigationProvider><Fixture /></PresentedDetailNavigationProvider>);
    expect(resolve).toHaveBeenCalledTimes(1);
    const items = model!.items;
    const initialModel = model;
    await act(async () => rerender());
    expect(model).toBe(initialModel);
    expect(model!.items).toBe(items);
    await act(async () => storage.setState(state => ({ localSettings: { ...state.localSettings,
        navigationSurfacePlacementsV1: { pageTabs: { [pageKind]: 'top' }, detailPages: { [pageKind]: { phone: { items: {
            orderedIds: ['steps', 'flow'], placements: { steps: 'overflow' },
        } } } } },
    } })));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(presentation!.shown.every(item => item.navigation.kind === 'companion')).toBe(true);
    expect(presentation!.behindMore.some(item => item.id === 'steps')).toBe(pageKind === 'workflowRun');
    const read = await invokeScopeAction('shell.column.get', { column: 'main' });
    expect(read).toMatchObject({ activeTab: activeId, items: expect.arrayContaining([{ id: 'steps', label: expect.any(String), available: true, pageKind, placement: pageKind === 'workflowEditor' ? 'pinned' : 'overflow' }]) });
    await invokeScopeAction('shell.column.set', { column: 'main', visible: true, tab: activeId });
    // Selecting the retained page also returns from its companion (34ec23a793c).
    expect(selectPage).toHaveBeenCalledExactlyOnceWith(activeId);
    await invokeScopeAction('shell.column.set', { column: 'main', visible: true, tab: activeId === 'steps' ? 'flow' : 'steps' });
    expect(selectPage).toHaveBeenCalledTimes(2);
    expect(selectPage).toHaveBeenLastCalledWith(activeId === 'steps' ? 'flow' : 'steps');
    expect(selectCompanion).not.toHaveBeenCalled();
    expect(closeCompanion).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
    await screen.unmount();
});

it.each(['workflowEditor', 'workflowRun'] as const)('detail-navigation.%s floating and native menus share top-mode placement and exactly one Customize', async pageKind => {
    const selectPage = vi.fn();
    const selectCompanion = vi.fn();
    let floating: ReturnType<typeof useWorkflowCockpitBarPresentation> | undefined;
    let native: ReturnType<typeof useWorkflowCockpitBarPresentation> | undefined;
    storage.setState(state => ({ localSettings: { ...state.localSettings,
        navigationSurfacePlacementsV1: { pageTabs: { [pageKind]: 'top' }, detailPages: { [pageKind]: { phone: { items: {
            orderedIds: [], placements: { steps: 'overflow' },
        } } } } },
    } }));
    function Fixture() {
        const { model } = useWorkflowNavigation({ pageKind, identity: 'menu', scope: null, phone: true, presented: true,
            activeId: 'flow', agentAvailable: pageKind === 'workflowEditor', selectPage,
            companion: pageKind === 'workflowEditor' ? { activeId: null, select: selectCompanion, close: () => {} } : undefined });
        floating = useWorkflowCockpitBarPresentation({ model, onSelect: selectPage });
        native = useWorkflowCockpitBarPresentation({ model, onSelect: selectPage }, true);
        return <>{floating.menu}{native.menu}</>;
    }
    const screen = await renderScreen(<PresentedDetailNavigationProvider><Fixture /></PresentedDetailNavigationProvider>);
    expect(floating!.shown.map(item => item.id)).toEqual(native!.shown.map(item => item.id));
    expect(floating!.shown.every(item => item.navigation.kind === 'companion')).toBe(true);
    expect(floating!.behindMore.map(item => item.id)).toEqual(native!.behindMore.map(item => item.id));
    expect(floating!.behindMore.some(item => item.id === 'steps')).toBe(pageKind === 'workflowRun');
    const menus = screen.findAllByType(DropdownMenu);
    expect(menus).toHaveLength(2);
    for (const menu of menus) expect(menu.props.items.filter((item: { id: string }) => item.id === 'customize')).toHaveLength(1);
    await act(async () => { floating!.openMore(); native!.openMore(); });
    expect(screen.findAllByType(DropdownMenu).every(menu => menu.props.open === true)).toBe(true);
    expect(selectPage).not.toHaveBeenCalled();
    expect(selectCompanion).not.toHaveBeenCalled();
    await screen.unmount();
});

it('a retained mounted Action port reads the current controlled page after another selection', async () => {
    const select = vi.fn();
    let change: (id: string) => void = () => {};
    let model: ReturnType<typeof useWorkflowNavigation>['model'] | undefined;
    function Fixture() {
        const [activeId, setActiveId] = React.useState('steps');
        change = setActiveId;
        ({ model } = useWorkflowNavigation({ pageKind: 'workflowEditor', identity: 'retained', scope: null,
            phone: false, presented: true, activeId, selectPage: select }));
        return null;
    }
    const screen = await renderScreen(<PresentedDetailNavigationProvider><Fixture /></PresentedDetailNavigationProvider>);
    const retained = model!;
    await act(async () => change('flow'));
    expect(retained.readColumn('main').activeTab).toBe('flow');
    retained.readColumn('main').selectTab?.('steps');
    expect(select).toHaveBeenCalledExactlyOnceWith('steps');
    await screen.unmount();
});

it('keeps the desktop page tabs still while the page around them re-renders for an unrelated edit', async () => {
    const select = vi.fn();
    let rerender = () => {};
    function Fixture() {
        const [, bump] = React.useReducer(n => n + 1, 0);
        rerender = bump;
        // A Workflow name keystroke re-renders the editor page with the same navigation facts.
        const navigation = useWorkflowNavigation({ pageKind: 'workflowEditor', identity: 'rename', scope: null,
            phone: false, presented: true, activeId: 'steps', selectPage: select });
        return <WorkflowPageNavigation navigation={navigation} phone={false} onSelect={select} testIDPrefix="workflow-pages" />;
    }
    const screen = await renderScreen(<PresentedDetailNavigationProvider><Fixture /></PresentedDetailNavigationProvider>);
    // A host element keeps its props object only while nothing above it renders again.
    const tabProps = () => screen.findAll(node => typeof node.type === 'string'
        && String(node.props.testID ?? '').startsWith('workflow-pages')).map(node => node.props);
    const before = tabProps();
    expect(before.length).toBeGreaterThan(0);
    for (let index = 0; index < 3; index += 1) await act(async () => rerender());
    const after = tabProps();
    expect(after.filter((props, index) => props !== before[index])).toHaveLength(0);
    await screen.unmount();
});

it('offers the authoring agent as the editor\'s one companion; settings are a popover, never a sidebar (owner 2026-11-15)', async () => {
    const all = catalog.resolveDetailNavigationItems({ scope: 'workflowEditor', agentAvailable: true });
    // Steps is the page; Flow is both a page and a companion; the agent is a companion on the rail and in More.
    expect(all.find(item => item.id === 'flow')?.navigation.kind).toBe('both');
    expect(all.filter(item => item.navigation.kind === 'companion').map(item => item.id)).toEqual(['agent']);
    expect(all.filter(item => item.navigation.kind === 'companion').every(item => item.phonePlacement === 'more')).toBe(true);
    // A companion that cannot present is not offered (no authoring agent).
    const quiet = catalog.resolveDetailNavigationItems({ scope: 'workflowEditor' });
    // Steps, Flow and Sentence (round 1116c) are pages; nothing else without the agent.
    expect(quiet.map(item => item.id)).toEqual(['steps', 'flow', 'sentence']);
});

it('reports the page navigation as shown exactly when it draws something, so its row never keeps an empty band (QA-WAVE-1115)', async () => {
    storage.setState(state => ({ settings: { ...state.settings, mobileWorkspaceExperienceV1: 'cockpit' } }));
    let shown: boolean | undefined;
    function Fixture(props: Readonly<{ phone: boolean }>) {
        const navigation = useWorkflowNavigation({ pageKind: 'workflowEditor', identity: 'one', scope: null, phone: props.phone, presented: true,
            activeId: 'steps', agentAvailable: true, selectPage: () => {}, companion: { activeId: null, select: () => {}, close: () => {} } });
        shown = useWorkflowPageNavigationShown(navigation, props.phone);
        return <WorkflowPageNavigation navigation={navigation} phone={props.phone} onSelect={() => {}} testIDPrefix="workflow-pages" />;
    }
    const drawn = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.root.findAll(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('workflow-pages')).length > 0;
    // A cockpit phone keeps its pages in the bottom bar: nothing on top, and the row is told so.
    const phone = await renderScreen(<PresentedDetailNavigationProvider><Fixture phone /></PresentedDetailNavigationProvider>);
    expect(shown).toBe(false);
    expect(drawn(phone)).toBe(false);
    // Pages placed on top draw the strip, and the row is shown.
    await act(async () => storage.setState(state => ({ localSettings: { ...state.localSettings,
        navigationSurfacePlacementsV1: { pageTabs: { workflowEditor: 'top' } } } })));
    expect(shown).toBe(drawn(phone));
    await phone.unmount();
    // Wide: the page tabs draw whenever there is more than one page.
    const wide = await renderScreen(<PresentedDetailNavigationProvider><Fixture phone={false} /></PresentedDetailNavigationProvider>);
    expect(shown).toBe(true);
    expect(drawn(wide)).toBe(true);
    await wide.unmount();
});
