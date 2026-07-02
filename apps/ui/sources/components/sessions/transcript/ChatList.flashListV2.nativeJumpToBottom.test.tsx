import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flashListChatListHarnessState,
    renderFlashListChatList,
    resetFlashListChatListHarness,
    standardCleanup,
} from '@/dev/testkit';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installTranscriptCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListReactNativeMock({
            platformOs: 'ios',
        }),
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListStorageMock(importOriginal),
});

// The FlashListCompat module mock binds the ref handle once at factory time, so the whole
// file shares one stable handle; tests steer the reported native offset via this state.
const nativeScrollOffsetState = { value: 0 };
const fileFlashListRefHandle = {
    scrollToOffset: vi.fn(),
    scrollToIndex: vi.fn(),
    getAbsoluteLastScrollOffset: vi.fn(() => nativeScrollOffsetState.value),
};

beforeEach(() => {
    resetTranscriptCommonModuleMockState();
    nativeScrollOffsetState.value = 0;
    fileFlashListRefHandle.scrollToOffset.mockClear();
    fileFlashListRefHandle.scrollToIndex.mockClear();
    resetFlashListChatListHarness({ platformOs: 'ios', flashListRefHandle: fileFlashListRefHandle });
    flashListChatListHarnessState.sessionMessagesState = {
        messages: [{ kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'hi' }],
        isLoaded: true,
    };
    flashListChatListHarnessState.sessionPendingState = { messages: [], discarded: [], isLoaded: true };
    flashListChatListHarnessState.sessionActionDraftsState = [];
    flashListChatListHarnessState.sessionState = {
        ...flashListChatListHarnessState.sessionState,
        id: 'session-1',
        seq: 0,
        metadata: null,
        accessLevel: null,
        canApprovePermissions: true,
    };
    flashListChatListHarnessState.settingValues.transcriptListImplementation = 'flash_v2';
    flashListChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 72;
    flashListChatListHarnessState.settingValues.transcriptScrollJumpToBottomEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollJumpToBottomMinNewCount = 1;
    flashListChatListHarnessState.settingValues.transcriptScrollJumpToBottomAnimateScroll = false;
    flashListChatListHarnessState.settingValues.transcriptScrollJumpToBottomRevealViewportRatio = 0.75;
});

afterEach(() => {
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
    TranscriptMotionProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/transcript/motion/resolveTranscriptMotionConfig', () => ({
    resolveTranscriptMotionConfig: () => ({ preset: 'off', animateThinkingEnabled: false }),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
    TranscriptEnterWrapper: ({ children }: any) => React.createElement(React.Fragment, null, children),
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
    fireAndForget: (p: any) => p,
}));

vi.mock('@/sync/sync', async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListSyncModuleMock({
        loadOlderMessages: vi.fn(async () => ({ loaded: 0, hasMore: false, status: 'no_more' as const })),
        loadNewerMessages: vi.fn(),
    })
);

