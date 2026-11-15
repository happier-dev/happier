/** @vitest-environment jsdom */
import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderCommitCounter, createSessionListRenderableSessionFixture, flattenTestStyle, installBrowserStorageLockBoundary, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import type { HorizontalSafeArea } from '@/components/navigation/safeArea/horizontalSafeAreaGeometry';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { CompactAppDestination, DestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { createWorkspaceState, reduceWorkspaceState, type WorkspaceState } from './workspaceState';
import { registerWorkspaceRouteContext } from './workspaceRouteContext';

const route = vi.hoisted(() => ({ pathname: '/' }));

// Observe the React SDK boundary without replacing any shell, selector or title logic.
// A tab row has exactly one external-store hook, in useDocumentTabItem.
const tabStoreObserver = vi.hoisted(() => ({
    enabled: false,
    render: (_read: () => unknown) => {},
    commit: (_read: () => unknown) => {},
    read: (_read: () => unknown) => {},
    subscribe: (_read: () => unknown, _delta: number) => {},
}));
vi.mock('react', async importOriginal => {
    const actual = await importOriginal<typeof import('react')>();
    const sdk = actual;
    const useSyncExternalStore: typeof actual.useSyncExternalStore = (subscribe, read, serverRead) => {
        const tabRow = tabStoreObserver.enabled && new Error().stack?.includes('useDocumentTabItem') === true;
        const observed = sdk.useMemo(() => ({
            subscribe: (listener: () => void) => {
                if (tabRow) tabStoreObserver.subscribe(read, 1);
                const stop = subscribe(listener);
                return () => { stop(); if (tabRow) tabStoreObserver.subscribe(read, -1); };
            },
            read: () => { if (tabRow) tabStoreObserver.read(read); return read(); },
        }), [subscribe, read, tabRow]);
        if (tabRow) tabStoreObserver.render(read);
        sdk.useLayoutEffect(() => { if (tabRow) tabStoreObserver.commit(read); });
        return sdk.useSyncExternalStore(observed.subscribe, observed.read, serverRead);
    };
    return { ...actual, default: { ...sdk, useSyncExternalStore }, useSyncExternalStore };
});

installPanelCommonModuleMocks();
const { HorizontalSafeAreaProvider, ScreenSafeAreaFrame, useHorizontalSafeArea, useScreenSafeAreaBackdrop, useScreenSafeAreaBleed } =
    await import('@/components/navigation/safeArea/HorizontalSafeArea');
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => route.pathname, params: () => ({}) }).module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});
// Expo's module-loader boundary supplies stateful page bodies; the shell and sidebar stay real.
const routeModuleKeys = ['./(app)/index.tsx', './(app)/projects/[workspaceRefId]/index.tsx',
    './(app)/settings/appearance.tsx', './(app)/settings/connected-services/index.tsx',
    './(app)/machines/index.tsx', './(app)/settings/machines/index.tsx',
    './(app)/settings/machines/_layout.tsx', './(app)/settings/machines/presets/new.tsx',
    './(app)/settings/machines/presets/[presetId].tsx'];
registerWorkspaceRouteContext(Object.assign((key: string) => {
    if (!routeModuleKeys.includes(key)) throw new Error(`Unexpected shell route: ${key}`);
    if (key === './(app)/settings/machines/_layout.tsx') return import('@/app/(app)/settings/machines/_layout');
    if (key.endsWith('/machines/index.tsx')) return { WorkspaceRouteBody: PresetCollectionEntry };
    if (key.includes('/machines/presets/')) return { WorkspaceRouteBody: PresetRouteProbe };
    return { WorkspaceRouteBody: StatefulRouteBody };
}, { keys: () => routeModuleKeys }));

// The route-module boundary supplies fixture data, while the actual collection entries,
// destination router, workspace owner and Machines layout execute the navigation.
function PresetCollectionEntry() {
    const serverId = production[7].storage.getState().profileScope!.serverId;
    return <MachinePresetCollectionSectionView rail selectedKey={null} replacing={false} query=""
        section={{ key: 'presets', serverId, title: null, status: 'idle', rows: [{ kind: 'preset',
            presetId: 'build', serverId, title: 'Build recipe', audience: 'You', preset: {
                id: 'build', homeId: serverId, revision: 1, name: 'Build recipe', owner: { kind: 'account', accountId: 'alice' },
                controller: { machineId: 'builder', installationId: 'builder-installation' },
                launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Build box', choices: {} },
            },
        }] }} />;
}
function PresetRouteProbe() { return React.createElement('PresetRouteProbe', { door: useMachinesDoor() }); }

let nextBodyMount = 0;
let bodyUnmounts = 0;
const bodyRenders = new Map<string | null, number>();
function StatefulRouteBody() {
    const tabId = useDestinationInstanceKey();
    bodyRenders.set(tabId, (bodyRenders.get(tabId) ?? 0) + 1);
    const focused = useDestinationFocus();
    const windowEligible = usePluginSurfaceFocusEligibility();
    React.useEffect(() => () => { bodyUnmounts += 1; }, []);
    useScreenSafeAreaBackdrop(`tab-${tabId}`);
    const safeArea = useHorizontalSafeArea();
    const bleed = useScreenSafeAreaBleed();
    const [mount] = React.useState(() => ++nextBodyMount);
    const [draft, setDraft] = React.useState('');
    const [viewport, setViewport] = React.useState(0);
    return React.createElement('StatefulRouteBodyProbe', { tabId, mount, draft, viewport, setDraft, setViewport, safeArea, bleed, focused, windowEligible });
}
// Recipient-envelope HTTP/process APIs are outside this deterministic workspace owner harness.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unavailable = () => { throw new Error('Unexpected recipient-envelope API in workspace owner test'); };
    return { createSessionDataKeyEnvelopeClient: unavailable, readSessionDataKeyEnvelopeCollectionPage: unavailable,
        prepareSessionDataKeyEnvelopesForScope: unavailable, prepareSessionDataKeyEnvelopesDetached: unavailable };
});
// The popover's portal/measurement boundary renders the open tab menu inline; the menu itself is real.
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

