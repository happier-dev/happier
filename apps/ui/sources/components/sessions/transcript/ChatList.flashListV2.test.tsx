import {
    flashListChatListHarnessState,
    createFlashListChatListWebElement,
    createFlashListChatListWebScroller,
    FlashListChatListWebElement,
    renderFlashListChatList,
    triggerFlashListChatListInitialFill,
    triggerFlashListChatListScroll,
    triggerFlashListChatListStartReached,
    withRenderedFlashListChatListWebScroller,
    withFlashListChatListWebScrollerDom,
} from '@/dev/testkit/harness/chatListHarness';
import * as React from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { buildChatListNativeId } from './chatListNativeId';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFlashListProps: any = null;
let renderedFlatListCount = 0;
let flashListRefHandle: any = null;
const mountedTrees: ReactTestRenderer[] = [];

function getCapturedFlashListProps(): any {
    const props = flashListChatListHarnessState.flashListProps ?? capturedFlashListProps;
    expect(props).toBeTruthy();
    return props;
}

async function renderTrackedFlashListChatList(element: React.ReactElement) {
    const screen = await renderFlashListChatList(element, {
        flushOptions: { cycles: 0 },
    });
    mountedTrees.push(screen.tree);
    return screen;
}

function expectScreenHasTestId(screen: { findByTestId: (testID: string) => unknown }, testID: string): void {
    expect(screen.findByTestId(testID)).toBeTruthy();
}

type FlashListFlushOptions = {
    turns?: number;
    frames?: number;
    advanceTimersMs?: number;
};

async function primeFlashListMetrics(
    layoutHeight: number,
    contentHeight: number,
    options: FlashListFlushOptions = {},
): Promise<void> {
    await triggerFlashListChatListInitialFill({
        layoutHeight,
        contentHeight,
        flushOptions: {
            turns: options.turns ?? 1,
            frames: options.frames,
            advanceTimersMs: options.advanceTimersMs,
        },
    });
}

async function scrollFlashListTo(contentOffsetY: number, options: FlashListFlushOptions & { trusted?: boolean } = {}): Promise<void> {
    await triggerFlashListChatListScroll(
        contentOffsetY,
        options.trusted === false ? {} : { isTrusted: true },
        {
            turns: options.turns ?? 1,
            frames: options.frames,
            advanceTimersMs: options.advanceTimersMs,
        },
    );
}

async function withWebFlashListFakeTimers<T>(now: number, run: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ now: new Date(now) });
    try {
        return await run();
    } finally {
        vi.useRealTimers();
    }
}

let sessionMessagesState: { messages: any[]; isLoaded: boolean } = { messages: [], isLoaded: true };
let sessionPendingState: { messages: any[] } = { messages: [] };
let sessionActionDraftsState: any[] = [];
let sessionState: any = null;

const settingValues: Record<string, any> = {};
let platformOs: 'web' | 'ios' = 'web';

type SyncTuningMock = {
    transcriptForwardPrefetchThresholdPx: number;
    transcriptBackwardPrefetchThresholdPx: number;
    transcriptFlashListEstimatedItemSize: number;
    transcriptWebHotTailItemCount: number;
    transcriptWebInitialPinStabilizeMs: number;
    transcriptWebInitialPinRetryIntervalMs: number;
};

