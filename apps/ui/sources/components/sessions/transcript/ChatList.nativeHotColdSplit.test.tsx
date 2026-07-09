import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installTranscriptCommonModuleMocks } from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFlashListProps: any = null;
let capturedMaintainVisibleContentPosition: any = null;
let capturedNativeHotTailProps: any = null;
let sessionState: any = null;
let sessionMessagesState: { messages: any[]; isLoaded: boolean } = { messages: [], isLoaded: true };
const settingValues: Record<string, unknown> = {};
let nativeHotTailItemCount = 4;

const STREAMING_META = { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant', segmentLocalId: 's1', segmentState: 'streaming', updatedAtMs: 10 } };

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: React.forwardRef((props: any, ref: any) => {
        capturedFlashListProps = props;
        capturedMaintainVisibleContentPosition = props.maintainVisibleContentPosition;
        if (ref && typeof ref === 'object') {
            ref.current = { scrollToIndex: vi.fn(), scrollToOffset: vi.fn() };
        }
        const header =
            typeof props.ListHeaderComponent === 'function' ? props.ListHeaderComponent() : props.ListHeaderComponent;
        const footer =
            typeof props.ListFooterComponent === 'function' ? props.ListFooterComponent() : props.ListFooterComponent;
        return React.createElement(
            'FlashList',
            props,
            header,
            (props.data ?? []).map((item: any, index: number) =>
                React.createElement(
                    'FlashListItem',
                    { key: item.id ?? String(index) },
                    props.renderItem?.({ item, index }),
                ),
            ),
            footer,
        );
    }),
    LayoutCommitObserver: ({ children, onCommitLayoutEffect }: any) => {
        React.useLayoutEffect(() => {
            onCommitLayoutEffect?.();
        });
        return React.createElement(React.Fragment, null, children);
    },
    useLayoutState: <T,>(initialValue: T) => React.useState(initialValue),
    useMappingHelper: () => ({
        getMappingKey: (_key: string | number, index: number) => index,
    }),
    useRecyclingState: <T,>(initialValue: T, dependencies: readonly unknown[], onReset?: () => void) => {
        const [state, setState] = React.useState(initialValue);
        React.useEffect(() => {
            setState(initialValue);
            onReset?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps
        }, dependencies);
        return [state, setState] as const;
    },
}));

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            ActivityIndicator: () => React.createElement('ActivityIndicator'),
            FlatList: () => React.createElement('FlatList'),
            Platform: {
                OS: 'ios',
                select: (values: any) => values?.ios ?? values?.native ?? values?.default,
            },
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useForkedTranscriptSnapshot: () => null,
            useMessage: (_sessionId: string, messageId: string) =>
                sessionMessagesState.messages.find((message) => message.id === messageId) ?? null,
            useSession: () => sessionState,
            useSessionActionDrafts: () => [],
            useSessionChatFooterState: () => ({
                controlledByUser: false,
                localControl: null,
                permissionsInUiWhileLocal: false,
            }),
            useSessionLatestThinkingMessageId: () => null,
            useSessionLatestThinkingMessageActivityAtMs: () => null,
            useSessionMessagesById: () =>
                Object.fromEntries(sessionMessagesState.messages.map((message) => [message.id, message])),
            useSessionPendingMessages: () => ({ messages: [], discarded: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({
                ids: sessionMessagesState.messages.map((message) => message.id),
                isLoaded: sessionMessagesState.isLoaded,
            }),
            useSetting: (key: string) => settingValues[key],
            getStorage: () => ({
                getState: () => ({
                    sessionMessages: {
                        [sessionState.id]: {
                            messageIdsOldestFirst: sessionMessagesState.messages.map((message) => message.id),
                            messagesById: Object.fromEntries(sessionMessagesState.messages.map((message) => [message.id, message])),
                            messagesMap: Object.fromEntries(sessionMessagesState.messages.map((message) => [message.id, message])),
                        },
                    },
                }),
            }),
        });
    },
});

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/sessions/chatListItems', () => ({
    buildChatListItems: ({ messageIdsOldestFirst, messagesById }: any) =>
        (messageIdsOldestFirst ?? []).map((id: string) => ({
            kind: 'message',
            id,
            messageId: id,
            createdAt: messagesById?.[id]?.createdAt ?? 0,
            seq: messagesById?.[id]?.seq ?? null,
        })),
    buildChatListItemsCached: ({ messageIdsOldestFirst, messagesById }: any) => ({
        cache: null,
        items: (messageIdsOldestFirst ?? []).map((id: string) => ({
            kind: 'message',
            id,
            messageId: id,
            createdAt: messagesById?.[id]?.createdAt ?? 0,
            seq: messagesById?.[id]?.seq ?? null,
        })),
    }),
}));

