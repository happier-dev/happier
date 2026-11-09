import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createRootLayoutFeaturesResponse, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { InboxSummaryProvider } from '@/hooks/inbox/useInboxSummary';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionNavigationCursor } from '@/sync/domains/session/navigation/sessionNavigationCursor';
import { clearSessionNavigationCursor, publishSessionNavigationCursor } from '@/sync/domains/session/navigation/sessionNavigationCursorStore';
import '@/sync/syncEngine';

import { PresentedProjectChromeFixture, PresentedSessionChromeFixture, type ProjectChromeFixtureModel } from '@/dev/testkit/harness/presentedDetailChrome';
import { resolveProjectPageCatalogState } from '@/components/projects/detail/projectPageCatalog';
import { readProjectWidgetAreaContextV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { DiscussionPaneHost } from '@/components/discussions/DiscussionRightSidebar';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useSessionCockpitChromeRegister } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { resolveSessionCockpitMobileCatalog } from '@/components/workspaceCockpit/session/sessionCockpitMobileCatalog';
import type { DiscussionMobileSurface } from '@/components/workspaceCockpit/discussion/discussionCockpitState';
let sessionChrome: string | null = null;
function SessionPublisher() {
    const register = useSessionCockpitChromeRegister();
    const sessionId = sessionChrome;
    React.useEffect(() => sessionId ? register({ sessionId, activeSurface: 'chat', terminalTabAvailable: false,
        openDetailsTabCount: 0, catalog: resolveSessionCockpitMobileCatalog({ terminalTabAvailable: false }),
        readColumn: () => ({ present: true, visible: true, available: true, setVisible: () => {} }),
        switchSurface: () => {},
    }) : undefined, [register, sessionId]);
    return null;
}
let discussionChrome: { id: string; surface: DiscussionMobileSurface; select: (surface: DiscussionMobileSurface) => void } | null = null;
function DiscussionPublisher() {
    return discussionChrome ? <AppPaneProvider><DiscussionPaneHost discussionId={discussionChrome.id}
        scope={captureActiveServerAccountScopeLifetime()?.scope ?? null} paneEnabled={false}
        phoneSurface={discussionChrome.surface} onSurfaceChange={discussionChrome.select} main={null} /></AppPaneProvider> : null;
}
let projectChrome: ProjectChromeFixtureModel | null = null;
function ProjectPublisher() {
    return projectChrome ? <PresentedProjectChromeFixture catalog={projectChrome} /> : null;
}
const route = vi.hoisted(() => ({ pathname: '/', params: {} as Record<string, string | undefined>,
    listeners: new Set<() => void>(), resetParams: () => {} }));
const device = vi.hoisted(() => ({ width: 390, height: 844, isPad: false }));
const keyboard = vi.hoisted(() => ({ listeners: new Map<string, Set<(event: unknown) => void>>() }));
const native = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
const navigation = vi.hoisted(() => ({ replace: vi.fn(), navigate: vi.fn(), setParams: vi.fn(), push: vi.fn() }));

vi.mock('expo-router', async () => {
    const base = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        pathname: () => route.pathname, params: () => route.params, router: { ...navigation },
    });
    route.resetParams = base.resetParams;
    return { ...base.module, usePathname: () => React.useSyncExternalStore(listener => {
        route.listeners.add(listener); return () => { route.listeners.delete(listener); };
    }, () => route.pathname) };
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
    { platformOS: 'ios' }, {
        Platform: { get isPad() { return device.isPad; } },
        useWindowDimensions: () => ({ width: device.width, height: device.height, scale: 3, fontScale: 1 }),
        Keyboard: {
            addListener: (name: string, callback: (event: unknown) => void) => {
                const listeners = keyboard.listeners.get(name) ?? new Set();
                listeners.add(callback); keyboard.listeners.set(name, listeners);
                return { remove: () => listeners.delete(callback) };
            },
            dismiss() {}, isVisible: () => false,
        },
    },
));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// Only UIKit/Expo are replaced: routing, normalization, definitions, settings and registries stay real.
vi.mock('expo-modules-core', async importOriginal => {
    const original = await importOriginal<typeof import('expo-modules-core')>();
    const React = await import('react');
    const Rail = (props: Record<string, unknown>) => {
        React.useLayoutEffect(() => { native.mounts++; return () => { native.unmounts++; }; }, []);
        return React.createElement('NativeSystemTabBar', props);
    };
    const Fold = (props: Record<string, unknown>) => React.createElement('NativeFoldObserver', props);
    return { ...original,
        requireOptionalNativeModule: (name: string) => name === 'HappierSystemTabBar' || name === 'HappierWindowFoldMetrics' ? {} : null,
        requireNativeViewManager: (name: string) => name === 'HappierSystemTabBar' ? Rail : Fold,
    };
});

