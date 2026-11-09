import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { RenderWithAppProvidersOptions } from '@/dev/testkit/render/renderWithAppProviders';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import type { SplitCanvasHostControls } from '../../splitCanvas/components/SplitCanvasHost';
import { WorkspaceNavigationProvider, type WorkspaceNavigationContextValue } from '../WorkspaceNavigationContext';
import { WorkspaceShell } from '../WorkspaceShell';
import { createWorkspaceState, reduceWorkspaceState, type WorkspaceState, type WorkspaceTab } from '../workspaceState';
import { WorkspaceTitleBar } from './WorkspaceTitleBar';
import { createWorkspaceBarGeometry, WorkspaceBarGeometryContext } from './workspaceBarGeometry';
import { createWorkspaceNavigationAdapter } from '../workspaceNavigationAdapter';
import { createWorkspaceActionAdapter } from '../workspaceActions';
import { registerMountedWorkspaceAction } from '../workspaceActionRuntime';
import { AppShellMaterialFrame } from '@/components/navigation/shell/AppShellMaterialFrame';
import { AppShellTitleStrip } from '@/components/navigation/shell/appRail/AppShellTitleStrip';
import { invokeTestInstanceHandler } from '@/dev/testkit/render/renderScreen';
import { View } from 'react-native';
import { readHitFrameReach } from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';
import { DocumentTabStrip, type DocumentTabItem } from '@/components/ui/navigation/DocumentTabStrip';
import { WorkspaceGroupTabs } from './WorkspaceGroupTabs';
import { resolveCompactAppDestinations, resolveDestinationRefFromHref, type CompactAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import * as workspaceRoutes from '@/components/appShell/workspace/workspaceRoutes';
import { storage } from '@/sync/domains/state/storageStore';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

installPanelCommonModuleMocks();
// Recipient-envelope HTTP/process APIs are outside this deterministic workspace owner harness.
// Session list surfaces demand content from the sync singleton; the fixture settles that demand without a Home.
vi.mock('@/sync/sync', async () => ({ sync: (await import('@/dev/testkit/mocks/sync')).createSessionListHydrationSyncBoundary() }));
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unavailable = () => { throw new Error('Unexpected recipient-envelope API in workspace owner test'); };
    return { createSessionDataKeyEnvelopeClient: unavailable, readSessionDataKeyEnvelopeCollectionPage: unavailable,
        prepareSessionDataKeyEnvelopesForScope: unavailable, prepareSessionDataKeyEnvelopesDetached: unavailable };
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: false }).module;
});
// The popover's portal/measurement boundary renders open menus inline; the menus themselves are real.
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});

type WindowFrame = Readonly<{ x: number; width: number }>;
const EMPTY_CATALOG: readonly CompactAppDestination[] = [];

/** The platform's window measurement, per measured view (the only boundary between panes and the strip). */
function windowMeasurement(frames: Readonly<Record<string, WindowFrame>>): NonNullable<RenderWithAppProvidersOptions['createNodeMock']> {
    return element => {
        const frame = typeof element.props.testID === 'string' ? frames[element.props.testID] : undefined;
        return frame
            ? { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(frame.x, 0, frame.width, 800) }
            : null;
    };
}

function tab(id: string, overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
    return { id, target: { kind: `removed:${id}`, params: {} }, pinned: false, preview: false, ...overrides };
}