vi.mock('./MessageView', () => ({
    MessageView: ({ message }: any) => React.createElement('MessageView', { messageId: message?.id }),
    MessageViewWithSessionCommon: ({ message }: any) => React.createElement('MessageView', { messageId: message?.id }),
}));

vi.mock('./ChatFooter', () => ({
    ChatFooter: (props: any) => React.createElement('ChatFooter', props),
}));

vi.mock('@/components/sessions/transcript/forkContext/injectForkContextRows', () => ({
    injectForkContextRows: ({ baseItems }: any) => baseItems,
}));

vi.mock('@/components/sessions/transcript/forkContext/ForkDividerRow', () => ({
    ForkDividerRow: () => React.createElement('ForkDividerRow'),
}));

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
    PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
    SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        getSyncTuning: () => ({
            transcriptForwardPrefetchThresholdPx: 0,
            transcriptBackwardPrefetchThresholdPx: 0,
            transcriptFlashListEstimatedItemSize: 120,
            transcriptWebHotTailItemCount: 2,
            transcriptNativeHotTailItemCount: nativeHotTailItemCount,
            transcriptWebInitialPinStabilizeMs: 0,
            transcriptWebInitialPinRetryIntervalMs: 16,
            transcriptWebInitialPinRetryMilestonesMs: [16, 50, 100, 200, 400, 800],
            transcriptOlderLoadSpinnerDelayMs: 300,
            transcriptFlashListDrawDistance: 0,
            transcriptMountSettleQuiescentWindowMs: 120,
            transcriptInitialFillBudgetMs: 1500,
        }),
        loadOlderMessages: vi.fn(),
        loadOlderMessagesForkAware: vi.fn(),
        loadNewerMessages: vi.fn(),
        hasDeferredNewerMessages: () => false,
    },
}));

vi.mock('@/sync/domains/state/agentStateCapabilities', () => ({
    getPermissionsInUiWhileLocal: () => ({}),
}));

vi.mock('@/utils/sessions/jumpToTranscriptSeq', () => ({
    jumpToTranscriptSeq: vi.fn(),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (value: Promise<unknown>) => value,
}));