installDisconnectedServerSocketBoundary();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
const settings = { ...settingsDefaults, mobileWorkspaceExperienceV1: 'cockpit' as const };

beforeEach(async () => {
    route.pathname = '/'; route.params = {};
    route.resetParams();
    device.width = 390; device.height = 844; device.isPad = false;
    native.mounts = 0; native.unmounts = 0; keyboard.listeners.clear();
    vi.clearAllMocks();
    const artifact = createHomeHubArtifactHttpBoundary('rail-account');
    connection = await restoreServerAccountForTest({
        serverUrl: 'https://rail.test', accountId: 'rail-account',
        request: (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v2/account/settings') return Promise.resolve(Response.json({ content: { t: 'plain', v: settings }, version: 1 }));
            if (path === '/v1/features') return Promise.resolve(Response.json(createRootLayoutFeaturesResponse()));
            if (path === '/v1/kv/bulk') return Promise.resolve(Response.json({ values: [] }));
            const bootstrap = createEmptyAccountBootstrapHttpResponse(path, init);
            if (bootstrap) return Promise.resolve(bootstrap);
            return artifact.request(url, init);
        },
    });
    route.params.serverId = connection.home.id;
    await flushHookEffects({ cycles: 3 });
    storage.setState({ isDataReady: true, settings, localSettings: { ...storage.getState().localSettings, systemTabBarEnabled: true } });
});
afterEach(async () => {
    clearSessionNavigationCursor();
    standardCleanup(); projectChrome = null; discussionChrome = null; sessionChrome = null; await connection?.dispose(); connection = undefined;
});

async function createHarness() {
    const { WindowFoldMetricsProvider } = await import('@/utils/platform/useWindowFoldMetrics');
    const { MainAppTabStateProvider } = await import('./MainAppTabStateProvider');
    const { SessionCockpitChromeRegistryProvider } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
    const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
    function Harness() {
        return <InjectedAuthProvider credentials={connection!.credentials}>
            <InboxSummaryProvider><WindowFoldMetricsProvider><MainAppTabStateProvider>
                <SessionCockpitChromeRegistryProvider><ProjectPublisher /><DiscussionPublisher /><SessionPublisher /><PresentedSessionChromeFixture /><MobileBottomChromeHost /></SessionCockpitChromeRegistryProvider>
            </MainAppTabStateProvider></WindowFoldMetricsProvider></InboxSummaryProvider>
        </InjectedAuthProvider>;
    }
    const screen = await renderScreen(<Harness />);
    const update = async () => {
        await act(async () => { route.resetParams(); for (const listener of route.listeners) listener(); });
        await screen.update(<Harness />);
    };
    const setEdge = async (edge: string | null) => {
        await act(async () => screen.tree.root.findByType('NativeFoldObserver' as never).props.onMetricsChange({
            nativeEvent: { width: device.width, height: device.height, divisions: [], verticalBarEdge: edge },
        }));
    };
    const bars = () => screen.tree.root.findAllByType('NativeSystemTabBar' as never);
    return { screen, update, setEdge, bars };
}