let syncTuningState: SyncTuningMock = {
    transcriptForwardPrefetchThresholdPx: 0,
    transcriptBackwardPrefetchThresholdPx: 0,
    transcriptFlashListEstimatedItemSize: 120,
    transcriptWebHotTailItemCount: 2,
    transcriptWebInitialPinStabilizeMs: 3000,
    transcriptWebInitialPinRetryIntervalMs: 250,
};

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: React.forwardRef((props: any, ref: any) => {
        capturedFlashListProps = props;
        flashListChatListHarnessState.flashListProps = props;
        if (typeof ref === 'function') {
            ref(flashListRefHandle);
        } else if (ref && typeof ref === 'object') {
            ref.current = flashListRefHandle;
        }
        const data = Array.isArray(props.data) ? props.data : [];
        const header =
            props.ListHeaderComponent
                ? (typeof props.ListHeaderComponent === 'function'
                    ? props.ListHeaderComponent()
                    : props.ListHeaderComponent)
                : null;
        const footer =
            props.ListFooterComponent
                ? (typeof props.ListFooterComponent === 'function'
                    ? props.ListFooterComponent()
                    : props.ListFooterComponent)
                : null;

        return React.createElement(
            'FlashList',
            { ...props, testID: 'flash-list' },
            header,
            data.map((item: any, index: number) => {
                const key =
                    typeof props.keyExtractor === 'function'
                        ? props.keyExtractor(item, index)
                        : (item?.id ?? String(index));
                const child = typeof props.renderItem === 'function' ? props.renderItem({ item, index }) : null;
                return React.createElement('FlashListItem', { key }, child);
            }),
            footer,
        );
    }),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            Dimensions: {
                                get: () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }),
                            },
                            Platform: {
                                get OS() {
                                                return platformOs;
                                            },
                                select: (values: any) => values?.[platformOs] ?? values?.default,
                            },
                            Easing: {
                                bezier: () => (t: number) => t,
                                linear: (t: number) => t,
                            },
                            View: (props: any) => React.createElement('View', props, props.children),
                            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                            ActivityIndicator: () => React.createElement('ActivityIndicator'),
                            FlatList: (_props: any) => {
                                    renderedFlatListCount++;
                                    return React.createElement('FlatList');
                                },
                        }
    );
});

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
    useSession: () => sessionState,
    useSessionTranscriptIds: () => ({
            ids: (sessionMessagesState.messages ?? []).map((m: any) => m.id),
            isLoaded: sessionMessagesState.isLoaded,
        }),
    useSessionMessagesById: () => Object.fromEntries((sessionMessagesState.messages ?? []).map((m: any) => [m.id, m])),
    useForkedTranscriptSnapshot: () => null,
    useSessionPendingMessages: () => sessionPendingState,
    useSessionActionDrafts: () => sessionActionDraftsState,
    useSessionLatestThinkingMessageId: () => null,
    useSessionLatestThinkingMessageActivityAtMs: () => null,
    useMessage: () => null,
    useSetting: (key: string) => settingValues[key],
    getStorage: () => ({
        getState: () => ({
            sessionMessages: {
                [sessionState?.id ?? 'session-1']: {
                    messagesById: Object.fromEntries((sessionMessagesState.messages ?? []).map((m: any) => [m.id, m])),
                    messagesMap: Object.fromEntries((sessionMessagesState.messages ?? []).map((m: any) => [m.id, m])),
                },
            },
        }),
    }),
});
});

vi.mock('@/components/sessions/chatListItems', () => ({
    buildChatListItems: ({ messageIdsOldestFirst, messagesById }: any) =>
        (messageIdsOldestFirst ?? []).map((id: string) => {
            const m = messagesById?.[id];
            return { kind: 'message', id, messageId: id, createdAt: m?.createdAt ?? 0, seq: null };
        }),
    buildChatListItemsCached: (opts: any) => ({
        cache: null,
        items: (opts?.messageIdsOldestFirst ?? []).map((id: string) => {
            const m = opts?.messagesById?.[id];
            return { kind: 'message', id, messageId: id, createdAt: m?.createdAt ?? 0, seq: null };
        }),
    }),
}));

vi.mock('@/components/sessions/transcript/forkContext/injectForkContextRows', async () => await import('./forkContext/injectForkContextRows'));

vi.mock('@/components/sessions/transcript/forkContext/ForkDividerRow', () => ({
    ForkDividerRow: () => React.createElement('ForkDividerRow'),
}));

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter', { testID: 'chat-footer' }),
}));

vi.mock('./MessageView', () => ({
    MessageView: () => React.createElement('MessageView'),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionProvider', () => ({
    TranscriptMotionProvider: ({ children }: any) => React.createElement('TranscriptMotionProvider', null, children),
}));

vi.mock('@/components/sessions/transcript/motion/resolveTranscriptMotionConfig', () => ({
    resolveTranscriptMotionConfig: () => ({}),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
    TranscriptEnterWrapper: ({ children }: any) => React.createElement('TranscriptEnterWrapper', null, children),
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: () => React.createElement('TurnView'),
}));

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
    PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
    SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/utils/sessions/jumpToTranscriptSeq', () => ({
    jumpToTranscriptSeq: async (params: {
        getIndex: () => number | null;
        scrollToIndex: (index: number) => void;
    }) => {
        const index = params.getIndex();
        if (index != null) params.scrollToIndex(index);
    },
}));

