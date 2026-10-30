import * as React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { WorkspaceDestinationBody } from '@/components/appShell/workspace/WorkspaceDestinationBody';
import { WorkspaceNavigationContext, type WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { registerWorkspaceRouteContext } from '@/components/appShell/workspace/workspaceRouteContext';
import { createWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';

installPanelCommonModuleMocks();
const boundary = vi.hoisted(() => ({ pathname: '/settings/server', nested: null as React.ComponentType | null }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    // Expo mounts the selected registered nested layout, even when its parent is hidden.
    const Nested = React.createContext(false);
    const Stack = Object.assign(() => {
        const nested = React.useContext(Nested);
        return !nested && boundary.nested
            ? <Nested.Provider value>{React.createElement(boundary.nested)}</Nested.Provider> : null;
    }, { Screen: () => null });
    return { ...createExpoRouterMock({ pathname: () => boundary.pathname }).module, Stack };
});
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness'))
    .createSocketIoClientBoundary(original));

await initializeAuthRouteRuntimeForTests();
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');

let SettingsLayout: React.ComponentType;
let HomesLayout: React.ComponentType;
let TokensLayout: React.ComponentType;
let HomesProvider: typeof import('@/components/settings/server/collection/HomesCollection').HomesCollectionProvider;
let TokensProvider: typeof import('@/components/settings/apiTokens/collection/ApiTokenSettingsScope').ApiTokenSettingsScope;
beforeAll(async () => {
    SettingsLayout = (await import('./_layout')).default;
    HomesLayout = (await import('./server/_layout')).default;
    TokensLayout = (await import('./account/api-tokens/_layout')).default;
    HomesProvider = (await import('@/components/settings/server/collection/HomesCollection')).HomesCollectionProvider;
    TokensProvider = (await import('@/components/settings/apiTokens/collection/ApiTokenSettingsScope')).ApiTokenSettingsScope;
});

describe('Settings mirror and hosted collection ownership', () => {
    it.each(['server', 'account/api-tokens'])('mounts one collection controller for %s', async page => {
        boundary.pathname = `/settings/${page}`;
        boundary.nested = page === 'server' ? HomesLayout : TokensLayout;
        const modules: Record<string, unknown> = {
            './(app)/settings/_layout.tsx': { default: SettingsLayout },
            [`./(app)/settings/${page}/_layout.tsx`]: { default: boundary.nested },
            [`./(app)/settings/${page}/index.tsx`]: { WorkspaceRouteBody: () => null },
        };
        registerWorkspaceRouteContext(Object.assign((key: string) => modules[key], { keys: () => Object.keys(modules) }));
        const target = { kind: 'settings', params: { pageId: page } };
        const navigation: WorkspaceNavigationContextValue = {
            active: true, state: createWorkspaceState({ id: 'settings-tab', target, pinned: false, preview: true }),
            canGoBack: false, canGoForward: false, openHref: () => false, activateTab: () => {}, closeTab: () => {},
            closeTabs: () => {}, dispatch: () => {}, navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
            registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        };
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><WorkspaceNavigationContext.Provider value={navigation}>
            <SettingsLayout />
            <DestinationInstanceHost tabId="settings-tab" ref={target} pathname={boundary.pathname} focused visible
                navigation={navigation.navigationForTab('settings-tab')}>
                <WorkspaceDestinationBody target={target} pathname={boundary.pathname} renderSession={() => null} renderSessionDetails={() => null} />
            </DestinationInstanceHost>
        </WorkspaceNavigationContext.Provider></InjectedAuthProvider>);
        expect(screen.root.findAllByType(page === 'server' ? HomesProvider : TokensProvider.type)).toHaveLength(1);
    });
});
