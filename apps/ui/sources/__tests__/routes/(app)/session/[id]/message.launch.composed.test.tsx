import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { createDeferred, createSessionFixture, createSessionMessagesFixture, renderScreen } from '@/dev/testkit';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { CurtainProbe, startTestLaunchCurtain } from '@/dev/testkit/harness/launchCurtainHarness';
import { storage } from '@/sync/domains/state/storageStore';
import type { Message } from '@happier-dev/session-core/messages';

import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installSessionRouteCommonModuleMocks({
    nativeNavigation: async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock({ renderInitialNavigatorScreen: true }),
});

const sessionChunk = vi.hoisted(() => ({ pending: null as Promise<void> | null }));
// Delay delivery at the lazy boundary and mount the real Session body once it resolves.
vi.mock('@/components/sessions/shell/SessionDestinationBody', async importOriginal => {
    const actual = await importOriginal<typeof import('@/components/sessions/shell/SessionDestinationBody')>();
    return { ...actual, SessionDestinationBody: (props: React.ComponentProps<typeof actual.SessionDestinationBody>) => {
        if (sessionChunk.pending) React.use(sessionChunk.pending);
        return <actual.SessionDestinationBody {...props} />;
    } };
});

const sessionId = 'session-1';
const messageId = 'linked-answer';
const pathname = '/session/session-1/message/linked-answer';
const runtime = installSessionPaneRuntimeTestHarness({ sessionId });
const { WorkspaceRouteBody: MessageRouteBody } = await import('@/app/(app)/session/[id]/message/[messageId]');
const { SessionCockpitShell } = await import('@/components/workspaceCockpit/session/SessionCockpitShell');

it('holds the curtain for the linked Session chunk and releases it when the Session frame draws', async () => {
    const message: Message = { kind: 'agent-text', id: messageId, seq: 1, localId: null, createdAt: 1, text: 'Linked answer', meta: null };
    storage.getState().applySessions([createSessionFixture({ id: sessionId, serverId: runtime.serverId })]);
    storage.setState(state => ({ sessionMessages: { ...state.sessionMessages, [sessionId]: createSessionMessagesFixture({
        messagesById: { [messageId]: message }, messageIdsOldestFirst: [messageId], isLoaded: true,
    }) } }));
    const ref = { kind: 'session', params: { id: sessionId, serverId: runtime.serverId, messageId, workspacePathname: pathname } };
    const launch = startTestLaunchCurtain();
    const initial = createDeferred<void>();
    const warm = createDeferred<void>();
    sessionChunk.pending = initial.promise;
    const route = (key: string) => <runtime.Wrapper>
        <DestinationInstanceHost tabId={key} key={key} ref={ref} pathname={pathname} focused visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <MessageRouteBody />
        </DestinationInstanceHost>
        <CurtainProbe />
    </runtime.Wrapper>;
    const screen = await renderScreen(route('cold'));
    const curtain = () => screen.root.findByType('CurtainProbe').props.state;
    try {
        await waitForHomeGovernance(() => expect(screen.findAllByType(PaneLoadingFallback)).toHaveLength(1));
        expect(screen.findAllByType(SessionCockpitShell)).toHaveLength(0);
        launch.releaseShell();
        await launch.paint();
        expect(curtain()).toBe('up');

        sessionChunk.pending = null;
        await act(async () => { initial.resolve(); });
        await waitForHomeGovernance(() => expect(screen.findAllByType(SessionCockpitShell)).toHaveLength(1));
        await launch.paint();
        expect(curtain()).toBe('leaving');

        await act(async () => { launch.finish(); });
        sessionChunk.pending = warm.promise;
        await screen.update(route('warm'));
        await waitForHomeGovernance(() => expect(screen.findAllByType(PaneLoadingFallback)).toHaveLength(1));
        await launch.paint();
        expect(curtain()).toBe('gone');
    } finally {
        sessionChunk.pending = null;
        initial.resolve();
        warm.resolve();
        await screen.unmount();
        launch.dispose();
    }
});
