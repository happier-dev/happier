import * as React from 'react';
import 'fake-indexeddb/auto';
import { Text } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createRootLayoutFeaturesResponse, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import '@/sync/syncEngine';

const route = vi.hoisted(() => ({ serverId: '' }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: () => '/session/session-1',
    params: () => ({ serverId: route.serverId }),
}).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

installDisconnectedServerSocketBoundary();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
});

it('uses the live navigator after it registers without changing the selected surface', async () => {
    const settings = { ...settingsDefaults, mobileWorkspaceExperienceV1: 'cockpit' as const };
    const artifact = createHomeHubArtifactHttpBoundary('chrome-account');
    connection = await restoreServerAccountForTest({
        serverUrl: 'https://chrome.test', accountId: 'chrome-account',
        request: (url, init) => {
            const pathname = new URL(String(url)).pathname;
            if (pathname === '/v2/account/settings') return Promise.resolve(Response.json({ content: { t: 'plain', v: settings }, version: 1 }));
            if (pathname === '/v1/features') return Promise.resolve(Response.json(createRootLayoutFeaturesResponse()));
            return artifact.request(url, init);
        },
    });
    route.serverId = connection.home.id;
    await flushHookEffects({ cycles: 3 });
    storage.setState({ isDataReady: true, settings });

    const { SessionCockpitChromeRegistryProvider, useSessionCockpitChromeRegister } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
    const { MainAppTabStateProvider } = await import('./MainAppTabStateProvider');
    const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');

    // A controlled caller of the real registry, not a registry/navigator mock.
    // Its rendered state records whether the actual tab reached the current callback.
    function NavigatorCaller(props: Readonly<{ registered: boolean }>) {
        const register = useSessionCockpitChromeRegister();
        const [surface, setSurface] = React.useState<SessionMobileSurface>('chat');
        React.useEffect(() => {
            if (!props.registered) return;
            return register({ sessionId: 'session-1', serverId: route.serverId, activeSurface: surface,
                terminalTabAvailable: false, openDetailsTabCount: 0, switchSurface: setSurface });
        }, [props.registered, register, surface]);
        return <Text testID="navigator-surface">{surface}</Text>;
    }
    const credentials = connection.credentials;
    function Harness(props: Readonly<{ registered: boolean }>) {
        return <InjectedAuthProvider credentials={credentials}>
            <MainAppTabStateProvider><SessionCockpitChromeRegistryProvider>
                <NavigatorCaller registered={props.registered} />
                <MobileBottomChromeHost />
            </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>;
    }
    const screen = await renderScreen(<Harness registered={false} />);
    expect(screen.findHostByTestId('session-cockpit-tab-browse')).not.toBeNull();
    await screen.update(<Harness registered />);
    await flushHookEffects({ cycles: 3 });
    await screen.pressByTestIdAsync('session-cockpit-tab-browse');
    expect(screen.findHostByTestId('navigator-surface')?.props.children).toBe('browse');
    await screen.pressByTestIdAsync('session-cockpit-tab-chat');
    expect(screen.findHostByTestId('navigator-surface')?.props.children).toBe('chat');
    // Dispatch the web keyboard event at the actual painted control boundary.
    await act(async () => {
        const onKeyDown = screen.findHostByTestId('session-cockpit-tab-browse')?.props.onKeyDown;
        if (typeof onKeyDown === 'function') {
            onKeyDown({ nativeEvent: { key: ' ' }, preventDefault() {}, stopPropagation() {} });
        }
    });
    expect(screen.findHostByTestId('navigator-surface')?.props.children).toBe('browse');
});
