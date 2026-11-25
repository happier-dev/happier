import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { createConcurrentCacheNetworkHarness } from '@/dev/testkit/harness/concurrentCacheNetworkHarness';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import type { SharedWorkspaceTabs } from './workspaceSyncedTabs';
import type { WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';

// Expo is the navigator boundary; the workspace owner, Account sync and KV transport stay real.
const route = vi.hoisted(() => ({ pathname: '/', params: {} as Record<string, string> }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: () => route.pathname, params: () => route.params,
}).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
    Dimensions: { get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }), addEventListener: () => ({ remove() {} }) },
}));
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected vendor Markdown reveal in workspace restore test'); },
}));

// Keep the cockpit router and focus real. Browser history and the native tab view are test-renderer boundaries.
vi.mock('@react-navigation/native', async importOriginal => {
    const navigation = await importOriginal<typeof import('@react-navigation/native')>();
    return { ...navigation, NavigationContainer: ({ theme, children, onStateChange }:
        React.ComponentProps<typeof navigation.NavigationContainer>) => (
        <navigation.BaseNavigationContainer theme={theme ?? navigation.DefaultTheme} onStateChange={onStateChange}>
            {children}
        </navigation.BaseNavigationContainer>
    ) };
});
vi.mock('@react-navigation/bottom-tabs', () => ({
    BottomTabView: ({ state, descriptors, navigation, tabBar }: Readonly<{
        state: { index: number; routes: readonly { key: string }[] };
        descriptors: Readonly<Record<string, { render: () => React.ReactNode }>>;
        navigation: unknown;
        tabBar: (props: object) => React.ReactNode;
    }>) => <>{descriptors[state.routes[state.index].key].render()}{tabBar({ state, descriptors, navigation })}</>,
}));

// The network harness replaces HTTP, Socket.IO and OS credential custody.
const homes = await createConcurrentCacheNetworkHarness('workspace-shared-tabs-delivery');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { dispatchKvBatchUpdate } = await import('@/sync/engine/socket/kvUpdateDispatcher');
const { resolveCompactAppDestinations } = await import('../destinations/compactAppDestinationCatalog');
const { WorkspaceProvider } = await import('./WorkspaceProvider');
const { useOptionalWorkspaceNavigation } = await import('./WorkspaceNavigationContext');

const catalog = resolveCompactAppDestinations({ pages: [], builtins: { workflows: true, inbox: false, friends: false, externalSessions: false } });
const sharedRecord = (pageId: string): SharedWorkspaceTabs => ({ v: 1,
    tabsById: { peer: { id: 'peer', target: { kind: 'settings', params: { pageId } }, pinned: true } }, order: ['peer'], pairs: [] });

const published: WorkspaceNavigationContextValue[] = [];
function NavigationConsumer() {
    const navigation = useOptionalWorkspaceNavigation();
    if (navigation) published.push(navigation);
    return null;
}

