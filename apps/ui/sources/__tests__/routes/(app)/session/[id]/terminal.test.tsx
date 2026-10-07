import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
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
let terminalFeatureEnabled = true;
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
        const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
        const navigation = createReactNavigationNativeMock({
            navigation: { canGoBack: () => canGoBack, goBack: routerBackSpy },
        }).useNavigation();
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
    safeAreaInsets: { top: 19, bottom: 29 },
});

const runtime = installSessionPaneRuntimeTestHarness({
    sessionId: 'session-1',
    scopeId: ({ sessionId, serverId }) => createSessionPaneScopeId(sessionId, serverId),
    features: () => createRootLayoutFeaturesResponse({ features: {
        terminal: { embeddedPty: { enabled: terminalFeatureEnabled } },
    } }),
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
    phone = true;
    terminalFeatureEnabled = true;
    sessionReads.length = 0;
    routerBackSpy.mockClear();
    routerPushSpy.mockClear();
    routerReplaceSpy.mockClear();
    storage.getState().applySettingsLocal({
        experiments: true, featureToggles: { 'terminal.embeddedPty': true }, mobileWorkspaceExperienceV1: 'classic',
    });
});

async function renderRouteScreen(preparePane?: () => void) {
    const { default: SessionTerminalRouteScreen } = await import('@/app/(app)/session/[id]/terminal');
    ({ useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope'));
    const body = () => <runtime.Wrapper>
        <SecondSessionPaneProbe />
        <navigationBoundary.NavigationContext.Provider value={navigationBoundary.useNavigation()}>
            <SessionTerminalRouteScreen />
        </navigationBoundary.NavigationContext.Provider>
    </runtime.Wrapper>;
    const screen = await renderScreen(<runtime.Wrapper><SecondSessionPaneProbe /></runtime.Wrapper>);
    if (preparePane) await act(async () => preparePane());
    await screen.update(body());
    return { screen, rerender: () => screen.update(body()) };
}

describe('/session/[id]/terminal', () => {
    it('opens the Home-qualified phone terminal and applies fullscreen safe areas once', async () => {
        const { SessionRightPanel } = await import('@/components/sessions/panes/SessionRightPanel');
        const { screen } = await renderRouteScreen();
        const root = screen.findHostByTestId('session-terminal-screen');
        if (!root) throw new Error('Expected terminal screen');
        expect(screen.findByType(SessionRightPanel).props).toMatchObject({
            sessionId: 'session-1', scopeId: createSessionPaneScopeId('session-1', runtime.serverId), presentation: 'screen',
        });
        expect(getStyleValue(root, 'paddingTop')).toBe(19);
        expect(getStyleValue(root, 'paddingBottom')).toBe(29);
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'terminal' });
    });

    it('renders the actual phone cockpit against the hydrated Home', async () => {
        storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
        const { SessionCockpitShell } = await import('@/components/workspaceCockpit/session/SessionCockpitShell');
        const { SessionRightPanel } = await import('@/components/sessions/panes/SessionRightPanel');
        const { screen } = await renderRouteScreen();
        expect(screen.findByType(SessionCockpitShell).props).toMatchObject({
            sessionId: 'session-1', routeServerId: runtime.serverId,
            scopeId: createSessionPaneScopeId('session-1', runtime.serverId), surface: 'terminal', safeAreaPadding: false,
            routeHydrationState: { kind: 'available', sessionId: 'session-1', serverId: runtime.serverId },
        });
        const root = screen.findHostByTestId('session-cockpit-route-screen');
        if (!root) throw new Error('Expected cockpit route');
        expect(getStyleValue(root, 'paddingTop')).toBe(0);
        expect(getStyleValue(root, 'paddingBottom')).toBe(29);
        expect(screen.findAllByType(SessionRightPanel)).toHaveLength(0);
    });

    it('retargets an existing non-terminal right pane on initial entry', async () => {
        await renderRouteScreen(() => runtime.pane.openRight({ tabId: 'files' }));
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'terminal' });
    });

    it('preserves the selected shared-panel tab through a focus cycle', async () => {
        const route = await renderRouteScreen();
        isFocused = false;
        await route.rerender();
        await act(async () => runtime.pane.setRightTab('files'));
        isFocused = true;
        await route.rerender();
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'files' });
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

    it('closes the actual right pane and returns through native history', async () => {
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
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1?serverId=' + encodeURIComponent(runtime.serverId));
    });

    it('does not open a terminal pane when the Home feature is denied', async () => {
        terminalFeatureEnabled = false;
        await renderRouteScreen();
        expect(runtime.pane.scopeState?.right?.isOpen ?? false).toBe(false);
        expect(routerBackSpy).toHaveBeenCalled();
    });

    it('does not open the phone terminal route on a larger bottom-dock device', async () => {
        phone = false;
        await renderRouteScreen();
        expect(runtime.pane.scopeState?.right?.isOpen ?? false).toBe(false);
        expect(routerBackSpy).toHaveBeenCalled();
    });

    it('keeps details in the cockpit instead of pushing another fullscreen route', async () => {
        storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
        const { createSessionFileDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
        await renderRouteScreen(() => runtime.pane.openDetailsTab(createSessionFileDetailsTab('README.md'), { intent: 'pinned' }));
        expect(runtime.pane.scopeState?.details).toMatchObject({ isOpen: true, activeTabKey: 'file:README.md' });
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('opens the same details resource anew after changing Session identity', async () => {
        storage.getState().applySessions([createSessionFixture({ id: 'session-2', serverId: runtime.serverId })]);
        const { createSessionFileDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
        const route = await renderRouteScreen(() => {
            runtime.pane.openDetailsTab(createSessionFileDetailsTab('README.md'), { intent: 'pinned' });
            secondPane.openDetailsTab(createSessionFileDetailsTab('README.md'), { intent: 'pinned' });
        });
        expect(routerPushSpy).toHaveBeenCalledTimes(1);
        expect(routerPushSpy).toHaveBeenLastCalledWith({ pathname: '/session/[id]/details', params: {
            id: 'session-1', serverId: runtime.serverId, details: 'file', path: 'README.md', sourceSurface: 'terminal',
        } });
        routeParams = { id: 'session-2', serverId: runtime.serverId };
        await route.rerender();
        expect(routerPushSpy).toHaveBeenCalledTimes(2);
        expect(routerPushSpy).toHaveBeenLastCalledWith({ pathname: '/session/[id]/details', params: {
            id: 'session-2', serverId: runtime.serverId, details: 'file', path: 'README.md', sourceSurface: 'terminal',
        } });
        expect(secondPane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'terminal' });
    });
});
