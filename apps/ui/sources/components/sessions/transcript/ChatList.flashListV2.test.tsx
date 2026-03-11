import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFlashListProps: any = null;
let renderedFlatListCount = 0;
let flashListRefHandle: any = null;
const mountedTrees: renderer.ReactTestRenderer[] = [];

function createTree(element: React.ReactElement): renderer.ReactTestRenderer {
    const tree = renderer.create(element);
    mountedTrees.push(tree);
    return tree;
}

async function flushAnimationFrame(): Promise<void> {
    const raf = (globalThis as any).requestAnimationFrame as undefined | ((cb: FrameRequestCallback) => unknown);
    if (typeof raf === 'function') {
        await new Promise<void>((resolve) => {
            raf(() => resolve());
        });
        return;
    }
    await Promise.resolve();
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
            props,
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
    const ReactMod = await import('react');
    return {
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
        View: (props: any) => ReactMod.createElement('View', props, props.children),
        Pressable: ({ children, ...props }: any) => ReactMod.createElement('Pressable', props, children),
        ActivityIndicator: () => ReactMod.createElement('ActivityIndicator'),
        FlatList: (_props: any) => {
            renderedFlatListCount++;
            return ReactMod.createElement('FlatList');
        },
    };
});

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
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
}));

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
    ChatFooter: () => React.createElement('ChatFooter'),
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

