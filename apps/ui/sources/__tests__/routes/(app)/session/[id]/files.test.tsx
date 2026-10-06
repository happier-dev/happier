import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { getStyleValue, installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.fn();
const routerPushSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const sessionReads: string[] = [];
let routeParams: { id: string; serverId?: string } = { id: 'session-1' };
let isFocused = true;
let canGoBack = true;
let phone = true;
let navigationBoundary: ReturnType<typeof import('@/dev/testkit/mocks/reactNavigation').createReactNavigationNativeMock>;

installSessionRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            Platform: { isPad: false },
            useWindowDimensions: () => ({ width: phone ? 390 : 1280, height: phone ? 844 : 900, scale: 1, fontScale: 1 }),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const { createNavigationMock } = await import('@/dev/testkit');
        const navigation = { ...createNavigationMock(), canGoBack: () => canGoBack, goBack: routerBackSpy };
        const boundary = createExpoRouterMock({ router: {
            back: routerBackSpy, push: routerPushSpy, replace: routerReplaceSpy,
        } });
        return {
            ...boundary.module,
            useLocalSearchParams: () => routeParams,
            useGlobalSearchParams: () => routeParams,
            useNavigation: () => navigation,
        };
    },
    nativeNavigation: async () => {
        const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
        navigationBoundary = createReactNavigationNativeMock({ navigation: { canGoBack: () => canGoBack } });
        return { ...navigationBoundary, useIsFocused: () => isFocused };
    },
    safeAreaInsets: { top: 17, bottom: 23 },
});

const runtime = installSessionPaneRuntimeTestHarness({
    sessionId: 'session-1',
    scopeId: ({ sessionId, serverId }) => createSessionPaneScopeId(sessionId, serverId),
    request: async (url, init) => {
        const address = new URL(String(url));
        if ((init?.method ?? 'GET') !== 'GET' || address.pathname !== '/v2/sessions/session-1') return null;
        sessionReads.push(address.origin);
        const { SessionCurrentProjectionRecordV1Schema } = await import('@happier-dev/protocol');
        const session = createSessionFixture({ id: 'session-1', serverId: runtime.serverId });
        if (!session.access) throw new Error('Expected owner access fixture');
        return Response.json({ session: SessionCurrentProjectionRecordV1Schema.parse({
            ...session, metadataLayoutVersion: 0, metadata: JSON.stringify(session.metadata),
            effectiveAccess: { v: 1, level: session.access.level, sources: [{ kind: 'owner' }], capabilities: session.access.capabilities },
            responsibleAccountId: null, responsibleAccount: null, share: null,
            archivedAt: null, agentState: null, dataEncryptionKey: null, pendingCount: 0, pendingVersion: 0,
        }) });
    },
});

let useAppPaneScope: typeof import('@/components/appShell/panes/hooks/useAppPaneScope')['useAppPaneScope'];
let secondPane: AppPaneScopeApi;
function SecondSessionPaneProbe() {
    secondPane = useAppPaneScope(createSessionPaneScopeId('session-2', runtime.serverId));
    return null;
}

beforeEach(() => {
    routeParams = { id: 'session-1', serverId: runtime.serverId };
    isFocused = true;
    canGoBack = true;
    phone = false;
    sessionReads.length = 0;
    routerBackSpy.mockClear();
    routerPushSpy.mockClear();
    routerReplaceSpy.mockClear();
    storage.getState().applySettingsLocal({
        mobileWorkspaceExperienceV1: 'classic',
    });
});