describe('workspace navigation delivery of shared tab records', () => {
    beforeEach(async () => {
        published.length = 0;
        route.pathname = '/';
        route.params = {};
        await homes.reset();
        await homes.startFocused();
    });
    afterEach(async () => { await standardCleanup(); await homes.cleanup(); });
    afterAll(async () => { await homes.dispose(); });

    it('keeps the navigation value when a peer record leaves this window unchanged', async () => {
        const credentials = { token: homes.homeA.token };
        let stored = sharedRecord('appearance');
        let version = 1;
        let reads = 0;
        const keyPath = '/v1/kv/bulk';
        homes.setResponder(async input => {
            if (new URL(String(input)).pathname !== keyPath) return null;
            reads++;
            return Response.json({ values: [{ key: 'workspace:tabs:v1', value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: stored }), version }] });
        });
        await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <WorkspaceProvider enabled catalog={catalog}><NavigationConsumer /></WorkspaceProvider>
        </InjectedAuthProvider>);
        const latest = () => published[published.length - 1];
        await vi.waitFor(() => {
            expect(latest()?.state.tabs.peer?.target.params.pageId).toBe('appearance');
            expect(latest()?.tabSyncStatus).toBe('synced');
        });
        const settled = latest();
        const settledCommits = published.length;

        // Another window navigates inside the shared tab. This window keeps its mounted destination.
        stored = sharedRecord('account'); version++;
        const readsBefore = reads;
        await act(async () => { await dispatchKvBatchUpdate({ kvUpdate: { changes: [{ key: 'workspace:tabs:v1', value: null, version }] },
            credentials, shouldContinue: () => true, applyTodoSocketUpdates: async () => {}, invalidateTodosSync: () => {}, log: { log: () => {} } }); });
        await vi.waitFor(() => expect(reads).toBe(readsBefore + 1));
        await act(async () => {});

        expect(latest().state).toBe(settled.state);
        expect(latest()).toBe(settled);
        expect(published).toHaveLength(settledCommits);
    });

    it('keeps the cold Session cockpit through delayed Account tab restore at 390 px', async () => {
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        const { DefaultTheme, ThemeProvider } = await import('@react-navigation/native');
        const { WorkspaceShell } = await import('./WorkspaceShell');
        await import('@/components/sessions/shell/SessionDestinationBody');
        const { SessionCockpitChromeRegistryProvider } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
        const { ComposerKeyboardScaffold } = await import('@/components/sessions/keyboardAvoidance/ComposerKeyboardScaffold');
        const { AppPaneProvider } = await import('../panes/AppPaneProvider');
        const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
        const { MobileBottomChromeHost } = await import('@/components/navigation/mobile/chrome/MobileBottomChromeHost');
        const sessionId = 'cold-session';
        const home = homes.homeA;
        const credentials = { token: home.token };
        route.pathname = '/session/' + sessionId;
        route.params = { id: sessionId, serverId: home.id };
        homes.setSessions(home, [
            homes.session({ id: sessionId, active: true, activeAt: Date.now() }),
            homes.session({ id: 'other-session' }),
        ]);
        homes.storage.setState(state => ({
            settings: { ...state.settings, mobileWorkspaceExperienceV1: 'cockpit' },
        }));
        const saved = { id: 'saved-session-tab', target: { kind: 'session', params: { id: sessionId, serverId: home.id } }, pinned: true };
        const other = { id: 'other-session-tab', target: { kind: 'session', params: { id: 'other-session', serverId: home.id } }, pinned: false };
        const record: SharedWorkspaceTabs = { v: 1, tabsById: { [saved.id]: saved, [other.id]: other },
            order: [other.id, saved.id], pairs: [[other.id, saved.id]] };
        const viewport = { x: 0, y: 0, width: 390, height: 844 };
        const phoneBarHeight = 56;
        const composerHeight = 64;
        const pending = Promise.withResolvers<void>();
        homes.setResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === `/v2/sessions/${sessionId}/messages` || path === `/v1/sessions/${sessionId}/messages`) {
                return Response.json({ messages: [], hasMore: false });
            }
            if (path !== '/v1/kv/bulk') return null;
            const { keys } = JSON.parse(String(init?.body)) as { keys: string[] };
            if (!keys.includes('workspace:tabs:v1')) return Response.json({ values: [] });
            await pending.promise;
            return Response.json({ values: [{ key: 'workspace:tabs:v1', value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: record }), version: 1 }] });
        });
        try {
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
                <ThemeProvider value={DefaultTheme}><AppPaneProvider><MainAppTabStateProvider><SessionCockpitChromeRegistryProvider>
                    <WorkspaceProvider enabled={false} phone catalog={catalog}>
                        <NavigationConsumer />
                        <WorkspaceShell catalog={catalog} />
                        <MobileBottomChromeHost />
                    </WorkspaceProvider>
                </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider></AppPaneProvider></ThemeProvider>
            </InjectedAuthProvider>, {
                createNodeMock: node => node.props.testID === 'mobile-bottom-chrome-bar' ? { offsetHeight: phoneBarHeight } : null,
            });
            const latest = () => published.at(-1)!;
            const active = () => latest().state.groups[latest().state.focusedGroupId].activeTabId;
            const first = active();
            expect(latest().active).toBe(true);
            expect(latest().state.tabs[first].target.params.id).toBe(sessionId);
            await act(async () => {
                invokeTestInstanceHandler(screen.findByTestId('split-canvas-host'), 'onLayout', { nativeEvent: { layout: viewport } });
                invokeTestInstanceHandler(screen.findByTestId('split-canvas-content-slot-' + latest().state.focusedGroupId), 'onLayout', { nativeEvent: { layout: viewport } });
            });
            const drawn = () => screen.findHostByTestId('workspace-retained-' + first)!;
            const cockpitHostNodes = (testId: string) => drawn().findAll(node => typeof node.type === 'string'
                && node.props.testID === testId);
            const firstComposer = await vi.waitFor(() => {
                const matches = cockpitHostNodes('agent-input-composer');
                expect(matches).toHaveLength(1);
                return matches[0];
            });
            const firstScene = cockpitHostNodes('session-cockpit-scene:chat');
            expect(firstScene).toHaveLength(1);
            // At rest, the footer sits at the bottom of the viewport minus its
            // measured height and the bottom band reserved by the real scaffold.
            const composerTop = () => viewport.height - composerHeight
                - drawn().findByType(ComposerKeyboardScaffold).props.layoutBottomInset;
            const firstTop = composerTop();
            expect(firstTop).toBe(viewport.height - composerHeight - phoneBarHeight);
            await act(async () => pending.resolve());
            await vi.waitFor(() => expect(latest().state.tabs[other.id]).toBeDefined());
            expect(Object.values(latest().state.tabs).filter(tab => tab.target.params.id === sessionId).map(tab => tab.id)).toEqual([first]);
            expect(active()).toBe(first);
            expect(cockpitHostNodes('session-cockpit-scene:chat')[0]).toBe(firstScene[0]);
            expect(cockpitHostNodes('agent-input-composer')[0]).toBe(firstComposer);
            expect(composerTop()).toBe(firstTop);
            expect(latest().state.groups[latest().state.focusedGroupId].tabIds).toEqual([other.id, first]);
            expect(latest().state.tabs[first].pinned).toBe(true);
            expect(latest().state.tabPairs).toEqual([[other.id, first]]);
        } finally {
            pending.resolve();
        }
    });
});
