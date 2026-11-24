import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { renderScreen } from '@/dev/testkit';
import { CurtainProbe, startTestLaunchCurtain } from '@/dev/testkit/harness/launchCurtainHarness';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';
import { storage } from '@/sync/domains/state/storageStore';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

const runtime = installSessionPaneRuntimeTestHarness();
const { SessionView } = await import('./SessionView');

it('releases a settled Session route even while the Account data fallback is still showing', async () => {
    const id = 'missing-curtain-session';
    storage.setState({ isDataReady: false });
    const tree = (state: SessionRouteHydrationState) => <runtime.Wrapper>
        <DestinationInstanceHost tabId={id} ref={{ kind: 'session', params: { id, serverId: runtime.serverId } }}
            pathname={`/session/${id}`} focused visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <SessionView id={id} routeServerId={runtime.serverId} routeHydrationState={state} />
        </DestinationInstanceHost>
        <CurtainProbe />
    </runtime.Wrapper>;
    const launch = startTestLaunchCurtain();
    const address = { sessionId: id, serverId: runtime.serverId };
    const screen = await renderScreen(tree({ ...address, kind: 'loading', reason: 'cold' }));
    const curtain = () => screen.root.findByType('CurtainProbe').props.state;
    try {
        expect(screen.findByTestId('session-route-loading')).not.toBeNull();
        launch.releaseShell();
        await launch.paint();
        expect(curtain()).toBe('up');

        await screen.update(tree({ ...address, kind: 'missing', cause: 'not_found' }));
        expect(screen.findByTestId('session-route-loading')).not.toBeNull();
        await launch.paint();
        expect(curtain()).toBe('leaving');
        await act(async () => { launch.finish(); });
        expect(curtain()).toBe('gone');
        await act(async () => { storage.setState({ isDataReady: true }); });
        expect(screen.findByTestId('session-root-unavailable')).not.toBeNull();
    } finally {
        await screen.unmount();
        launch.dispose();
    }
});
