import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, createTestSessionTranscriptSource, renderWithSessionTranscriptSource, standardCleanup } from '@/dev/testkit';
import {
    chatListHarnessState,
    createChatListHarnessWebScroller,
    resetChatListHarness,
    triggerLegendChatListInitialFill,
    triggerLegendChatListScroll,
    triggerLegendChatListWheel,
    withChatListHarnessWebScrollerDom,
} from '@/dev/testkit/harness/chatListHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { Message } from '@happier-dev/session-core/messages';
import { installTranscriptCommonModuleMocks } from './transcriptTestHelpers';

installTranscriptCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/harness/chatListHarness')).createChatListHarnessReactNativeMock({ platformOs: 'web' }),
});
installDisconnectedServerSocketBoundary();
vi.mock('@legendapp/list/react-native', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@legendapp/list/react-native')>()),
    ...(await import('@/dev/testkit/harness/chatListHarness')).createLegendChatListModuleMock(),
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
}));

await loadSyncSingletonForTests();
const { ChatList } = await import('./ChatList');

const session = createSessionFixture({ id: 'session-1', serverId: 'test-server', metadata: null });
const viewportGeometry = {
    contentSize: { height: 3000, width: 400 },
    layoutMeasurement: { height: 600, width: 400 },
    isTrusted: true,
} as const;

async function detachFromTail(scroller: ReturnType<typeof createChatListHarnessWebScroller>) {
    await triggerLegendChatListScroll(scroller.scrollTop, viewportGeometry, { turns: 1 });
    await triggerLegendChatListWheel(-100, { turns: 1 });
    // Input arrives before DOM movement; the renderer classifies the actual
    // scrollTop change against its last observed/programmatic position.
    scroller.scrollTop = 200;
    chatListHarnessState.legendListState = {
        contentLength: 3000, scrollLength: 600, scroll: 200,
        isAtEnd: false, isNearEnd: false, isWithinMaintainScrollAtEndThreshold: false,
    };
    await triggerLegendChatListScroll(200, viewportGeometry, { turns: 1 });
}

beforeEach(() => {
    resetChatListHarness();
    storage.setState({
        sessions: { [session.id]: session },
        settings: {
            ...settingsDefaults,
            transcriptGroupingMode: 'linear',
            transcriptGroupToolCalls: false,
            transcriptScrollPinEnabled: true,
            transcriptScrollPinOffsetThresholdPx: 72,
            transcriptScrollJumpToBottomEnabled: true,
            transcriptScrollJumpToBottomMinNewCount: 1,
            transcriptScrollJumpToBottomAnimateScroll: false,
            transcriptMotionPreset: 'off',
            transcriptAnimateNewItemsEnabled: false,
        },
    });
    // The recycler's real settle monitor needs an asynchronous native frame boundary.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
        Number(setTimeout(() => callback(Date.now()), 0)));
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
});

afterEach(() => {
    standardCleanup();
    storage.setState(storage.getInitialState(), true);
    vi.unstubAllGlobals();
});

describe('ChatList (jump-to-bottom)', () => {
    it('shows a jump-to-bottom button when unpinned and new messages arrive', async () => {
        const onViewportChange = vi.fn();
        const messages: Message[] = [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' },
            { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' },
        ];
        const source = createTestSessionTranscriptSource({ sessionId: session.id, messages });
        const scroller = createChatListHarnessWebScroller({ clientHeight: 600, scrollHeight: 3000, scrollTop: 2400 });
        await withChatListHarnessWebScrollerDom(scroller, async () => {
        const screen = await renderWithSessionTranscriptSource(
            <ChatList session={session} sessionSurfaceKey={JSON.stringify(['test-server', session.id])} onViewportChange={onViewportChange} />,
            source,
        );
        try {
        await triggerLegendChatListInitialFill(screen, { contentHeight: 3000, layoutHeight: 600 });
        await detachFromTail(scroller);
        expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({ isPinned: false }));

        // The canonical dataset owner publishes the new row; equal Session props
        // are not an internal-store notification and cannot force a memoized root.
        await act(async () => {
            source.update({
                messages: [...messages, { kind: 'agent-text', id: 'a2', localId: null, createdAt: 3, text: 'a2' }],
                metadata: null, agentState: null, reducerState: null,
            });
        });

        const jumpButtons = screen.findAllByTestId('transcript-jump-to-bottom');
        expect(jumpButtons.length).toBeGreaterThan(0);
        onViewportChange.mockClear();
        await act(async () => { jumpButtons[0]?.props.onPress(); });
        expect(onViewportChange).toHaveBeenCalledWith({
            isPinned: true, offsetY: 0, shouldRestoreViewport: false,
        });
        } finally {
            await screen.unmount();
        }
        });
    });

    it('shows a jump-to-bottom button when an existing newest turn grows while unpinned', async () => {
        const onViewportChange = vi.fn();
        storage.setState({ settings: { ...storage.getState().settings, transcriptGroupingMode: 'turns' } });
        const messages: Message[] = [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'u1' }];
        const source = createTestSessionTranscriptSource({ sessionId: session.id, messages });
        const scroller = createChatListHarnessWebScroller({ clientHeight: 600, scrollHeight: 3000, scrollTop: 2400 });
        await withChatListHarnessWebScrollerDom(scroller, async () => {
        const screen = await renderWithSessionTranscriptSource(
            <ChatList session={session} sessionSurfaceKey={JSON.stringify(['test-server', session.id])} onViewportChange={onViewportChange} />,
            source,
        );
        try {
        await triggerLegendChatListInitialFill(screen, { contentHeight: 3000, layoutHeight: 600 });
        await detachFromTail(scroller);
        expect(onViewportChange).toHaveBeenCalledWith(expect.objectContaining({ isPinned: false }));

        await act(async () => {
            source.update({
                messages: [...messages, { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'a1' }],
                metadata: null, agentState: null, reducerState: null,
            });
        });

        expect(screen.findAllByTestId('transcript-jump-to-bottom').length).toBeGreaterThan(0);
        } finally {
            await screen.unmount();
        }
        });
    });
});
