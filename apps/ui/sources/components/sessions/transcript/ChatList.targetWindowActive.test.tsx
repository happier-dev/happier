import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flashListChatListHarnessState,
    renderFlashListChatList,
    resetFlashListChatListHarness,
    standardCleanup,
} from '@/dev/testkit';
import { triggerFlashListChatListLoad } from '@/dev/testkit/harness/chatListHarness';
import type { SessionMessagesWindowState } from '@/sync/runtime/sessionMessagesWindowState';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const scrollToOffsetSpy = vi.fn();
const scrollToIndexSpy = vi.fn();
const loadTargetWindowMessagesSpy = vi.hoisted(() => vi.fn());
const markSessionLiveTailIntentSpy = vi.hoisted(() => vi.fn());
const viewportControllerMockState = vi.hoisted(() => ({
    resolveInputs: [] as Array<Record<string, unknown>>,
}));

const inactiveTargetWindowState: SessionMessagesWindowState = {
    isWindowMode: false,
    windowId: null,
    targetSeq: null,
    windowMinSeq: null,
    windowMaxSeq: null,
    olderCursor: null,
    newerCursor: null,
    hasMoreOlder: null,
    hasMoreNewer: null,
    activatedAtMs: null,
    lifecycleEpoch: 2,
};

const activeTargetWindowState: SessionMessagesWindowState = {
    isWindowMode: true,
    windowId: 'window-100',
    targetSeq: 2,
    windowMinSeq: 1,
    windowMaxSeq: 2,
    olderCursor: 1,
    newerCursor: 2,
    hasMoreOlder: true,
    hasMoreNewer: false,
    activatedAtMs: 1,
    lifecycleEpoch: 1,
};

let targetWindowState: SessionMessagesWindowState = activeTargetWindowState;

type ChatListComponent = (typeof import('./ChatList'))['ChatList'];

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
    viewportControllerMockState.resolveInputs = [];
    targetWindowState = activeTargetWindowState;
    scrollToOffsetSpy.mockClear();
    scrollToIndexSpy.mockClear();
    resetFlashListChatListHarness({
        flashListRefHandle: { scrollToOffset: scrollToOffsetSpy, scrollToIndex: scrollToIndexSpy },
        platformOs: 'ios',
    });
    flashListChatListHarnessState.sessionState = {
        ...flashListChatListHarnessState.sessionState,
        active: true,
        id: 'session-target-window',
        seq: 0,
        metadata: null,
        accessLevel: null,
        canApprovePermissions: true,
    };
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 72;
    flashListChatListHarnessState.sessionPendingState = { messages: [], discarded: [], isLoaded: true };
    flashListChatListHarnessState.sessionActionDraftsState = [];
    flashListChatListHarnessState.sessionMessagesState = {
        isLoaded: true,
        messages: [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'hi' },
            { kind: 'assistant-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'streaming...' },
        ],
    };
});

afterEach(() => {
    standardCleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    resetTranscriptCommonModuleMockState();
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
            return { kind: 'message', id: `msg:${id}`, messageId: id, createdAt: message?.createdAt ?? 0, seq: message?.seq ?? null };
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
    JumpToBottomButton: (props: any) => React.createElement('JumpToBottomButton', props),
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
        getSessionTargetWindowState: () => targetWindowState,
        hasDeferredNewerMessages: () => false,
        loadTargetWindowMessages: loadTargetWindowMessagesSpy,
        loadOlderMessages: vi.fn(async () => ({ loaded: 0, hasMore: false, status: 'no_more' as const })),
        loadNewerMessages: vi.fn(),
        markSessionLiveTailIntent: markSessionLiveTailIntentSpy,
    })
);

vi.mock('@/components/sessions/transcript/viewport/createTranscriptViewportController', async () => {
    const actual = await vi.importActual<typeof import('@/components/sessions/transcript/viewport/createTranscriptViewportController')>(
        '@/components/sessions/transcript/viewport/createTranscriptViewportController',
    );
    return {
        ...actual,
        createTranscriptViewportController: () => {
            const controller = actual.createTranscriptViewportController();
            return {
                ...controller,
                resolve: (input: Parameters<typeof controller.resolve>[0]) => {
                    viewportControllerMockState.resolveInputs.push(input as unknown as Record<string, unknown>);
                    return controller.resolve(input);
                },
            };
        },
    };
});

async function settleNativeMount(screen: Awaited<ReturnType<typeof renderFlashListChatList>>) {
    await triggerFlashListChatListLoad(12, { turns: 1 });
    await screen.settle({ advanceTimersMs: 160, cycles: 1, turns: 1 });
}

async function primeAtBottom(screen: Awaited<ReturnType<typeof renderFlashListChatList>>) {
    await screen.triggerInitialFill({
        layoutHeight: 600,
        contentHeight: 1200,
        contentWidth: 0,
        flushOptions: { cycles: 1, turns: 1 },
    });
    await settleNativeMount(screen);
    scrollToOffsetSpy.mockClear();
    scrollToIndexSpy.mockClear();
    loadTargetWindowMessagesSpy.mockReset();
    markSessionLiveTailIntentSpy.mockReset();
    viewportControllerMockState.resolveInputs = [];
}

