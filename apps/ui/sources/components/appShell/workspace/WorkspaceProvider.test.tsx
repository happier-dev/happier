import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { WORKSPACE_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol';
import { storage } from '@/sync/domains/state/storage';
import { resolveCompactAppDestinations } from '../destinations/compactAppDestinationCatalog';
import { DestinationInstanceHost, useDestinationInstanceKey, useDestinationParams, useDestinationRouter } from './DestinationInstanceHost';
import type { WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { WorkspaceProvider } from './WorkspaceProvider';
import { WorkspaceShell } from './WorkspaceShell';
import { captureMountedWorkspaceAction, invokeWorkspaceAction } from './workspaceActionRuntime';
import { clearActiveUnsavedChangesGuard, setActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { KeyboardShortcutProvider, useKeyboardCommand, type KeyboardCommandId } from '@/keyboard';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { serializeWorkspaceLayout, workspaceLayoutScopeKey } from './workspacePersistence';
import { AppShellTitleStrip } from '@/components/navigation/shell/appRail/AppShellTitleStrip';
import { reconcileWorkspaceSyncedTabs } from './workspaceSyncedTabs';
import { registerWorkspaceRouteContext } from './workspaceRouteContext';
import { Stack } from './destinationRoute';
import { WorkspaceRouteEntry } from './createWorkspaceRouteEntry';
import { WorkspaceRootStack } from './WorkspaceRootStack';

const boundary = vi.hoisted(() => ({ layouts: {} as Record<string, unknown>, mirrors: [] as string[], scope: { serverId: 'home-a', accountId: 'alice' }, dataReady: true,
    platform: 'ios', pathname: '/session/A1', params: { id: 'A1', serverId: 'home-a' } as Record<string, string>,
    renderScene: null as (() => React.ReactNode) | null }));
// Socket transport is a genuine boundary; this layout-owner suite has no authenticated RPCs.
vi.mock('@/sync/api/session/apiSocket', () => ({ apiSocket: {} }));
// This navigation journey never renders Markdown; the vendor/native SDK remains a boundary.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected vendor Markdown reveal in workspace navigation test'); },
}));
vi.mock('expo-router/build/fork/getPathFromState', async () => {
    const { loadInstalledExpoPathSerializer } = await import('@/dev/testkit/runtime/installedExpoPathSerializer');
    return loadInstalledExpoPathSerializer();
});
// This harness has no recipient-envelope HTTP/process authority; reaching that API is a setup bug.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unavailable = () => { throw new Error('Unexpected recipient-envelope API in workspace navigation test'); };
    return { createSessionDataKeyEnvelopeClient: unavailable, readSessionDataKeyEnvelopeCollectionPage: unavailable,
        prepareSessionDataKeyEnvelopesForScope: unavailable, prepareSessionDataKeyEnvelopesDetached: unavailable };
});
// Authentication is a boundary of this no-network layout harness.
vi.mock('@/auth/context/AuthContext', () => ({ useOptionalAuth: () => null }));
// Native has no browser History; Expo is the genuine platform URL boundary here.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return boundary.platform; }, select: (values: Record<string, unknown>) => values[boundary.platform] ?? values.default } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const module = createExpoRouterMock({ pathname: () => boundary.pathname, params: () => boundary.params,
        router: { replace: (href: unknown) => { boundary.mirrors.push(String(href)); } } }).module;
    // Expo is the navigator boundary. Observe whether its admitted options mount a modal scene;
    // workspace admission, hydration, route entries and destination resolution remain real.
    return { ...module, Stack: Object.assign((props: React.ComponentProps<typeof module.Stack>) => {
        if (!boundary.renderScene) return React.createElement(module.Stack, props);
        const declaration = React.Children.toArray(props.children).find(child =>
            React.isValidElement<{ name?: string }>(child) && child.props.name === boundary.pathname.slice(1));
        if (!React.isValidElement<{ options?: unknown }>(declaration)) throw new Error('Missing route declaration');
        const options = typeof declaration.props.options === 'function'
            ? declaration.props.options({ route: { name: boundary.pathname.slice(1), params: boundary.params }, navigation: {} })
            : declaration.props.options;
        const presentation = (options as { presentation?: string } | undefined)?.presentation;
        const scene = boundary.renderScene();
        return presentation && presentation !== 'card' ? React.createElement('RouteModalShell', { presentation }, scene) : scene;
    }, { Screen: module.Stack.Screen }) };
});
const initialStorageState = storage.getState();
// Test inputs use the same store snapshots and selectors as the mounted workspace.
Object.defineProperties(boundary, {
    layouts: {
        get: () => storage.getState().localSettings.workspaceLayoutV1,
        set: (layouts: Record<string, unknown>) => storage.setState({
            localSettings: { ...storage.getState().localSettings, workspaceLayoutV1: layouts },
        }),
    },
    scope: {
        get: () => storage.getState().profileScope,
        set: (scope: typeof boundary.scope) => storage.setState({ profileScope: scope }),
    },
    dataReady: {
        get: () => storage.getState().isDataReady,
        set: (isDataReady: boolean) => storage.setState({ isDataReady }),
    },
});

function HostedProbe() {
    const params = useDestinationParams<{ id?: string; serverId?: string }>();
    const router = useDestinationRouter();
    return React.createElement('HostedIdentity', { params, next: () => router.push('/session/A2?serverId=home-a') });
}