function Harness(props: Readonly<{ initial: WorkspaceState; clusterEndPx: number; trailingStartPx?: number; chromeActive?: boolean; phone?: boolean; tabsOnly?: boolean; catalog?: readonly CompactAppDestination[] }>) {
    const [state, dispatch] = React.useReducer(reduceWorkspaceState, props.initial);
    const canvasControlsRef = React.useRef<SplitCanvasHostControls | null>(null);
    const currentState = React.useRef(state);
    currentState.current = state;
    const navigation = React.useMemo(() => createWorkspaceNavigationAdapter({
        getState: () => currentState.current, getCatalog: () => EMPTY_CATALOG, dispatch,
        createId: () => 'empty', onChange: () => {}, transport: { commit: () => {} },
    }), []);
    React.useEffect(() => {
        const execute = createWorkspaceActionAdapter({ getState: () => currentState.current,
            navigation, readCanvas: () => canvasControlsRef.current, createId: () => 'empty' });
        return registerMountedWorkspaceAction(async request => execute(request.actionId, request.input));
    }, [navigation]);
    const [geometry] = React.useState(createWorkspaceBarGeometry);
    const value: WorkspaceNavigationContextValue = {
        active: true, state, dispatch, canvasControlsRef,
        phone: props.phone ? { catalog: EMPTY_CATALOG, onTab: false, openHref: () => false, activateTab: () => {}, closeTab: () => {} } : null,
        closeTab: (groupId, tabId) => dispatch({ type: 'closeTab', groupId, tabId, newTab: tab('empty', { target: { kind: 'newTab', params: {} } }) }),
        closeTabs: (groupId, tabIds) => {
            for (const tabId of tabIds) if (!state.tabs[tabId]?.pinned) dispatch({ type: 'closeTab', groupId, tabId, newTab: tab('empty', { target: { kind: 'newTab', params: {} } }) });
        },
        activateTab: (groupId, tabId) => dispatch({ type: 'activateTab', groupId, tabId }),
        canGoBack: false, canGoForward: false, openHref: () => false,
        navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
        registerBackStep: () => () => {}, back: () => {}, forward: () => {},
    };
    return <WorkspaceNavigationProvider value={value}>
        <WorkspaceBarGeometryContext.Provider value={geometry}>
            {React.createElement('WorkspaceStateProbe', { state, dispatch })}
            {props.tabsOnly ? <WorkspaceGroupTabs workspace={value} group={state.groups['group:1']} catalog={props.catalog ?? EMPTY_CATALOG}
                focused placement="bar" /> : props.chromeActive === undefined ? <>
                <WorkspaceTitleBar catalog={EMPTY_CATALOG} clusterEndPx={props.clusterEndPx} stripHeightPx={40} trailingStartPx={props.trailingStartPx} />
                <WorkspaceShell catalog={EMPTY_CATALOG} />
            </> : <AppShellMaterialFrame showChrome={props.chromeActive} dragEnabled={false} leftOffsetPx={0}
                sidebarWidth={320} rail={null} column={null} peek={null}
                titleStrip={<AppShellTitleStrip columnVisible={false} columnToggleAvailable={false}
                    onToggleColumn={() => {}} navigation={value} workspaceCatalog={EMPTY_CATALOG} trailing={<View />} />}>
                <WorkspaceShell catalog={EMPTY_CATALOG} />
            </AppShellMaterialFrame>}
        </WorkspaceBarGeometryContext.Provider>
    </WorkspaceNavigationProvider>;
}

function stateOf(screen: Awaited<ReturnType<typeof renderScreen>>): WorkspaceState {
    return screen.root.findByType('WorkspaceStateProbe' as unknown as React.ElementType).props.state;
}

function hasTestId(node: ReactTestInstance, testID: string): boolean {
    return node.findAll((candidate) => candidate.props?.testID === testID).length > 0;
}

/** Group 1 (a, b) | group 2 (c) over group 3 (d): two top-row panes and one below. */
function threePanes(): WorkspaceState {
    let state = reduceWorkspaceState(createWorkspaceState(tab('a')), { type: 'openTab', groupId: 'group:1', tab: tab('b') });
    state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('c') });
    state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('d') });
    state = reduceWorkspaceState(state, { type: 'splitTab', tabId: 'c', sourceGroupId: 'group:1', targetGroupId: 'group:1',
        newGroupId: 'group:2', axis: 'row', placement: 'after', availableSizePx: 1200, minimumFirstSizePx: 420, minimumSecondSizePx: 420 });
    state = reduceWorkspaceState(state, { type: 'splitTab', tabId: 'd', sourceGroupId: 'group:1', targetGroupId: 'group:2',
        newGroupId: 'group:3', axis: 'column', placement: 'after', availableSizePx: 800, minimumFirstSizePx: 200, minimumSecondSizePx: 200 });
    return reduceWorkspaceState(state, { type: 'activateTab', groupId: 'group:1', tabId: 'a' });
}

