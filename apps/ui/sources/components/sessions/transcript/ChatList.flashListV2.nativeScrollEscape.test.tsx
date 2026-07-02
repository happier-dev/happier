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
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const scrollToOffsetSpy = vi.fn();
const scrollToIndexSpy = vi.fn();
const getAbsoluteLastScrollOffsetSpy = vi.fn(() => undefined as number | undefined);
const flashListRefHandle = {
    getAbsoluteLastScrollOffset: getAbsoluteLastScrollOffsetSpy,
    scrollToIndex: scrollToIndexSpy,
    scrollToOffset: scrollToOffsetSpy,
};
const viewportControllerMockState = vi.hoisted(() => ({
    resolveInputs: [] as Array<Record<string, unknown>>,
}));

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
    scrollToOffsetSpy.mockClear();
    scrollToIndexSpy.mockClear();
    getAbsoluteLastScrollOffsetSpy.mockReset();
    getAbsoluteLastScrollOffsetSpy.mockReturnValue(undefined);
    resetFlashListChatListHarness({
        flashListRefHandle,
        platformOs: 'ios',
    });
    flashListChatListHarnessState.sessionPendingState = { messages: [], discarded: [], isLoaded: true };
    flashListChatListHarnessState.sessionActionDraftsState = [];
    flashListChatListHarnessState.sessionState = {
        ...flashListChatListHarnessState.sessionState,
        active: true,
        id: 'session-escape',
        seq: 0,
        metadata: null,
        accessLevel: null,
        canApprovePermissions: true,
    };
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 72;
    flashListChatListHarnessState.settingValues.transcriptScrollJumpToBottomEnabled = true;
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
        hasDeferredNewerMessages: () => false,
        loadOlderMessages: vi.fn(async () => ({ loaded: 0, hasMore: false, status: 'no_more' as const })),
        loadNewerMessages: vi.fn(),
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

async function renderStreamingChatList() {
    const { ChatList } = await import('./ChatList');
    return {
        ChatList,
        screen: await renderFlashListChatList(
            <ChatList session={flashListChatListHarnessState.sessionState} />,
        ),
    };
}

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
    viewportControllerMockState.resolveInputs = [];
}

async function observeNativeScrollAtBottom(screen: Awaited<ReturnType<typeof renderFlashListChatList>>) {
    await screen.triggerScroll(600, {
        contentSize: { height: 1200, width: 0 },
        isTrusted: true,
        layoutMeasurement: { height: 600, width: 0 },
    }, { cycles: 1, turns: 1 });
    scrollToOffsetSpy.mockClear();
    viewportControllerMockState.resolveInputs = [];
}

async function growStreamingAssistantMessage(
    ChatList: ChatListComponent,
    screen: Awaited<ReturnType<typeof renderFlashListChatList>>,
    contentHeight: number,
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
                text: 'streaming... plus more long markdown content',
            },
        ],
    };
    await screen.update(<ChatList session={flashListChatListHarnessState.sessionState} />);
    await screen.settle({ cycles: 1, turns: 1 });
    await screen.triggerContentSizeChange(0, contentHeight, { advanceTimersMs: 1, cycles: 1, turns: 2 });
}

function autoFollowReasons() {
    return viewportControllerMockState.resolveInputs
        .filter((input) => input.type === 'auto-follow')
        .map((input) => input.reason);
}

const nativeAnchoringWithoutBottomAutoscroll = {
    startRenderingFromBottom: true,
};

