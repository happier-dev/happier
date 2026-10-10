import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { Session } from '@/sync/domains/state/storageTypes';

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const { storage } = await import('@/sync/domains/state/storage');
const { useChatListRootState } = await import('./useChatListRootState');
const { ChatListFooterWithKeyboardInset } = await import('./ChatListFrameSlots');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');
const { PluginContextualResourceStoreProvider } = await import('@/components/plugins/surfaces/PluginContextualResourceStoreProvider');

function RootActivity(props: Readonly<{ session: Session }>) {
    const { internalProps } = useChatListRootState({ session: props.session, sessionSurfaceKey: 'legacy-activity' });
    return <ChatListFooterWithKeyboardInset sessionId={internalProps.sessionId}
        serverId={internalProps.sessionServerId} showToolCalls={false} />;
}

describe('transcript root activity Home', () => {
    it('carries the canonical unique Home for a legacy Session shell without borrowing an unknown Session', async () => {
        const account = await restoreServerAccountForTest({ serverUrl: 'https://legacy-transcript-activity.test' });
        // A running turn: the hidden-tools activity line exists only while work runs.
        const live = createSessionFixture({ id: 'legacy-activity-session', serverId: account.home.id,
            active: true, activeAt: Date.now(), thinking: true, thinkingAt: Date.now(),
            latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: Date.now() });
        const legacyShell = { ...live, serverId: undefined };
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        const view = (session: Session) => <AppSessionTranscriptSourceProvider sessionId={session.id}
            serverId={account.home.id} navigation="none">
            <PluginContextualResourceStoreProvider><RootActivity session={session} /></PluginContextualResourceStoreProvider>
        </AppSessionTranscriptSourceProvider>;
        try {
            storage.getState().applySessions([live]);
            screen = await renderScreen(view(legacyShell));
            expect(screen.findByTestId('transcript-session-activity-status')).not.toBeNull();
            await screen.update(view({ ...legacyShell, id: 'unknown-session' }));
            expect(screen.findByTestId('transcript-session-activity-status')).toBeNull();
        } finally {
            await screen?.unmount();
            await account.dispose();
        }
    });
});