function NavigationProbe(props: Readonly<{ navigation: WorkspaceNavigationContextValue }>) {
    const state = props.navigation.state;
    const group = state.groups[state.focusedGroupId];
    const tab = state.tabs[group.activeTabId];
    return <>
        {React.createElement('WorkspaceOwner', { navigation: props.navigation })}
        <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname={`/session/${tab.target.params.id}`}
            focused visible navigation={props.navigation.navigationForTab(tab.id)}><HostedProbe /></DestinationInstanceHost>
    </>;
}

function ResizeLayout() { return <Stack />; }
function ResizeEditor() {
    const [draft, setDraft] = React.useState('');
    const params = useDestinationParams();
    return React.createElement('ResizeEditor', { draft, setDraft, params });
}

/** Real event dispatch beneath the external browser URL/history fixtures. */
function installBrowserBoundary(input: Record<string, unknown> & { history: object }) {
    const events = new EventTarget();
    vi.stubGlobal('window', { ...input,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
    });
}

describe('consumed workspace navigation owner', () => {
    it('retains qualified Project page and resource through mounted phone tab admission and activation', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const screen = await renderScreen(<WorkspaceProvider enabled={false} phone catalog={catalog}>
            {(navigation) => React.createElement('ProjectPhoneOwner', { navigation })}
        </WorkspaceProvider>);
        const navigation = () => screen.root.findByType('ProjectPhoneOwner').props.navigation as WorkspaceNavigationContextValue;
        const href = '/projects/wr_1/changes?serverId=home-b&worktreeId=checkout-a&layoutId=selected&comparisonId=comparison-a&initialFile=src%2Fa.ts';
        await act(async () => { navigation().phone?.openHref(href, 'newTab'); });
        const state = navigation().state;
        const tabId = state.groups[state.focusedGroupId].activeTabId;
        expect(state.tabs[tabId].target).toEqual({ kind: 'project', params: { workspaceRefId: 'wr_1', pageId: 'changes',
            serverId: 'home-b', worktreeId: 'checkout-a', layoutId: 'selected', comparisonId: 'comparison-a', initialFile: 'src/a.ts' } });
        await act(async () => { navigation().phone?.activateTab(tabId); });
        expect(boundary.mirrors.at(-1)).toBe(href);
    });
    beforeEach(() => {
        storage.setState({ ...initialStorageState, profileScope: { serverId: 'home-a', accountId: 'alice' }, isDataReady: true,
            localSettings: { ...initialStorageState.localSettings, workspaceLayoutV1: {}, titleStripThemeToggleVisible: false } }, true);
    });
    afterEach(() => { standardCleanup(); storage.setState(initialStorageState, true); boundary.mirrors = [];
        boundary.platform = 'ios'; boundary.pathname = '/session/A1'; boundary.params = { id: 'A1', serverId: 'home-a' };
        boundary.renderScene = null;
        clearActiveUnsavedChangesGuard(); vi.unstubAllGlobals(); });
    it.each([true, false])('never mounts an empty route modal for hosted History before/after hydration or resize (desktop=%s)', async desktop => {
        boundary.platform = 'web'; boundary.pathname = '/external/browse'; boundary.params = {}; boundary.dataReady = false;
        const location = { pathname: boundary.pathname, search: '', hash: '' };
        const history = { state: null as unknown,
            replaceState: (state: unknown) => { history.state = state; },
            pushState: (state: unknown) => { history.state = state; }, go: () => {},
        };
        installBrowserBoundary({ location, history, sessionStorage: { getItem: () => 'main' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: true, inbox: false, workflows: false, friends: false } });
        const Body = () => React.createElement('HistoryBody');
        boundary.renderScene = () => <WorkspaceRouteEntry Body={Body} />;
        const element = () => <WorkspaceProvider enabled={desktop} phone={!desktop} catalog={catalog}>
            <WorkspaceRootStack><WorkspaceRootStack.Screen name="external/browse" options={() => ({ presentation: 'transparentModal' })} /></WorkspaceRootStack>
        </WorkspaceProvider>;
        const screen = await renderScreen(element());
        expect(screen.root.findAllByType('RouteModalShell')).toHaveLength(0);
        expect(screen.root.findAllByType('HistoryBody')).toHaveLength(0);
        await act(async () => { boundary.dataReady = true; screen.update(element()); });
        expect(screen.root.findAllByType('RouteModalShell')).toHaveLength(0);
        expect(screen.root.findAllByType('HistoryBody')).toHaveLength(0);
        for (const next of [!desktop, desktop]) {
            desktop = next;
            await act(async () => { screen.update(element()); });
            expect(screen.root.findAllByType('RouteModalShell')).toHaveLength(0);
        }
    });
    it.each(['web', 'ios', 'android'])('keeps unhosted History modal presentation on %s', async platform => {
        boundary.platform = platform; boundary.pathname = '/external/browse'; boundary.params = {};
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: platform !== 'web', inbox: false, workflows: false, friends: false } });
        const Body = () => React.createElement('HistoryBody');
        boundary.renderScene = () => <WorkspaceRouteEntry Body={Body} />;
        const presentation = platform === 'web' ? 'transparentModal' : 'modal';
        const screen = await renderScreen(<WorkspaceProvider enabled={false} phone catalog={catalog}>
            <WorkspaceRootStack><WorkspaceRootStack.Screen name="external/browse" options={{ presentation }} /></WorkspaceRootStack>
        </WorkspaceProvider>);
        const modal = screen.root.findByType('RouteModalShell');
        expect(modal.props.presentation).toBe(presentation);
        expect(modal.findAllByType('HistoryBody')).toHaveLength(1);
    });
    it('keeps a hosted History entry non-modal while an unhosted modal is current', async () => {
        boundary.platform = 'web'; boundary.pathname = '/new/index'; boundary.params = {};
        const history = { state: null as unknown, replaceState: (state: unknown) => { history.state = state; },
            pushState: (state: unknown) => { history.state = state; }, go: () => {} };
        installBrowserBoundary({ location: { pathname: '/new', search: '', hash: '' },
            history, sessionStorage: { getItem: () => 'main' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: true, inbox: false, workflows: false, friends: false } });
        const screen = await renderScreen(<WorkspaceProvider enabled={false} phone catalog={catalog}>
            <WorkspaceRootStack>
                <WorkspaceRootStack.Screen name="external/browse" options={() => ({ presentation: 'transparentModal' })} />
                <WorkspaceRootStack.Screen name="new/index" options={{ presentation: 'modal' }} />
            </WorkspaceRootStack>
        </WorkspaceProvider>);
        const optionsFor = (name: string) => {
            const options = screen.root.findByProps({ name }).props.options;
            return typeof options === 'function' ? options({ route: { name, params: {} }, navigation: {} }) : options;
        };
        expect(optionsFor('external/browse').presentation).toBe('card');
        expect(optionsFor('new/index').presentation).toBe('modal');
    });
    it.each([
        ['/settings/no-body', '', false],
        ['/settings/plugins/acme.review/policy', '?subPath=bindings%2F1&subPath=bindings%2F2', false],
        ['/settings/no-body', '', true],
        ['/settings/plugins/acme.review/policy', '?subPath=bindings%2F1&subPath=bindings%2F2', true],
    ] as const)('retains Expo ownership for the unadmitted web location %s%s (desktop=%s)', async (pathname, search, desktop) => {
        boundary.platform = 'web'; boundary.pathname = pathname; boundary.params = {}; boundary.dataReady = false;
        const history = { state: null as unknown, pushState: () => { throw new Error('Unadmitted route must not be projected'); },
            replaceState: (state: unknown, _unused: string, href?: string | URL | null) => {
                if (href) throw new Error('Unadmitted route must not be projected');
                history.state = state;
            } };
        installBrowserBoundary({ location: { pathname, search, hash: '' }, history,
            sessionStorage: { getItem: () => 'main' }, addEventListener: () => {}, removeEventListener: () => {} });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const Body = () => React.createElement('ExpoOwnedBody');
        const screen = await renderScreen(<WorkspaceProvider enabled={desktop} phone={!desktop} catalog={catalog}>
            {navigation => <>{React.createElement('WorkspaceOwner', { navigation })}<WorkspaceRouteEntry Body={Body} /></>}
        </WorkspaceProvider>);
        const navigation = screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        expect(navigation.active).toBe(false);
        expect(screen.root.findAllByType('ExpoOwnedBody')).toHaveLength(1);
        expect(boundary.mirrors).toEqual([]);
    });
    it('keeps an unready native phone route with its stack rather than the web workspace host', async () => {
        boundary.platform = 'ios'; boundary.dataReady = false;
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const Body = () => React.createElement('NativeOwnedDraft');
        const screen = await renderScreen(<WorkspaceProvider enabled={false} phone catalog={catalog}>
            <WorkspaceRouteEntry Body={Body} />
        </WorkspaceProvider>);
        expect(screen.root.findAllByType('NativeOwnedDraft')).toHaveLength(1);
    });
    it.each([[true, '/workflows/new'], [false, '/workflows/new'],
        [false, '/settings/prompts/skills'], [false, '/settings/prompts/templates'],
        [true, '/settings/session/runtime'], [true, '/settings/session/new-session-wizard']] as const)(
        'admits the cold web route once readiness arrives without a throwaway body (desktop=%s, path=%s)', async (desktop, pathname) => {
        boundary.platform = 'web'; boundary.dataReady = false; boundary.pathname = pathname; boundary.params = {};
        const location = { pathname, search: '', hash: '' };
        const history = { state: null as unknown,
            replaceState: (state: unknown) => { history.state = state; },
            pushState: (state: unknown) => { history.state = state; }, go: () => {},
        };
        installBrowserBoundary({ location, history, sessionStorage: { getItem: () => 'main' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: true, friends: false } });
        let mounts = 0;
        const Body = () => {
            const hosted = useDestinationInstanceKey() !== null;
            React.useEffect(() => { mounts += 1; }, []);
            return React.createElement('EditableDraft', { hosted });
        };
        const element = () => <WorkspaceProvider enabled={desktop} phone={!desktop} catalog={catalog}>
            {navigation => {
                const group = navigation.state.groups[navigation.state.focusedGroupId];
                const tab = navigation.state.tabs[group.activeTabId];
                return <>{React.createElement('WorkspaceOwner', { navigation })}
                    <WorkspaceRouteEntry Body={Body} mirror={React.createElement('UrlMirror')} />
                    {navigation.active && <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname={pathname}
                        focused visible navigation={navigation.navigationForTab(tab.id)}><Body /></DestinationInstanceHost>}
                </>;
            }}
        </WorkspaceProvider>;
        const screen = await renderScreen(element());
        expect(screen.root.findByType('WorkspaceOwner').props.navigation.active).toBe(false);
        expect(screen.root.findAllByType('EditableDraft')).toHaveLength(0);
        expect(mounts).toBe(0);
        await act(async () => { boundary.dataReady = true; await screen.update(element()); });
        expect(screen.root.findByType('WorkspaceOwner').props.navigation.active).toBe(true);
        expect(screen.root.findByType('EditableDraft').props.hosted).toBe(true);
        expect(mounts).toBe(1);
        expect(screen.root.findAllByType('UrlMirror')).toHaveLength(1);
        expect(location.pathname).toBe(pathname);
        expect(boundary.mirrors.every(href => href.split('?')[0] === pathname)).toBe(true);
    });
    it.each(['agents/custom', 'connected-services/connect', 'embeds/new', 'account/api-tokens/token-a', 'voice/service', 'personalize',
        'artifacts/new', 'artifacts/edit/document-a', 'workflows/new', 'workflows/edit', 'automations/new', 'boards/board-a', 'inbox',
        'external/browse', 'prompts/skills', 'prompts/templates', 'session/runtime',
        'session/new-session-wizard'])('retains the %s editor across mobile-web/desktop hosting changes', async pageId => {
        const appPage = /^(artifacts|workflows|automations|boards|inbox|external)(\/|$)/.test(pageId);
        const pathname = pageId === 'personalize' || appPage ? `/${pageId}` : `/settings/${pageId}`;
        const search = pageId === 'personalize' ? '?page=conversation' : '';
        boundary.platform = 'web'; boundary.pathname = pathname; boundary.params = {};
        const location = { pathname, search, hash: '' };
        const browserHistory = { state: null as unknown,
            replaceState: (state: unknown, _unused: string, href?: string | URL | null) => { browserHistory.state = state;
                if (!href) return;
                const url = new URL(href, 'https://happier.invalid'); location.pathname = url.pathname; location.search = url.search; location.hash = url.hash; },
            pushState: (state: unknown, unused: string, href: string) => browserHistory.replaceState(state, unused, href), go: () => {},
        };
        installBrowserBoundary({ location, history: browserHistory, sessionStorage: { getItem: () => 'main' } });
        const moduleName = pageId === 'agents/custom' ? 'agents/custom/index'
            : pageId === 'prompts/skills' || pageId === 'prompts/templates' ? `${pageId}/index`
            : pageId === 'account/api-tokens/token-a' ? 'account/api-tokens/[tokenId]' : pageId;
        const appModule = pageId === 'artifacts/edit/document-a' ? 'artifacts/edit/[id]'
            : pageId === 'boards/board-a' ? 'boards/[boardId]' : pageId === 'inbox' ? 'inbox/index'
                : pageId === 'workflows/new' ? 'workflows/[id]/index' : pageId;
        const moduleKey = pageId === 'personalize' || appPage ? `./(app)/${appModule}.tsx` : `./(app)/settings/${moduleName}.tsx`;
        const modules: Record<string, unknown> = {
            './(app)/settings/_layout.tsx': { default: ResizeLayout },
            './(app)/index.tsx': { WorkspaceRouteBody: () => null },
            [moduleKey]: { WorkspaceRouteBody: ResizeEditor },
        };
        registerWorkspaceRouteContext(Object.assign((key: string) => modules[key], { keys: () => Object.keys(modules) }));
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: pageId === 'external/browse', inbox: true, workflows: true, friends: false } });
        let desktop = true;
        const element = () => <WorkspaceProvider enabled={desktop} phone={!desktop} catalog={catalog}>
            {navigation => <>{React.createElement('WorkspaceOwner', { navigation })}<WorkspaceShell catalog={catalog} /></>}
        </WorkspaceProvider>;
        const screen = await renderScreen(element());
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        expect(navigation().active).toBe(true);
        // The native/browser layout boundary admits retained content after its slot is measured.
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('split-canvas-host'), 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 0, width: 1000, height: 600 } },
            });
            const groupId = navigation().state.focusedGroupId;
            invokeTestInstanceHandler(screen.findByTestId(`split-canvas-content-slot-${groupId}`), 'onLayout', {
                nativeEvent: { layout: { x: 0, y: 40, width: 1000, height: 560 } },
            });
        });
        await act(async () => { screen.root.findByType('ResizeEditor').props.setDraft('unsaved draft'); });
        const tabId = navigation().state.groups[navigation().state.focusedGroupId].activeTabId;
        for (const next of [false, true, false]) {
            desktop = next;
            await act(async () => { screen.update(element()); });
            expect(navigation().active).toBe(true);
            expect(navigation().state.groups[navigation().state.focusedGroupId].activeTabId).toBe(tabId);
            expect(screen.root.findByType('ResizeEditor').props.draft).toBe('unsaved draft');
            expect(location.pathname).toBe(pathname);
            expect(location.search).toBe(search);
            if (pageId === 'personalize') expect(screen.root.findByType('ResizeEditor').props.params.page).toBe('conversation');
        }
    });
    it.each(['disabled', 'unready'] as const)('retires a held desktop open when its workspace becomes %s', async transition => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        let enabled = true;
        const element = () => <WorkspaceProvider enabled={enabled} catalog={catalog}>{navigation => React.createElement('WorkspaceOwner', { navigation })}</WorkspaceProvider>;
        const screen = await renderScreen(element());
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        let settleDecision!: (value: 'discard') => void;
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, tag: 'desktop-retirement-test',
            requestDecision: () => new Promise(resolve => { settleDecision = resolve; }) });
        await act(async () => { navigation().openHref('/session/A4?serverId=home-a', { mode: 'newTab' }); });
        await act(async () => { if (transition === 'disabled') enabled = false; else boundary.dataReady = false; screen.update(element()); });
        const before = navigation().state;
        const layouts = boundary.layouts;
        boundary.mirrors = [];
        await act(async () => { settleDecision('discard'); });
        expect(navigation().state).toBe(before);
        expect(boundary.layouts).toBe(layouts);
        expect(boundary.mirrors).toEqual([]);
    });
    it.each(['open', 'activate', 'close', 'bulk-close', 'dispatch', 'back', 'forward'] as const)(
        'retires a held desktop %s continuation before the replacement Account layout is touched', async (operation) => {
            const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
            const tab = (id: string) => ({ id, target: { kind: 'session', params: { id: id.toUpperCase(), serverId: 'home-a' } }, pinned: false, preview: false });
            let saved = createWorkspaceState(tab('a1'));
            for (const id of ['a2', 'a3']) saved = reduceWorkspaceState(saved, { type: 'openTab', groupId: 'group:1', tab: tab(id) });
            saved = reduceWorkspaceState(saved, { type: 'activateTab', groupId: 'group:1', tabId: 'a1' });
            boundary.layouts = Object.fromEntries(['alice', 'bob'].map(accountId => [workspaceLayoutScopeKey({ serverId: 'home-a', accountId, windowId: 'main' }), serializeWorkspaceLayout(saved)]));
            const element = () => <WorkspaceProvider enabled catalog={catalog}>{navigation => React.createElement('WorkspaceOwner', { navigation })}</WorkspaceProvider>;
            const screen = await renderScreen(element());
            const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
            await act(async () => { navigation().activateTab('group:1', 'a2'); navigation().activateTab('group:1', 'a3'); });
            if (operation === 'forward') await act(async () => { navigation().back(); });
            let settleDecision!: (value: 'discard') => void;
            setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, tag: 'desktop-account-custody-test',
                requestDecision: () => new Promise(resolve => { settleDecision = resolve; }) });
            const source = navigation();
            await act(async () => {
                switch (operation) {
                    case 'open': source.openHref('/session/A4?serverId=home-a', { mode: 'newTab' }); break;
                    case 'activate': source.activateTab('group:1', 'a2'); break;
                    case 'close': source.closeTab('group:1', 'a1'); break;
                    case 'bulk-close': source.closeTabs('group:1', ['a1', 'a2']); break;
                    case 'dispatch': source.dispatch({ type: 'openTab', groupId: 'group:1', tab: tab('a4') }); break;
                    case 'back': source.back(); break;
                    case 'forward': source.forward(); break;
                }
            });
            await act(async () => { boundary.scope = { serverId: 'home-a', accountId: 'bob' }; screen.update(element()); });
            const before = navigation().state;
            const layouts = boundary.layouts;
            boundary.mirrors = [];
            await act(async () => { settleDecision('discard'); });
            expect(navigation().state).toBe(before);
            expect(boundary.layouts).toBe(layouts);
            expect(boundary.mirrors).toEqual([]);
        });
    it.each(['home', 'back', 'forward'] as const)('continues the title strip %s through the real workspace after one discard decision', async (operation) => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>{navigation => <>
            {React.createElement('WorkspaceOwner', { navigation })}
            <AppShellTitleStrip columnVisible columnToggleAvailable onToggleColumn={() => {}} navigation={navigation} />
        </>}</WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        await act(async () => { navigation().openHref('/session/A2?serverId=home-a'); navigation().openHref('/session/A3?serverId=home-a'); });
        if (operation === 'forward') await act(async () => { navigation().back(); });
        boundary.mirrors = [];
        const requestDecision = vi.fn(async () => 'discard' as const);
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision, tag: 'title-strip-owner-test' });
        await screen.pressByTestIdAsync(operation === 'home' ? 'app-shell-logo' : `app-shell-${operation}`);
        expect(requestDecision).toHaveBeenCalledOnce();
        expect(boundary.mirrors).toEqual([operation === 'home' ? '/' : `/session/${operation === 'back' ? 'A2' : 'A3'}?serverId=home-a`]);
    });
    it('closes a batch under one discard decision and preserves pinned tabs', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>{navigation => React.createElement('WorkspaceOwner', { navigation })}</WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        await act(async () => {
            for (const id of ['A2', 'A3', 'A4']) navigation().openHref(`/session/${id}?serverId=home-a`, { mode: 'newTab' });
        });
        const state = navigation().state;
        const group = state.groups[state.focusedGroupId];
        const pinnedId = group.tabIds[1];
        await act(async () => { navigation().dispatch({ type: 'setPinned', tabId: pinnedId, pinned: true }); });
        let decision: 'keepEditing' | 'discard' = 'keepEditing';
        const requestDecision = vi.fn(async () => decision);
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision, tag: 'batch-close-test' });
        const before = navigation().state;
        await act(async () => { navigation().closeTabs(group.id, group.tabIds); });
        expect(navigation().state).toBe(before);
        decision = 'discard';
        await act(async () => { navigation().closeTabs(group.id, group.tabIds); });
        expect(requestDecision).toHaveBeenCalledTimes(2);
        expect(navigation().state.groups[group.id].tabIds).toEqual([pinnedId]);
        expect(navigation().state.recentlyClosed).toHaveLength(3);
    });
    it('admits the current browser location when readiness arrives before the Expo URL mirror', async () => {
        boundary.platform = 'web';
        boundary.pathname = '/session/A1';
        boundary.params = { id: 'A1', serverId: 'home-a' };
        boundary.dataReady = false;
        const location = { pathname: '/session/A1', search: '?serverId=home-a', hash: '' };
        const browserHistory = { state: null as unknown,
            replaceState: (state: unknown, _unused: string, href?: string | URL | null) => {
                browserHistory.state = state;
                if (!href) return;
                const url = new URL(href, 'https://happier.invalid');
                location.pathname = url.pathname; location.search = url.search; location.hash = url.hash;
            },
            pushState: (state: unknown, unused: string, href: string) => browserHistory.replaceState(state, unused, href),
            go: () => {},
        };
        installBrowserBoundary({ location, history: browserHistory, sessionStorage: { getItem: () => 'main' },
            addEventListener: () => {}, removeEventListener: () => {} });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>
            {navigation => React.createElement('WorkspaceOwner', { navigation })}
        </WorkspaceProvider>);
        expect(screen.root.findByType('WorkspaceOwner').props.navigation.active).toBe(false);
        await act(async () => {
            // Browser navigation is authoritative even while Expo still presents A1's mirror inputs.
            location.pathname = '/session/A2';
            boundary.dataReady = true;
        });
        const navigation = screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const group = navigation.state.groups[navigation.state.focusedGroupId];
        expect(navigation.state.tabs[group.activeTabId].target.params.id).toBe('A2');
        expect(location.pathname).toBe('/session/A2');
    });
    it('admits the initial route over a restored layout without persisting until an explicit navigation', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const saved = createWorkspaceState({ id: 'saved', target: { kind: 'session', params: { id: 'saved', serverId: 'home-a' } }, pinned: true, preview: false });
        boundary.layouts = { [workspaceLayoutScopeKey({ ...boundary.scope, windowId: 'main' })]: saved };
        const layouts = boundary.layouts;
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>{navigation => <NavigationProbe navigation={navigation} />}</WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const state = navigation().state;
        expect(state.tabs[state.groups[state.focusedGroupId].activeTabId].target.params.id).toBe('A1');
        expect(state.tabs.saved).toBeDefined();
        expect(boundary.layouts).toBe(layouts);
        act(() => { navigation().openHref('/session/A2?serverId=home-a', { mode: 'newTab' }); });
        expect(boundary.layouts).not.toBe(layouts);
        expect(Object.values(boundary.layouts)[0]).toEqual(serializeWorkspaceLayout(navigation().state));
        await screen.unmount();
    });
    it('keeps an initial deep link selected when shared tabs hydrate afterwards', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>
            {navigation => React.createElement('WorkspaceOwner', { navigation })}
        </WorkspaceProvider>);
        const state = (screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue).state;
        const initialId = state.groups[state.focusedGroupId].activeTabId;
        const remote = { id: 'saved-machine', target: { kind: 'settings', params: { pageId: 'machines/machine-a', id: 'machine-a' } }, pinned: false };
        const hydrated = reconcileWorkspaceSyncedTabs(state, { v: 1, tabsById: { [remote.id]: remote }, order: [remote.id], pairs: [] }, () => 'blank');
        expect(hydrated.groups[hydrated.focusedGroupId].activeTabId).toBe(initialId);
        expect(hydrated.tabs[initialId].target.params.id).toBe('A1');
    });
    it('binds tab commands only while active and uses the current focused group through mounted Actions', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        let invoke: (command: KeyboardCommandId) => boolean = () => false;
        function Commands() { invoke = useKeyboardCommand(); return null; }
        let enabled = true;
        const element = () => <KeyboardShortcutProvider handlers={{}}><Commands /><WorkspaceProvider enabled={enabled} catalog={catalog}>
            {(navigation) => React.createElement('WorkspaceOwner', { navigation })}
        </WorkspaceProvider></KeyboardShortcutProvider>;
        const screen = await renderScreen(element());
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const state = () => navigation().state;
        const originalGroupId = state().focusedGroupId;
        const originalTabId = state().groups[originalGroupId].activeTabId;
        await act(async () => { expect(invoke('workspace.tab.new')).toBe(true); });
        const emptyTabId = state().groups[originalGroupId].activeTabId;
        expect(state().tabs[emptyTabId]).toMatchObject({ target: { kind: 'newTab' }, preview: false });
        expect(emptyTabId).not.toBe(originalTabId);
        await act(async () => { navigation().dispatch({ type: 'splitTab', tabId: emptyTabId, sourceGroupId: originalGroupId,
            targetGroupId: originalGroupId, newGroupId: 'other-group', axis: 'row', placement: 'after',
            availableSizePx: 1600, minimumFirstSizePx: 320, minimumSecondSizePx: 320 }); });
        expect(state().focusedGroupId).toBe('other-group');
        await act(async () => { expect(invoke('workspace.tab.new')).toBe(true); });
        expect(state().groups[originalGroupId].tabIds).toEqual([originalTabId]);
        const lastTabId = state().groups['other-group'].activeTabId;
        await act(async () => { expect(invoke('workspace.tab.select1')).toBe(true); });
        expect(state().groups['other-group'].activeTabId).toBe(emptyTabId);
        await act(async () => { expect(invoke('workspace.tab.select9')).toBe(true); });
        expect(state().groups['other-group'].activeTabId).toBe(lastTabId);
        const beforeOutOfRange = state();
        await act(async () => { invoke('workspace.tab.select8'); });
        expect(state()).toBe(beforeOutOfRange);
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision: async () => 'keepEditing', tag: 'workspace-keyboard-test' });
        await act(async () => { invoke('workspace.tab.close'); });
        expect(state()).toBe(beforeOutOfRange);
        clearActiveUnsavedChangesGuard();
        await act(async () => { invoke('workspace.tab.close'); invoke('workspace.tab.close'); });
        expect(state().groups['other-group']).toBeUndefined();
        expect(state().focusedGroupId).toBe(originalGroupId);
        expect(state().groups[originalGroupId].tabIds).toEqual([originalTabId]);
        await act(async () => { invoke('workspace.tab.close'); });
        expect(state().groups[originalGroupId].tabIds).toHaveLength(1);
        expect(state().tabs[state().groups[originalGroupId].activeTabId].target.kind).toBe('newTab');
        const closedState = state();
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision: async () => 'keepEditing', tag: 'workspace-reopen-test' });
        await act(async () => { expect(invoke('workspace.tab.reopen')).toBe(true); });
        expect(state()).toBe(closedState);
        clearActiveUnsavedChangesGuard();
        await act(async () => { invoke('workspace.tab.reopen'); });
        expect(state().groups[originalGroupId].activeTabId).toBe(originalTabId);
        expect(state().recentlyClosed).toEqual([]);
        enabled = false;
        await act(async () => { screen.update(element()); });
        expect(invoke('workspace.tab.new')).toBe(false);
        expect(invoke('workspace.tab.close')).toBe(false);
        expect(invoke('workspace.tab.reopen')).toBe(false);
        expect(invoke('workspace.tab.select1')).toBe(false);
    });
    it('does not carry a guarded Action into the replacement Account workspace', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const element = () => <WorkspaceProvider enabled catalog={catalog}>
            {(navigation) => React.createElement('WorkspaceOwner', { navigation })}
        </WorkspaceProvider>;
        const screen = await renderScreen(element());
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        await act(async () => {
            const state = navigation().state;
            const group = state.groups[state.focusedGroupId];
            navigation().closeTab(group.id, group.activeTabId);
        });
        expect(WORKSPACE_ACTION_OUTPUT_SCHEMAS['workspace.tabs.closed.list'].parse(await invokeWorkspaceAction({ actionId: 'workspace.tabs.closed.list', input: {} })).tabs).toHaveLength(1);
        const mounted = captureMountedWorkspaceAction();
        let settleDecision!: (value: 'discard') => void;
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, tag: 'account-change-test',
            requestDecision: () => new Promise((resolve) => { settleDecision = resolve; }) });
        const pending = invokeWorkspaceAction({ actionId: 'workspace.tabs.reopen', input: {} });
        await act(async () => {
            boundary.scope = { serverId: 'home-a', accountId: 'bob' };
            screen.update(element());
        });
        await act(async () => { settleDecision('discard'); });
        expect(await pending).toMatchObject({ ok: false, errorCode: 'workspace_unavailable' });
        expect(await mounted?.({ actionId: 'workspace.tabs.list', input: {} })).toMatchObject({ ok: false, errorCode: 'workspace_unavailable' });
        const listed = WORKSPACE_ACTION_OUTPUT_SCHEMAS['workspace.tabs.list'].parse(await invokeWorkspaceAction({ actionId: 'workspace.tabs.list', input: {} }));
        expect(listed.tabs).toHaveLength(1);
        expect(WORKSPACE_ACTION_OUTPUT_SCHEMAS['workspace.tabs.closed.list'].parse(await invokeWorkspaceAction({ actionId: 'workspace.tabs.closed.list', input: {} })).tabs).toEqual([]);
    });
    it('splits an explicitly selected inactive-group tab through the mounted measured canvas and resizes that split', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        let showCanvas = false;
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>
            {(navigation) => <>{React.createElement('WorkspaceOwner', { navigation })}
                {showCanvas ? <WorkspaceShell catalog={catalog} /> : null}</>}
        </WorkspaceProvider>);
        const state = () => (screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue).state;
        const sourceGroupId = state().focusedGroupId;
        await act(async () => {
            const navigation = screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
            navigation.dispatch({ type: 'setTarget', tabId: state().groups[sourceGroupId].activeTabId, target: { kind: 'newTab', params: {} } });
            showCanvas = true;
            expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.open', input: {} })).toMatchObject({ ok: true });
        });
        const inactiveTabId = state().groups[sourceGroupId].activeTabId;
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.open', input: {} })).toMatchObject({ ok: true });
            invokeTestInstanceHandler(screen.findByTestId('split-canvas-host'), 'onLayout', { nativeEvent: { layout: { width: 3000, height: 1000 } } });
        });
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.split', input: { direction: 'right' } })).toMatchObject({ ok: true });
        });
        const previouslyFocusedGroupId = state().focusedGroupId;
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.split', input: { tabId: inactiveTabId, direction: 'down' } })).toMatchObject({ ok: true });
        });
        const root = state().root;
        expect(root).toMatchObject({ kind: 'split', first: { kind: 'split', axis: 'column' }, second: { id: previouslyFocusedGroupId, kind: 'leaf' } });
        expect(state().groups[state().focusedGroupId].tabIds).toEqual([inactiveTabId]);
        if (root.kind !== 'split' || root.first.kind !== 'split') throw new Error('The source group must own the new split');
        const splitId = root.first.id;
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.resize', input: { splitId, ratio: 0.65 } }))
                .toMatchObject({ ok: false, errorCode: 'workspace_layout_unmeasured' });
            invokeTestInstanceHandler(screen.findByTestId(`split-canvas-split-${splitId}`), 'onLayout',
                { nativeEvent: { layout: { width: 1497, height: 1000 } } });
        });
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.resize', input: { splitId, ratio: 0.65 } })).toMatchObject({ ok: true });
        });
        expect(state().root).toMatchObject({ first: { id: splitId, ratio: 0.65 } });
        const listed = WORKSPACE_ACTION_OUTPUT_SCHEMAS['workspace.tabs.list'].parse(await invokeWorkspaceAction({ actionId: 'workspace.tabs.list', input: {} }));
        expect(listed.tabs.find((tab) => tab.id === inactiveTabId)?.groupId).toBe(state().focusedGroupId);
        expect(listed.rootNodeId).toBe(state().root.id);
        expect(listed.splits).toEqual(expect.arrayContaining([expect.objectContaining({ id: splitId, axis: 'column', ratio: 0.65,
            firstNodeId: root.first.first.id, secondNodeId: root.first.second.id })]));
    });
    it('executes mounted Actions against real tabs, honors cancellation and retires with its owner', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>
            {(navigation) => React.createElement('WorkspaceOwner', { navigation })}
        </WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        const originalId = navigation().state.groups[navigation().state.focusedGroupId].activeTabId;
        const mounted = captureMountedWorkspaceAction();
        expect(mounted).not.toBeNull();
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.open', input: { href: '/session/B1?serverId=home-b', mode: 'newTab' } })).toMatchObject({ ok: true });
        });
        const newId = navigation().state.groups[navigation().state.focusedGroupId].activeTabId;
        expect(newId).not.toBe(originalId);
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.pin', input: { tabId: newId, pinned: true } })).toMatchObject({ ok: true });
            expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.open', input: { tabId: originalId, href: '/session/C1?serverId=home-c' } })).toMatchObject({ ok: true });
        });
        expect(navigation().state.tabs[newId]).toMatchObject({ pinned: true, target: { params: { id: 'B1', serverId: 'home-b' } } });
        expect(navigation().state.tabs[originalId].target.params).toEqual({ id: 'C1', serverId: 'home-c' });
        expect(Object.keys(navigation().state.tabs)).toHaveLength(2);
        const before = navigation().state;
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision: async () => 'keepEditing', tag: 'workspace-action-test' });
        await act(async () => {
            expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.close', input: { tabId: originalId } })).toMatchObject({ ok: false, errorCode: 'workspace_navigation_cancelled' });
        });
        expect(navigation().state).toBe(before);
        clearActiveUnsavedChangesGuard();
        expect(await invokeWorkspaceAction({ actionId: 'workspace.split', input: { direction: 'right' } })).toMatchObject({ ok: false, errorCode: 'workspace_layout_unmeasured' });
        await act(async () => { screen.unmount(); });
        expect(await invokeWorkspaceAction({ actionId: 'workspace.tabs.list', input: {} })).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        expect(await mounted?.({ actionId: 'workspace.tabs.open', input: {} })).toMatchObject({ ok: false, errorCode: 'workspace_unavailable' });
    });
    it('routes hosted actions and cross-tab history through one owner with scoped server identity', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>
            {(navigation) => <NavigationProbe navigation={navigation} />}
        </WorkspaceProvider>);
        const navigation = () => screen.root.findByType('WorkspaceOwner').props.navigation as WorkspaceNavigationContextValue;
        expect(navigation().active).toBe(true);
        expect(screen.root.findByType('HostedIdentity').props.params).toEqual({ id: 'A1', serverId: 'home-a' });
        await act(async () => { screen.root.findByType('HostedIdentity').props.next(); });
        await act(async () => { navigation().openHref('/session/B1?serverId=home-b', { mode: 'newTab' }); });
        for (const [direction, id, serverId] of [['back', 'A2', 'home-a'], ['back', 'A1', 'home-a'], ['forward', 'A2', 'home-a'], ['forward', 'B1', 'home-b']] as const) {
            await act(async () => { navigation()[direction](); });
            expect(screen.root.findByType('HostedIdentity').props.params).toEqual({ id, serverId });
            expect(boundary.mirrors.at(-1)).toBe(`/session/${id}?serverId=${serverId}`);
        }
    });
});