vi.mock('@/utils/sessions/deriveTranscriptInteraction', () => ({
    deriveTranscriptInteraction: () => ({
        isReadonly: false,
        canOpenTools: true,
    }),
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
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
        });

        expect(renderedFlatListCount).toBe(0);
        expect(capturedFlashListProps).not.toBeNull();
        expect(capturedFlashListProps.maintainVisibleContentPosition).toBeUndefined();
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
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
        });

        expect(capturedFlashListProps).toBeTruthy();
        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await act(async () => {
            capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 600 } } });
            capturedFlashListProps.onContentSizeChange?.(0, 1200);
            await Promise.resolve();
        });

        await act(async () => {
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 100 }, isTrusted: true } });
            await Promise.resolve();
        });

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
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
        });

        expect(capturedFlashListProps).toBeTruthy();

        await act(async () => {
            capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 600 } } });
            capturedFlashListProps.onContentSizeChange?.(0, 1200);
            await Promise.resolve();
        });

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await act(async () => {
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 100 } } });
            await Promise.resolve();
        });

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
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
        });

        await act(async () => {
            capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 600 } } });
            capturedFlashListProps.onContentSizeChange?.(0, 1200);
            await Promise.resolve();
            await Promise.resolve();
            await flushAnimationFrame();
            await flushAnimationFrame();
        });

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        await act(async () => {
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 600 }, isTrusted: true } });
            await Promise.resolve();
        });

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();
    });

    it('waits for web scroll metrics to settle before prefetching older messages during initial fill', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        const originalDocument = (globalThis as any).document;
        const originalWindow = (globalThis as any).window;

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

        (globalThis as any).document = { getElementById: vi.fn(() => scrollEl) };
        (globalThis as any).window = {
            getComputedStyle: vi.fn(() => ({
                overflowY: 'auto',
                overflowX: 'hidden',
                overflow: 'auto',
            })),
        };

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
        });

        expect(capturedFlashListProps).toBeTruthy();

        await act(async () => {
            capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 100 } } });
            capturedFlashListProps.onContentSizeChange?.(0, 100);
            await Promise.resolve();
            scrollEl.scrollHeight = 1600;
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
    });

    it('ignores a web onStartReached misfire while the transcript is still pinned at the bottom', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);
        const originalDocument = (globalThis as any).document;
        const originalWindow = (globalThis as any).window;

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

        (globalThis as any).document = { getElementById: vi.fn(() => scrollEl) };
        (globalThis as any).window = {
            getComputedStyle: vi.fn(() => ({
                overflowY: 'auto',
                overflowX: 'hidden',
                overflow: 'auto',
            })),
        };

        loadOlderMessagesMock.mockResolvedValue({ loaded: 1, hasMore: true, status: 'loaded' as const });
        loadOlderMessagesMock.mockClear();

        syncTuningState = { ...syncTuningState, transcriptBackwardPrefetchThresholdPx: 800 };
        sessionState = { ...sessionState, seq: 25 };
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
        });

        expect(capturedFlashListProps).toBeTruthy();

        await act(async () => {
            capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 600 } } });
            capturedFlashListProps.onContentSizeChange?.(0, 1200);
            await Promise.resolve();
            await Promise.resolve();
        });

        await act(async () => {
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 600 }, isTrusted: true } });
            await Promise.resolve();
        });

        loadOlderMessagesMock.mockClear();

        await act(async () => {
            capturedFlashListProps.onStartReached?.();
            await Promise.resolve();
        });

        expect(loadOlderMessagesMock).not.toHaveBeenCalled();

        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
    });

    it('preserves the web viewport when older messages prepend above the current scroll position', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const originalDocument = (globalThis as any).document;
        const originalWindow = (globalThis as any).window;

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

        (globalThis as any).document = { getElementById: vi.fn(() => scrollEl) };
        (globalThis as any).window = {
            getComputedStyle: vi.fn(() => ({
                overflowY: 'auto',
                overflowX: 'hidden',
                overflow: 'auto',
            })),
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

        const { ChatList } = await import('./ChatList');
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
        });

        expect(capturedFlashListProps).toBeTruthy();

        await act(async () => {
            capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 600 } } });
            capturedFlashListProps.onContentSizeChange?.(0, 1200);
            await Promise.resolve();
            await Promise.resolve();
        });

        scrollEl.scrollHeight = 1200;
        loadOlderMessagesMock.mockClear();

        await act(async () => {
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 600 }, isTrusted: true } });
            await Promise.resolve();
        });

        scrollEl.scrollTop = 100;
        await act(async () => {
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 100 }, isTrusted: true } });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(loadOlderMessagesMock.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(scrollEl.scrollTop).toBe(700);

        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
    });

    it('continues preserving the web viewport if content grows again after the prepend commit', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const originalDocument = (globalThis as any).document;
        const originalWindow = (globalThis as any).window;

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

        (globalThis as any).document = { getElementById: vi.fn(() => scrollEl) };
        (globalThis as any).window = {
            getComputedStyle: vi.fn(() => ({
                overflowY: 'auto',
                overflowX: 'hidden',
                overflow: 'auto',
            })),
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

        const { ChatList } = await import('./ChatList');
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
        });

        expect(capturedFlashListProps).toBeTruthy();

        await act(async () => {
            capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 600 } } });
            capturedFlashListProps.onContentSizeChange?.(0, 1200);
            await Promise.resolve();
            await Promise.resolve();
        });

        scrollEl.scrollHeight = 1200;
        loadOlderMessagesMock.mockClear();

        await act(async () => {
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 600 }, isTrusted: true } });
            await Promise.resolve();
        });

        scrollEl.scrollTop = 100;
        await act(async () => {
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 100 }, isTrusted: true } });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(loadOlderMessagesMock.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(scrollEl.scrollTop).toBe(300);

        scrollEl.scrollHeight = 1800;
        await act(async () => {
            capturedFlashListProps.onContentSizeChange?.(0, 1800);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(scrollEl.scrollTop).toBe(700);

        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
    });

    it('preserves the web viewport when the user keeps scrolling upward while older messages are still loading', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const originalDocument = (globalThis as any).document;
        const originalWindow = (globalThis as any).window;

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

        (globalThis as any).document = { getElementById: vi.fn(() => scrollEl) };
        (globalThis as any).window = {
            getComputedStyle: vi.fn(() => ({
                overflowY: 'auto',
                overflowX: 'hidden',
                overflow: 'auto',
            })),
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
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
        });

        expect(capturedFlashListProps).toBeTruthy();

        await act(async () => {
            capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 600 } } });
            capturedFlashListProps.onContentSizeChange?.(0, 1200);
            await Promise.resolve();
            await Promise.resolve();
        });

        await act(async () => {
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 600 }, isTrusted: true } });
            await Promise.resolve();
        });

        scrollEl.scrollTop = 100;
        await act(async () => {
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 100 }, isTrusted: true } });
            await Promise.resolve();
        });

        await act(async () => {
            capturedFlashListProps.onStartReached?.();
            await Promise.resolve();
        });

        expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

        scrollEl.scrollTop = 60;
        await act(async () => {
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 60 }, isTrusted: true } });
            await Promise.resolve();
        });

        scrollEl.scrollHeight = 1400;
        await act(async () => {
            resolveLoadOlder?.({ loaded: 5, hasMore: true, status: 'loaded' });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(scrollEl.scrollTop).toBe(260);

        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
    });

    it('keeps tracking the original web prepend anchor when it is temporarily unmounted during a large prepend', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const originalDocument = (globalThis as any).document;
        const originalWindow = (globalThis as any).window;
        const originalHTMLElement = (globalThis as any).HTMLElement;

        class FakeElement {
            public scrollTop = 0;
            public scrollHeight = 0;
            public clientHeight = 0;
            public scrollWidth = 0;
            public clientWidth = 0;
            public isConnected = true;
            public parentElement: FakeElement | null = null;

            private rect: { top: number; bottom: number };
            private readonly nodesBySelector = new Map<string, FakeElement[]>();

            constructor(
                private readonly testId: string | null,
                rect: { top: number; bottom: number },
            ) {
                this.rect = rect;
            }

            getAttribute(name: string) {
                return name === 'data-testid' ? this.testId : null;
            }

            getBoundingClientRect() {
                return {
                    top: this.rect.top,
                    bottom: this.rect.bottom,
                    left: 0,
                    right: 0,
                    width: 0,
                    height: this.rect.bottom - this.rect.top,
                    x: 0,
                    y: this.rect.top,
                    toJSON: () => ({}),
                };
            }

            querySelectorAll(selector: string) {
                return this.nodesBySelector.get(selector) ?? [];
            }

            setQuerySelectorAll(selector: string, nodes: FakeElement[]) {
                this.nodesBySelector.set(selector, nodes);
            }

            contains(node: unknown) {
                return node === this;
            }

            setRect(rect: { top: number; bottom: number }) {
                this.rect = rect;
            }
        }

        (globalThis as any).HTMLElement = FakeElement;

        let scrollTopValue = 0;
        const scrollEl = new FakeElement(null, { top: 0, bottom: 600 }) as FakeElement & {
            contains: (node: unknown) => boolean;
            scrollTop: number;
        };
        scrollEl.scrollHeight = 1200;
        scrollEl.clientHeight = 600;
        Object.defineProperty(scrollEl, 'scrollTop', {
            configurable: true,
            enumerable: true,
            get: () => scrollTopValue,
            set: (value: number) => {
                const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                scrollTopValue = Math.max(0, Math.min(value, maxScrollTop));
            },
        });
        scrollEl.scrollTop = 600;

        const visibleAnchor = new FakeElement('transcript-anchor-message-m1', { top: 120, bottom: 220 });
        scrollEl.setQuerySelectorAll('[data-testid]', [visibleAnchor]);

        (globalThis as any).document = { getElementById: vi.fn(() => scrollEl) };
        (globalThis as any).window = {
            getComputedStyle: vi.fn(() => ({
                overflowY: 'auto',
                overflowX: 'hidden',
                overflow: 'auto',
            })),
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
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
        });

        await act(async () => {
            capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 600 } } });
            capturedFlashListProps.onContentSizeChange?.(0, 1200);
            await Promise.resolve();
            await Promise.resolve();
        });

        await act(async () => {
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 600 }, isTrusted: true } });
            await Promise.resolve();
        });

        scrollEl.scrollTop = 100;
        await act(async () => {
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 100 }, isTrusted: true } });
            await Promise.resolve();
        });

        expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

        scrollEl.scrollHeight = 5200;
        scrollEl.setQuerySelectorAll('[data-testid]', []);
        await act(async () => {
            resolveLoadOlder?.({ loaded: 50, hasMore: true, status: 'loaded' });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(scrollEl.scrollTop).toBe(4100);

        visibleAnchor.setRect({ top: 300, bottom: 400 });
        scrollEl.scrollHeight = 5300;
        scrollEl.setQuerySelectorAll('[data-testid]', [visibleAnchor]);
        await act(async () => {
            capturedFlashListProps.onContentSizeChange?.(0, 5300);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(scrollEl.scrollTop).toBe(4280);

        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
        (globalThis as any).HTMLElement = originalHTMLElement;
    });

    it('recovers the captured web prepend item when scrollHeight growth overshoots the original viewport anchor', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const originalDocument = (globalThis as any).document;
        const originalWindow = (globalThis as any).window;
        const originalHTMLElement = (globalThis as any).HTMLElement;
        const originalRaf = (globalThis as any).requestAnimationFrame;
        const originalCancelRaf = (globalThis as any).cancelAnimationFrame;

        class FakeElement {
            public scrollTop = 0;
            public scrollHeight = 0;
            public clientHeight = 0;
            public scrollWidth = 0;
            public clientWidth = 0;
            public isConnected = true;
            public parentElement: FakeElement | null = null;

            private rect: { top: number; bottom: number };
            private readonly nodesBySelector = new Map<string, FakeElement[]>();

            constructor(
                private readonly testId: string | null,
                rect: { top: number; bottom: number },
            ) {
                this.rect = rect;
            }

            getAttribute(name: string) {
                return name === 'data-testid' ? this.testId : null;
            }

            getBoundingClientRect() {
                return {
                    top: this.rect.top,
                    bottom: this.rect.bottom,
                    left: 0,
                    right: 0,
                    width: 0,
                    height: this.rect.bottom - this.rect.top,
                    x: 0,
                    y: this.rect.top,
                    toJSON: () => ({}),
                };
            }

            querySelectorAll(selector: string) {
                return this.nodesBySelector.get(selector) ?? [];
            }

            setQuerySelectorAll(selector: string, nodes: FakeElement[]) {
                this.nodesBySelector.set(selector, nodes);
            }

            contains(node: unknown) {
                return node === this;
            }

            setRect(rect: { top: number; bottom: number }) {
                this.rect = rect;
            }
        }

        (globalThis as any).HTMLElement = FakeElement;
        (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
            cb(0);
            return 1;
        };
        (globalThis as any).cancelAnimationFrame = () => {};

        let scrollTopValue = 0;
        const scrollEl = new FakeElement(null, { top: 0, bottom: 600 }) as FakeElement & {
            contains: (node: unknown) => boolean;
            scrollTop: number;
        };
        scrollEl.scrollHeight = 1200;
        scrollEl.clientHeight = 600;
        Object.defineProperty(scrollEl, 'scrollTop', {
            configurable: true,
            enumerable: true,
            get: () => scrollTopValue,
            set: (value: number) => {
                const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                scrollTopValue = Math.max(0, Math.min(value, maxScrollTop));
            },
        });
        scrollEl.scrollTop = 600;

        const itemAnchor = new FakeElement('transcript-item-u1', { top: 40, bottom: 340 });
        const messageAnchor = new FakeElement('transcript-anchor-message-u1', { top: 120, bottom: 180 });
        scrollEl.setQuerySelectorAll('[data-testid]', [itemAnchor, messageAnchor]);

        flashListRefHandle = {
            scrollToOffset: vi.fn(),
            scrollToIndex: vi.fn(() => {
                scrollEl.scrollTop = 3900;
                itemAnchor.setRect({ top: 140, bottom: 440 });
                messageAnchor.setRect({ top: 220, bottom: 280 });
                scrollEl.setQuerySelectorAll('[data-testid]', [itemAnchor, messageAnchor]);
            }),
        };

        (globalThis as any).document = { getElementById: vi.fn(() => scrollEl) };
        (globalThis as any).window = {
            getComputedStyle: vi.fn(() => ({
                overflowY: 'auto',
                overflowX: 'hidden',
                overflow: 'auto',
            })),
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
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
        });

        await act(async () => {
            capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 600 } } });
            capturedFlashListProps.onContentSizeChange?.(0, 1200);
            await Promise.resolve();
            await Promise.resolve();
        });

        await act(async () => {
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 600 }, isTrusted: true } });
            await Promise.resolve();
        });

        scrollEl.scrollTop = 100;
        await act(async () => {
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 100 }, isTrusted: true } });
            await Promise.resolve();
        });

        expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

        scrollEl.scrollHeight = 5200;
        scrollEl.setQuerySelectorAll('[data-testid]', []);
        await act(async () => {
            resolveLoadOlder?.({ loaded: 50, hasMore: true, status: 'loaded' });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith({
            index: 0,
            animated: false,
            viewPosition: 0,
        });
        expect(scrollEl.scrollTop).toBe(4000);

        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
        (globalThis as any).HTMLElement = originalHTMLElement;
        (globalThis as any).requestAnimationFrame = originalRaf;
        (globalThis as any).cancelAnimationFrame = originalCancelRaf;
    });

    it('recovers by stable anchor identity when the captured turn wrapper id changes across the prepend', async () => {
        const syncMod = await import('@/sync/sync');
        const loadOlderMessagesMock = vi.mocked(syncMod.sync.loadOlderMessages);

        const originalDocument = (globalThis as any).document;
        const originalWindow = (globalThis as any).window;
        const originalHTMLElement = (globalThis as any).HTMLElement;
        const originalRaf = (globalThis as any).requestAnimationFrame;
        const originalCancelRaf = (globalThis as any).cancelAnimationFrame;

        class FakeElement {
            public scrollTop = 0;
            public scrollHeight = 0;
            public clientHeight = 0;
            public scrollWidth = 0;
            public clientWidth = 0;
            public isConnected = true;
            public parentElement: FakeElement | null = null;

            private rect: { top: number; bottom: number };
            private readonly nodesBySelector = new Map<string, FakeElement[]>();

            constructor(
                private readonly testId: string | null,
                rect: { top: number; bottom: number },
            ) {
                this.rect = rect;
            }

            getAttribute(name: string) {
                return name === 'data-testid' ? this.testId : null;
            }

            getBoundingClientRect() {
                return {
                    top: this.rect.top,
                    bottom: this.rect.bottom,
                    left: 0,
                    right: 0,
                    width: 0,
                    height: this.rect.bottom - this.rect.top,
                    x: 0,
                    y: this.rect.top,
                    toJSON: () => ({}),
                };
            }

            querySelectorAll(selector: string) {
                return this.nodesBySelector.get(selector) ?? [];
            }

            setQuerySelectorAll(selector: string, nodes: FakeElement[]) {
                this.nodesBySelector.set(selector, nodes);
            }

            contains(node: unknown) {
                return node === this;
            }

            setRect(rect: { top: number; bottom: number }) {
                this.rect = rect;
            }
        }

        (globalThis as any).HTMLElement = FakeElement;
        (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
            cb(0);
            return 1;
        };
        (globalThis as any).cancelAnimationFrame = () => {};

        let scrollTopValue = 0;
        const scrollEl = new FakeElement(null, { top: 0, bottom: 600 }) as FakeElement & {
            contains: (node: unknown) => boolean;
            scrollTop: number;
        };
        scrollEl.scrollHeight = 1200;
        scrollEl.clientHeight = 600;
        Object.defineProperty(scrollEl, 'scrollTop', {
            configurable: true,
            enumerable: true,
            get: () => scrollTopValue,
            set: (value: number) => {
                const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                scrollTopValue = Math.max(0, Math.min(value, maxScrollTop));
            },
        });
        scrollEl.scrollTop = 600;

        const staleItemAnchor = new FakeElement('transcript-item-turn:stale', { top: 20, bottom: 360 });
        const stableMessageAnchor = new FakeElement('transcript-anchor-message-u1', { top: 120, bottom: 180 });
        scrollEl.setQuerySelectorAll('[data-testid]', [staleItemAnchor, stableMessageAnchor]);

        flashListRefHandle = {
            scrollToOffset: vi.fn(),
            scrollToIndex: vi.fn(() => {
                scrollEl.scrollTop = 3900;
                stableMessageAnchor.setRect({ top: 150, bottom: 210 });
                scrollEl.setQuerySelectorAll('[data-testid]', [stableMessageAnchor]);
            }),
        };

        (globalThis as any).document = { getElementById: vi.fn(() => scrollEl) };
        (globalThis as any).window = {
            getComputedStyle: vi.fn(() => ({
                overflowY: 'auto',
                overflowX: 'hidden',
                overflow: 'auto',
            })),
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
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
        });

        await act(async () => {
            capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 600 } } });
            capturedFlashListProps.onContentSizeChange?.(0, 1200);
            await Promise.resolve();
            await Promise.resolve();
        });

        await act(async () => {
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 600 }, isTrusted: true } });
            await Promise.resolve();
        });

        scrollEl.scrollTop = 100;
        await act(async () => {
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 100 }, isTrusted: true } });
            await Promise.resolve();
        });

        expect(loadOlderMessagesMock).toHaveBeenCalledTimes(1);

        scrollEl.scrollHeight = 5200;
        scrollEl.setQuerySelectorAll('[data-testid]', []);
        await act(async () => {
            resolveLoadOlder?.({ loaded: 50, hasMore: true, status: 'loaded' });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(flashListRefHandle.scrollToIndex).toHaveBeenCalledWith({
            index: 0,
            animated: false,
            viewPosition: 0,
        });

        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
        (globalThis as any).HTMLElement = originalHTMLElement;
        (globalThis as any).requestAnimationFrame = originalRaf;
        (globalThis as any).cancelAnimationFrame = originalCancelRaf;
    });

    it('uses startRenderingFromBottom on native FlashList', async () => {
        platformOs = 'ios';
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
        });

        expect(capturedFlashListProps).not.toBeNull();
        expect(capturedFlashListProps.maintainVisibleContentPosition?.startRenderingFromBottom).toBe(true);
        expect(capturedFlashListProps.maintainVisibleContentPosition?.autoscrollToTopThreshold).toBeUndefined();
    });

    it('memoizes maintainVisibleContentPosition to avoid prop churn (FlashList)', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        let rerender: (() => void) | null = null;

        function Wrapper() {
            const [tick, setTick] = React.useState(0);
            rerender = () => setTick((t) => t + 1);
            return <ChatList session={{ ...sessionState }} bottomNotice={tick ? null : null} />;
        }

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = createTree(<Wrapper />);
        });

	        const first = capturedFlashListProps?.maintainVisibleContentPosition;
	        expect(first).toBeUndefined();

        await act(async () => {
            rerender?.();
        });

	        const second = capturedFlashListProps?.maintainVisibleContentPosition;
	        expect(second).toBe(first);

        // Unmount handled by afterEach to ensure stabilization timers are cancelled.
    });

    it('renders ListHeaderComponent above items and ChatFooter as ListFooterComponent (non-inverted FlashList)', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = createTree(<ChatList session={{ ...sessionState }} />);
        });

        expect(capturedFlashListProps).not.toBeNull();
        const headerEl = capturedFlashListProps.ListHeaderComponent;
        const footerEl = capturedFlashListProps.ListFooterComponent;

        // The header is responsible for top padding + optional older-loading affordance.
        expect(typeof headerEl?.props?.isLoadingOlder).toBe('boolean');
        // The footer can be wrapped by the web hot-tail split, but it must still render ChatFooter.
        expect(footerEl).toBeTruthy();
        expect(tree!.root.findAllByType('ChatFooter')).toHaveLength(1);

        // Render sanity: FlashList still mounts in tree.
        tree!.root.findByType('FlashList');
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
        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = createTree(<ChatList session={{ ...sessionState }} />);
        });

        expect(capturedFlashListProps).not.toBeNull();
        expect((capturedFlashListProps.data ?? []).map((item: any) => item.id)).toEqual(['u1', 'u2']);
        expect(tree!.root.findAllByProps({ testID: 'transcript-web-hot-tail' }).length).toBeGreaterThan(0);
        expect(tree!.root.findAllByProps({ testID: 'transcript-web-hot-tail-item-u3' }).length).toBeGreaterThan(0);
        expect(tree!.root.findAllByProps({ testID: 'transcript-web-hot-tail-item-u4' }).length).toBeGreaterThan(0);
        expect(tree!.root.findByType('ChatFooter')).toBeTruthy();
    });

    it('pins via DOM scroll on web without calling scrollToOffset when DOM pinning is possible', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

        const originalDocument = (globalThis as any).document;
        const originalWindow = (globalThis as any).window;

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

        const { ChatList } = await import('./ChatList');
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect((scrollEl as any).scrollTop).toBeGreaterThan(0);
        expect(scrollEl.scrollTo).not.toHaveBeenCalled();
        expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();

        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
    });

    it('does not fall back to scrollToOffset on web when DOM pinning is unavailable (prevents mount jitter)', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

        const originalDocument = (globalThis as any).document;
        const originalWindow = (globalThis as any).window;

        (globalThis as any).document = { getElementById: vi.fn(() => null) };
        (globalThis as any).window = { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) };

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();

        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
    });

    it('stops scheduling long-running initial web pin retries once DOM pinning succeeds', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

        const originalDocument = (globalThis as any).document;
        const originalWindow = (globalThis as any).window;
        const scrollEl: any = {
            scrollHeight: 1000,
            clientHeight: 100,
            scrollTop: 0,
            querySelectorAll: () => [],
            parentElement: null,
        };
        (globalThis as any).document = { getElementById: vi.fn(() => scrollEl) };
        (globalThis as any).window = { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) };

        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 1 as any);

        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const { ChatList } = await import('./ChatList');
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
            await Promise.resolve();
            await Promise.resolve();
        });

        const delays = setTimeoutSpy.mock.calls
            .map((call) => call[1])
            .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms));
        const maxDelay = delays.length ? Math.max(...delays) : 0;
        expect(maxDelay).toBeLessThanOrEqual(800);

        setTimeoutSpy.mockRestore();
        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
    });

    it('does not re-pin during the initial web stabilize window after the user scrolls away from bottom', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(0));

        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

        const originalDocument = (globalThis as any).document;
        const originalWindow = (globalThis as any).window;

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

        (globalThis as any).document = { getElementById: vi.fn(() => scrollEl) };
        (globalThis as any).window = { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) };

        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
            ],
        };

        const { ChatList } = await import('./ChatList');
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
            await Promise.resolve();
            await Promise.resolve();
        });

        // Initial stabilization pins to bottom.
        expect(scrollEl.scrollTop).toBeGreaterThanOrEqual(1000);

        // User scrolls away slightly from bottom.
        scrollEl.scrollTop = 900;
        await act(async () => {
            capturedFlashListProps?.onWheel?.({ deltaY: -80, stopPropagation: vi.fn() });
        });

        // Even though stabilization retries are scheduled, we must not fight the user's scroll.
        await act(async () => {
            vi.advanceTimersByTime(1500);
            await Promise.resolve();
        });

        expect(scrollEl.scrollTop).toBe(900);

        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
        vi.useRealTimers();
    });

    it('re-pins to the bottom for passive mount-time web scroll drift while follow mode is still desired', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(0));

        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };

        const originalDocument = (globalThis as any).document;
        const originalWindow = (globalThis as any).window;

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

        (globalThis as any).document = { getElementById: vi.fn(() => scrollEl) };
        (globalThis as any).window = { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) };

        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
            ],
        };

        const { ChatList } = await import('./ChatList');
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
            await Promise.resolve();
            await Promise.resolve();
        });

        // The initial mount pin puts us at the bottom.
        expect(scrollEl.scrollTop).toBeGreaterThanOrEqual(maxScrollTop);

        await act(async () => {
            // Establish scroll metrics used by FlashList distance-from-bottom math.
            capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 100 } } });
            capturedFlashListProps.onContentSizeChange?.(0, 1000);

            // First, we're at the bottom (distanceFromBottom = 0).
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 900 } } });

            // FlashList/web can apply a programmatic scroll adjustment during mount (no wheel/touch intent).
            // Simulate being nudged away from bottom by ~400px.
            vi.setSystemTime(new Date(300));
            scrollEl.scrollTop = 492;
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 492 } } });
        });

        // Passive mount-time drift should be corrected back to the visual bottom while follow mode remains desired.
        expect(scrollEl.scrollTop).toBeGreaterThanOrEqual(maxScrollTop);

        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
        vi.useRealTimers();
    });

    it('keeps bottom follow when passive web scroll drift occurs without user intent', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebInitialPinStabilizeMs: 0,
        };

        const originalDocument = (globalThis as any).document;
        const originalWindow = (globalThis as any).window;

        let scrollTopValue = 0;
        const scrollEl: any = {
            scrollHeight: 1000,
            clientHeight: 100,
            scrollTo: ({ top }: { top: number }) => {
                scrollEl.scrollTop = top;
            },
            querySelectorAll: () => [],
            parentElement: null,
        };
        Object.defineProperty(scrollEl, 'scrollTop', {
            configurable: true,
            enumerable: true,
            get: () => scrollTopValue,
            set: (value: number) => {
                const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                scrollTopValue = Math.max(0, Math.min(value, maxScrollTop));
            },
        });

        (globalThis as any).document = { getElementById: vi.fn(() => scrollEl) };
        (globalThis as any).window = { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) };

        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
            ],
        };

        const { ChatList } = await import('./ChatList');
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(capturedFlashListProps).not.toBeNull();
        flashListRefHandle.scrollToOffset.mockClear();

        await act(async () => {
            // Establish scroll metrics used by onScroll distance-from-bottom math.
            capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 100 } } });
            capturedFlashListProps.onContentSizeChange?.(0, 1000);

            // Simulate a passive drift away from the bottom without any user gesture or new activity.
            scrollEl.scrollTop = 0;
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 0 } } });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(scrollEl.scrollTop).toBe(900);
        expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();

        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
    });

    it('keeps the visual bottom pinned when existing web content remeasures without user activity', async () => {
        flashListRefHandle = { scrollToOffset: vi.fn(), scrollToIndex: vi.fn() };
        syncTuningState = {
            ...syncTuningState,
            transcriptWebInitialPinStabilizeMs: 0,
        };

        const originalDocument = (globalThis as any).document;
        const originalWindow = (globalThis as any).window;
        const originalRaf = (globalThis as any).requestAnimationFrame;
        const originalCancelRaf = (globalThis as any).cancelAnimationFrame;

        let scrollTopValue = 900;
        const scrollEl: any = {
            scrollHeight: 1000,
            clientHeight: 100,
            scrollTo: ({ top }: { top: number }) => {
                scrollEl.scrollTop = top;
            },
            querySelectorAll: () => [],
            parentElement: null,
        };
        Object.defineProperty(scrollEl, 'scrollTop', {
            configurable: true,
            enumerable: true,
            get: () => scrollTopValue,
            set: (value: number) => {
                const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                scrollTopValue = Math.max(0, Math.min(value, maxScrollTop));
            },
        });

        (globalThis as any).document = { getElementById: vi.fn(() => scrollEl) };
        (globalThis as any).window = { getComputedStyle: vi.fn(() => ({ overflowY: 'auto' })) };
        (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
            cb(0);
            return 1;
        };
        (globalThis as any).cancelAnimationFrame = () => {};

        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' },
                { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'hello' },
            ],
        };

        const { ChatList } = await import('./ChatList');
        await act(async () => {
            createTree(<ChatList session={{ ...sessionState }} />);
            await Promise.resolve();
            await Promise.resolve();
        });

        flashListRefHandle.scrollToOffset.mockClear();

        await act(async () => {
            capturedFlashListProps.onLayout?.({ nativeEvent: { layout: { height: 100 } } });
            capturedFlashListProps.onContentSizeChange?.(0, 1000);
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 900 } } });
            await Promise.resolve();
        });

        scrollEl.scrollHeight = 1400;

        await act(async () => {
            capturedFlashListProps.onContentSizeChange?.(0, 1400);
            capturedFlashListProps.onScroll?.({ nativeEvent: { contentOffset: { y: 900 } } });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(scrollEl.scrollTop).toBe(1300);
        expect(flashListRefHandle.scrollToOffset).not.toHaveBeenCalled();

        (globalThis as any).document = originalDocument;
        (globalThis as any).window = originalWindow;
        (globalThis as any).requestAnimationFrame = originalRaf;
        (globalThis as any).cancelAnimationFrame = originalCancelRaf;
    });

    it('pins using the current session nativeID when multiple transcript lists exist in the DOM (web)', async () => {
        sessionMessagesState = {
            isLoaded: true,
            messages: [{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' }],
        };

        const wrongScroller: any = {
            scrollHeight: 2000,
            clientHeight: 500,
            scrollTop: 111,
        };
        const rightScroller: any = {
            scrollHeight: 3000,
            clientHeight: 600,
            scrollTop: 0,
        };

        const prevDocument = (globalThis as any).document;
        const prevWindow = (globalThis as any).window;
        try {
            (globalThis as any).document = {
                querySelector: () => wrongScroller,
                getElementById: (id: string) => (id.startsWith('chat-list-session-1-') ? rightScroller : null),
            };
            (globalThis as any).window = {
                getComputedStyle: () => ({ overflowY: 'auto' }),
            };

            const { ChatList } = await import('./ChatList');
            await act(async () => {
                createTree(<ChatList session={{ ...sessionState }} />);
                await Promise.resolve();
                await Promise.resolve();
            });

            // If DOM pinning accidentally targets the first `[data-testid="transcript-chat-list"]` in the
            // document, it would pin the wrong scroller. We must always pin the current session's list.
            expect(wrongScroller.scrollTop).toBe(111);
            expect(rightScroller.scrollTop).toBe(3000);
        } finally {
            (globalThis as any).document = prevDocument;
            (globalThis as any).window = prevWindow;
        }
    });
});