describe('ChatList (FlashList v2, native jump-to-bottom)', () => {
    it('hides the jump-to-bottom affordance when native scrolling returns within the bottom threshold', async () => {
        vi.useFakeTimers({ now: new Date(0) });

        const { ChatList } = await import('./ChatList');
        const screen = await renderFlashListChatList(
            <ChatList session={flashListChatListHarnessState.sessionState} />,
        );

        await screen.triggerInitialFill({
            layoutHeight: 500,
            contentHeight: 2000,
            contentWidth: 0,
            flushOptions: { cycles: 1, turns: 1 },
        });

        await screen.triggerScroll(1500, { isTrusted: true }, { cycles: 1, turns: 1 });
        expect(screen.findAllByTestId('transcript-jump-to-bottom')).toHaveLength(0);

        const flashListProps = screen.requireCapturedFlashListProps();
        await act(async () => {
            flashListProps.onScrollBeginDrag?.({});
        });

        await screen.triggerScroll(1000, {}, { cycles: 1, turns: 1 });
        expect(screen.findAllByTestId('transcript-jump-to-bottom').length).toBeGreaterThan(0);

        await act(async () => {
            vi.setSystemTime(new Date(600));
        });

        await screen.triggerScroll(1460, {}, { cycles: 1, turns: 1 });
        expect(screen.findAllByTestId('transcript-jump-to-bottom')).toHaveLength(0);
    });

    it('only shows jump-to-bottom after scrolling beyond the reveal threshold', async () => {
        vi.useFakeTimers({ now: new Date(0) });

        const { ChatList } = await import('./ChatList');
        const screen = await renderFlashListChatList(
            <ChatList session={flashListChatListHarnessState.sessionState} />,
        );

        await screen.triggerInitialFill({
            layoutHeight: 500,
            contentHeight: 2000,
            contentWidth: 0,
            flushOptions: { cycles: 1, turns: 1 },
        });

        await screen.triggerScroll(1500, { isTrusted: true }, { cycles: 1, turns: 1 });

        const flashListProps = screen.requireCapturedFlashListProps();
        await act(async () => {
            flashListProps.onScrollBeginDrag?.({});
        });

        await screen.triggerScroll(1200, {}, { cycles: 1, turns: 1 });
        expect(screen.findAllByTestId('transcript-jump-to-bottom')).toHaveLength(0);

        await screen.triggerScroll(1000, {}, { cycles: 1, turns: 1 });
        expect(screen.findAllByTestId('transcript-jump-to-bottom').length).toBeGreaterThan(0);
    });

    it('shows jump-to-bottom when a trusted drag flings far from the bottom on untrusted momentum frames (plan B9 momentum release)', async () => {
        vi.useFakeTimers({ now: new Date(0) });
        nativeScrollOffsetState.value = 7500;

        const { ChatList } = await import('./ChatList');
        const screen = await renderFlashListChatList(
            <ChatList session={flashListChatListHarnessState.sessionState} />,
        );

        await screen.triggerInitialFill({
            layoutHeight: 500,
            contentHeight: 8000,
            contentWidth: 0,
            flushOptions: { cycles: 1, turns: 1 },
        });

        const flashListProps = screen.requireCapturedFlashListProps();

        // Hard flick: finger travel stays inside the pin threshold (dfb 40 < 72),
        // so the release-threshold crossing happens entirely on momentum frames.
        await act(async () => {
            flashListProps.onScrollBeginDrag?.({});
        });
        nativeScrollOffsetState.value = 7460;
        await screen.triggerScroll(7460, { isTrusted: true }, { cycles: 1, turns: 1 });
        await act(async () => {
            flashListProps.onScrollEndDrag?.({});
            flashListProps.onMomentumScrollBegin?.({});
        });

        // Untrusted momentum frames carry the viewport far from the bottom.
        nativeScrollOffsetState.value = 7000;
        await screen.triggerScroll(7000, {}, { cycles: 1, turns: 1 });
        nativeScrollOffsetState.value = 5000;
        await screen.triggerScroll(5000, {}, { cycles: 1, turns: 1 });
        nativeScrollOffsetState.value = 500;
        await screen.triggerScroll(500, {}, { cycles: 1, turns: 1 });
        nativeScrollOffsetState.value = 0;
        await screen.triggerScroll(0, {}, { cycles: 1, turns: 1 });
        await act(async () => {
            flashListProps.onMomentumScrollEnd?.({});
        });

        expect(screen.findAllByTestId('transcript-jump-to-bottom').length).toBeGreaterThan(0);
    });

    it('shows jump-to-bottom at momentum settle even when every momentum frame was swallowed (plan B9 settle release)', async () => {
        vi.useFakeTimers({ now: new Date(0) });
        nativeScrollOffsetState.value = 7500;

        const { ChatList } = await import('./ChatList');
        const screen = await renderFlashListChatList(
            <ChatList session={flashListChatListHarnessState.sessionState} />,
        );

        await screen.triggerInitialFill({
            layoutHeight: 500,
            contentHeight: 8000,
            contentWidth: 0,
            flushOptions: { cycles: 1, turns: 1 },
        });

        const flashListProps = screen.requireCapturedFlashListProps();

        // Hard flick near the bottom; in the field every momentum scroll frame can be
        // swallowed by open prepend transactions ('pending' observations), so the settle
        // itself must surface the released state.
        await act(async () => {
            flashListProps.onScrollBeginDrag?.({});
        });
        nativeScrollOffsetState.value = 7460;
        await screen.triggerScroll(7460, { isTrusted: true }, { cycles: 1, turns: 1 });
        await act(async () => {
            flashListProps.onScrollEndDrag?.({});
            flashListProps.onMomentumScrollBegin?.({});
        });

        nativeScrollOffsetState.value = 0;
        await act(async () => {
            flashListProps.onMomentumScrollEnd?.({});
        });
        await screen.settle({ cycles: 1, turns: 1 });

        expect(screen.findAllByTestId('transcript-jump-to-bottom').length).toBeGreaterThan(0);
    });

    it('keeps jump-to-bottom hidden for momentum without a drag (plan B9 B6-safety)', async () => {
        vi.useFakeTimers({ now: new Date(0) });

        const { ChatList } = await import('./ChatList');
        const screen = await renderFlashListChatList(
            <ChatList session={flashListChatListHarnessState.sessionState} />,
        );

        await screen.triggerInitialFill({
            layoutHeight: 500,
            contentHeight: 2000,
            contentWidth: 0,
            flushOptions: { cycles: 1, turns: 1 },
        });

        const flashListProps = screen.requireCapturedFlashListProps();

        // An animated programmatic scroll fires momentum events without any drag session.
        // Untrusted moved-away frames (height churn) inside that window must never release
        // follow or reveal the button.
        await act(async () => {
            flashListProps.onMomentumScrollBegin?.({});
        });
        await screen.triggerScroll(1000, {}, { cycles: 1, turns: 1 });
        await screen.triggerScroll(800, {}, { cycles: 1, turns: 1 });
        await act(async () => {
            flashListProps.onMomentumScrollEnd?.({});
        });
        await screen.settle({ cycles: 1, turns: 1 });

        expect(screen.findAllByTestId('transcript-jump-to-bottom')).toHaveLength(0);
    });

    it('uses native event dimensions to hide jump-to-bottom when cached content height is stale', async () => {
        vi.useFakeTimers({ now: new Date(0) });

        const { ChatList } = await import('./ChatList');
        const screen = await renderFlashListChatList(
            <ChatList session={flashListChatListHarnessState.sessionState} />,
        );

        await screen.triggerInitialFill({
            layoutHeight: 500,
            contentHeight: 2200,
            contentWidth: 0,
            flushOptions: { cycles: 1, turns: 1 },
        });

        await screen.triggerScroll(1700, {
            contentSize: { height: 2200, width: 0 },
            isTrusted: true,
            layoutMeasurement: { height: 500, width: 0 },
        }, { cycles: 1, turns: 1 });
        expect(screen.findAllByTestId('transcript-jump-to-bottom')).toHaveLength(0);

        const flashListProps = screen.requireCapturedFlashListProps();
        await act(async () => {
            flashListProps.onScrollBeginDrag?.({});
        });

        await screen.triggerScroll(1000, {
            contentSize: { height: 2000, width: 0 },
            layoutMeasurement: { height: 500, width: 0 },
        }, { cycles: 1, turns: 1 });
        expect(screen.findAllByTestId('transcript-jump-to-bottom').length).toBeGreaterThan(0);

        await screen.triggerScroll(1500, {
            contentSize: { height: 2000, width: 0 },
            layoutMeasurement: { height: 500, width: 0 },
        }, { cycles: 1, turns: 1 });
        expect(screen.findAllByTestId('transcript-jump-to-bottom')).toHaveLength(0);
    });
});