describe('ChatList (FlashList v2 native scroll escape)', () => {
    it('does not auto-follow same-message streaming growth after native list drag begins', async () => {
        const { ChatList, screen } = await renderStreamingChatList();

        await primeAtBottom(screen);
        await act(async () => {
            screen.requireCapturedFlashListProps().onScrollBeginDrag?.({});
            vi.setSystemTime(new Date(500));
        });

        await growStreamingAssistantMessage(ChatList, screen, 1500);

        expect(autoFollowReasons()).not.toContain('stream-append');
        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
        expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual(
            nativeAnchoringWithoutBottomAutoscroll,
        );
    });

    it('treats real native vertical touch movement as scroll escape before a useful scroll observation arrives', async () => {
        const { ChatList, screen } = await renderStreamingChatList();

        await primeAtBottom(screen);
        await act(async () => {
            const scrollSurfaceProps = screen.requireCapturedFlashListProps().overrideProps as Record<string, any> | undefined;
            expect(typeof scrollSurfaceProps?.onTouchStart).toBe('function');
            expect(typeof scrollSurfaceProps?.onTouchMove).toBe('function');
            expect(typeof scrollSurfaceProps?.onStartShouldSetResponderCapture).toBe('function');
            expect(typeof scrollSurfaceProps?.onMoveShouldSetResponderCapture).toBe('function');
            expect(scrollSurfaceProps?.onStartShouldSetResponderCapture?.({ nativeEvent: { pageY: 560 } })).toBe(false);
            expect(scrollSurfaceProps?.onMoveShouldSetResponderCapture?.({ nativeEvent: { pageY: 500 } })).toBe(false);
            vi.setSystemTime(new Date(500));
        });

        await growStreamingAssistantMessage(ChatList, screen, 1500);

        expect(autoFollowReasons()).not.toContain('stream-append');
        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
        expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual(
            nativeAnchoringWithoutBottomAutoscroll,
        );
    });

    it('keeps follow-bottom through streamed growth with a stale offset when no touch attribution exists (plan P3 no-touch escape)', async () => {
        const { ChatList, screen } = await renderStreamingChatList();

        await primeAtBottom(screen);
        getAbsoluteLastScrollOffsetSpy.mockReturnValue(300);

        await growStreamingAssistantMessage(ChatList, screen, 1500);

        // No drag session, no momentum, no finger, no recent intent: the stale offset against
        // freshly grown content is height churn, not an escape (plan B6/P3) — follow is
        // RETAINED, MVCP owns the visual bottom maintenance, and no JS write fires.
        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
        expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
            startRenderingFromBottom: true,
        });
        expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).not.toHaveProperty('disabled');
    });

    it('does not recover an impossible native offset by repinning while drag escape is active', async () => {
        const { screen } = await renderStreamingChatList();

        await primeAtBottom(screen);
        await observeNativeScrollAtBottom(screen);
        await act(async () => {
            screen.requireCapturedFlashListProps().onScrollBeginDrag?.({});
        });

        await screen.triggerScroll(-972759, {
            contentSize: { height: 24578, width: 0 },
            layoutMeasurement: { height: 682, width: 0 },
        }, { cycles: 1, turns: 1 });

        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
        expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual(
            nativeAnchoringWithoutBottomAutoscroll,
        );
    });

    it('keeps same-message streaming growth following bottom through native MVCP without JS scroll writes by default', async () => {
        const { ChatList, screen } = await renderStreamingChatList();

        await primeAtBottom(screen);
        await growStreamingAssistantMessage(ChatList, screen, 1500);

        expect(autoFollowReasons()).toContain('stream-append');
        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
        expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
            animateAutoScrollToBottom: false,
            startRenderingFromBottom: true,
        });
    });

    it('does not rearm from a passive bottom observation while escaping before later stream growth', async () => {
        const { ChatList, screen } = await renderStreamingChatList();

        await primeAtBottom(screen);
        await observeNativeScrollAtBottom(screen);
        await act(async () => {
            screen.requireCapturedFlashListProps().onScrollBeginDrag?.({});
        });
        await screen.triggerScroll(400, {
            contentSize: { height: 1200, width: 0 },
            layoutMeasurement: { height: 600, width: 0 },
        }, { cycles: 1, turns: 1 });
        await act(async () => {
            vi.setSystemTime(new Date(500));
        });
        await screen.triggerScroll(600, {
            contentSize: { height: 1200, width: 0 },
            layoutMeasurement: { height: 600, width: 0 },
        }, { cycles: 1, turns: 1 });
        scrollToOffsetSpy.mockClear();
        viewportControllerMockState.resolveInputs = [];

        await growStreamingAssistantMessage(ChatList, screen, 1500);

        expect(autoFollowReasons()).not.toContain('stream-append');
        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
    });

    it('does not opportunistically repin from a delayed FlashList scroll event while escaping', async () => {
        const { screen } = await renderStreamingChatList();

        await primeAtBottom(screen);
        await observeNativeScrollAtBottom(screen);
        await act(async () => {
            screen.requireCapturedFlashListProps().onScrollBeginDrag?.({});
            vi.setSystemTime(new Date(500));
        });

        await screen.triggerScroll(400, {
            contentSize: { height: 1500, width: 0 },
            layoutMeasurement: { height: 600, width: 0 },
        }, { cycles: 1, turns: 1 });

        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
        expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual(
            nativeAnchoringWithoutBottomAutoscroll,
        );
    });

    it('keeps native bottom autoscroll disabled while the same drag returns near bottom, then rearms on drag end', async () => {
        const { ChatList, screen } = await renderStreamingChatList();

        await primeAtBottom(screen);
        await observeNativeScrollAtBottom(screen);
        await act(async () => {
            screen.requireCapturedFlashListProps().onScrollBeginDrag?.({});
        });

        await screen.triggerScroll(400, {
            contentSize: { height: 1200, width: 0 },
            isTrusted: true,
            layoutMeasurement: { height: 600, width: 0 },
        }, { cycles: 1, turns: 1 });

        await screen.triggerScroll(560, {
            contentSize: { height: 1200, width: 0 },
            isTrusted: true,
            layoutMeasurement: { height: 600, width: 0 },
        }, { cycles: 1, turns: 1 });

        expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual(
            nativeAnchoringWithoutBottomAutoscroll,
        );
        scrollToOffsetSpy.mockClear();
        viewportControllerMockState.resolveInputs = [];
        await act(async () => {
            vi.setSystemTime(new Date(800));
        });
        await growStreamingAssistantMessage(ChatList, screen, 1500);

        expect(autoFollowReasons()).not.toContain('stream-append');
        expect(scrollToOffsetSpy).not.toHaveBeenCalled();

        await act(async () => {
            screen.requireCapturedFlashListProps().onScrollEndDrag?.({});
        });
        expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual({
            animateAutoScrollToBottom: false,
            autoscrollToBottomThreshold: 0.12,
            startRenderingFromBottom: true,
        });
    });

    it('rearms native bottom follow on drag end after non-trusted native events return near bottom', async () => {
        const { ChatList, screen } = await renderStreamingChatList();

        await primeAtBottom(screen);
        await observeNativeScrollAtBottom(screen);
        await act(async () => {
            screen.requireCapturedFlashListProps().onScrollBeginDrag?.({});
        });

        await screen.triggerScroll(400, {
            contentSize: { height: 1200, width: 0 },
            layoutMeasurement: { height: 600, width: 0 },
        }, { cycles: 1, turns: 1 });

        await screen.triggerScroll(560, {
            contentSize: { height: 1200, width: 0 },
            layoutMeasurement: { height: 600, width: 0 },
        }, { cycles: 1, turns: 1 });

        expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual(
            nativeAnchoringWithoutBottomAutoscroll,
        );

        await act(async () => {
            screen.requireCapturedFlashListProps().onScrollEndDrag?.({});
        });
        expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toEqual({
            animateAutoScrollToBottom: false,
            autoscrollToBottomThreshold: 0.12,
            startRenderingFromBottom: true,
        });

        scrollToOffsetSpy.mockClear();
        viewportControllerMockState.resolveInputs = [];
        await act(async () => {
            vi.setSystemTime(new Date(800));
        });
        await growStreamingAssistantMessage(ChatList, screen, 1500);

        expect(autoFollowReasons()).toContain('stream-append');
        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
    });

    it('follows immediate content growth after drag end re-arms bottom follow', async () => {
        const { ChatList, screen } = await renderStreamingChatList();

        await primeAtBottom(screen);
        await observeNativeScrollAtBottom(screen);
        await act(async () => {
            screen.requireCapturedFlashListProps().onScrollBeginDrag?.({});
        });

        await screen.triggerScroll(400, {
            contentSize: { height: 1200, width: 0 },
            layoutMeasurement: { height: 600, width: 0 },
        }, { cycles: 1, turns: 1 });

        await screen.triggerScroll(600, {
            contentSize: { height: 1200, width: 0 },
            layoutMeasurement: { height: 600, width: 0 },
        }, { cycles: 1, turns: 1 });

        await act(async () => {
            screen.requireCapturedFlashListProps().onScrollEndDrag?.({});
        });

        scrollToOffsetSpy.mockClear();
        viewportControllerMockState.resolveInputs = [];
        await growStreamingAssistantMessage(ChatList, screen, 1500);

        expect(autoFollowReasons()).toContain('stream-append');
        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
    });

    it('cancels a scheduled native bottom pin when list drag begins', async () => {
        const { screen } = await renderStreamingChatList();

        await primeAtBottom(screen);
        await act(async () => {
            screen.requireCapturedFlashListProps().onTouchMove?.({});
        });
        await screen.triggerContentSizeChange(0, 1500, { cycles: 1, turns: 1 });
        await act(async () => {
            screen.requireCapturedFlashListProps().onScrollBeginDrag?.({});
            await vi.advanceTimersByTimeAsync(260);
        });
        await screen.settle({ cycles: 1, turns: 2 });

        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
    });

    it('does not hard-release bottom-follow for generic native transcript touch movement', async () => {
        const { ChatList, screen } = await renderStreamingChatList();

        await primeAtBottom(screen);
        await act(async () => {
            screen.requireCapturedFlashListProps().onTouchMove?.({});
            vi.setSystemTime(new Date(500));
        });

        await growStreamingAssistantMessage(ChatList, screen, 1500);

        expect(autoFollowReasons()).toContain('stream-append');
        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
        expect(screen.requireCapturedFlashListProps().maintainVisibleContentPosition).toMatchObject({
            startRenderingFromBottom: true,
            autoscrollToBottomThreshold: 0.12,
        });
    });
});