const WINDOW_ID = 'main';
const loadProduction = () => Promise.all([
    import('./WorkspaceProvider'), import('./WorkspaceShell'), import('./DestinationInstanceHost'),
    import('../destinations/compactAppDestinationCatalog'), import('./workspacePersistence'),
    import('@/keyboard/KeyboardShortcutProvider'), import('@/sync/ops/actions/frontDoorRuntimeActionExecutor'),
    import('@/sync/domains/state/storage'), import('@/modal'),
    import('@/components/navigation/shell/appRail/useAppShellLocation'),
    import('@/components/settings/shell/SettingsSidebar'),
]);
let production!: Awaited<ReturnType<typeof loadProduction>>;
let MachinePresetCollectionSectionView!: (typeof import('@/components/settings/machines/collection/MachineCollectionList'))['MachinePresetCollectionSectionView'];
let useMachinesDoor!: (typeof import('@/components/machines/page/machinesDoor'))['useMachinesDoor'];
let DestinationInstanceHost!: (Awaited<ReturnType<typeof loadProduction>>)[2]['DestinationInstanceHost'];
let useDestinationInstanceKey!: (Awaited<ReturnType<typeof loadProduction>>)[2]['useDestinationInstanceKey'];
let useDestinationFocus!: (Awaited<ReturnType<typeof loadProduction>>)[2]['useDestinationFocus'];
let resolveDestinationRefFromHref!: (Awaited<ReturnType<typeof loadProduction>>)[3]['resolveDestinationRefFromHref'];
let fixture: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
let disconnect: (() => Promise<unknown>) | undefined;
let restoreLocks: (() => void) | undefined;
let baseline: ReturnType<(Awaited<ReturnType<typeof loadProduction>>)[7]['storage']['getState']> | undefined;

// Cold production-graph imports belong to collection, after transport boundaries
// are installed; individual lifecycle hooks should measure the actual journeys.
{
    restoreLocks = installBrowserStorageLockBoundary();
    installDisconnectedServerSocketBoundary();
    fixture = await serveActionHomes({ homes: [{ key: 'import', serverUrl: 'https://workspace-shell-import.test', accountId: 'alice', currentAccount: true }], route: () => undefined });
    disconnect = await fixture.restoreActiveConnection();
    production = await loadProduction();
    ({ MachinePresetCollectionSectionView } = await import('@/components/settings/machines/collection/MachineCollectionList'));
    ({ useMachinesDoor } = await import('@/components/machines/page/machinesDoor'));
    ({ DestinationInstanceHost, useDestinationInstanceKey, useDestinationFocus } = production[2]);
    ({ resolveDestinationRefFromHref } = production[3]);
    await disconnect(); disconnect = undefined;
    await fixture.dispose(); fixture = undefined;
    restoreLocks(); restoreLocks = undefined;
}
beforeEach(() => {
    route.pathname = '/';
    baseline = production[7].storage.getState();
    window.history.replaceState(null, '', '/');
    vi.mocked(production[8].Modal.alertAsync).mockClear();
});
afterEach(async () => {
    standardCleanup();
    try { await disconnect?.(); }
    finally {
        disconnect = undefined; await fixture?.dispose(); fixture = undefined;
        restoreLocks?.(); restoreLocks = undefined;
        if (baseline) production[7].storage.setState(baseline, true);
        vi.restoreAllMocks();
    }
});
afterAll(async () => { await disconnect?.(); await fixture?.dispose(); restoreLocks?.(); });

function ShellColumnProbe() {
    const { location } = production[9].useAppShellLocation();
    const collapsed = production[7].useLocalSetting('sidebarCollapsed');
    return React.createElement('ShellColumnProbe', { column: location.column, collapsed });
}

function Harness(props: Readonly<{ catalog: readonly CompactAppDestination[]; horizontalArea?: HorizontalSafeArea; sidebar?: boolean; presentation?: 'destination' }>) {
    const [{ WorkspaceProvider }, { WorkspaceShell }, , , , { KeyboardShortcutProvider }] = production;
    const { SettingsSidebar } = production[10];
    return <KeyboardShortcutProvider handlers={{}}><WorkspaceProvider enabled catalog={props.catalog}>{navigation => <>
        {React.createElement('WorkspaceStateProbe', { state: navigation.state, navigation })}
        <ShellColumnProbe />
        {props.sidebar ? <SettingsSidebar /> : null}
        <HorizontalSafeAreaProvider value={props.horizontalArea ?? { left: 0, right: 0, padded: false }}>
            <WorkspaceShell catalog={props.catalog} presentation={props.presentation} />
        </HorizontalSafeAreaProvider>
    </>}</WorkspaceProvider></KeyboardShortcutProvider>;
}

function initialState() {
    return reduceWorkspaceState(createWorkspaceState(restoredTab('a')),
        { type: 'openTab', groupId: 'group:1', tab: restoredTab('b', true) });
}

// Distinct canonical root-route anchors let initial URL admission restore the
// selected instance rather than open the separate Sessions-list preview at '/'.
function restoredTab(id: string, preview = false) {
    return { id, target: { kind: 'sessions', params: { anchor: id } }, pinned: false, preview };
}

function stateOf(screen: Awaited<ReturnType<typeof renderScreen>>): WorkspaceState {
    return screen.root.findByType('WorkspaceStateProbe').props.state;
}

async function measureContentSlots(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await act(async () => {
        for (const groupId of Object.keys(stateOf(screen).groups)) {
            screen.findByTestId(`split-canvas-content-slot-${groupId}`)?.props.onLayout({
                nativeEvent: { layout: { x: 0, y: 32, width: 760, height: 820 } },
            });
        }
    });
}

async function renderWorkspace(initial: WorkspaceState, horizontalArea?: HorizontalSafeArea, scale?: Readonly<{
    seed: (serverId: string) => void;
}>) {
    restoreLocks = installBrowserStorageLockBoundary();
    installDisconnectedServerSocketBoundary();
    fixture = await serveActionHomes({ homes: [{ key: 'home', serverUrl: 'https://workspace-shell.test', accountId: 'alice', currentAccount: true,
        settings: { keyboardShortcutsV2Enabled: true } }], route: () => undefined });
    disconnect = await fixture.restoreActiveConnection();
    const { storage } = production[7];
    const scope = storage.getState().profileScope;
    if (!scope) throw new Error('Shell fixture requires the restored Account scope');
    scale?.seed(scope.serverId);
    const { serializeWorkspaceLayout, workspaceLayoutScopeKey } = production[4];
    // Seed the current persistence owner.
    const { workspaceLayoutsState } = await import('@/sync/domains/state/filePaneUiState');
    workspaceLayoutsState.set(workspaceLayoutScopeKey({ ...scope, windowId: WINDOW_ID }), serializeWorkspaceLayout(initial));
    storage.setState({ isDataReady: true });
    const catalog = production[3].resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
    const activeTab = initial.tabs[initial.groups[initial.focusedGroupId].activeTabId];
    const href = production[3].hrefForDestinationRef(catalog, activeTab.target);
    if (!href) throw new Error('Shell fixture requires a catalog-admitted initial route');
    window.history.replaceState(null, '', href);
    if (scale) route.pathname = new URL(href, window.location.origin).pathname;
    const screen = await renderScreen(<Harness catalog={catalog} horizontalArea={horizontalArea} sidebar={Boolean(scale)} />);
    await settle(() => { expect(Object.keys(stateOf(screen).tabs)).toEqual(Object.keys(initial.tabs)); });
    await measureContentSlots(screen);
    return screen;
}

