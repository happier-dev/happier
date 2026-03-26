import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installTranscriptCommonModuleMocks } from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFlashListProps: any = null;
let sessionState: any = null;
let sessionMessagesState: { messages: any[]; isLoaded: boolean } = { messages: [], isLoaded: true };
const settingValues: Record<string, unknown> = {};

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: React.forwardRef((props: any, ref: any) => {
        capturedFlashListProps = props;
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
}));

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            ActivityIndicator: () => React.createElement('ActivityIndicator'),
            FlatList: () => React.createElement('FlatList'),
            Platform: {
                OS: 'web',
                select: (values: any) => values?.web ?? values?.default,
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
            transcriptWebInitialPinStabilizeMs: 0,
            transcriptWebInitialPinRetryIntervalMs: 16,
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
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
    ToolCallsGroupRow: () => React.createElement('ToolCallsGroupRow'),
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
}));

vi.mock('@/components/sessions/transcript/scroll/shouldPrefetchOlderFromTop', () => ({
    shouldPrefetchOlderFromTop: () => false,
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

vi.mock('@/components/ui/lists/useWebFlashListCrashFallback', () => ({
    useWebFlashListCrashFallback: () => false,
}));

vi.mock('@/components/sessions/transcript/segments/buildTranscriptHotColdSegments', async () => await import('./segments/buildTranscriptHotColdSegments'));

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

describe('ChatList web hot/cold split', () => {
    beforeEach(() => {
        capturedFlashListProps = null;
        sessionState = {
            id: 'session-1',
            seq: 4,
            metadata: null,
            active: true,
            presence: 'online',
            accessLevel: null,
        };
        sessionMessagesState = {
            isLoaded: true,
            messages: [
                { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'one', seq: 1 },
                { kind: 'user-text', id: 'u2', localId: null, createdAt: 2, text: 'two', seq: 2 },
                { kind: 'user-text', id: 'u3', localId: null, createdAt: 3, text: 'three', seq: 3 },
                { kind: 'user-text', id: 'u4', localId: null, createdAt: 4, text: 'four', seq: 4 },
            ],
        };

        for (const key of Object.keys(settingValues)) delete settingValues[key];
        settingValues.transcriptGroupingMode = 'linear';
        settingValues.transcriptGroupToolCalls = false;
        settingValues.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
        settingValues.transcriptListImplementation = 'flash_v2';
    });

    afterEach(() => {
        standardCleanup();
    });

    it('keeps only cold items in FlashList data and renders the hot tail in the footer', async () => {
        const { ChatList } = await import('./ChatList');

        const screen = await renderScreen(<ChatList session={{ ...sessionState }} />);

        expect(capturedFlashListProps).not.toBeNull();
        expect((capturedFlashListProps.data ?? []).map((item: any) => item.id)).toEqual(['u1', 'u2']);
        expect(screen.findAllByTestId('transcript-web-hot-tail').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('transcript-web-hot-tail-item-u3').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('transcript-web-hot-tail-item-u4').length).toBeGreaterThan(0);
        expect(screen.findByType('ChatFooter')).toBeTruthy();
    });
});