describe('system bottom chrome through the real host', () => {
    it('routes native swipes and accessibility steps through the Session order, respecting disabled and hidden input', async () => {
        const serverId = connection!.home.id;
        const sessions = ['newer', 'current', 'older'].map(id => createSessionFixture({ id, serverId }));
        storage.setState({ sessions: Object.fromEntries(sessions.map(session => [session.id, session])), settings: {
            ...storage.getState().settings, sessionCockpitSwipeNavigationEnabled: true,
            sessionCockpitSwipeAlwaysSessionsEnabled: true, sessionCockpitSwipeSource: 'list',
        } });
        publishSessionNavigationCursor(buildSessionNavigationCursor({
            identity: { origin: 'session-list', sourceScopeKey: 'native-bar', storageKind: 'all' },
            items: sessions.map(session => ({ type: 'session', sessionId: session.id, serverId })), nowMs: 0,
        })!);
        sessionChrome = 'current'; route.pathname = '/session/current';
        const h = await createHarness(); await h.setEdge('trailing');
        const bar = () => h.bars()[0]!;
        const send = async (direction: 'previous' | 'next', source: 'swipe' | 'accessibility' = 'swipe', distance = 100) => {
            const translationX = direction === 'next' ? distance : -distance;
            await act(async () => bar().props.onSessionNavigate({ nativeEvent: {
                direction, source, translationX, translationY: 0, velocityX: 0, maxAbsTranslationX: distance,
            } }));
        };
        expect(bar().props.sessionSwipeEnabled).toBe(true);
        await send('next', 'swipe', 20);
        expect(navigation.navigate).not.toHaveBeenCalled();
        await send('next');
        expect(navigation.navigate).toHaveBeenLastCalledWith(`/session/older?serverId=${encodeURIComponent(serverId)}`, expect.any(Object));
        await send('previous');
        expect(navigation.navigate).toHaveBeenLastCalledWith(`/session/newer?serverId=${encodeURIComponent(serverId)}`, expect.any(Object));
        navigation.navigate.mockClear();
        await act(async () => { for (const listener of keyboard.listeners.get('keyboardWillShow') ?? []) listener({}); });
        expect(bar().props.sessionSwipeEnabled).toBe(false);
        expect(bar().props.sessionNavigationLabels).toBeNull();
        await send('next'); expect(navigation.navigate).not.toHaveBeenCalled();
        await act(async () => { for (const listener of keyboard.listeners.get('keyboardWillHide') ?? []) listener({}); });
        expect(bar().props.sessionSwipeEnabled).toBe(true);
        await act(async () => storage.setState({ settings: { ...storage.getState().settings, sessionCockpitSwipeNavigationEnabled: false } }));
        expect(bar().props.sessionSwipeEnabled).toBe(false);
        navigation.navigate.mockClear();
        await send('next'); expect(navigation.navigate).not.toHaveBeenCalled();
        expect(bar().props.sessionNavigationLabels).toEqual({ previous: expect.any(String), next: expect.any(String) });
        await send('next', 'accessibility');
        expect(navigation.navigate).toHaveBeenLastCalledWith(`/session/older?serverId=${encodeURIComponent(serverId)}`, expect.any(Object));
        navigation.navigate.mockClear();
        sessionChrome = null; route.pathname = '/account'; await h.update();
        expect(bar().props.hidden).toBe(true);
        expect(bar().props.sessionSwipeEnabled).toBe(false);
        expect(bar().props.sessionNavigationLabels).toBeNull();
        await send('next', 'accessibility'); expect(navigation.navigate).not.toHaveBeenCalled();
    });

    it('renders main definitions including Projects and preserves one anchor across keyboard, hidden routes and family changes', async () => {
        const h = await createHarness();
        await h.setEdge('trailing');
        expect(h.bars()).toHaveLength(1);
        const bar = h.bars()[0]!;
        expect(bar.props.items.map((item: { id: string }) => item.id)).toEqual(['sessions', 'projects', 'inbox', 'workflows', 'more', 'newSession']);
        expect(bar.props.items.find((item: { id: string }) => item.id === 'projects')).toMatchObject({ title: expect.any(String), sfSymbol: 'folder' });
        expect(bar.props.hidden).toBe(false);
        await act(async () => {
            for (const listener of keyboard.listeners.get('keyboardWillShow') ?? []) listener({
                duration: 250, easing: 'keyboard', endCoordinates: { screenX: 0, screenY: 574, width: 390, height: 270 },
            });
        });
        expect(h.bars()[0]).toBe(bar); expect(bar.props.hidden).toBe(false);
        route.pathname = '/account'; await h.update();
        expect(h.bars()[0]).toBe(bar); expect(bar.props.hidden).toBe(true);
        route.pathname = '/'; await h.update();
        expect(h.bars()[0]).toBe(bar); expect(bar.props.hidden).toBe(false);
        discussionChrome = { id: 'discussion-1', surface: 'chat', select: surface => {
            discussionChrome = { ...discussionChrome!, surface, select: discussionChrome!.select };
        } };
        route.pathname = '/discussions/discussion-1'; await h.update();
        expect(h.bars()[0]).toBe(bar);
        expect(bar.props.items.map((item: { id: string }) => item.id)).toEqual(['chat', 'participants', 'agents', 'details', 'more']);
        await act(async () => bar.props.onTabPress({ nativeEvent: { id: 'unknown' } }));
        expect(bar.props.selectedId).toBe('chat');
        await act(async () => bar.props.onTabPress({ nativeEvent: { id: 'participants' } }));
        await vi.waitFor(() => expect(discussionChrome?.surface).toBe('participants'));
        await h.update();
        expect(discussionChrome.surface).toBe('participants');
        expect(bar.props.selectedId).toBe('participants');
        discussionChrome = null;
        route.pathname = '/session/session-1'; route.params.mobileSurface = undefined; await h.update();
        expect(bar.props.items.map((item: { id: string }) => item.id)).not.toContain('browse');
        sessionChrome = 'session-1'; await h.update();
        expect(h.bars()[0]).toBe(bar);
        expect(bar.props.items.map((item: { id: string }) => item.id)).toContain('browse');
        sessionChrome = null;
        const target = { kind: 'project' as const, workspaceRefId: 'family-project', serverId: connection!.home.id };
        const catalog = resolveProjectPageCatalogState({ target });
        projectChrome = { ...catalog, target, activePageId: 'overview', activeSurface: 'overview', terminalTabAvailable: false,
            scopeId: 'family-project', context: readProjectWidgetAreaContextV1({ serverId: target.serverId }), projection: null,
            authority: captureActiveServerAccountScopeLifetime(),
        };
        route.pathname = '/projects/project-1'; await h.update();
        expect(h.bars()[0]).toBe(bar);
        expect(bar.props.items.map((item: { id: string }) => item.id)).toContain('overview');
        expect(native).toEqual({ mounts: 1, unmounts: 0 });
    });

    it('waits for a first visible model, then deactivates only on setting, edge or tablet disqualification', async () => {
        route.pathname = '/account';
        const h = await createHarness(); await h.setEdge('trailing');
        expect(h.bars()).toHaveLength(0);
        route.pathname = '/'; await h.update(); expect(h.bars()).toHaveLength(1);
        await act(async () => storage.setState({ localSettings: { ...storage.getState().localSettings, systemTabBarEnabled: false } }));
        expect(h.bars()).toHaveLength(0); expect(h.screen.findHostByTestId('tabbar-tab-projects')).not.toBeNull();
        await act(async () => storage.setState({ localSettings: { ...storage.getState().localSettings, systemTabBarEnabled: true } }));
        expect(h.bars()).toHaveLength(1);
        await h.setEdge(null); expect(h.bars()).toHaveLength(0);
        device.isPad = true; device.width = 1128; await h.setEdge('trailing'); await h.update();
        expect(h.bars()).toHaveLength(0);
    });
});