async function settle(outcome: () => void) {
    await vi.waitFor(async () => { await act(async () => {}); outcome(); });
}

async function action(actionId: ActionId, input: unknown) {
    const scope = production[7].storage.getState().profileScope;
    if (!scope) throw new Error('Shell Action requires its Account scope');
    let result!: ActionExecuteResult;
    await act(async () => { result = await production[6].createFrontDoorActionExecute()(actionId, input, {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: scope.serverId, expectedAccountId: scope.accountId,
    }); });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    return result.result;
}

/** Opens a tab's menu (press and hold) and chooses one of its items; the menu commits once closed. */
async function chooseFromTabMenu(screen: Awaited<ReturnType<typeof renderScreen>>, tabId: string, itemTestId: string, outcome: () => void) {
    const tab = screen.findAllByTestId(`workspace-tab-${tabId}`).find((node) => typeof node.props.onLongPress === 'function');
    if (!tab) throw new Error(`Tab ${tabId} offers no menu`);
    await act(async () => { tab.props.onLongPress({}); });
    await screen.pressByTestIdAsync(itemTestId);
    await settle(outcome);
    await measureContentSlots(screen);
}

function measureCanvas(screen: Awaited<ReturnType<typeof renderScreen>>, width: number, height: number) {
    const event = { nativeEvent: { layout: { width, height, x: 0, y: 0 } } };
    screen.findByTestId('split-canvas-host')?.props.onLayout(event);
    screen.findByTestId('split-canvas-leaf-interaction-surface-group:1')?.props.onLayout(event);
}

describe('WorkspaceShell Machines preset entries', () => {
    it.each(['new', 'edit'] as const)('opens the real preset %s entry beside the Machines column', async operation => {
        route.pathname = '/machines';
        const screen = await renderWorkspace(createWorkspaceState({ id: 'machines', target: { kind: 'machines', params: {} }, pinned: false, preview: true }));
        await act(async () => { await vi.dynamicImportSettled(); });
        const serverId = production[7].storage.getState().profileScope!.serverId;
        await settle(() => expect(screen.findByTestId(`settings.machines.presets.new.${serverId}`)).not.toBeNull());
        await screen.pressByTestIdAsync(operation === 'new'
            ? `settings.machines.presets.new.${serverId}` : `settings.machines.preset.${serverId}.build`);
        await settle(() => expect(screen.root.findAllByType('PresetRouteProbe')).toHaveLength(1));
        expect(screen.root.findByType('ShellColumnProbe').props.column).toEqual({ kind: 'builtin', id: 'machines' });
        expect(screen.root.findByType('PresetRouteProbe').props.door).toBe('rail');
        const { MachineCollectionRail } = await import('@/components/settings/machines/collection/MachineCollectionList');
        expect(screen.root.findAllByType(MachineCollectionRail)).toHaveLength(0);
        const { navigation } = screen.root.findByType('WorkspaceStateProbe').props;
        await act(async () => navigation.back());
        await settle(() => expect(screen.findByTestId(`settings.machines.presets.new.${serverId}`)).not.toBeNull());
        expect(screen.root.findByType('ShellColumnProbe').props.column).toEqual({ kind: 'builtin', id: 'machines' });
    });
});

describe('WorkspaceShell params-only target write', () => {
    it('renders only the written tab\'s destination, not the other tabs', async () => {
        const screen = await renderWorkspace(initialState());
        const { navigation } = screen.root.findByType('WorkspaceStateProbe').props;
        await act(async () => { navigation.activateTab('group:1', 'a'); });
        await act(async () => { navigation.activateTab('group:1', 'b'); });
        await settle(() => { expect(screen.root.findAllByType('StatefulRouteBodyProbe')).toHaveLength(2); });
        const focusedId = stateOf(screen).groups['group:1'].activeTabId;
        const otherId = focusedId === 'a' ? 'b' : 'a';
        const before = new Map(bodyRenders);
        await act(async () => { navigation.dispatch({ type: 'setTarget', tabId: focusedId,
            target: { kind: 'sessions', params: { anchor: focusedId, q: 'x' } } }); });
        expect(bodyRenders.get(otherId)).toBe(before.get(otherId));
        expect(stateOf(screen).tabs[focusedId].target.params.q).toBe('x');
    });

    it('leaves the unwritten tab\'s retained host and frame untouched by a params-only write', async () => {
        const screen = await renderWorkspace(initialState());
        const { navigation } = screen.root.findByType('WorkspaceStateProbe').props;
        await act(async () => { navigation.activateTab('group:1', 'a'); });
        await act(async () => { navigation.activateTab('group:1', 'b'); });
        await settle(() => { expect(screen.root.findAllByType('StatefulRouteBodyProbe')).toHaveLength(2); });
        const focusedId = stateOf(screen).groups['group:1'].activeTabId;
        const otherId = focusedId === 'a' ? 'b' : 'a';
        // A host whose parent did not re-render keeps the props object it was committed with.
        const hostProps = (tabId: string) => screen.root.findAll(node => node.type === DestinationInstanceHost && node.props.tabId === tabId)[0]?.props;
        const otherBefore = hostProps(otherId);
        const writtenBefore = hostProps(focusedId);

        await act(async () => { navigation.dispatch({ type: 'setTarget', tabId: focusedId,
            target: { kind: 'sessions', params: { anchor: focusedId, q: 'x' } } }); });

        expect(hostProps(focusedId)).not.toBe(writtenBefore);
        expect(hostProps(otherId)).toBe(otherBefore);
    });
});

