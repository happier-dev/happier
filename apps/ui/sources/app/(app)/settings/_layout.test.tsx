import * as React from 'react';
import { expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { WorkspaceNavigationContext, type WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { createWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';

installPanelCommonModuleMocks();
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness'))
    .createSocketIoClientBoundary(original));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const Stack = Object.assign((props: React.PropsWithChildren) => React.createElement('NativeSettingsNavigator', props), {
        Screen: (props: { name: string }) => React.createElement('RegisteredSettingsRoute', props),
    });
    return { ...createExpoRouterMock().module, Stack };
});

// Expo still needs nested route registration to mirror hosted query parameters into its URL state.
await initializeAuthRouteRuntimeForTests();
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { default: SettingsLayout } = await import('./_layout');

it('keeps the native Settings navigator registered while the workspace owns the visible body', async () => {
    const navigation: WorkspaceNavigationContextValue = {
        active: true,
        state: createWorkspaceState({ id: 'settings-tab', target: { kind: 'settings', params: {} }, pinned: false, preview: true }),
        canGoBack: false, canGoForward: false,
        openHref: () => false, activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
        navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
        registerBackStep: () => () => {}, back: () => {}, forward: () => {},
    };
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
        <WorkspaceNavigationContext.Provider value={navigation}><SettingsLayout /></WorkspaceNavigationContext.Provider>
    </InjectedAuthProvider>);
    expect(screen.root.findAllByType('NativeSettingsNavigator')).toHaveLength(1);
    expect(screen.root.findAllByType('RegisteredSettingsRoute').map(node => node.props.name)).toContain('connected-services');
    expect(screen.findAllHostsByTestId('settings-shell')).toHaveLength(0);
});
