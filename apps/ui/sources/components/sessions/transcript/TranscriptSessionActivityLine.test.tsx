import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const { storage } = await import('@/sync/domains/state/storage');
const { ChatListFooterWithKeyboardInset } = await import('./ChatListFrameSlots');
const { projectUiSessionAwareness } = await import('@/sync/domains/session/awareness/sessionAwareness');
const { presentSessionAwarenessV1 } = await import('@/utils/sessions/sessionUtils');

describe('hidden transcript Session activity', () => {
    it('shows the live line only while the turn runs: settled and disconnected states leave it to the group and the composer status', async () => {
        const account = await restoreServerAccountForTest({ serverUrl: 'https://transcript-activity.test', accountId: 'account-a' });
        vi.useFakeTimers();
        vi.setSystemTime(100_000);
        const shell = createSessionFixture({ id: 'activity-session', serverId: account.home.id,
            active: true, activeAt: 100_000, thinking: true, thinkingAt: 100_000,
            latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: 90_000 });
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        try {
            storage.getState().applySessions([shell]);
            screen = await renderScreen(<ChatListFooterWithKeyboardInset sessionId={shell.id}
                serverId={shell.serverId} showToolCalls={false} />);
            expect(screen.findByTestId('transcript-session-activity-status')).not.toBeNull();
            expect(screen.findByTestId('transcript-session-activity-timer')).not.toBeNull();
            expect(screen.getTextContent()).toContain(presentSessionAwarenessV1(projectUiSessionAwareness(shell, 100_000)).statusText);

            const settled = { ...shell, thinking: false, latestTurnStatus: 'completed' as const,
                latestTurnStatusObservedAt: 100_000 };
            await act(async () => { storage.getState().applySessions([settled]); });
            expect(screen.findByTestId('transcript-session-activity-timer')).toBeNull();
            expect(screen.findByTestId('transcript-session-activity-status')).toBeNull();

            const disconnected = { ...settled, active: false };
            await act(async () => { storage.getState().applySessions([disconnected]); });
            expect(screen.findByTestId('transcript-session-activity-status')).toBeNull();
            expect(screen.getTextContent()).not.toContain(presentSessionAwarenessV1(projectUiSessionAwareness(disconnected, 100_000)).statusText);

            // A subsequent turn is newer than the completion already observed;
            // replaying the initial stale snapshot must not resurrect activity.
            vi.setSystemTime(100_001);
            await act(async () => { storage.getState().applySessions([{ ...shell,
                activeAt: 100_001, thinkingAt: 100_001, latestTurnStatusObservedAt: 100_001,
            }]); });
            expect(screen.findByTestId('transcript-session-activity-status')).not.toBeNull();
            await screen.update(<ChatListFooterWithKeyboardInset sessionId={shell.id}
                serverId="another-home" showToolCalls={false} />);
            expect(screen.findByTestId('transcript-session-activity-status')).toBeNull();
        } finally {
            await screen?.unmount();
            vi.useRealTimers();
            await account.dispose();
        }
    });
});
