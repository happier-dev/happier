import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, vi } from 'vitest';

import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { readHomeShownUnavailable } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { createPlainSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { CurtainProbe, startTestLaunchCurtain } from '@/dev/testkit/harness/launchCurtainHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

/** Each destination needs its own cold document. A finished curtain cannot be restarted. */
export function installSessionLaunchReachabilityTest(kind: 'session' | 'sessionDetails') {
    const id = `unanswered-${kind}`;
    const requested = createDeferred<void>();
    const response = createDeferred<void>();
    const runtime = installSessionPaneRuntimeTestHarness({
        request: async (input) => {
            if (new URL(String(input)).pathname !== `/v2/sessions/${id}`) return null;
            requested.resolve();
            await response.promise;
            return Response.json(createPlainSessionByIdResponseFixture(createSessionFixture({ id })));
        },
    });

    return async function expectReleaseWithPendingRead(Body: React.ComponentType) {
        const serverId = runtime.serverId;
        const launch = startTestLaunchCurtain();
        publishAppliedActiveServerRuntimeAvailability(true);
        storage.setState({ endpointStatus: 'online', endpointReason: null, socketStatus: 'connected', syncError: null });
        const pathname = kind === 'sessionDetails' ? `/session/${id}/details` : `/session/${id}`;
        const screen = await renderScreen(<runtime.Wrapper>
            <DestinationInstanceHost tabId={id} ref={{ kind, params: { id, serverId } }} pathname={pathname} focused visible
                navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                <Body />
            </DestinationInstanceHost>
            <CurtainProbe />
        </runtime.Wrapper>);
        const curtain = () => screen.root.findByType('CurtainProbe').props.state;
        try {
            await requested.promise;
            expect(storage.getState().sessions[id]).toBeUndefined();
            expect(readHomeShownUnavailable(serverId)).toBe(false);
            expect(screen.findAllHostsByTestId('workspace-destination-body-loading-rows')).toHaveLength(1);
            launch.releaseShell();
            await launch.paint();
            expect(curtain()).toBe('up');

            await act(async () => {
                storage.setState({ endpointStatus: 'offline', endpointReason: null, socketStatus: 'disconnected' });
            });
            expect(readHomeShownUnavailable(serverId)).toBe(true);
            await launch.paint();
            expect(curtain()).toBe('leaving');
            await act(async () => { launch.finish(); });
            expect(curtain()).toBe('gone');
            expect(screen.findAllHostsByTestId('workspace-destination-body-loading-rows')).toHaveLength(1);
            expect(storage.getState().sessions[id]).toBeUndefined();
        } finally {
            await screen.unmount();
            response.resolve();
            launch.dispose();
        }
    };
}
