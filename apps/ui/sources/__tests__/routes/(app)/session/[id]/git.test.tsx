import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { getStyleValue, installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.fn();
const routerPushSpy = vi.fn();
const routerReplaceSpy = vi.fn();
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
    safeAreaInsets: { top: 13, bottom: 27 },
});

const runtime = installSessionPaneRuntimeTestHarness({
    sessionId: 'session-1',
    scopeId: ({ sessionId, serverId }) => createSessionPaneScopeId(sessionId, serverId),
});

beforeEach(() => {
    routeParams = { id: 'session-1', serverId: runtime.serverId };
    isFocused = true;
    canGoBack = true;
    phone = false;
    routerBackSpy.mockClear();
    routerPushSpy.mockClear();
    routerReplaceSpy.mockClear();
    storage.getState().applySettingsLocal({
        mobileWorkspaceExperienceV1: 'classic',
    });
});

async function renderRouteScreen(preparePane?: () => void) {
    const { default: SessionGitRouteScreen } = await import('@/app/(app)/session/[id]/git');
    const body = () => <runtime.Wrapper>
        <navigationBoundary.NavigationContext.Provider value={navigationBoundary.useNavigation()}>
            <SessionGitRouteScreen />
        </navigationBoundary.NavigationContext.Provider>
    </runtime.Wrapper>;
    const screen = await renderScreen(<runtime.Wrapper />);
    if (preparePane) await act(async () => preparePane());
    await screen.update(body());
    return { screen, rerender: () => screen.update(body()) };
}

describe('/session/[id]/git', () => {
    it('opens the actual Home-qualified Git pane fullscreen', async () => {
        const { SessionRightPanel } = await import('@/components/sessions/panes/SessionRightPanel');
        const { screen } = await renderRouteScreen();
        const root = screen.findHostByTestId('session-git-screen');
        if (!root) throw new Error('Expected Git screen');
        expect(screen.findByType(SessionRightPanel).props).toMatchObject({
            sessionId: 'session-1', scopeId: createSessionPaneScopeId('session-1', runtime.serverId), presentation: 'screen',
        });
        expect(getStyleValue(root, 'paddingTop')).toBe(13);
        expect(getStyleValue(root, 'paddingBottom')).toBe(27);
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'git' });
    });

    it('preserves another shared-panel tab after initial entry', async () => {
        const route = await renderRouteScreen();
        await act(async () => runtime.pane.setRightTab('files'));
        await route.rerender();
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'files' });
    });

    it('renders the actual phone cockpit with the hydrated Home', async () => {
        phone = true;
        storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
        const { SessionCockpitShell } = await import('@/components/workspaceCockpit/session/SessionCockpitShell');
        const { SessionRightPanel } = await import('@/components/sessions/panes/SessionRightPanel');
        const { screen } = await renderRouteScreen();
        expect(screen.findByType(SessionCockpitShell).props).toMatchObject({
            sessionId: 'session-1', routeServerId: runtime.serverId, surface: 'git', safeAreaPadding: false,
        });
        const root = screen.findHostByTestId('session-cockpit-route-screen');
        if (!root) throw new Error('Expected cockpit route');
        expect(getStyleValue(root, 'paddingTop')).toBe(0);
        expect(getStyleValue(root, 'paddingBottom')).toBe(27);
        expect(screen.findAllByType(SessionRightPanel)).toHaveLength(0);
    });

    it('closes real pane state and returns through native history', async () => {
        const { SessionRightPanel } = await import('@/components/sessions/panes/SessionRightPanel');
        const { screen } = await renderRouteScreen();
        await act(async () => screen.findByType(SessionRightPanel).props.onRequestClose());
        expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
        expect(routerBackSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps an opened details tab inside the cockpit', async () => {
        phone = true;
        storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
        const { createSessionFileDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
        await renderRouteScreen(() => runtime.pane.openDetailsTab(createSessionFileDetailsTab('README.md'), { intent: 'pinned' }));
        expect(runtime.pane.scopeState?.details).toMatchObject({ isOpen: true, activeTabKey: 'file:README.md' });
        expect(routerPushSpy).not.toHaveBeenCalled();
    });
});
