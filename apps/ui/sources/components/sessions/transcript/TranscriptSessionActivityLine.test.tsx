import * as React from 'react';
import { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// Exercise the real web spinner host; only the native platform boundary is replaced.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default },
    });
});

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const { storage } = await import('@/sync/domains/state/storage');
const { ChatListFooterWithKeyboardInset } = await import('./ChatListFrameSlots');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');
const { projectUiSessionAwareness } = await import('@/sync/domains/session/awareness/sessionAwareness');
const { presentSessionAwarenessV1 } = await import('@/utils/sessions/sessionUtils');

describe('hidden transcript Session activity', () => {
    it('keeps delayed background work visible with paused motion and resumes on a fresh observation', async () => {
        const account = await restoreServerAccountForTest({ serverUrl: 'https://transcript-background.test', accountId: 'account-a' });
        const previousLocalSettings = storage.getState().localSettings;
        vi.useFakeTimers();
        vi.setSystemTime(500_000);
        const shell = createSessionFixture({ id: 'background-session', serverId: account.home.id,
            active: true, activeAt: 500_000, presence: 'online', thinking: false,
            latestTurnStatus: 'completed', latestTurnStatusObservedAt: 490_000,
            runtimeActivityState: 'active', runtimeActivityActiveCount: 2,
            runtimeActivityObservedAt: 500_000, runtimeActivityRevision: 1 });
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        try {
            storage.getState().applyLocalSettings({ loadingIndicatorStyle: 'classicRing' });
            storage.getState().applySessions([shell]);
            screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId={shell.id} serverId={shell.serverId ?? null}>
                <ChatListFooterWithKeyboardInset sessionId={shell.id} serverId={shell.serverId} showToolCalls={false} />
            </AppSessionTranscriptSourceProvider>);
            const animatedHosts = () => screen!.findAll((node) => typeof node.type === 'string'
                && Boolean(StyleSheet.flatten(node.props.style)?.animationName));
            expect(animatedHosts().length).toBeGreaterThan(0);
            await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
            expect(screen.findByTestId('transcript-session-activity-status')).not.toBeNull();
            expect(screen.getTextContent()).toContain(presentSessionAwarenessV1(projectUiSessionAwareness(shell, Date.now())).statusText);
            expect(animatedHosts()).toHaveLength(0);
            await act(async () => { storage.getState().applySessions([{ ...shell,
                activeAt: Date.now(), runtimeActivityObservedAt: Date.now(), runtimeActivityRevision: 2,
            }]); });
            expect(animatedHosts().length).toBeGreaterThan(0);
        } finally {
            await screen?.unmount();
            vi.useRealTimers();
            storage.setState({ localSettings: previousLocalSettings });
            await account.dispose();
        }
    });

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
            screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId={shell.id} serverId={shell.serverId ?? null}>
                <ChatListFooterWithKeyboardInset sessionId={shell.id}
                    serverId={shell.serverId} showToolCalls={false} />
            </AppSessionTranscriptSourceProvider>);
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
            await screen.update(<AppSessionTranscriptSourceProvider sessionId={shell.id} serverId="another-home">
                <ChatListFooterWithKeyboardInset sessionId={shell.id}
                    serverId="another-home" showToolCalls={false} />
            </AppSessionTranscriptSourceProvider>);
            expect(screen.findByTestId('transcript-session-activity-status')).toBeNull();
        } finally {
            await screen?.unmount();
            vi.useRealTimers();
            await account.dispose();
        }
    });
});