it('presents the mounted Project through native chrome, shares Action identities and keeps top mode to one bottom More', async () => {
    const serverId = connection!.home.id;
    const target = { kind: 'project' as const, workspaceRefId: 'mounted-project', serverId };
    const catalog = resolveProjectPageCatalogState({ target, sidebar: { presentation: 'mobile', terminalTabAvailable: true } });
    const effects: string[] = [];
    projectChrome = { ...catalog, target, activePageId: 'changes', activeSurface: 'changes', terminalTabAvailable: true,
        scopeId: 'project-mounted-scope', context: readProjectWidgetAreaContextV1({ serverId }), projection: null,
        authority: captureActiveServerAccountScopeLifetime(),
        onSelect: (column, id) => effects.push(`${column}:${id}`),
    };
    // Expo still names another route. The visible Project supplies identity and restored selection.
    route.pathname = '/projects/stale/overview';
    const h = await createHarness();
    await h.setEdge('trailing');
    const bar = () => h.bars()[0]!;
    expect(h.bars()).toHaveLength(1);
    expect(bar().props.selectedId).toBe('changes');
    await act(async () => { bar().props.onTabPress({ nativeEvent: { id: 'overview' } }); });
    await vi.waitFor(() => expect(effects).toEqual(['main:overview']));
    const before = native.mounts;
    await act(async () => { storage.setState({ localSettings: { ...storage.getState().localSettings,
        navigationSurfacePlacementsV1: { pageTabs: { project: 'top' }, detailPages: { project: { phone: { items: {
            orderedIds: ['overview', 'changes', 'terminal'], placements: { terminal: 'pinned', tabs: 'overflow' },
        } } } } },
    } }); });
    expect(h.bars()).toHaveLength(1);
    expect(native.mounts).toBe(before);
    const ids = bar().props.items.map((item: { id: string }) => item.id);
    expect(ids.filter((id: string) => id === 'more')).toHaveLength(1);
    expect(ids).toContain('terminal');
    expect(ids).not.toContain('changes');
    await act(async () => { bar().props.onTabPress({ nativeEvent: { id: 'terminal' } }); });
    await vi.waitFor(() => expect(effects).toEqual(['main:overview', 'side:terminal']));
    await act(async () => { storage.setState({ settings: { ...storage.getState().settings, mobileWorkspaceExperienceV1: 'classic' } }); });
    await h.update();
    expect(bar().props.hidden).toBe(true);
});