vi.mock('@/components/sessions/transcript/turnGrouping/buildTranscriptTurns', () => ({
    buildTranscriptTurnsCached: () => ({ cache: null, turns: [] }),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: () => React.createElement('TurnView'),
    TurnViewWithSessionCommon: () => React.createElement('TurnView'),
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
    ToolCallsGroupRow: () => React.createElement('ToolCallsGroupRow'),
    ToolCallsGroupRowWithSessionCommon: () => React.createElement('ToolCallsGroupRow'),
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

vi.mock('@/components/sessions/transcript/scroll/JumpToBottomButton', () => ({
    JumpToBottomButton: (props: any) => React.createElement('JumpToBottomButton', props),
}));

vi.mock('@/components/sessions/transcript/scroll/transcriptScrollPinController', () => ({
    reduceTranscriptScrollPinState: (state: any) => state,
    reduceTranscriptScrollPinStateWithPinnedSnapshot: (state: any) => state,
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

vi.mock('@/components/sessions/transcript/thinking/resolveActiveThinkingMessageId', () => ({
    resolveActiveThinkingMessageId: () => null,
}));

vi.mock('@/sync/domains/settings/settings', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        settingsDefaults: {},
    };
});

vi.mock('./chatListNativeId', () => ({
    buildChatListNativeId: () => 'transcript-chat-list-native',
}));

vi.mock('@/components/sessions/transcript/segments/buildTranscriptHotColdSegments', async () => await import('./segments/buildTranscriptHotColdSegments'));

vi.mock('@/components/sessions/transcript/segments/TranscriptHotTail', async () => {
    const actual = await import('./segments/TranscriptHotTail');
    return {
        ...actual,
        TranscriptHotTail: (props: any) => {
            capturedNativeHotTailProps = props;
            return React.createElement(actual.TranscriptHotTail as any, props);
        },
    };
});

vi.mock('@/components/sessions/transcript/webTranscriptScrollMetrics', () => ({
    getWebTranscriptDistanceFromBottom: () => 0,
    isWebTranscriptScrollable: () => false,
    resolveWebTranscriptScrollMetrics: () => null,
}));

vi.mock('@/components/sessions/transcript/web/WebTranscriptSplitFooter', async () => await import('./web/WebTranscriptSplitFooter'));

vi.mock('@/components/sessions/transcript/webTranscriptPrependAnchor', () => ({
    captureWebTranscriptPrependAnchor: () => null,
    refreshWebTranscriptPrependAnchor: (anchor: any) => anchor,
    restoreWebTranscriptPrependAnchor: () => ({ strategy: 'none' }),
    TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX: 'message-anchor-',
    TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX: 'prepend-anchor-',
    TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX: 'tool-anchor-',
}));

function setMessages(streamingTail: boolean, active = true, thinking = true) {
    sessionMessagesState = {
        isLoaded: true,
        messages: [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'one', seq: 1 },
            { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, text: 'two', seq: 2 },
            { kind: 'user-text', id: 'u3', localId: null, createdAt: 3, text: 'three', seq: 3 },
            {
                kind: 'agent-text',
                id: 'a4',
                localId: null,
                createdAt: 4,
                text: 'four',
                seq: 4,
                meta: streamingTail ? STREAMING_META : undefined,
            },
        ],
    };
    sessionState = {
        id: 'session-1',
        seq: 4,
        metadata: null,
        active,
        thinking,
        presence: 'online',
        accessLevel: null,
    };
}

function setThirdMessageStreamingTail() {
    sessionMessagesState = {
        isLoaded: true,
        messages: [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'one', seq: 1 },
            { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, text: 'two', seq: 2 },
            {
                kind: 'agent-text',
                id: 'u3',
                localId: null,
                createdAt: 3,
                text: 'three',
                seq: 3,
                meta: STREAMING_META,
            },
            { kind: 'agent-text', id: 'a4', localId: null, createdAt: 4, text: 'four', seq: 4 },
        ],
    };
    sessionState = {
        id: 'session-1',
        seq: 4,
        metadata: null,
        active: true,
        thinking: false,
        presence: 'online',
        accessLevel: null,
    };
}

function setRunningToolTail(active: boolean) {
    // Newest row is an in-flight (running) tool call — no streaming text, no thinking pulse.
    sessionMessagesState = {
        isLoaded: true,
        messages: [
            { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'one', seq: 1 },
            { kind: 'agent-text', id: 'a2', localId: null, createdAt: 2, text: 'two', seq: 2 },
            { kind: 'user-text', id: 'u3', localId: null, createdAt: 3, text: 'three', seq: 3 },
            { kind: 'tool-call', id: 'a4', localId: null, createdAt: 4, seq: 4, tool: { state: 'running' } },
        ],
    };
    sessionState = {
        id: 'session-1',
        seq: 4,
        metadata: null,
        active,
        thinking: false,
        presence: 'online',
        accessLevel: null,
    };
}

describe('ChatList native live-tail carve', () => {
    beforeEach(() => {
        capturedFlashListProps = null;
        capturedMaintainVisibleContentPosition = null;
        capturedNativeHotTailProps = null;
        nativeHotTailItemCount = 4;
        setMessages(true);

        for (const key of Object.keys(settingValues)) delete settingValues[key];
        settingValues.transcriptGroupingMode = 'linear';
        settingValues.transcriptGroupToolCalls = false;
        settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
        settingValues.transcriptListImplementation = 'flash_v2';
    });

    afterEach(() => {
        standardCleanup();
    });

    it('carves the actively-streaming live row into the footer (outside the recycler) and keeps cold data only', async () => {
        const { ChatList } = await import('./ChatList');

        const screen = await renderScreen(<ChatList session={{ ...sessionState }} />);

        expect(capturedFlashListProps).not.toBeNull();
        // The streaming row (a4) is the anchor; it renders in the footer, NOT in the recycler data.
        expect((capturedFlashListProps.data ?? []).map((item: any) => item.id)).toEqual(['u3', 'a2', 'u1']);
        expect(screen.findAllByTestId('transcript-native-hot-tail').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('transcript-native-hot-tail-item-a4').length).toBeGreaterThan(0);
    });

    it('renders native FlashList inverted with oriented cold data and a canonical hot edge slot', async () => {
        setThirdMessageStreamingTail();
        const { ChatList } = await import('./ChatList');

        const screen = await renderScreen(<ChatList session={{ ...sessionState }} />);

        expect(capturedFlashListProps).not.toBeNull();
        expect(capturedFlashListProps.inverted).toBe(true);
        expect((capturedFlashListProps.data ?? []).map((item: any) => item.id)).toEqual(['a2', 'u1']);
        expect(capturedNativeHotTailProps).toBeTruthy();
        expect(capturedNativeHotTailProps.displayIndexMode).toBe('invertedEdgeSlot');
        expect(capturedNativeHotTailProps.startIndex).toBe(1);
        expect((capturedNativeHotTailProps.hotItems ?? []).map((item: any) => item.id)).toEqual(['u3', 'a4']);
        expect(capturedFlashListProps.ListHeaderComponent?.props?.testIDPrefix).toBe('transcript-native-hot-tail');
        expect(capturedFlashListProps.ListFooterComponent?.props?.testIDPrefix).toBeUndefined();
        expect(screen.findAllByTestId('transcript-native-hot-tail-item-u3').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('transcript-native-hot-tail-item-a4').length).toBeGreaterThan(0);
    });

    it('withholds the MVCP autoscroll threshold while the carve is active (single pin owner)', async () => {
        const { ChatList } = await import('./ChatList');

        await renderScreen(<ChatList session={{ ...sessionState }} />);

        // While the carve is active, maintenance returns startRenderingFromBottom only (no threshold).
        expect(capturedMaintainVisibleContentPosition).toBeTruthy();
        expect(capturedMaintainVisibleContentPosition).not.toHaveProperty('autoscrollToBottomThreshold');
        expect(capturedMaintainVisibleContentPosition.startRenderingFromBottom).toBe(true);
    });

    it('does NOT carve when nothing is streaming (idle → no orphan)', async () => {
        setMessages(false, /* active */ false, /* thinking */ false);
        const { ChatList } = await import('./ChatList');

        const screen = await renderScreen(<ChatList session={{ ...sessionState }} />);

        // No anchor on an idle session → all rows stay in the recycler, footer has no hot tail.
        expect((capturedFlashListProps.data ?? []).map((item: any) => item.id)).toEqual(['a4', 'u3', 'a2', 'u1']);
        expect(screen.findAllByTestId('transcript-native-hot-tail').length).toBe(0);
    });

    it('does NOT carve when a stale streaming flag lingers on an INACTIVE session (idle orphan guard)', async () => {
        // Streaming meta present but session inactive — the carve must fail closed.
        setMessages(true, /* active */ false, /* thinking */ false);
        const { ChatList } = await import('./ChatList');

        const screen = await renderScreen(<ChatList session={{ ...sessionState }} />);

        expect((capturedFlashListProps.data ?? []).map((item: any) => item.id)).toEqual(['a4', 'u3', 'a2', 'u1']);
        expect(screen.findAllByTestId('transcript-native-hot-tail').length).toBe(0);
    });

    it('is OFF (no carve) when the native flag is 0 — byte-for-byte all-in-FlashList', async () => {
        nativeHotTailItemCount = 0;
        const { ChatList } = await import('./ChatList');

        const screen = await renderScreen(<ChatList session={{ ...sessionState }} />);

        expect((capturedFlashListProps.data ?? []).map((item: any) => item.id)).toEqual(['a4', 'u3', 'a2', 'u1']);
        expect(screen.findAllByTestId('transcript-native-hot-tail').length).toBe(0);
        // With the carve off the maintenance threshold branch is restored.
        expect(capturedMaintainVisibleContentPosition).toBeTruthy();
    });

    it('engages the carve via the whole-turn floor when active+thinking with no per-row stream meta (FIX 1 positive)', async () => {
        // Legacy / no-segment-meta streaming (e.g. Gemini): no row is detectably mid-stream this frame,
        // but a REAL active turn is both `active` AND `thinking`. The whole-turn floor anchors the carve
        // at the newest committed row (a4) so the growing answer is not stranded in the recycler.
        setMessages(false, /* active */ true, /* thinking */ true);
        const { ChatList } = await import('./ChatList');

        const screen = await renderScreen(<ChatList session={{ ...sessionState }} />);

        expect((capturedFlashListProps.data ?? []).map((item: any) => item.id)).toEqual(['u3', 'a2', 'u1']);
        expect(screen.findAllByTestId('transcript-native-hot-tail-item-a4').length).toBeGreaterThan(0);
    });

    it('does NOT carve via the whole-turn floor when thinking but NOT active (FIX 1 sessionActive gate)', async () => {
        // `thinking && !active` is a debounced grace flag / thinking flag stuck across a disconnect — NOT
        // a live turn. The floor is gated on sessionActive, so it yields no anchor → no detached block.
        setMessages(false, /* active */ false, /* thinking */ true);
        const { ChatList } = await import('./ChatList');

        const screen = await renderScreen(<ChatList session={{ ...sessionState }} />);

        expect((capturedFlashListProps.data ?? []).map((item: any) => item.id)).toEqual(['a4', 'u3', 'a2', 'u1']);
        expect(screen.findAllByTestId('transcript-native-hot-tail').length).toBe(0);
    });

    it('carves an in-flight running tool-call row on an ACTIVE session (R2 positive control)', async () => {
        // A genuine live tail with no streaming text and no thinking pulse: the running-tool anchor
        // carves the trailing tool row into the footer.
        setRunningToolTail(/* active */ true);
        const { ChatList } = await import('./ChatList');

        const screen = await renderScreen(<ChatList session={{ ...sessionState }} />);

        expect((capturedFlashListProps.data ?? []).map((item: any) => item.id)).toEqual(['u3', 'a2', 'u1']);
        expect(screen.findAllByTestId('transcript-native-hot-tail-item-a4').length).toBeGreaterThan(0);
    });

    it('does NOT carve an idle session whose trailing tool is stuck in running (R2 orphan fix)', async () => {
        // A tool left `running` after a disconnect on an otherwise-idle session must NOT keep the carve
        // open, or its row would be permanently detached into the footer. The running-tool anchor is
        // scoped to session.active → idle yields no anchor → no carve.
        setRunningToolTail(/* active */ false);
        const { ChatList } = await import('./ChatList');

        const screen = await renderScreen(<ChatList session={{ ...sessionState }} />);

        expect((capturedFlashListProps.data ?? []).map((item: any) => item.id)).toEqual(['a4', 'u3', 'a2', 'u1']);
        expect(screen.findAllByTestId('transcript-native-hot-tail').length).toBe(0);
    });

    it('recomputes the carve anchor when the live row flips streaming -> complete (memo freshness)', async () => {
        // a4 streams → carve engages on a4 (active, no thinking pulse → streaming-message anchor).
        setMessages(true, /* active */ true, /* thinking */ false);
        const { ChatList } = await import('./ChatList');

        const screen = await renderScreen(<ChatList session={{ ...sessionState }} />);
        expect((capturedFlashListProps.data ?? []).map((item: any) => item.id)).toEqual(['u3', 'a2', 'u1']);
        expect(screen.findAllByTestId('transcript-native-hot-tail-item-a4').length).toBeGreaterThan(0);

        // The segment finalizes (streaming -> complete) and nothing else is live (active stays true, but
        // thinking is false so the whole-turn floor does NOT re-anchor). Finalizing is a newly-committed
        // event, so session.seq advances. A stale memo would keep a4 detached in the footer forever; the
        // live-tail memo MUST recompute off the flipped segmentState → anchor null → no carve. The seq
        // bump alone does not drop the carve (a4 would still be streaming) — the meta flip is operative.
        sessionMessagesState = {
            isLoaded: true,
            messages: sessionMessagesState.messages.map((message: any) =>
                message.id === 'a4' ? { ...message, meta: undefined } : message),
        };
        await screen.update(<ChatList session={{ ...sessionState, seq: 5 }} />);

        expect((capturedFlashListProps.data ?? []).map((item: any) => item.id)).toEqual(['a4', 'u3', 'a2', 'u1']);
        expect(screen.findAllByTestId('transcript-native-hot-tail').length).toBe(0);
    });

    it('does not arm an autoscroll-to-bottom yank as the carved live row grows (scrolled-up safe)', async () => {
        // The native carve is MVCP-only (no imperative pin): the no-yank guarantee for a scrolled-up
        // reader is that the carve NEVER arms `autoscrollToBottomThreshold` while it owns the bottom, so
        // MVCP cannot drag the viewport to the tail as the live row grows. Re-render with the live row
        // grown and confirm the threshold stays withheld and the single pin owner is unchanged.
        setMessages(true, /* active */ true, /* thinking */ true);
        const { ChatList } = await import('./ChatList');

        const screen = await renderScreen(<ChatList session={{ ...sessionState }} />);
        expect(capturedMaintainVisibleContentPosition).toBeTruthy();
        expect(capturedMaintainVisibleContentPosition).not.toHaveProperty('autoscrollToBottomThreshold');

        // The live row grows (more streamed text) while still streaming on the active session.
        sessionMessagesState = {
            isLoaded: true,
            messages: sessionMessagesState.messages.map((message: any) =>
                message.id === 'a4' ? { ...message, text: 'four-much-longer-streamed-body' } : message),
        };
        await screen.update(<ChatList session={{ ...sessionState }} />);

        expect(capturedMaintainVisibleContentPosition).toBeTruthy();
        expect(capturedMaintainVisibleContentPosition).not.toHaveProperty('autoscrollToBottomThreshold');
        expect(capturedMaintainVisibleContentPosition.startRenderingFromBottom).toBe(true);
    });
});
