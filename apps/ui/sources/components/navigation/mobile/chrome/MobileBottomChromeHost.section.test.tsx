import * as React from 'react';
import { act } from 'react-test-renderer';
import { it, expect, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { WorkspaceNavigationProvider, type WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { createWorkspaceState } from '@/components/appShell/workspace/workspaceState';

const route = vi.hoisted(() => ({ pathname: '/workflows', listeners: new Set<() => void>() }));
vi.mock('expo-router', async () => {
    const router = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: () => route.pathname });
    return { ...router.module, usePathname: () => React.useSyncExternalStore(
        listener => { route.listeners.add(listener); return () => route.listeners.delete(listener); },
        () => route.pathname, () => route.pathname,
    ) };
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Dimensions: { get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }), addEventListener: () => ({ remove() {} }) },
    Keyboard: { isVisible: () => false, addListener: () => ({ remove() {} }), dismiss() {} },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const runtime = installSessionPaneRuntimeTestHarness({ sessionId: 'session-1', request: async url => (
    new URL(String(url)).pathname === '/v1/kv/bulk' ? Response.json({ values: [] }) : null
) });
const { InboxSummaryProvider } = await import('@/hooks/inbox/useInboxSummary');
const { MainAppTabStateProvider } = await import('./MainAppTabStateProvider');
const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
const { MainAppTabBar } = await import('./bars/MainAppTabBar');
const { SessionCockpitChromeRegistryProvider } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
function Harness() {
    return <runtime.Wrapper><MainAppTabStateProvider><SessionCockpitChromeRegistryProvider><InboxSummaryProvider>
        <MobileBottomChromeHost />
    </InboxSummaryProvider></SessionCockpitChromeRegistryProvider></MainAppTabStateProvider></runtime.Wrapper>;
}
async function navigateTo(pathname: string) {
    await act(async () => { route.pathname = pathname; for (const listener of route.listeners) listener(); });
}

    it('keeps the selected main tab when an entity route belongs to another section', async () => {
        const value = {
            active: false, sectionPathname: '/', ownsRoute: true,
            state: createWorkspaceState({ id: 'a', target: { kind: 'session', params: { id: 'session-1' } }, pinned: false, preview: false }),
            canGoBack: false, canGoForward: false, openHref: () => false,
            activateTab() {}, closeTab() {}, closeTabs() {}, dispatch() {},
            navigationForTab: () => ({ push() {}, replace() {}, back() {} }),
            registerBackStep: () => () => {}, back() {}, forward() {},
        } satisfies WorkspaceNavigationContextValue;
        route.pathname = '/workflows';
        const screen = await renderScreen(<WorkspaceNavigationProvider value={value}><Harness /></WorkspaceNavigationProvider>);
        expect(screen.findByType(MainAppTabBar).props.activeTab).toBe('sessions');
        await navigateTo('/');
        await screen.update(<WorkspaceNavigationProvider value={{ ...value, sectionPathname: '/workflows' }}><Harness /></WorkspaceNavigationProvider>);
        expect(screen.findByType(MainAppTabBar).props.activeTab).toBe('workflows');
    });