async function growStreamingAssistantMessage(
    ChatList: ChatListComponent,
    screen: Awaited<ReturnType<typeof renderFlashListChatList>>,
    seq: number,
    contentHeight = 1500,
) {
    flashListChatListHarnessState.sessionMessagesState = {
        isLoaded: true,
        messages: [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'hi' },
            {
                kind: 'assistant-text',
                id: 'a1',
                localId: null,
                createdAt: 2,
                seq: 2,
                text: `streaming... ${seq}`,
            },
        ],
    };
    await screen.update(<ChatList session={{ ...flashListChatListHarnessState.sessionState, seq }} />);
    await screen.settle({ cycles: 1, turns: 1 });
    await screen.triggerContentSizeChange(0, contentHeight, { advanceTimersMs: 1, cycles: 1, turns: 2 });
}

async function appendLiveTailMessageAfterReset(
    ChatList: ChatListComponent,
    screen: Awaited<ReturnType<typeof renderFlashListChatList>>,
    followBottomIntentKey: string,
) {
    flashListChatListHarnessState.sessionMessagesState = {
        isLoaded: true,
        messages: [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, seq: 1, text: 'hi' },
            { kind: 'assistant-text', id: 'a1', localId: null, createdAt: 2, seq: 2, text: 'streaming... 1' },
            { kind: 'assistant-text', id: 'a2', localId: null, createdAt: 3, seq: 3, text: 'live tail after reset' },
        ],
    };
    await screen.update(
        <ChatList
            followBottomIntentKey={followBottomIntentKey}
            session={{ ...flashListChatListHarnessState.sessionState, seq: 3 }}
        />,
    );
    await screen.settle({ cycles: 1, turns: 1 });
    await screen.triggerContentSizeChange(0, 1800, { advanceTimersMs: 1, cycles: 1, turns: 2 });
    await screen.settle({ advanceTimersMs: 160, cycles: 2, turns: 2 });
}

function autoFollowReasons() {
    return viewportControllerMockState.resolveInputs
        .filter((input) => input.type === 'auto-follow')
        .map((input) => input.reason);
}

describe('ChatList target-window active live-tail gating', () => {
    it('gates auto-follow and native MVCP bottom autoscroll while target-window mode is active, then re-enables after live-tail reset', async () => {
        const { ChatList } = await import('./ChatList');
        const screen = await renderFlashListChatList(
            <ChatList session={flashListChatListHarnessState.sessionState} />,
        );

        await primeAtBottom(screen);

        await growStreamingAssistantMessage(ChatList, screen, 1);

        expect(autoFollowReasons()).not.toContain('stream-append');
        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
        expect(scrollToIndexSpy).not.toHaveBeenCalled();
        expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual({
            startRenderingFromBottom: true,
        });

        targetWindowState = inactiveTargetWindowState;
        viewportControllerMockState.resolveInputs = [];
        scrollToOffsetSpy.mockClear();
        scrollToIndexSpy.mockClear();

        const followBottomIntentKey = 'live-tail-reset-1';
        await act(async () => {
            await screen.update(
                <ChatList
                    followBottomIntentKey={followBottomIntentKey}
                    session={{ ...flashListChatListHarnessState.sessionState, seq: 2 }}
                />,
            );
        });
        await screen.settle({ cycles: 1, turns: 1 });
        scrollToOffsetSpy.mockClear();
        scrollToIndexSpy.mockClear();
        await appendLiveTailMessageAfterReset(ChatList, screen, followBottomIntentKey);

        expect(autoFollowReasons()).toContain('stream-append');
        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
        expect(scrollToIndexSpy).not.toHaveBeenCalled();
        expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
            startRenderingFromBottom: true,
        });
        expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).not.toHaveProperty('disabled');
    });

    it('pages the active target window at the older FlashList edge', async () => {
        loadTargetWindowMessagesSpy.mockResolvedValue({
            status: 'loaded',
            windowId: 'window-100',
            targetSeq: 2,
            targetPresent: true,
        });
        const { ChatList } = await import('./ChatList');
        const screen = await renderFlashListChatList(
            <ChatList session={flashListChatListHarnessState.sessionState} />,
        );
        await primeAtBottom(screen);

        await act(async () => {
            screen.requireCapturedFlashListProps().onEndReached?.();
            await Promise.resolve();
        });

        expect(loadTargetWindowMessagesSpy).toHaveBeenCalledWith(
            'session-target-window',
            { kind: 'seq', seq: 2 },
            { direction: 'older' },
        );
        expect(markSessionLiveTailIntentSpy).not.toHaveBeenCalled();
    });

    it('exits target-window mode through live-tail intent at the newest edge when no newer pages remain', async () => {
        const { ChatList } = await import('./ChatList');
        const screen = await renderFlashListChatList(
            <ChatList session={flashListChatListHarnessState.sessionState} />,
        );
        await primeAtBottom(screen);

        await act(async () => {
            screen.requireCapturedFlashListProps().onStartReached?.();
            await Promise.resolve();
        });

        expect(loadTargetWindowMessagesSpy).not.toHaveBeenCalled();
        expect(markSessionLiveTailIntentSpy).toHaveBeenCalledWith('session-target-window');
    });
});