describe('WorkspaceShell retained member layer', () => {
    it('leaves a hidden tab\'s member layer untouched by another tab\'s write', async () => {
        const screen = await renderWorkspace(initialState());
        const { navigation } = screen.root.findByType('WorkspaceStateProbe').props;
        await act(async () => { navigation.activateTab('group:1', 'a'); });
        await act(async () => { navigation.activateTab('group:1', 'b'); });
        await settle(() => { expect(screen.root.findAllByType('StatefulRouteBodyProbe')).toHaveLength(2); });
        const focusedId = stateOf(screen).groups['group:1'].activeTabId;
        const otherId = focusedId === 'a' ? 'b' : 'a';
        // A host element whose parent did not re-render keeps the props object it was committed with.
        const layerProps = (tabId: string) => screen.findByTestId(`split-canvas-retained-content-${tabId}`)?.props;
        const otherBefore = layerProps(otherId);
        expect(otherBefore).toBeTruthy();

        await act(async () => { navigation.dispatch({ type: 'setTarget', tabId: focusedId,
            target: { kind: 'sessions', params: { anchor: focusedId, q: 'x' } } }); });

        expect(layerProps(otherId)).toBe(otherBefore);
    });

    it.each([10, 400])('mounts member layers only for presented tabs, independent of %i restored tabs', async (tabCount) => {
        let initial = createWorkspaceState(restoredTab('restored-0'));
        for (let index = 1; index < tabCount; index++) {
            initial = reduceWorkspaceState(initial, { type: 'openTab', groupId: 'group:1', tab: restoredTab(`restored-${index}`) });
        }
        const screen = await renderWorkspace(initial);
        const prefix = 'split-canvas-retained-content-';
        const layers = () => screen.root.findAll(node => typeof node.type === 'string' && typeof node.props.testID === 'string'
            && node.props.testID.startsWith(prefix)).map(node => String(node.props.testID).slice(prefix.length)).sort();
        const last = `restored-${tabCount - 1}`;
        expect(layers()).toEqual([last]);
        const { navigation } = screen.root.findByType('WorkspaceStateProbe').props;
        await act(async () => { navigation.activateTab('group:1', 'restored-0'); });
        await settle(() => { expect(stateOf(screen).groups['group:1'].activeTabId).toBe('restored-0'); });
        // The visited tab keeps its layer (its retained state); unvisited tabs still mount nothing.
        expect(layers()).toEqual(['restored-0', last].sort());
    });

    it('re-renders a member layer when its tab changes', async () => {
        const screen = await renderWorkspace(initialState());
        const { navigation } = screen.root.findByType('WorkspaceStateProbe').props;
        await act(async () => { navigation.activateTab('group:1', 'a'); });
        await settle(() => { expect(screen.root.findAllByType('StatefulRouteBodyProbe').length).toBeGreaterThan(0); });
        const focusedId = stateOf(screen).groups['group:1'].activeTabId;
        const layerProps = (tabId: string) => screen.findByTestId(`split-canvas-retained-content-${tabId}`)?.props;
        const before = layerProps(focusedId);
        await act(async () => { navigation.dispatch({ type: 'setTarget', tabId: focusedId,
            target: { kind: 'sessions', params: { anchor: focusedId, q: 'y' } } }); });
        expect(stateOf(screen).tabs[focusedId].target.params.q).toBe('y');
        expect(layerProps(focusedId)).not.toBe(before);
    });
});

describe('WorkspaceShell desktop presentation', () => {
    it('presents a destination body without the workspace tab chrome', async () => {
        const screen = await renderWorkspace(initialState());
        const { navigation } = screen.root.findByType('WorkspaceStateProbe').props;
        await act(async () => { navigation.activateTab('group:1', 'a'); });
        await act(async () => { navigation.activateTab('group:1', 'b'); });
        await settle(() => { expect(screen.root.findAllByType('StatefulRouteBodyProbe')).toHaveLength(2); });
        const catalog = navigation.catalog;
        await screen.update(<Harness catalog={catalog} presentation="destination" />);
        await settle(() => {
            expect(screen.root.findAllByType('StatefulRouteBodyProbe').map(node => node.props.tabId)).toEqual(['b']);
            expect(screen.findAllByTestId('workspace-tab-b')).toHaveLength(0);
        });
    });
    it('unmounts the source body and strip entry while retaining the tab for return', async () => {
        const screen = await renderWorkspace(initialState());
        await settle(() => { expect(screen.root.findAllByType('StatefulRouteBodyProbe').some(node => node.props.tabId === 'b')).toBe(true); });
        const navigation = screen.root.findByType('WorkspaceStateProbe').props.navigation;
        await act(async () => { navigation.dispatch({ type: 'setPresentation', tabId: 'b', presentation: { windowId: 'destination-window' } }); });
        await settle(() => {
            expect(screen.root.findAllByType('StatefulRouteBodyProbe').some(node => node.props.tabId === 'b')).toBe(false);
            expect(screen.findAllByTestId('workspace-tab-b')).toHaveLength(0);
            expect(screen.root.findAllByType('StatefulRouteBodyProbe').some(node => node.props.tabId === 'a' && node.props.focused)).toBe(true);
        });
        expect(stateOf(screen).groups['group:1'].tabIds).toEqual(['a', 'b']);
        expect(stateOf(screen).tabs.b.presentation).toEqual({ windowId: 'destination-window' });
        await act(async () => { navigation.dispatch({ type: 'setPresentation', tabId: 'b', presentation: null }); });
        await settle(() => { expect(screen.root.findAllByType('StatefulRouteBodyProbe').some(node => node.props.tabId === 'b')).toBe(true); });
    });
});