vi.mock('@/components/sessions/transcript/turnGrouping/buildTranscriptTurns', () => ({
    buildTranscriptTurnsCached: () => ({
        cache: null,
        turns: [],
    }),
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
    ToolCallsGroupRow: () => React.createElement('ToolCallsGroupRow'),
}));

vi.mock('@/components/sessions/transcript/scroll/JumpToBottomButton', () => ({
    JumpToBottomButton: (props: any) => React.createElement('JumpToBottomButton', props),
}));

vi.mock('@/components/sessions/transcript/scroll/transcriptScrollPinController', async () => await import('./scroll/transcriptScrollPinController'));

vi.mock('@/components/sessions/transcript/scroll/shouldPrefetchOlderFromTop', async () => await import('./scroll/shouldPrefetchOlderFromTop'));

vi.mock('@/encryption/hex', () => ({
    decodeHex: () => new Uint8Array(),
    encodeHex: () => '',
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
    getPermissionsInUiWhileLocal: () => ({}),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (p: any) => p,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        loadOlderMessages: vi.fn(),
        loadNewerMessages: vi.fn(),
        hasDeferredNewerMessages: () => false,
        getSyncTuning: () => syncTuningState,
    },
}));

vi.mock('@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId', async () => await import('./thinking/resolveActiveThinkingMessageId'));

vi.mock('@/sync/domains/settings/settings', () => ({
    settingsDefaults: {},
}));

vi.mock('./chatListNativeId', () => ({
    buildChatListNativeId: (sessionId: string, reactId: string) => `chat-list-${sessionId}-${reactId}`,
}));

vi.mock('@/components/ui/lists/useWebFlashListCrashFallback', () => ({
    useWebFlashListCrashFallback: () => false,
}));

vi.mock('@/components/sessions/transcript/segments/buildTranscriptHotColdSegments', async () => await import('./segments/buildTranscriptHotColdSegments'));

vi.mock('@/components/sessions/transcript/webTranscriptScrollMetrics', async () => await import('./webTranscriptScrollMetrics'));

vi.mock('@/components/sessions/transcript/web/WebTranscriptSplitFooter', async () => await import('./web/WebTranscriptSplitFooter'));

vi.mock('@/components/sessions/transcript/webTranscriptPrependAnchor', async () => await import('./webTranscriptPrependAnchor'));

