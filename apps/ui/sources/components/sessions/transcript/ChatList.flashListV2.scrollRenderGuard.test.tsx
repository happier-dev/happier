import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flashListChatListHarnessState,
    renderFlashListChatList,
    resetFlashListChatListHarness,
    standardCleanup,
} from '@/dev/testkit';
import { triggerFlashListChatListLoad } from '@/dev/testkit/harness/chatListHarness';
import { transcriptViewportTelemetry } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Port plan W4.3 / G4 performance guard: the transcript scroll path must stay ref-based — scroll
 * frames that cross no UI-state threshold must produce ZERO additional React commits of the
 * ChatList subtree. Commits are counted through a TEST-LOCAL `React.Profiler` wrapper around
 * ChatList (recorded W4 decision: do not depend on perf-telemetry profiler infrastructure for
 * this guard; a Profiler ancestor observes exactly the same subtree commits). Viewport telemetry
 * is deliberately ENABLED (the guard must hold with telemetry on).
 */

const scrollToOffsetSpy = vi.fn();
let chatListCommitCount = 0;

const onProfilerRender: React.ProfilerOnRenderCallback = () => {
    chatListCommitCount += 1;
};

function renderGuardedChatListElement(): React.ReactElement {
    return (
        <React.Profiler id="sessions.transcript.chatList.scrollRenderGuard" onRender={onProfilerRender}>
            <ChatListLazy />
        </React.Profiler>
    );
}

// The ChatList module must load AFTER the vi.mocks below, so the guarded element resolves it
// lazily through a small indirection component set up per test.
let LoadedChatList: React.ComponentType<{ session: any }> | null = null;
function ChatListLazy(): React.ReactElement {
    if (!LoadedChatList) throw new Error('ChatList module not loaded — call loadChatList() first');
    return <LoadedChatList session={flashListChatListHarnessState.sessionState} />;
}

async function loadChatList(): Promise<void> {
    const { ChatList } = await import('./ChatList');
    LoadedChatList = ChatList;
}

installTranscriptCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListReactNativeMock({
            platformOs: 'ios',
        }),
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListStorageMock(importOriginal),
});

beforeEach(() => {
    vi.useFakeTimers({ now: new Date(0) });
    resetTranscriptCommonModuleMockState();
    scrollToOffsetSpy.mockClear();
    chatListCommitCount = 0;
    LoadedChatList = null;
    transcriptViewportTelemetry.configure({ enabled: true, capacity: 500 });
    resetFlashListChatListHarness({
        flashListRefHandle: { scrollToOffset: scrollToOffsetSpy, scrollToIndex: vi.fn() },
        platformOs: 'ios',
    });
    flashListChatListHarnessState.sessionMessagesState = {
        messages: [{ kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'hi' }],
        isLoaded: true,
    };
    flashListChatListHarnessState.sessionPendingState = { messages: [], discarded: [], isLoaded: true };
    flashListChatListHarnessState.sessionActionDraftsState = [];
    // sessionSeq=0 avoids the initial-fill effect's unconditional pin (matches sibling suites).
    flashListChatListHarnessState.sessionState = {
        ...flashListChatListHarnessState.sessionState,
        id: 'session-1',
        seq: 0,
        metadata: null,
        accessLevel: null,
        canApprovePermissions: true,
    };
});