it('projects mounted Discussion phone placement to native chrome and selects through one column effect', async () => {
    const effects: DiscussionMobileSurface[] = [];
    discussionChrome = { id: 'mounted-thread', surface: 'chat', select: surface => effects.push(surface) };
    route.pathname = '/discussions/stale-thread';
    const workspaceRail = { orderedIds: [], placements: { discussionParticipants: 'hidden' as const } };
    storage.setState({ localSettings: { ...storage.getState().localSettings, navigationSurfacePlacementsV1: {
        workspaceRail, detailPages: { discussion: { phone: { items: { orderedIds: [],
            placements: { discussionAgents: 'hidden', discussionDetails: 'overflow' } } } } },
    } } });
    const h = await createHarness();
    await h.setEdge('trailing');
    expect(h.bars()).toHaveLength(1);
    const bar = h.bars()[0]!;
    expect(bar.props.items.map((item: { id: string }) => item.id)).toEqual(['chat', 'participants', 'more']);
    await act(async () => bar.props.onTabPress({ nativeEvent: { id: 'participants' } }));
    await vi.waitFor(() => expect(effects).toEqual(['participants']));
    const mounts = native.mounts;
    await act(async () => storage.setState({ localSettings: { ...storage.getState().localSettings,
        navigationSurfacePlacementsV1: { workspaceRail, pageTabs: { discussion: 'top' },
            detailPages: { discussion: { phone: { items: { orderedIds: [],
                placements: { discussionAgents: 'hidden', discussionDetails: 'pinned' } } } } } },
    } }));
    expect(bar.props.items.map((item: { id: string }) => item.id)).toEqual(['chat', 'participants', 'details', 'more']);
    expect(native.mounts).toBe(mounts);
    expect(storage.getState().localSettings.navigationSurfacePlacementsV1.workspaceRail).toBe(workspaceRail);
    await act(async () => storage.setState({ settings: { ...storage.getState().settings, mobileWorkspaceExperienceV1: 'classic' } }));
    await h.update();
    expect(bar.props.hidden).toBe(true);
});