describe('WorkspaceTitleBar', () => {
    it('resolves only the arriving route at 153 tabs and does no route work on a real Machine arrival', async () => {
        const original = storage.getState();
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
        const target = resolveDestinationRefFromHref(catalog, '/settings/appearance')!;
        const makeTab = (index: number) => tab(`route-${index}`, { target });
        let initial = createWorkspaceState(makeTab(0));
        for (let index = 1; index < 153; index++) initial = reduceWorkspaceState(initial, {
            type: 'openTab', groupId: 'group:1', tab: makeTab(index), fallbackTitle: `Saved ${index}`,
        });
        const routes = vi.spyOn(workspaceRoutes, 'matchWorkspaceDestinationRoute');
        const screen = await renderScreen(<Harness initial={initial} clusterEndPx={200} tabsOnly catalog={catalog} />);
        try {
            const routesPerTab = Math.ceil(routes.mock.calls.length / 153);
            expect(routesPerTab).toBeGreaterThan(0);
            routes.mockClear();
            await act(async () => storage.getState().applyMachines([createMachineFixture({ id: 'workspace-strip-background' })]));
            expect(routes).not.toHaveBeenCalled();
            await act(async () => screen.root.findByType('WorkspaceStateProbe' as unknown as React.ElementType).props.dispatch({
                type: 'openTab', groupId: 'group:1', tab: makeTab(153), fallbackTitle: 'Arriving tab',
            }));
            expect(routes.mock.calls.length).toBeLessThanOrEqual(routesPerTab);
            console.info('PERF-STRIP workspace route cost', { existingTabs: 153, arrivingRouteMatches: routes.mock.calls.length, routesPerTab });
            expect(screen.findHostByTestId('workspace-tab-route-153')?.props.accessibilityState.selected).toBe(true);
        } finally {
            await screen.unmount();
            routes.mockRestore();
            storage.setState(original, true);
        }
    });
    it('mounts no desktop strip tabs once the window narrows to the phone layout', async () => {
        let initial = createWorkspaceState(tab('document-0'));
        for (let index = 1; index < 30; index += 1) initial = reduceWorkspaceState(initial, {
            type: 'openTab', groupId: 'group:1', tab: tab(`document-${index}`), fallbackTitle: `Document ${index}`,
        });
        const frames = windowMeasurement({ 'workspace-title-bar': { x: 0, width: 1440 },
            'workspace-group-group_1': { x: 300, width: 1100 } });
        const screen = await renderScreen(<Harness initial={initial} clusterEndPx={200} />, { createNodeMock: frames });
        try {
            const stripTabs = () => screen.root.findAll(node => typeof node.type === 'function' && node.type.name === 'DocumentBarTabRow').length;
            expect(stripTabs()).toBeGreaterThan(0);
            await screen.update(<Harness initial={initial} clusterEndPx={200} phone />);
            expect(stripTabs()).toBe(0);
        } finally {
            await screen.unmount();
        }
    });
    it('changes only the affected document descriptor across a 120-tab title, pin and selection publication', async () => {
        let initial = createWorkspaceState(tab('document-0'));
        initial = reduceWorkspaceState(initial, { type: 'setFallbackTitle', tabId: 'document-0', title: 'Document 0' });
        for (let index = 1; index < 120; index += 1) initial = reduceWorkspaceState(initial, {
            type: 'openTab', groupId: 'group:1', tab: tab(`document-${index}`), fallbackTitle: `Document ${index}`,
        });
        const frames = windowMeasurement({ 'workspace-title-bar': { x: 0, width: 1440 },
            'workspace-group-group_1': { x: 300, width: 1100 } });
        const screen = await renderScreen(<Harness initial={initial} clusterEndPx={200} />, { createNodeMock: frames });
        // Renderer props are the boundary output of the actual descriptor producer, not a mocked projection.
        const rows = (): readonly DocumentTabItem[] => screen.root.findByType(DocumentTabStrip).props.tabs;
        const dispatch = async (action: Parameters<typeof reduceWorkspaceState>[1]) => act(async () => {
            screen.root.findByType('WorkspaceStateProbe' as unknown as React.ElementType).props.dispatch(action);
        });
        const changedKeys = (before: readonly DocumentTabItem[]) => rows()
            .filter((row, index) => row !== before[index]).map(row => row.key);
        try {
            const initialRows = rows();
            expect(initialRows).toHaveLength(120);
            expect(initialRows[37].title).toBe('Document 37');
            await dispatch({ type: 'setFallbackTitle', tabId: 'document-37', title: 'Release checklist' });
            expect(rows()[37].title).toBe('Release checklist');
            expect(changedKeys(initialRows)).toEqual(['document-37']);

            const titledRows = rows();
            await dispatch({ type: 'setPinned', tabId: 'document-47', pinned: true });
            expect(rows()[47].isPinned).toBe(true);
            expect(changedKeys(titledRows)).toEqual(['document-47']);

            const pinnedRows = rows();
            await dispatch({ type: 'activateTab', groupId: 'group:1', tabId: 'document-12' });
            expect(changedKeys(pinnedRows)).toEqual([]);
            expect(screen.findHostByTestId('workspace-tab-document-12')?.props.accessibilityState.selected).toBe(true);

            const selectedRows = rows();
            await screen.update(<Harness initial={initial} clusterEndPx={200} />);
            expect(changedKeys(selectedRows)).toEqual([]);
        } finally { await screen.unmount(); }
    });
    it('retains its document tabs when hidden strip measurements report zero width', async () => {
        const initial = createWorkspaceState(tab('kept'));
        const body = (chromeActive: boolean) => <Harness initial={initial} clusterEndPx={200} chromeActive={chromeActive} />;
        const screen = await renderScreen(body(true), { createNodeMock: windowMeasurement({
            'workspace-title-bar': { x: 0, width: 1440 },
            'workspace-group-group_1': { x: 300, width: 1100 },
        }) });
        const measure = async (width: number) => act(async () => {
            invokeTestInstanceHandler(screen.findHostByTestId('app-shell-title-strip')!, 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 0, width, height: 40 } },
            });
            invokeTestInstanceHandler(screen.findHostByTestId('app-shell-title-strip-trailing')!, 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 0, width: width === 0 ? 0 : 40, height: 40 } },
            });
        });
        try {
            await measure(1440);
            const document = screen.findHostByTestId('workspace-tab-kept');
            expect(document).not.toBeNull();
            await screen.update(body(false));
            await measure(0);
            expect(screen.findHostByTestId('workspace-tab-kept')).toBe(document);
            await screen.update(body(true));
            await measure(1440);
            expect(screen.findHostByTestId('workspace-tab-kept')).toBe(document);
        } finally {
            await screen.unmount();
        }
    });
    it('honors UI Require over a waiver before closing a tab, then closes when Require is removed', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const initialSettings = storage.getState().settings;
        const state = reduceWorkspaceState(createWorkspaceState(tab('keep')), { type: 'openTab', groupId: 'group:1', tab: tab('close') });
        const screen = await renderScreen(<Harness initial={state} clusterEndPx={200} />, {
            createNodeMock: windowMeasurement({ 'workspace-title-bar': { x: 0, width: 1440 }, 'workspace-group-group_1': { x: 300, width: 1100 } }),
        });
        try {
            storage.setState({ settings: { ...initialSettings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
                actions: { 'workspace.tabs.close': { approvalRequiredSurfaces: ['ui'] } },
                approvalWaivedSurfaces: { 'workspace.tabs.close': ['ui'] } }) } });
            await screen.pressByTestIdAsync('workspace-tab-close-close');
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
            expect(stateOf(screen).groups['group:1'].tabIds).toEqual(['keep', 'close']);
            storage.setState({ settings: { ...initialSettings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {},
                approvalWaivedSurfaces: { 'workspace.tabs.close': ['ui'] } }) } });
            await screen.pressByTestIdAsync('workspace-tab-close-close');
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
            expect(stateOf(screen).groups['group:1'].tabIds).toEqual(['keep']);
        } finally { storage.setState({ settings: initialSettings }); }
    });

    it('offers close left and close all through the existing tab menu and overflow while preserving pinned tabs', async () => {
        let state = createWorkspaceState(tab('pinned', { pinned: true }));
        for (const id of ['left', 'middle', 'right']) state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab(id) });
        const screen = await renderScreen(<Harness initial={state} clusterEndPx={200} />, {
            createNodeMock: windowMeasurement({ 'workspace-title-bar': { x: 0, width: 1440 }, 'workspace-group-group_1': { x: 300, width: 1100 } }),
        });
        const middle = screen.findAllByTestId('workspace-tab-middle').find(node => typeof node.props.onLongPress === 'function');
        await act(async () => { middle?.props.onLongPress({}); });
        await screen.pressByTestIdAsync('workspace-tab-menu-close-left');
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
        expect(stateOf(screen).groups['group:1'].tabIds).toEqual(['pinned', 'middle', 'right']);
        await screen.pressByTestIdAsync('workspace-overflow-group_1');
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
        await screen.pressByTestIdAsync('workspace-overflow-close-all');
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
        expect(stateOf(screen).groups['group:1'].tabIds).toEqual(['pinned']);
        expect(stateOf(screen).groups['group:1'].activeTabId).toBe('pinned');
    });

    it('reserves the measured trailing control span, including a resize that hides a covered pane', async () => {
        const frames = windowMeasurement({
            'workspace-title-bar': { x: 0, width: 1440 },
            'workspace-group-group_1': { x: 300, width: 560 },
            'workspace-group-group_2': { x: 870, width: 560 },
        });
        const screen = await renderScreen(<Harness initial={threePanes()} clusterEndPx={200} trailingStartPx={1200} />, { createNodeMock: frames });
        expect(screen.findByTestId('workspace-bar-segment-group:2')?.props.style)
            .toEqual(expect.arrayContaining([expect.objectContaining({ left: 870, width: 330 })]));
        await act(async () => { screen.tree.update(<Harness initial={threePanes()} clusterEndPx={200} trailingStartPx={850} />); });
        expect(screen.findByTestId('workspace-bar-segment-group:2')).toBeNull();
        expect(screen.findByTestId('workspace-bar-segment-group:1')?.props.style)
            .toEqual(expect.arrayContaining([expect.objectContaining({ left: 300, width: 550 })]));
    });
    it('offers recently closed tabs even when all open tabs fit and reopens the chosen tab', async () => {
        let state = createWorkspaceState(tab('a'));
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('b'), fallbackTitle: 'Closed document' });
        state = reduceWorkspaceState(state, { type: 'closeTab', groupId: 'group:1', tabId: 'b', newTab: tab('blank', { target: { kind: 'newTab', params: {} } }) });
        const screen = await renderScreen(<Harness initial={state} clusterEndPx={200} />, {
            createNodeMock: windowMeasurement({ 'workspace-title-bar': { x: 0, width: 1440 }, 'workspace-group-group_1': { x: 300, width: 1100 } }),
        });
        expect(screen.findByTestId('workspace-overflow-group_1')).not.toBeNull();
        await screen.pressByTestIdAsync('workspace-overflow-group_1');
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
        await screen.pressByTestIdAsync('workspace-reopen-tab-b');
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
        expect(stateOf(screen).groups['group:1'].activeTabId).toBe('b');
        expect(stateOf(screen).recentlyClosed).toEqual([]);
    });
    it('puts each top-row pane\'s tabs in the window strip over that pane and keeps a strip for a pane below', async () => {
        const screen = await renderScreen(<Harness initial={threePanes()} clusterEndPx={200} />, {
            createNodeMock: windowMeasurement({
                'workspace-title-bar': { x: 0, width: 1440 },
                'workspace-group-group_1': { x: 300, width: 560 },
                'workspace-group-group_2': { x: 870, width: 560 },
                'workspace-group-group_3': { x: 870, width: 560 },
            }),
        });
        const first = screen.findByTestId('workspace-bar-segment-group:1');
        const second = screen.findByTestId('workspace-bar-segment-group:2');
        expect(first && hasTestId(first, 'workspace-tab-a') && hasTestId(first, 'workspace-tab-b')).toBe(true);
        expect(second && hasTestId(second, 'workspace-tab-c')).toBe(true);
        expect(screen.findByTestId('workspace-bar-segment-group:3')).toBeNull();
        // Over its pane: the segment spans exactly the pane's measured span.
        expect(first?.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ left: 300, width: 560 })]));

        // The top-row panes keep no strip of their own; the pane below keeps one with its tabs.
        const top = screen.findByTestId('workspace-group-group_1');
        const below = screen.findByTestId('workspace-group-group_3');
        expect(top && hasTestId(top, 'workspace-tabs-group_1')).toBe(false);
        expect(below && hasTestId(below, 'workspace-tab-d')).toBe(true);

        // The focused pane's filled tab is the whole focus signal: panes draw no card, ring or controls of their own.
        expect(screen.root.findAll((node) => typeof node.props?.testID === 'string'
            && /^split-canvas-leaf-(maximize|close)-/.test(node.props.testID))).toHaveLength(0);

        // A tab in the strip is the pane's own tab: pressing it focuses that pane.
        await act(async () => { second?.findAll((node) => node.props?.testID === 'workspace-tab-c' && typeof node.props.onPress === 'function')[0]?.props.onPress(); });
        expect(stateOf(screen).focusedGroupId).toBe('group:2');
    });

    // The strip's controls sit 2 px (+ New tab, All tabs, Split) apart, with an 8 px spacer between New tab and All
    // tabs: a finger's hit areas split those gaps, so none of them overlaps the next.
    it('splits the gaps between the pane end controls instead of reaching into each other', async () => {
        const screen = await renderScreen(<HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
            <Harness initial={threePanes()} clusterEndPx={200} />
        </HappierUiPlatformProvider>, {
            createNodeMock: windowMeasurement({
                'workspace-title-bar': { x: 0, width: 1440 },
                'workspace-group-group_1': { x: 300, width: 560 },
                'workspace-group-group_2': { x: 870, width: 560 },
                'workspace-group-group_3': { x: 870, width: 560 },
            }),
        });
        const reachOf = (id: string) => readHitFrameReach(screen.findByTestId(id)!);
        expect([reachOf('workspace-new-tab-group_1')?.left, reachOf('workspace-new-tab-group_1')?.right]).toEqual([2, 6]);
        expect([reachOf('workspace-overflow-group_1')?.left, reachOf('workspace-overflow-group_1')?.right]).toEqual([6, 1]);
        expect(reachOf('workspace-split-right')?.left).toBe(1);
    });

    it('starts the first pane\'s tabs after the strip\'s own controls when the pane reaches under them', async () => {
        const screen = await renderScreen(<Harness initial={threePanes()} clusterEndPx={360} />, {
            createNodeMock: windowMeasurement({
                'workspace-title-bar': { x: 0, width: 1440 },
                'workspace-group-group_1': { x: 56, width: 804 },
                'workspace-group-group_2': { x: 870, width: 560 },
            }),
        });
        expect(screen.findByTestId('workspace-bar-segment-group:1')?.props.style)
            .toEqual(expect.arrayContaining([expect.objectContaining({ left: 372, width: 488 })]));
    });

    it('names a session tab after the session, live: renaming the session renames its tab', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const named = (text: string) => createSessionFixture({
            id: 'session-live',
            metadata: { path: '/Users/tester/project', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine-1',
                summary: { text, updatedAt: 1 } } as never,
        });
        act(() => { storage.getState().applySessions([named('Fix settings modal remount')]); });
        // The session tab stays unvisited, so only its title is in play (its body never mounts).
        const state = reduceWorkspaceState(createWorkspaceState(tab('s', { target: { kind: 'session', params: { id: 'session-live' } } })),
            { type: 'openTab', groupId: 'group:1', tab: tab('other') });
        const screen = await renderScreen(<Harness initial={state} clusterEndPx={200} />, {
            createNodeMock: windowMeasurement({ 'workspace-title-bar': { x: 0, width: 1440 }, 'workspace-group-group_1': { x: 300, width: 900 } }),
        });
        const segment = () => screen.findByTestId('workspace-bar-segment-group:1');
        const titles = () => (segment()?.findAll((node) => typeof node.props?.children === 'string').map((node) => node.props.children) ?? []);
        expect(titles()).toContain('Fix settings modal remount');

        await act(async () => { storage.getState().applySessions([named('Key the settings modal by route')]); });
        expect(titles()).toContain('Key the settings modal by route');
        expect(titles()).not.toContain('Fix settings modal remount');
    });

    it('keeps every tab in the scrolling strip and offers all tabs, recently closed, Close others and Close all from one trailing menu', async () => {
        const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
        let state = createWorkspaceState(tab('a', { pinned: true }));
        for (const id of ids.slice(1)) state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab(id) });
        state = reduceWorkspaceState(state, { type: 'activateTab', groupId: 'group:1', tabId: 'b' });
        const screen = await renderScreen(<Harness initial={state} clusterEndPx={200} />, {
            createNodeMock: windowMeasurement({ 'workspace-title-bar': { x: 0, width: 1440 }, 'workspace-group-group_1': { x: 300, width: 600 } }),
        });
        const visibleTabs = () => ids.filter((id) => screen.findAllByTestId(`workspace-tab-${id}`).length > 0);
        // A narrow pane never truncates the strip to a fit count: every tab stays reachable by scrolling.
        await act(async () => { screen.findByTestId('workspace-tabs-group_1')?.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 30 } } }); });
        expect(visibleTabs()).toEqual(ids);
        const menu = screen.findByTestId('workspace-overflow-group_1');
        expect(menu?.props.accessibilityLabel).toBe('workspaceBar.allTabs');

        // The one menu lists every tab of the pane; choosing one opens it.
        await screen.pressByTestIdAsync('workspace-overflow-group_1');
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
        expect(screen.findByTestId('workspace-overflow-close-left')).toBeNull();
        expect(screen.findByTestId('workspace-overflow-close-right')).toBeNull();
        expect(screen.findByTestId('workspace-overflow-close-all')).not.toBeNull();
        await screen.pressByTestIdAsync('workspace-overflow-tab-h');
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
        expect(stateOf(screen).groups['group:1'].activeTabId).toBe('h');

        // Close others, at the foot of the same menu, keeps the open tab and the pinned one.
        await screen.pressByTestIdAsync('workspace-overflow-group_1');
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
        await screen.pressByTestIdAsync('workspace-overflow-close-others');
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
        expect(stateOf(screen).groups['group:1'].tabIds).toEqual(['a', 'h']);
        expect(stateOf(screen).recentlyClosed.map(entry => entry.tab.id)).toEqual(ids.slice(1, -1).reverse());
        expect(screen.findByTestId('workspace-overflow-group_1')).not.toBeNull();
    });

    it('lists a pinned tab first in the all-tabs menu, as the strip shows it, and marks it pinned', async () => {
        let state = createWorkspaceState(tab('a'));
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('b') });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('c', { pinned: true }) });
        const screen = await renderScreen(<Harness initial={state} clusterEndPx={200} />, {
            createNodeMock: windowMeasurement({ 'workspace-title-bar': { x: 0, width: 1440 }, 'workspace-group-group_1': { x: 300, width: 600 } }),
        });
        await screen.pressByTestIdAsync('workspace-overflow-group_1');
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
        const order = [...new Set(screen.root
            .findAll((node) => typeof node.props?.testID === 'string' && /^workspace-overflow-tab-[abc]$/.test(node.props.testID))
            .map((node) => String(node.props.testID).slice(-1)))];
        expect(order).toEqual(['c', 'a', 'b']);
        expect(screen.findAllByTestId('workspace-overflow-pinned-c').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('workspace-overflow-pinned-a')).toHaveLength(0);
    });
});