afterEach(() => {
    transcriptViewportTelemetry.configure({ enabled: false, sink: null });
    vi.clearAllTimers();
    vi.useRealTimers();
    resetTranscriptCommonModuleMockState();
    standardCleanup();
});

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListModuleMock()
);

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/sessions/chatListItems', async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListItemsModuleMock(({ messageIdsOldestFirst, messagesById }: any) =>
        (messageIdsOldestFirst ?? []).map((id: string) => {
            const message = messagesById?.[id];
            return { kind: 'message', id: `msg:${id}`, messageId: id, createdAt: message?.createdAt ?? 0, seq: null };
        }),
    )
);

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('./MessageView', () => ({
    MessageView: () => React.createElement('MessageView'),
    MessageViewWithSessionCommon: () => React.createElement('MessageViewWithSessionCommon'),
}));

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
    PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
    SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: () => React.createElement('TurnView'),
    TurnViewWithSessionCommon: () => React.createElement('TurnViewWithSessionCommon'),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionProvider', () => ({
    TranscriptMotionProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/transcript/motion/resolveTranscriptMotionConfig', () => ({
    resolveTranscriptMotionConfig: () => ({ preset: 'off', animateThinkingEnabled: false }),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
    TranscriptEnterWrapper: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/transcript/scroll/JumpToBottomButton', () => ({
    JumpToBottomButton: () => null,
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
    getPermissionsInUiWhileLocal: () => ({}),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (p: Promise<unknown>) => p,
}));

vi.mock('@/sync/sync', async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListSyncModuleMock({
        loadOlderMessages: vi.fn(async () => ({ loaded: 0, hasMore: false, status: 'no_more' as const })),
        loadNewerMessages: vi.fn(),
    })
);

describe('ChatList (FlashList v2 scroll-path render guard, plan G4)', () => {
    async function renderGuardedChatList() {
        await loadChatList();
        const screen = await renderFlashListChatList(renderGuardedChatListElement());
        expect(screen.getCapturedFlashListProps()).toBeTruthy();
        return screen;
    }

    async function settleNativeMount(screen: Awaited<ReturnType<typeof renderFlashListChatList>>) {
        await screen.triggerInitialFill({
            layoutHeight: 600,
            contentHeight: 3000,
            contentWidth: 0,
            flushOptions: { cycles: 1, turns: 1 },
        });
        await triggerFlashListChatListLoad(12, { turns: 1 });
        await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });
    }

    it('observes ChatList commits through the test-local profiler (guard sensitivity check)', async () => {
        const screen = await renderGuardedChatList();
        await settleNativeMount(screen);

        // The mount itself must be observable, otherwise the zero-commit assertion below would be
        // vacuously green (a mis-wired profiler would also report zero).
        expect(chatListCommitCount).toBeGreaterThan(0);
    });

    it('issues zero additional React commits for steady mid-list scroll frames (scroll path stays ref-based)', async () => {
        const screen = await renderGuardedChatList();
        await settleNativeMount(screen);

        const scrollExtras = {
            contentSize: { height: 3000, width: 0 },
            layoutMeasurement: { height: 600, width: 0 },
            isTrusted: true,
        } as const;

        // One trusted escape scroll away from the bottom: pin/jump-button state transitions are
        // legitimate React commits and may happen HERE (not per frame). Warm through the full
        // mid-list offset range once so any one-time distance-bucket state settles, then baseline.
        await screen.triggerScroll(1200, { ...scrollExtras });
        await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });
        await screen.triggerScroll(1000, { ...scrollExtras });
        await screen.triggerScroll(1180, { ...scrollExtras });
        await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });

        const baselineCommits = chatListCommitCount;

        // 12 steady mid-list frames: all unpinned, far from both the pin threshold (bottom) and the
        // top-pagination threshold; no UI-state boundary is crossed, so the scroll path must commit
        // NOTHING (per-frame work stays in refs — invariant E adjacency).
        const midListOffsets = [1180, 1150, 1120, 1090, 1060, 1030, 1000, 1030, 1060, 1090, 1120, 1150];
        for (const offsetY of midListOffsets) {
            await screen.triggerScroll(offsetY, { ...scrollExtras });
        }

        const commitsAfterScrolls = chatListCommitCount;
        expect(
            commitsAfterScrolls - baselineCommits,
            `scroll path regression: ${commitsAfterScrolls - baselineCommits} React commit(s) during `
            + `${midListOffsets.length} steady scroll frames (expected 0 — per-frame setState on the scroll path)`,
        ).toBe(0);
    });
});