async function renderRouteScreen(preparePane?: () => void) {
    const { default: SessionFilesRouteScreen } = await import('@/app/(app)/session/[id]/files');
    ({ useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope'));
    const body = () => <runtime.Wrapper>
        <SecondSessionPaneProbe />
        <navigationBoundary.NavigationContext.Provider value={navigationBoundary.useNavigation()}>
            <SessionFilesRouteScreen />
        </navigationBoundary.NavigationContext.Provider>
    </runtime.Wrapper>;
    const screen = await renderScreen(<runtime.Wrapper><SecondSessionPaneProbe /></runtime.Wrapper>);
    if (preparePane) await act(async () => preparePane());
    await screen.update(body());
    return { screen, rerender: () => screen.update(body()) };
}

async function openFile(pane: AppPaneScopeApi = runtime.pane) {
    const { createSessionFileDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
    await act(async () => pane.openDetailsTab(createSessionFileDetailsTab('README.md'), { intent: 'pinned' }));
}
function expectFileDetailsRoute(sessionId = 'session-1') {
    expect(routerPushSpy).toHaveBeenLastCalledWith({ pathname: '/session/[id]/details', params: {
        id: sessionId, serverId: runtime.serverId, details: 'file', path: 'README.md', sourceSurface: 'browse',
    } });
}

describe('/session/[id]/files', () => {
    it('opens the actual Home-qualified Files pane fullscreen', async () => {
        const { SessionRightPanel } = await import('@/components/sessions/panes/SessionRightPanel');
        const { screen } = await renderRouteScreen();
        const root = screen.findHostByTestId('session-files-screen');
        if (!root) throw new Error('Expected Files screen');
        expect(screen.findByType(SessionRightPanel).props).toMatchObject({
            sessionId: 'session-1', scopeId: createSessionPaneScopeId('session-1', runtime.serverId), presentation: 'screen',
        });
        expect(getStyleValue(root, 'paddingTop')).toBe(17);
        expect(getStyleValue(root, 'paddingBottom')).toBe(23);
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'files' });
    });

    it('renders the actual phone browse cockpit with the hydrated Home', async () => {
        phone = true;
        storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
        const { SessionCockpitShell } = await import('@/components/workspaceCockpit/session/SessionCockpitShell');
        const { SessionRightPanel } = await import('@/components/sessions/panes/SessionRightPanel');
        const { screen } = await renderRouteScreen();
        expect(screen.findByType(SessionCockpitShell).props).toMatchObject({
            sessionId: 'session-1', routeServerId: runtime.serverId, surface: 'browse', safeAreaPadding: false,
        });
        const root = screen.findHostByTestId('session-cockpit-route-screen');
        if (!root) throw new Error('Expected cockpit route');
        expect(getStyleValue(root, 'paddingTop')).toBe(0);
        expect(getStyleValue(root, 'paddingBottom')).toBe(23);
        expect(screen.findAllByType(SessionRightPanel)).toHaveLength(0);
    });

    it('retargets a remembered right tab on initial Files entry', async () => {
        await renderRouteScreen(() => runtime.pane.openRight({ tabId: 'git' }));
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'files' });
    });

    it('preserves another shared-panel tab after initial entry', async () => {
        const route = await renderRouteScreen();
        await act(async () => runtime.pane.setRightTab('git'));
        await route.rerender();
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'git' });
    });

    it('hydrates a cold deep link through the exact Home HTTP boundary', async () => {
        storage.setState((state) => {
            const { ['session-1']: removed, ...sessions } = state.sessions;
            void removed;
            return { sessions };
        });
        const { SessionRightPanel } = await import('@/components/sessions/panes/SessionRightPanel');
        const { screen } = await renderRouteScreen();
        await flushHookEffects();
        expect(sessionReads).toEqual(['https://session-pane.test']);
        expect(storage.getState().sessions['session-1']).toMatchObject({ serverId: runtime.serverId, encryptionMode: 'plain' });
        expect(screen.findByType(SessionRightPanel).props.sessionId).toBe('session-1');
    });

    it('closes real pane state and returns through native history', async () => {
        const { SessionRightPanel } = await import('@/components/sessions/panes/SessionRightPanel');
        const { screen } = await renderRouteScreen();
        await act(async () => screen.findByType(SessionRightPanel).props.onRequestClose());
        expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
        expect(routerBackSpy).toHaveBeenCalledTimes(1);
    });

    it('falls back to the Home-qualified parent when native history is empty', async () => {
        canGoBack = false;
        const { SessionRightPanel } = await import('@/components/sessions/panes/SessionRightPanel');
        const { screen } = await renderRouteScreen();
        await act(async () => screen.findByType(SessionRightPanel).props.onRequestClose());
        expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1?serverId=' + encodeURIComponent(runtime.serverId));
    });

    it('navigates to Home-qualified details opened from the shared surface', async () => {
        await renderRouteScreen();
        await openFile();
        expectFileDetailsRoute();
    });

    it('keeps opened details inside the cockpit instead of pushing fullscreen', async () => {
        phone = true;
        storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
        await renderRouteScreen();
        await openFile();
        expect(runtime.pane.scopeState?.details).toMatchObject({ isOpen: true, activeTabKey: 'file:README.md' });
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('does not navigate for retained tabs while Details is closed', async () => {
        const { createSessionFileDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
        await renderRouteScreen(() => {
            runtime.pane.openDetailsTab(createSessionFileDetailsTab('README.md'), { intent: 'pinned' });
            runtime.pane.closeDetails();
        });
        expect(runtime.pane.scopeState?.details).toMatchObject({ isOpen: false, activeTabKey: 'file:README.md' });
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('does not navigate to Details while the native route is unfocused', async () => {
        isFocused = false;
        await renderRouteScreen();
        await openFile();
        expect(runtime.pane.scopeState?.details.isOpen).toBe(true);
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('encodes a retained commitHash resource into the current commit URL', async () => {
        await renderRouteScreen();
        await act(async () => runtime.pane.openDetailsTab({
            key: 'commit:abc1234', kind: 'commit', title: 'abc1234',
            resource: { kind: 'commit', commitHash: 'abc1234' },
        }, { intent: 'pinned' }));
        expect(routerPushSpy).toHaveBeenCalledWith({ pathname: '/session/[id]/details', params: {
            id: 'session-1', serverId: runtime.serverId, details: 'commit', sha: 'abc1234', sourceSurface: 'browse',
        } });
    });

    it('navigates again when the same Details tab is reopened after a focus cycle', async () => {
        const route = await renderRouteScreen();
        await openFile();
        expect(routerPushSpy).toHaveBeenCalledTimes(1);
        isFocused = false;
        await act(async () => runtime.pane.closeDetails());
        await route.rerender();
        isFocused = true;
        await route.rerender();
        await openFile();
        expect(routerPushSpy).toHaveBeenCalledTimes(2);
        expectFileDetailsRoute();
    });

    it('opens the same details resource anew after changing Session identity', async () => {
        storage.getState().applySessions([createSessionFixture({ id: 'session-2', serverId: runtime.serverId })]);
        const { createSessionFileDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
        const route = await renderRouteScreen(() => {
            runtime.pane.openDetailsTab(createSessionFileDetailsTab('README.md'), { intent: 'pinned' });
            secondPane.openDetailsTab(createSessionFileDetailsTab('README.md'), { intent: 'pinned' });
        });
        expect(routerPushSpy).toHaveBeenCalledTimes(1);
        expectFileDetailsRoute();
        routeParams = { id: 'session-2', serverId: runtime.serverId };
        await route.rerender();
        expect(routerPushSpy).toHaveBeenCalledTimes(2);
        expectFileDetailsRoute('session-2');
    });

    it('selects a retained resource when the focused split group is empty', async () => {
        const { createSessionFileDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
        await renderRouteScreen(() => {
            runtime.pane.openDetailsTab(createSessionFileDetailsTab('README.md'), { intent: 'pinned' });
            if (!runtime.pane.splitDetailsGroup) throw new Error('Expected canonical split action');
            runtime.pane.splitDetailsGroup({ axis: 'horizontal' });
        });
        expect(runtime.pane.scopeState?.details.tabs).toHaveLength(0);
        expect(runtime.pane.scopeState?.details.groups?.some((group) => group.tabs.some((tab) => tab.key === 'file:README.md'))).toBe(true);
        expectFileDetailsRoute();
    });
});