describe('ChatList (FlashList v2)', () => {
    beforeEach(() => {
        vi.resetModules();
        platformOs = 'web';
        capturedFlashListProps = null;
        flashListChatListHarnessState.flashListProps = null;
        renderedFlatListCount = 0;
        flashListRefHandle = null;
        mountedTrees.length = 0;
        sessionMessagesState = { messages: [], isLoaded: true };
        sessionPendingState = { messages: [] };
        sessionActionDraftsState = [];
        sessionState = {
            id: 'session-1',
            seq: 0,
            metadata: null,
            accessLevel: null,
            canApprovePermissions: true,
            agentState: null,
        };
        syncTuningState = {
            transcriptForwardPrefetchThresholdPx: 0,
            transcriptBackwardPrefetchThresholdPx: 0,
            transcriptFlashListEstimatedItemSize: 120,
            transcriptWebHotTailItemCount: 2,
            transcriptWebInitialPinStabilizeMs: 3000,
            transcriptWebInitialPinRetryIntervalMs: 250,
        };
        for (const k of Object.keys(settingValues)) delete settingValues[k];
        settingValues.transcriptGroupingMode = 'linear';
        settingValues.transcriptGroupToolCalls = false;
        settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
        settingValues.transcriptListImplementation = 'flash_v2';
    });

    afterEach(() => {
        // Prevent initial-pin stabilization timeouts from leaking across tests and mutating later
        // tests' mocked DOM scroll containers (especially when fake timers are advanced).
        for (const tree of mountedTrees) {
            act(() => {
                tree.unmount();
            });
        }
        mountedTrees.length = 0;
        try {
            vi.useRealTimers();
        } catch {
            // no-op
        }
    });

    it('omits maintainVisibleContentPosition on web to avoid FlashList layout crashes', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(renderedFlatListCount).toBe(0);
        expect(screen.getCapturedFlashListProps()).not.toBeNull();
        expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition).toBeUndefined();
    });

    it('loads older messages when scrolled near the top (without requiring onStartReached)', async () => {
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };

        const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        getCapturedFlashListProps();
        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await primeFlashListMetrics(600, 1200, { turns: 1 });
        await scrollFlashListTo(100);

        expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
    });

    it('loads older messages near the top even when onScroll is not marked isTrusted (web)', async () => {
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };

        const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        getCapturedFlashListProps();

        await primeFlashListMetrics(600, 1200, { turns: 1 });

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await scrollFlashListTo(100, { trusted: false });

        expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);
    });

    it('does not prefetch older messages while pinned at the bottom even when the top threshold is large', async () => {
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };

        const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        await primeFlashListMetrics(600, 1200, { turns: 2, frames: 2 });

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await scrollFlashListTo(600);

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();
    });

    it('waits for web scroll metrics to settle before prefetching older messages during initial fill', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        const scrollEl: any = {
            scrollHeight: 100,
            clientHeight: 400,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 0,
            querySelectorAll: () => [],
            parentElement: null,
            isConnected: true,
        };

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                expect(capturedFlashListProps).toBeTruthy();

                scrollEl.scrollHeight = 1600;
                await triggerFlashListChatListInitialFill({
                    layoutHeight: 100,
                    contentHeight: 100,
                    flushOptions: { turns: 3 },
                });

                expect(loadOlderMessagesMock).not.toHaveBeenCalled();
                expect(screen.getCapturedFlashListProps()).toBeTruthy();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
                useImmediateAnimationFrame: false,
            },
        );
    });

    it('ignores a web onStartReached misfire while the transcript is still pinned at the bottom', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const scrollEl: any = {
            scrollHeight: 1600,
            clientHeight: 600,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 1000,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };

        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                getCapturedFlashListProps();

                await primeFlashListMetrics(600, 1200);

                await scrollFlashListTo(600);

                loadOlderMessagesMock.mockClear();

                await triggerFlashListChatListStartReached();

                expect(loadOlderMessagesMock).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('preserves the web viewport when older messages prepend above the current scroll position', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const scrollEl: any = {
            scrollHeight: 1200,
            clientHeight: 600,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 600,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };

        loadOlderMessagesMock.mockImplementation(async () => {
            scrollEl.scrollHeight = 1800;
            return { loaded: 5, hasMore: true, status: 'loaded' as const };
        });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                getCapturedFlashListProps();

                await primeFlashListMetrics(600, 1200);

                scrollEl.scrollHeight = 1200;
                loadOlderMessagesMock.mockClear();

                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100, { turns: 3 });

                expect(loadOlderMessagesMock.mock.calls.length).toBeGreaterThanOrEqual(1);
                expect(scrollEl.scrollTop).toBe(700);
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('continues preserving the web viewport if content grows again after the prepend commit', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const scrollEl: any = {
            scrollHeight: 1200,
            clientHeight: 600,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 600,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };

        loadOlderMessagesMock.mockImplementation(async () => {
            scrollEl.scrollHeight = 1400;
            return { loaded: 5, hasMore: true, status: 'loaded' as const };
        });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

                getCapturedFlashListProps();

                await primeFlashListMetrics(600, 1200);

                scrollEl.scrollHeight = 1200;
                loadOlderMessagesMock.mockClear();

                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100, { turns: 3 });

                expect(loadOlderMessagesMock.mock.calls.length).toBeGreaterThanOrEqual(1);
                expect(scrollEl.scrollTop).toBe(300);

                scrollEl.scrollHeight = 1800;
                await primeFlashListMetrics(600, 1800);

                expect(scrollEl.scrollTop).toBe(700);
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('preserves the web viewport when the user keeps scrolling upward while older messages are still loading', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const scrollEl: any = {
            scrollHeight: 1200,
            clientHeight: 600,
            scrollWidth: 0,
            clientWidth: 0,
            scrollTop: 600,
            querySelectorAll: () => [],
            parentElement: null,
            contains: () => false,
            isConnected: true,
        };

        let resolveLoadOlder: ((value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void) | null = null;
        loadOlderMessagesMock.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveLoadOlder = resolve;
                }),
        );
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

                getCapturedFlashListProps();

                await primeFlashListMetrics(600, 1200);

                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100);

                await triggerFlashListChatListStartReached();

                expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                scrollEl.scrollTop = 60;
                await scrollFlashListTo(60);

                scrollEl.scrollHeight = 1400;
                resolveLoadOlder?.({ loaded: 5, hasMore: true, status: 'loaded' });
                await screen.settle();

                expect(scrollEl.scrollTop).toBe(260);
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: {
                    getComputedStyle: vi.fn(() => ({
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        overflow: 'auto',
                    })),
                },
            },
        );
    });

    it('keeps tracking the original web prepend anchor when it is temporarily unmounted during a large prepend', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const visibleAnchor = createFlashListChatListWebElement('transcript-anchor-message-m1', { top: 120, bottom: 220 });
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 600,
            testNodes: [visibleAnchor],
        });

        let resolveLoadOlder: ((value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void) | null = null;
        loadOlderMessagesMock.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveLoadOlder = resolve;
                }),
        );
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');

        await withRenderedFlashListChatListWebScroller(
            scrollEl,
            <ChatList session={{ ...sessionState }} />,
            async (screen) => {
                await primeFlashListMetrics(600, 1200);

                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100);

                expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                scrollEl.scrollHeight = 5200;
                scrollEl.setQuerySelectorAll('[data-testid]', []);
                resolveLoadOlder?.({ loaded: 50, hasMore: true, status: 'loaded' });
                await screen.settle();

                expect(scrollEl.scrollTop).toBe(4100);

                visibleAnchor.setRect({ top: 300, bottom: 400 });
                scrollEl.scrollHeight = 5300;
                scrollEl.setQuerySelectorAll('[data-testid]', [visibleAnchor]);
                await primeFlashListMetrics(600, 5300);

                expect(scrollEl.scrollTop).toBe(4280);
            },
            {
                initialFill: false,
                dom: {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        getComputedStyle: vi.fn(() => ({
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            overflow: 'auto',
                        })),
                    },
                },
            },
        );
    });

    it('recovers the captured web prepend item when scrollHeight growth overshoots the original viewport anchor', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const itemAnchor = createFlashListChatListWebElement('transcript-item-u1', { top: 40, bottom: 340 });
        const messageAnchor = createFlashListChatListWebElement('transcript-anchor-message-u1', { top: 120, bottom: 180 });
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 600,
            testNodes: [itemAnchor, messageAnchor],
        });

        flashListRefHandle = {
            scrollToOffset: vi.fn(),
            scrollToIndex: vi.fn(() => {
                scrollEl.scrollTop = 3900;
                itemAnchor.setRect({ top: 140, bottom: 440 });
                messageAnchor.setRect({ top: 220, bottom: 280 });
                scrollEl.setQuerySelectorAll('[data-testid]', [itemAnchor, messageAnchor]);
            }),
        };

        let resolveLoadOlder: ((value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void) | null = null;
        loadOlderMessagesMock.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveLoadOlder = resolve;
                }),
        );
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');

        await withRenderedFlashListChatListWebScroller(
            scrollEl,
            <ChatList session={{ ...sessionState }} />,
            async (screen) => {
                await primeFlashListMetrics(600, 1200);

                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100);

                expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                scrollEl.scrollHeight = 5200;
                scrollEl.setQuerySelectorAll('[data-testid]', []);
                resolveLoadOlder?.({ loaded: 50, hasMore: true, status: 'loaded' });
                await screen.settle();

                expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith({
                    index: 0,
                    animated: false,
                    viewPosition: 0,
                });
                expect(scrollEl.scrollTop).toBe(4000);
            },
            {
                initialFill: false,
                dom: {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        getComputedStyle: vi.fn(() => ({
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            overflow: 'auto',
                        })),
                    },
                },
            },
        );
    });

    it('recovers by stable anchor identity when the captured turn wrapper id changes across the prepend', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const staleItemAnchor = createFlashListChatListWebElement('transcript-item-turn:stale', { top: 20, bottom: 360 });
        const stableMessageAnchor = createFlashListChatListWebElement('transcript-anchor-message-u1', { top: 120, bottom: 180 });
        const scrollEl = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 1200,
            scrollTop: 600,
            testNodes: [staleItemAnchor, stableMessageAnchor],
        });

        flashListRefHandle = {
            scrollToOffset: vi.fn(),
            scrollToIndex: vi.fn(() => {
                scrollEl.scrollTop = 3900;
                stableMessageAnchor.setRect({ top: 150, bottom: 210 });
                scrollEl.setQuerySelectorAll('[data-testid]', [stableMessageAnchor]);
            }),
        };

        let resolveLoadOlder: ((value: { loaded: number; hasMore: boolean; status: 'loaded' }) => void) | null = null;
        loadOlderMessagesMock.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveLoadOlder = resolve;
                }),
        );
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');

        await withRenderedFlashListChatListWebScroller(
            scrollEl,
            <ChatList session={{ ...sessionState }} />,
            async (screen) => {
                await primeFlashListMetrics(600, 1200);
                await scrollFlashListTo(600);

                scrollEl.scrollTop = 100;
                await scrollFlashListTo(100);

                expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

                scrollEl.scrollHeight = 5200;
                scrollEl.setQuerySelectorAll('[data-testid]', []);
                resolveLoadOlder?.({ loaded: 50, hasMore: true, status: 'loaded' });
                await screen.settle();

                expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith({
                    index: 0,
                    animated: false,
                    viewPosition: 0,
                });
            },
            {
                initialFill: false,
                dom: {
                    HTMLElement: FlashListChatListWebElement,
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: {
                        getComputedStyle: vi.fn(() => ({
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            overflow: 'auto',
                        })),
                    },
                },
            },
        );
    });

    it('uses startRenderingFromBottom on native FlashList', async () => {
        platformOs = 'ios';
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(screen.getCapturedFlashListProps()).not.toBeNull();
        expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition?.startRenderingFromBottom).toBe(true);
        expect(screen.getCapturedFlashListProps().maintainVisibleContentPosition?.autoscrollToTopThreshold).toBeUndefined();
    });

    it('memoizes maintainVisibleContentPosition to avoid prop churn (FlashList)', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} bottomNotice={null} />);

        const first = screen.getCapturedFlashListProps().maintainVisibleContentPosition;
        expect(first).toBeUndefined();

        await screen.update(<ChatList session={{ ...sessionState }} bottomNotice={null} />);

        const second = screen.getCapturedFlashListProps().maintainVisibleContentPosition;
        expect(second).toBe(first);

        // Unmount handled by afterEach to ensure stabilization timers are cancelled.
    });

    it('renders ListHeaderComponent above items and ChatFooter as ListFooterComponent (non-inverted FlashList)', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(screen.getCapturedFlashListProps()).not.toBeNull();
        const flashListProps = screen.getCapturedFlashListProps();
        const headerEl = flashListProps.ListHeaderComponent;
        const footerEl = flashListProps.ListFooterComponent;

        // The header is responsible for top padding + optional older-loading affordance.
        expect(typeof headerEl?.props?.isLoadingOlder).toBe('boolean');
        // The footer can be wrapped by the web hot-tail split, but it must still render ChatFooter.
        expect(footerEl).toBeTruthy();
        expectScreenHasTestId(screen, 'chat-footer');

        // Render sanity: FlashList still mounts in tree.
        expectScreenHasTestId(screen, 'flash-list');
    });

    it('renders only cold history inside the web FlashList data and moves the live tail into the footer', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'one' },
                { kind: 'user-text', id: 'u2', localId: null, createdAt: 2, text: 'two' },
                { kind: 'user-text', id: 'u3', localId: null, createdAt: 3, text: 'three' },
                { kind: 'user-text', id: 'u4', localId: null, createdAt: 4, text: 'four' },
            ],
        };
        syncTuningState = { ...syncTuningState, transcriptWebHotTailItemCount: 2 };

        const { ChatList } = await import('./ChatList');
        const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);

        expect(screen.getCapturedFlashListProps()).not.toBeNull();
        expect((screen.getCapturedFlashListProps().data ?? []).map((item: any) => item.id)).toEqual(['u1', 'u2']);
        expectScreenHasTestId(screen, 'transcript-web-hot-tail');
        expectScreenHasTestId(screen, 'transcript-web-hot-tail-item-u3');
        expectScreenHasTestId(screen, 'transcript-web-hot-tail-item-u4');
        expectScreenHasTestId(screen, 'chat-footer');
    });

    it('pins via DOM scroll on web without calling scrollToOffset when DOM pinning is possible', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

        const scrollEl: any = {
            scrollHeight: 1000,
            clientHeight: 100,
            scrollTop: 0,
            scrollTo: vi.fn(() => {
                throw new Error('should not call scrollTo (RNW overrides scrollTo signature)');
            }),
            querySelectorAll: () => [],
            parentElement: null,
        };

        const fakeDocument: any = { getElementById: vi.fn(() => scrollEl) };
        const fakeWindow: any = { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) };
        (globalThis as any).document = fakeDocument;
        (globalThis as any).window = fakeWindow;

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();

                expect((scrollEl as any).scrollTop).toBeGreaterThan(0);
                expect(scrollEl.scrollTo).not.toHaveBeenCalled();
                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('does not fall back to scrollToOffset on web when DOM pinning is unavailable (prevents mount jitter)', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            null,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();

                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => null) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('stops scheduling long-running initial web pin retries once DOM pinning succeeds', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        const scrollEl: any = {
            scrollHeight: 1000,
            clientHeight: 100,
            scrollTop: 0,
            querySelectorAll: () => [],
            parentElement: null,
        };

        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 1 as any);

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();

                const delays = setTimeoutSpy.mock.calls
                    .map((call) => call[1])
                    .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms));
                const maxDelay = delays.length ? Math.max(...delays) : 0;
                expect(maxDelay).toBeLessThanOrEqual(800);
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );

        setTimeoutSpy.mockRestore();
    });

    it('does not re-pin during the initial web stabilize window after the user scrolls away from bottom', async () => {
        await withWebFlashListFakeTimers(250, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

            const scrollEl: any = {
                scrollHeight: 1000,
                clientHeight: 100,
                scrollTop: 0,
                scrollTo: ({ top }: { top: number }) => {
                    const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                    scrollEl.scrollTop = Math.max(0, Math.min(top, maxScrollTop));
                },
                querySelectorAll: () => [],
                parentElement: null,
            };

            const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
                ],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle();

                    // Initial stabilization pins to bottom.
                    expect(scrollEl.scrollTop).toBeGreaterThanOrEqual(maxScrollTop);

                    // User scrolls away slightly from bottom.
                    scrollEl.scrollTop = 900;
                    await act(async () => {
                        getCapturedFlashListProps()?.onWheel?.({ deltaY: -80, stopPropagation: vi.fn() });
                    });

                    // Even though stabilization retries are scheduled, we must not fight the user's scroll.
                    await screen.settle({ cycles: 1, turns: 1, advanceTimersMs: 250 });

                    expect(scrollEl.scrollTop).toBe(900);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('re-pins to the bottom for passive mount-time web scroll drift while follow mode is still desired', async () => {
        await withWebFlashListFakeTimers(0, async () => {
            flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

            const scrollEl: any = {
                scrollHeight: 1000,
                clientHeight: 100,
                scrollTop: 0,
                scrollTo: ({ top }: { top: number }) => {
                    const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                    scrollEl.scrollTop = Math.max(0, Math.min(top, max));
                },
                querySelectorAll: () => [],
                parentElement: null,
            };

            const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);

            sessionMessagesState = {
                isLoaded: true,
                messages: [
                    { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                    { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
                ],
            };

            await withFlashListChatListWebScrollerDom(
                scrollEl,
                async () => {
                    const { ChatList } = await import('./ChatList');
                    const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                    await screen.settle();

                    // The initial mount pin puts us at the bottom.
                    expect(scrollEl.scrollTop).toBeGreaterThanOrEqual(maxScrollTop);

                    await act(async () => {
                        // Establish scroll metrics used by FlashList distance-from-bottom math.
                        await primeFlashListMetrics(100, 1000, { turns: 1 });

                        // First, we're at the bottom (distanceFromBottom = 0).
                        await scrollFlashListTo(900, { trusted: false, turns: 1 });

                        // FlashList/web can apply a programmatic scroll adjustment during mount (no wheel/touch intent).
                        // Simulate being nudged away from bottom by ~400px.
                        scrollEl.scrollTop = 492;
                        await scrollFlashListTo(492, { trusted: false, turns: 1 });
                    });

                    // Passive mount-time drift should be corrected back to the visual bottom while follow mode remains desired.
                    expect(scrollEl.scrollTop).toBeGreaterThanOrEqual(maxScrollTop);
                },
                {
                    document: { getElementById: vi.fn(() => scrollEl) },
                    window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
                },
            );
        });
    });

    it('keeps bottom follow when passive web scroll drift occurs without user intent', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebInitialPinStabilizeMs: 0,
        };

        const scrollEl = Object.assign(
            createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 0,
            }),
            {
                scrollTo: ({ top }: { top: number }) => {
                    scrollEl.scrollTop = top;
                },
            },
        );

        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
            ],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();

                expect(getCapturedFlashListProps()).not.toBeNull();
                flashListRefHandle.scrollToOffset.mockClear();

                await act(async () => {
                    // Establish scroll metrics used by onScroll distance-from-bottom math.
                    await primeFlashListMetrics(100, 1000, { turns: 1 });
                    // Simulate a passive drift away from the bottom without any user gesture or new activity.
                    scrollEl.scrollTop = 0;
                    await scrollFlashListTo(0, { trusted: false, turns: 2 });
                });

                expect(scrollEl.scrollTop).toBe(900);
                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('keeps the visual bottom pinned when existing web content remeasures without user activity', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebInitialPinStabilizeMs: 0,
        };

        const scrollEl = Object.assign(
            createFlashListChatListWebScroller({
                clientHeight: 100,
                scrollHeight: 1000,
                scrollTop: 900,
            }),
            {
                scrollTo: ({ top }: { top: number }) => {
                    scrollEl.scrollTop = top;
                },
            },
        );

        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
            ],
        };

        await withFlashListChatListWebScrollerDom(
            scrollEl,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();

                flashListRefHandle.scrollToOffset.mockClear();

                await primeFlashListMetrics(100, 1000, { turns: 1 });
                await scrollFlashListTo(900, { trusted: false, turns: 1 });

                scrollEl.scrollHeight = 1400;

                await primeFlashListMetrics(100, 1400, { turns: 1 });
                await scrollFlashListTo(900, { trusted: false, turns: 2 });

                expect(scrollEl.scrollTop).toBe(1300);
                expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();
            },
            {
                document: { getElementById: vi.fn(() => scrollEl) },
                window: { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) },
            },
        );
    });

    it('pins using the current session nativeID when multiple transcript lists exist in the DOM (web)', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const wrongScroller = createFlashListChatListWebScroller({
            clientHeight: 500,
            scrollHeight: 2000,
            scrollTop: 111,
        });
        const rightScroller = createFlashListChatListWebScroller({
            clientHeight: 600,
            scrollHeight: 3000,
            scrollTop: 0,
        });
        const rightScrollerBottom = Math.max(0, rightScroller.scrollHeight - rightScroller.clientHeight);
        const currentSessionNativeIdPrefix = buildChatListNativeId(sessionState.id, '');

        await withFlashListChatListWebScrollerDom(
            wrongScroller,
            async () => {
                const { ChatList } = await import('./ChatList');
                const screen = await renderTrackedFlashListChatList(<ChatList session={{ ...sessionState }} />);
                await screen.settle();

                // If DOM pinning accidentally targets the first `[data-testid="transcript-chat-list"]` in the
                // document, it would pin the wrong scroller. We must always pin the current session's list.
                expect(wrongScroller.scrollTop).toBe(111);
                expect(rightScroller.scrollTop).toBe(rightScrollerBottom);
            },
            {
                document: {
                    querySelector: () => wrongScroller,
                    getElementById: (id: string) => (id.startsWith(currentSessionNativeIdPrefix) ? rightScroller : null),
                },
                window: { getComputedStyle: () => ({ overflowY: 'auto' }) },
            },
        );
    });
});
