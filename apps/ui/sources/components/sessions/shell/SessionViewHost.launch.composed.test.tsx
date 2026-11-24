import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

import { createDeferred, renderScreen } from '@/dev/testkit';
import { CurtainProbe, startTestLaunchCurtain } from '@/dev/testkit/harness/launchCurtainHarness';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import type { SessionViewEmbeddedPresentation } from './embedded/embeddedSessionPresentation';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';

const chunk = vi.hoisted(() => ({
    pending: null as Promise<void> | null,
}));
// Hold the lazy descendant at its module boundary without holding Vite's static collection graph.
vi.mock('./SessionView', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./SessionView')>();
    return { ...actual, SessionView: (props: React.ComponentProps<typeof actual.SessionView>) => {
        if (chunk.pending) React.use(chunk.pending);
        return <actual.SessionView {...props} />;
    } };
});
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

const runtime = installSessionPaneRuntimeTestHarness({ sessionId: 'view-launch-ready' });
const { SessionView } = await import('./SessionViewHost.web');
const embedded: SessionViewEmbeddedPresentation = {
    kind: 'embedded', composer: 'none', composerControls: 'session', modelPicker: false,
};

it('keeps the launched Session covered across its chunk and body read, and lets subsequent pane and tab loads stay in-shell', async () => {
    const launch = startTestLaunchCurtain();
    const initial = createDeferred<void>();
    const later = createDeferred<void>();
    chunk.pending = initial.promise;
    const tree = (id: string, kind: SessionRouteHydrationState['kind'], presentation?: SessionViewEmbeddedPresentation) => {
        const state = kind === 'loading'
            ? { kind, sessionId: id, serverId: runtime.serverId, reason: 'cold' } as const
            : { kind: 'available', sessionId: id, serverId: runtime.serverId } as const;
        return <runtime.Wrapper>
            <DestinationInstanceHost key={id} tabId={id} ref={{ kind: 'session', params: { id, serverId: runtime.serverId } }}
                pathname={`/session/${id}`} focused visible
                navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                <SessionView id={id} routeServerId={runtime.serverId} routeHydrationState={state} presentation={presentation} />
            </DestinationInstanceHost>
            <CurtainProbe />
        </runtime.Wrapper>;
    };
    const screen = await renderScreen(tree('view-launch-cold', 'loading'));
    const curtain = () => screen.root.findByType('CurtainProbe').props.state;
    try {
        expect(screen.findAllByType(PaneLoadingFallback)).toHaveLength(1);
        launch.releaseShell();
        await launch.paint();
        expect(curtain()).toBe('up');

        chunk.pending = null;
        await act(async () => { initial.resolve(); });
        await vi.waitFor(() => expect(screen.findByTestId('session-route-loading')).not.toBeNull());
        await launch.paint();
        expect(curtain()).toBe('up');

        await screen.update(tree('view-launch-ready', 'available'));
        const { ChatList } = await import('@/components/sessions/transcript/ChatList');
        await vi.waitFor(() => expect(screen.findAllByType(ChatList)).toHaveLength(1));
        expect(screen.findByTestId('session-route-loading')).toBeNull();
        await launch.paint();
        expect(curtain()).toBe('leaving');

        await act(async () => { launch.finish(); });
        await screen.update(tree('view-launch-later', 'loading'));
        expect(screen.findByTestId('session-route-loading')).not.toBeNull();
        await launch.paint();
        expect(curtain()).toBe('gone');

        chunk.pending = later.promise;
        await screen.update(tree('view-launch-pane', 'loading', embedded));
        expect(screen.findAllByType(PaneLoadingFallback)).toHaveLength(1);
        await launch.paint();
        expect(curtain()).toBe('gone');
    } finally {
        chunk.pending = null;
        initial.resolve();
        later.resolve();
        await screen.unmount();
        launch.dispose();
    }
});