describe('WorkspaceShell tab scale', () => {
    it.each([39, 389].flatMap(tabCount => (['existing', 'preview'] as const).map(mode => ({ tabCount, mode }))))(
        'keeps Credentials navigation and idle work independent of $tabCount tabs ($mode)', async ({ tabCount, mode }) => {
        const sessionUtils = await import('@/utils/sessions/sessionUtils');
        const { sessionListRuntimeClock } = await import('@/hooks/session/sessionListRuntimeClock');
        const { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS } = await import('@/sync/domains/session/attention/runtimePresentation');
        const { useEntityDragDropRuntime } = await import('@/components/ui/treeDragDrop/entityDragDropHooks');
        const { DOCUMENT_BAR_INITIAL_WINDOW_TABS } = await import('@/components/ui/navigation/DocumentTabStrip');
        const runtimeHook = await renderHook(useEntityDragDropRuntime);
        const dragRuntime = runtimeHook.getCurrent();
        await runtimeHook.unmount();
        // Observation-only spies call through the real derivations. No internal result is substituted.
        const statuses = vi.spyOn(sessionUtils, 'getSessionStatus');
        const deadlines = vi.spyOn(sessionUtils, 'readSessionStatusNextRefreshAtMs');
        const dragSubscriptions = vi.spyOn(dragRuntime, 'subscribe');
        const pointerSubscriptions = vi.spyOn(dragRuntime, 'subscribePointer');
        const counters = new Map<() => unknown, ReturnType<typeof createRenderCommitCounter>>();
        const counter = (read: () => unknown) => {
            let value = counters.get(read);
            if (!value) { value = createRenderCommitCounter(); counters.set(read, value); }
            return value;
        };
        let titleReads = 0;
        let added = 0;
        let removed = 0;
        let activeSubscriptions = 0;
        const commits = createRenderCommitCounter();
        tabStoreObserver.render = read => counter(read).render();
        tabStoreObserver.commit = read => counter(read).commit();
        tabStoreObserver.read = () => { titleReads += 1; };
        tabStoreObserver.subscribe = (_read, delta) => {
            activeSubscriptions += delta;
            if (delta > 0) added += 1; else removed += 1;
        };
        tabStoreObserver.enabled = true;
        const readCounts = () => {
            const rows = [...counters.values()].map(value => value.read());
            return { rootCommits: commits.read().commits,
                rowRenders: rows.reduce((sum, row) => sum + row.renders, 0),
                rowCommits: rows.reduce((sum, row) => sum + row.commits, 0),
                rowsRendered: rows.filter(row => row.renders > 0).length,
                maxRendersPerRow: Math.max(0, ...rows.map(row => row.renders)),
                titleSnapshotReads: titleReads, subscriptionsAdded: added, subscriptionsRemoved: removed,
                activeTitleSubscriptions: activeSubscriptions, statusDerivations: statuses.mock.calls.length,
                deadlineDerivations: deadlines.mock.calls.length,
                dragSubscriptionsAdded: dragSubscriptions.mock.calls.length,
                pointerSubscriptionsAdded: pointerSubscriptions.mock.calls.length };
        };
        const reset = () => {
            for (const value of counters.values()) value.reset();
            commits.reset(); titleReads = 0; added = 0; removed = 0;
            statuses.mockClear(); deadlines.mockClear();
            dragSubscriptions.mockClear(); pointerSubscriptions.mockClear();
        };
        const sessionTabs = tabCount - (mode === 'existing' ? 2 : 1);
        const settingsTab = (id: string, pageId: string, preview = false) => ({ id, target: { kind: 'settings', params: { pageId } }, pinned: false, preview });
        let initial = createWorkspaceState(settingsTab('appearance', 'appearance', mode === 'preview'));
        if (mode === 'existing') initial = reduceWorkspaceState(initial, { type: 'openTab', groupId: 'group:1', tab: settingsTab('credentials', 'connected-services') });
        for (let index = 0; index < sessionTabs; index += 1) {
            initial = reduceWorkspaceState(initial, { type: 'openTab', groupId: 'group:1', tab: {
                id: `scale-${index}`, target: { kind: 'session', params: { id: `scale-${index}` } }, pinned: false, preview: false,
            } });
        }
        initial = reduceWorkspaceState(initial, { type: 'activateTab', groupId: 'group:1', tabId: 'appearance' });
        let home = '';
        const { storage } = production[7];
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        const wake = {};
        try {
            screen = await renderWorkspace(initial, undefined, { seed: serverId => {
                home = serverId;
                storage.setState({ sessionListRowsByServerId: { [home]: Object.fromEntries(Array.from({ length: sessionTabs }, (_, index) => {
                    const id = `scale-${index}`;
                    return [id, createSessionListRenderableSessionFixture({ id, active: false, activeAt: 1, presence: undefined })];
                })) } });
            } });
            await settle(() => { expect(screen!.root.findAllByType('StatefulRouteBodyProbe')).toHaveLength(1); });
            expect(screen.root.findAllByType(DestinationInstanceHost)).toHaveLength(1);
            expect(screen.findAllHostsByTestId('workspace-tab-scale-0').length).toBeGreaterThan(0);
            // The bar mounts the tabs near its (not yet measured) viewport: the first window of a long restore.
            const mountedTabs = Math.min(tabCount, DOCUMENT_BAR_INITIAL_WINDOW_TABS + 1);
            expect(screen.root.findAll(node => typeof node.type === 'function' && node.type.name === 'DocumentBarTabRow')).toHaveLength(mountedTabs);
            expect(activeSubscriptions).toBe(mountedTabs);
            const mount = readCounts();
            const stop = screen.subscribe(commits.commit);
            reset();
            if (mode === 'existing') await screen.pressByTestIdAsync('workspace-tab-credentials');
            else {
                const credentials = screen.root.findAll(node => node.props.href === '/settings/connected-services'
                    && typeof node.props.onPress === 'function')[0];
                expect(credentials).toBeDefined();
                await act(async () => { credentials!.props.onPress(); });
            }
            await settle(() => {
                const state = stateOf(screen!);
                expect(state.tabs[state.groups['group:1'].activeTabId].target).toEqual({ kind: 'settings', params: { pageId: 'connected-services' } });
                expect(Object.keys(state.groups)).toHaveLength(1);
                expect(Object.keys(state.tabs)).toHaveLength(tabCount);
                expect(screen!.root.findAllByType('StatefulRouteBodyProbe')).toHaveLength(mode === 'existing' ? 2 : 1);
            });
            const navigation = readCounts();
            reset();
            vi.useFakeTimers();
            await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
            const idle = readCounts();
            reset();
            // Another live date/status leaf's real deadline must not recompute this strip's statuses.
            sessionListRuntimeClock.requestWake(wake, Date.now() + 100);
            await act(async () => { await vi.advanceTimersByTimeAsync(100); });
            const unrelatedWake = readCounts();
            reset();
            await act(async () => {
                const rows = storage.getState().sessionListRowsByServerId;
                storage.setState({ sessionListRowsByServerId: { ...rows, [home]: { ...rows[home],
                    'scale-0': createSessionListRenderableSessionFixture({ id: 'scale-0', active: true,
                        activeAt: Date.now(), presence: 'online', latestTurnStatus: 'in_progress' }),
                } } });
            });
            const changed = readCounts();
            const working = () => screen!.findAllByTestId('workspace-tab-scale-0')
                .some(node => String(node.props.accessibilityLabel ?? node.props['aria-label']).endsWith(', status.working'));
            expect(working()).toBe(true);
            reset();
            await act(async () => { await vi.advanceTimersByTimeAsync(SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 1); });
            const ownDeadline = readCounts();
            expect(working()).toBe(false);
            stop();
            console.info('CREDFREEZE_SCALE', JSON.stringify({ tabCount, mode, sessionTabs, mount, navigation, idle, unrelatedWake, changed, ownDeadline }));
            expect.soft(idle.rowRenders).toBe(0);
            expect.soft(idle.statusDerivations).toBe(0);
            expect.soft(navigation.statusDerivations).toBe(0);
            // Retargeting keeps the preview's position; activating an existing tab updates the old and new rows.
            // Neither cost grows with the inventory size.
            const navigationRows = mode === 'preview' ? 1 : 2;
            expect.soft(navigation.rowRenders).toBe(navigationRows);
            expect.soft(navigation.rowCommits).toBe(navigationRows);
            expect.soft(unrelatedWake.statusDerivations).toBe(0);
            expect.soft(unrelatedWake.rowRenders).toBe(0);
            expect(changed.rowRenders).toBeGreaterThan(0);
            expect(ownDeadline.statusDerivations).toBeGreaterThan(0);
        } finally {
            sessionListRuntimeClock.clearWake(wake);
            await screen?.unmount();
            tabStoreObserver.enabled = false;
            vi.useRealTimers();
        }
    });
});

