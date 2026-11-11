import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createSessionFixture, createSessionMessagesFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { ChatListHarnessWebScroller } from '@/dev/testkit/harness/chatListHarness';
import type { Message } from '@happier-dev/session-core/messages';

const geometry = vi.hoisted(() => {
    const state: { scroller: ChatListHarnessWebScroller | null } = { scroller: null };
    return state;
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@legendapp/list/react-native', async importOriginal => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    // Only the external recycler/geometry is substituted. ChatList, its first-paint,
    // rich-content, source, message/store and route owners remain real.
    const boundary = createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(),
        renderItemLimit: 8, emitViewability: true, emitLoadDuringLayout: true,
        resolveState: () => ({ contentLength: 600, scrollLength: 600,
            start: 0, end: 299, startBuffered: 0, endBuffered: 299 }),
        refHandle: { getScrollableNode: vi.fn(() => geometry.scroller), getNativeScrollRef: vi.fn(() => geometry.scroller) },
    });
    return boundary.module;
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { getStorage } = await import('@/sync/domains/state/storage');
const { ChatList } = await import('./ChatList');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');
const { createChatListHarnessWebScroller, withChatListHarnessWebScrollerDom } = await import('@/dev/testkit/harness/chatListHarness');
const original = getStorage().getState();
afterEach(async () => {
    await standardCleanup();
    getStorage().setState(original, true);
    await homes.reset();
    geometry.scroller = null;
});

it('keeps a warm renderer readiness fact published before the transcript mount effects', async () => {
    const serverId = await homes.addHome({ name: 'Source', serverUrl: 'https://source-paint.test', accountId: 'viewer', currentAccount: true });
    const session = createSessionFixture({ id: 'warm-source', serverId, active: false });
    const messages: Message[] = Array.from({ length: 300 }, (_, index) => ({
        kind: 'agent-text', id: `answer-${index}`, localId: null, createdAt: index + 1, seq: index + 1,
        text: `Source answer ${index}`, isThinking: false,
    }));
    getStorage().setState({ sessions: { [session.id]: session }, profileScope: { serverId, accountId: 'viewer' },
        settings: { ...getStorage().getState().settings, transcriptGroupingMode: 'linear' },
        sessionMessages: { [session.id]: createSessionMessagesFixture({ isLoaded: true,
            messageIdsOldestFirst: messages.map(message => message.id),
            messagesById: Object.fromEntries(messages.map(message => [message.id, message])),
        }) },
    });
    const scroller = createChatListHarnessWebScroller({ clientHeight: 600, clientWidth: 390, scrollHeight: 600 });
    geometry.scroller = scroller;
    await withChatListHarnessWebScrollerDom(scroller, async () => {
        const screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId={session.id} serverId={serverId}>
            <ChatList session={session} sessionSurfaceKey="warm-source-surface"
                onEditPendingMessage={() => {}} />
        </AppSessionTranscriptSourceProvider>);
        try {
            await flushHookEffects();
            expect(screen.findByTestId('transcript-first-paint-placeholder')).toBeNull();
            expect(screen.getTextContent()).toContain('Source answer');
        } finally { await screen.unmount(); }
    });
});