describe('WorkspaceShell', () => {
    it.each(['sessions', 'project'] as const)('keeps the %s destination and sidebar across New open, picker and close', async kind => {
        const target: DestinationRef = kind === 'project'
            ? { kind, params: { workspaceRefId: 'project-fixture' } }
            : { kind, params: {} };
        const screen = await renderWorkspace(createWorkspaceState({ id: 'background', target, pinned: false, preview: false }));
        const body = () => screen.root.findByType('StatefulRouteBodyProbe');
        await settle(() => { expect(body()).toBeDefined(); });
        await act(async () => { body().props.setDraft('Keep this draft'); body().props.setViewport(387); });
        const mounted = nextBodyMount;
        const unmounted = bodyUnmounts;
        const before = body().props.mount;
        const column = screen.root.findByType('ShellColumnProbe').props;
        const href = window.location.pathname + window.location.search;
        for (const pathname of ['/new', '/new/pick/machine', href]) {
            route.pathname = pathname.split('?')[0]!;
            await act(async () => { window.history.pushState({}, '', pathname); });
            expect.soft(bodyUnmounts).toBe(unmounted);
            expect.soft(nextBodyMount).toBe(mounted);
            expect(screen.root.findAllByType('StatefulRouteBodyProbe')).toHaveLength(1);
            expect(body().props).toMatchObject({ mount: before, draft: 'Keep this draft', viewport: 387,
                focused: true, windowEligible: !pathname.startsWith('/new') });
            expect(screen.root.findByType('ShellColumnProbe').props).toEqual(column);
        }
    });

    it.each(['right', 'down'] as const)('keeps retained clips full width and scopes content, headers, and backdrops to window edges when split %s', async direction => {
        const screen = await renderWorkspace(initialState(), { left: 16, right: 84, padded: false });
        await act(async () => { measureCanvas(screen, 1200, 1000); });
        const body = (tabId: string) => screen.root.findAllByType('StatefulRouteBodyProbe').find(node => node.props.tabId === tabId)!;
        const frame = (tabId: string) => screen.root.findAllByType(ScreenSafeAreaFrame)
            .find(node => node.findAllByType('StatefulRouteBodyProbe').some(body => body.props.tabId === tabId));
        const backdrop = (tabId: string) => {
            const host = frame(tabId)?.findAll(node => typeof node.type === 'string')[0];
            return flattenTestStyle(host?.props.style).backgroundColor;
        };
        expect(body('b').props.safeArea).toEqual({ left: 16, right: 84, padded: true });
        expect(body('b').props.bleed).toEqual({ left: 16, right: 84 });
        expect(backdrop('b')).toBe('tab-b');
        expect(flattenTestStyle(screen.findHostByTestId('split-canvas-retained-content-b')?.props.style)).toMatchObject({ left: 0, right: 0 });
        expect(flattenTestStyle(screen.findHostByTestId('workspace-group-group_1')?.props.style))
            .toMatchObject({ paddingLeft: 16, paddingRight: 84 });
        const mount = body('b').props.mount;
        await act(async () => {
            body('b').props.setDraft('Keep edge-owned draft');
            screen.findByTestId('workspace-tab-a')?.props.onPress();
        });
        await settle(() => { expect(stateOf(screen).groups['group:1'].activeTabId).toBe('a'); });
        await act(async () => { screen.findByTestId('workspace-tab-b')?.props.onPress(); });
        await settle(() => { expect(stateOf(screen).groups['group:1'].activeTabId).toBe('b'); });
        expect(backdrop('a')).toBe('tab-a');
        expect(backdrop('b')).toBe('tab-b');
        await chooseFromTabMenu(screen, 'b', `workspace-tab-menu-split-${direction}`, () => { expect(Object.keys(stateOf(screen).groups)).toHaveLength(2); });
        expect(body('a').props.bleed).toEqual({ left: 16, right: direction === 'right' ? 0 : 84 });
        expect(body('b').props.bleed).toEqual({ left: direction === 'right' ? 0 : 16, right: 84 });
        const groupId = stateOf(screen).focusedGroupId;
        await act(async () => { screen.root.findByType('WorkspaceStateProbe').props.navigation.dispatch({ type: 'toggleMaximize', groupId }); });
        expect(body('b').props.bleed).toEqual({ left: 16, right: 84 });
        expect(flattenTestStyle(screen.findHostByTestId('split-canvas-retained-content-b')?.props.style)).toMatchObject({ left: 0, right: 0 });
        await action('workspace.tabs.move', { tabId: 'b', targetGroupId: 'group:1' });
        expect(body('b').props).toMatchObject({ mount, draft: 'Keep edge-owned draft' });
        expect(body('b').props.bleed).toEqual({ left: 16, right: 84 });
    });

    it('budgets an honouring editor-first project leaf by the editor minimum', async () => {
        const screen = await renderWorkspace(createWorkspaceState({ id: 'project',
            target: { kind: 'project', params: { workspaceRefId: 'project-fixture' } }, pinned: false, preview: false }));
        const { storage } = production[7];
        const minimum = () => {
            const canvas = screen.root.find(node => typeof node.props.getLeafMinimumSizePx === 'function');
            return canvas.props.getLeafMinimumSizePx(stateOf(screen).root);
        };
        await act(async () => storage.getState().applyLocalSettings({ paneArrangement: 'editor' }, { source: 'ui' }));
        expect(minimum().width).toBe(480);
        await act(async () => storage.getState().applyLocalSettings({ paneArrangement: 'session' }, { source: 'ui' }));
        expect(minimum().width).toBe(420);
    });
    it('shows the registered split-down shortcut in the tab menu and withdraws it when shortcuts are disabled', async () => {
        const { KeyHint } = await import('@/components/ui/keyboard/KeyHint');
        const screen = await renderWorkspace(initialState());
        const tab = screen.findAllByTestId('workspace-tab-a').find(node => typeof node.props.onLongPress === 'function');
        if (!tab) throw new Error('The workspace tab must offer its menu');
        await act(async () => { tab.props.onLongPress({}); });
        const splitHint = () => screen.findByTestId('workspace-tab-menu-split-down')?.findAllByType(KeyHint);
        expect(splitHint()?.map(node => node.props.label)).toEqual(['Alt+Shift+\\']);

        const { storage } = production[7];
        await act(async () => { storage.setState({ settings: { ...storage.getState().settings, keyboardShortcutsV2Enabled: false } }); });
        expect(screen.findByTestId('workspace-tab-menu-split-down')).not.toBeNull();
        expect(splitHint()).toEqual([]);
    });

    it('provides an accessible new-tab action and closes that tab through the registered keyboard owner', async () => {
        const screen = await renderWorkspace(initialState());
        const button = screen.findHostByTestId('workspace-new-tab-group_1');
        expect(button?.props.accessibilityLabel).toBe('workspaceBar.newTab');
        expect(button?.props.role).toBe('button');
        await screen.pressByTestIdAsync('workspace-new-tab-group_1');
        await settle(() => { expect(stateOf(screen).groups['group:1'].tabIds).toHaveLength(3); });
        expect(stateOf(screen).tabs[stateOf(screen).groups['group:1'].activeTabId].target.kind).toBe('newTab');
        const openedTab = stateOf(screen).groups['group:1'].activeTabId;
        const closeKey = new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true, cancelable: true });
        await act(async () => { window.dispatchEvent(closeKey); });
        expect(closeKey.defaultPrevented).toBe(true);
        await settle(() => { expect(stateOf(screen).tabs[openedTab]).toBeUndefined(); });
        expect(stateOf(screen).groups['group:1'].tabIds).toEqual(['a', 'b']);
    });

    it('moves a singleton plugin tab into a split and leaves a new-tab target in its empty source', () => {
        const catalog: readonly CompactAppDestination[] = [{
            id: 'plugin:acme.notes:notes', kind: 'plugin', container: 'appPage',
            destination: { pluginId: 'acme.notes', localId: 'notes' },
            title: 'Notes', icon: 'note', order: 40, placement: { kind: 'rail', region: 'plugins' },
            activation: 'navigate', routePath: '/plugins/acme.notes/notes', availability: 'available',
        }];
        const target = resolveDestinationRefFromHref(catalog, '/plugins/acme.notes/notes/first');
        if (!target) throw new Error('The singleton catalog fixture must resolve its route');
        const pluginTab = { id: 'singleton-notes', target, pinned: true, preview: false };
        const state = reduceWorkspaceState(createWorkspaceState(pluginTab), {
            type: 'splitTab', tabId: pluginTab.id, sourceGroupId: 'group:1', targetGroupId: 'group:1',
            newGroupId: 'group:2', axis: 'row', placement: 'after',
            availableSizePx: 1200, minimumFirstSizePx: 420, minimumSecondSizePx: 420,
            newTabForSource: { id: 'source-new', target: { kind: 'newTab', params: {} }, pinned: false, preview: false },
        });
        expect(Object.values(state.tabs).filter((tab) => tab.target.kind === target.kind)).toEqual([pluginTab]);
        expect(state.groups['group:2'].tabIds).toEqual([pluginTab.id]);
        expect(state.groups['group:1'].tabIds).toEqual(['source-new']);
        expect(state.tabs['source-new'].target.kind).toBe('newTab');
        expect(state.focusedGroupId).toBe('group:2');
    });

    it('restores 50 tabs without mounting unopened bodies, retains visited state and releases closed bodies', async () => {
        let initial = createWorkspaceState(restoredTab('restored-0'));
        for (let index = 1; index < 50; index++) {
            initial = reduceWorkspaceState(initial, { type: 'openTab', groupId: 'group:1', tab: restoredTab(`restored-${index}`) });
        }
        const screen = await renderWorkspace(initial);
        const body = (tabId: string) => screen.root.findAllByType('StatefulRouteBodyProbe').find(node => node.props.tabId === tabId)!;
        const mountedBodies = () => screen.root.findAllByType('StatefulRouteBodyProbe').map(node => node.props.tabId);
        expect(stateOf(screen).groups['group:1'].tabIds).toHaveLength(50);
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => node.props.tabId)).toEqual(['restored-49']);
        expect(mountedBodies()).toEqual(['restored-49']);
        const lastMount = body('restored-49').props.mount;
        await act(async () => {
            body('restored-49').props.setDraft('Keep the restored draft');
            body('restored-49').props.setViewport(387);
            screen.findByTestId('workspace-tab-restored-0')?.props.onPress();
        });
        await settle(() => { expect(stateOf(screen).groups['group:1'].activeTabId).toBe('restored-0'); });
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => [node.props.tabId, node.props.visible, node.props.focused]))
            .toEqual([['restored-0', true, true], ['restored-49', false, false]]);
        expect(mountedBodies()).toEqual(['restored-0', 'restored-49']);
        expect(body('restored-49').props).toMatchObject({ mount: lastMount, draft: 'Keep the restored draft', viewport: 387 });
        const firstMount = body('restored-0').props.mount;
        await act(async () => {
            body('restored-0').props.setDraft('Keep the newly visited draft');
            body('restored-0').props.setViewport(92);
        });
        // The bar mounts the tabs near its viewport: scroll to the end for the last tab.
        const scrollBarTo = async (tabIndex: number) => act(async () => {
            for (const scroller of screen.root.findAll(node => (node.type as unknown) === 'ScrollView' && node.props.horizontal === true && typeof node.props.onScroll === 'function')) {
                scroller.props.onScroll({ nativeEvent: { contentOffset: { x: tabIndex * 146, y: 0 }, contentSize: { width: 50 * 146, height: 30 }, layoutMeasurement: { width: 600, height: 30 } } });
            }
        });
        await scrollBarTo(49);
        await act(async () => { screen.findByTestId('workspace-tab-restored-49')?.props.onPress(); });
        await settle(() => { expect(stateOf(screen).groups['group:1'].activeTabId).toBe('restored-49'); });
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => [node.props.tabId, node.props.visible, node.props.focused]))
            .toEqual([['restored-0', false, false], ['restored-49', true, true]]);
        expect(body('restored-49').props).toMatchObject({ mount: lastMount, draft: 'Keep the restored draft', viewport: 387 });
        expect(body('restored-0').props).toMatchObject({ mount: firstMount, draft: 'Keep the newly visited draft', viewport: 92 });
        await scrollBarTo(0);
        await chooseFromTabMenu(screen, 'restored-0', 'workspace-tab-menu-pin', () => { expect(stateOf(screen).tabs['restored-0'].pinned).toBe(true); });
        expect(stateOf(screen).tabs['restored-0']).toMatchObject({ pinned: true, preview: false });
        await scrollBarTo(49);
        await chooseFromTabMenu(screen, 'restored-49', 'workspace-tab-menu-pin', () => { expect(stateOf(screen).tabs['restored-49'].pinned).toBe(true); });
        expect(stateOf(screen).tabs['restored-49']).toMatchObject({ pinned: true, preview: false });
        await scrollBarTo(0);
        await chooseFromTabMenu(screen, 'restored-0', 'workspace-tab-menu-close', () => { expect(stateOf(screen).tabs['restored-0']).toBeUndefined(); });
        expect(stateOf(screen).tabs['restored-0']).toBeUndefined();
        expect(stateOf(screen).groups['group:1'].activeTabId).toBe('restored-49');
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => node.props.tabId)).toEqual(['restored-49']);
        expect(mountedBodies()).toEqual(['restored-49']);
        expect(body('restored-49').props).toMatchObject({ mount: lastMount, draft: 'Keep the restored draft', viewport: 387 });
    });

    it('preserves the mounted body, draft and viewport when a tab moves across groups', async () => {
        const initial = reduceWorkspaceState(createWorkspaceState(restoredTab('a')),
            { type: 'openTab', groupId: 'group:1', tab: restoredTab('b') });
        const screen = await renderWorkspace(initial);
        const body = () => screen.root.findAllByType('StatefulRouteBodyProbe').find(node => node.props.tabId === 'b')!;
        const mount = body().props.mount;
        await act(async () => {
            body().props.setDraft('Keep this unsent draft');
            body().props.setViewport(387);
            measureCanvas(screen, 1200, 800);
        });
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-right', () => { expect(Object.keys(stateOf(screen).groups)).toHaveLength(2); });
        expect(stateOf(screen).groups[stateOf(screen).focusedGroupId].tabIds).toEqual(['b']);
        expect(body().props).toMatchObject({ mount, draft: 'Keep this unsent draft', viewport: 387 });
        await action('workspace.tabs.move', { tabId: 'b', targetGroupId: 'group:1' });
        expect(stateOf(screen).groups['group:1'].tabIds).toContain('b');
        expect(body().props).toMatchObject({ mount, draft: 'Keep this unsent draft', viewport: 387 });
    });

    it('refuses an unmeasured split, then moves the selected tab using the measured group extent', async () => {
        const screen = await renderWorkspace(initialState());
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-right', () => { expect(production[8].Modal.alertAsync).toHaveBeenCalled(); });
        expect(Object.keys(stateOf(screen).groups)).toHaveLength(1);
        await act(async () => { measureCanvas(screen, 1200, 800); });
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-right', () => { expect(Object.keys(stateOf(screen).groups)).toHaveLength(2); });
        const state = stateOf(screen);
        expect(Object.keys(state.groups)).toHaveLength(2);
        expect(state.groups['group:1'].tabIds).toEqual(['a']);
        expect(state.groups[state.focusedGroupId].tabIds).toEqual(['b']);
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => [node.props.tabId, node.props.focused, node.props.visible]))
            .toEqual([['a', false, true], ['b', true, true]]);
    });

    it('keeps a split below the two existing minimum widths in one pane', async () => {
        const screen = await renderWorkspace(initialState());
        await act(async () => { measureCanvas(screen, 500, 800); });
        const before = stateOf(screen);
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-right', () => { expect(production[8].Modal.alertAsync).toHaveBeenCalled(); });
        expect(Object.keys(stateOf(screen).groups)).toHaveLength(1);
        expect(stateOf(screen)).toBe(before);
    });

    it('splits down using the existing minimum height and collapses the new pane when its tab closes', async () => {
        const screen = await renderWorkspace(initialState());
        await act(async () => { measureCanvas(screen, 800, 800); });
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-down', () => { expect(stateOf(screen).root).toMatchObject({ kind: 'split', axis: 'column' }); });
        expect(stateOf(screen).root).toMatchObject({ kind: 'split', axis: 'column' });
        await act(async () => { screen.findByTestId('workspace-tab-close-b')?.props.onPress({}); });
        await settle(() => { expect(stateOf(screen).root).toMatchObject({ kind: 'leaf', id: 'group:1' }); });
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => node.props.tabId)).toEqual(['a']);
    });

    it('uses the normal canvas budget while maximized and reveals the focused destination after an admitted split', async () => {
        let initial = reduceWorkspaceState(initialState(), { type: 'openTab', groupId: 'group:1',
            tab: restoredTab('c') });
        initial = reduceWorkspaceState(initial, { type: 'splitTab', tabId: 'c', sourceGroupId: 'group:1',
            targetGroupId: 'group:1', newGroupId: 'group:2', axis: 'row', placement: 'after',
            availableSizePx: 2190, minimumFirstSizePx: 420, minimumSecondSizePx: 420 });
        initial = reduceWorkspaceState(initial, { type: 'toggleMaximize', groupId: 'group:1' });
        const screen = await renderWorkspace(initial);
        expect(screen.root.findAllByType(DestinationInstanceHost).map((node) => node.props.tabId)).toEqual(['b']);

        // The maximized leaf reports the whole canvas; its normal half is too small to split.
        await act(async () => { measureCanvas(screen, 1600, 800); });
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-right', () => { expect(production[8].Modal.alertAsync).toHaveBeenCalled(); });
        expect(Object.keys(stateOf(screen).groups)).toHaveLength(2);
        expect(stateOf(screen).maximizedGroupId).toBe('group:1');

        await act(async () => { measureCanvas(screen, 2200, 800); });
        await chooseFromTabMenu(screen, 'b', 'workspace-tab-menu-split-right', () => { expect(Object.keys(stateOf(screen).groups)).toHaveLength(3); });
        expect(Object.keys(stateOf(screen).groups)).toHaveLength(3);
        expect(stateOf(screen).maximizedGroupId).toBeNull();
        expect(screen.root.findAllByType(DestinationInstanceHost).filter((node) => node.props.focused)
            .map((node) => [node.props.tabId, node.props.visible])).toEqual([['b', true]]);
    });
});
