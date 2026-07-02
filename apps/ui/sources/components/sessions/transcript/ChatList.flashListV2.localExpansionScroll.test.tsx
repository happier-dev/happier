import * as React from 'react';
import { Pressable } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flashListChatListHarnessState,
    renderFlashListChatList,
    resetFlashListChatListHarness,
    standardCleanup,
    triggerFlashListChatListContentSizeChange,
    triggerFlashListChatListInitialFill,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const scrollToOffsetSpy = vi.fn();
let renderMode: 'tool' | 'thinking' = 'tool';
let renderedMessageViewProps: any[] = [];
let renderedTurnViewProps: any[] = [];

beforeEach(() => {
    scrollToOffsetSpy.mockClear();
    resetFlashListChatListHarness({
        flashListRefHandle: { scrollToOffset: scrollToOffsetSpy, scrollToIndex: vi.fn() },
        platformOs: 'ios',
    });
    flashListChatListHarnessState.sessionMessagesState = {
        messages: [{ kind: 'agent-text', id: 'm1', localId: 'm1-local', createdAt: 1, text: 'hi', isThinking: false }],
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
    flashListChatListHarnessState.settingValues.transcriptGroupingMode = 'linear';
    flashListChatListHarnessState.settingValues.transcriptScrollAutoFollowWhenPinned = true;
    flashListChatListHarnessState.settingValues.transcriptScrollPinEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptScrollPinOffsetThresholdPx = 100;
    flashListChatListHarnessState.settingValues.transcriptAnimateToolExpandCollapseEnabled = true;
    flashListChatListHarnessState.settingValues.transcriptAnimateThinkingEnabled = true;
    flashListChatListHarnessState.settingValues.sessionThinkingDisplayMode = 'inline';
    flashListChatListHarnessState.settingValues.sessionThinkingInlinePresentation = 'summary';
    renderMode = 'tool';
    renderedMessageViewProps = [];
    renderedTurnViewProps = [];
});

afterEach(() => {
    standardCleanup();
});

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListModuleMock()
);

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListReactNativeMock({ platformOs: 'ios' })
);

vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        useHeaderHeight: () => 0,
    };
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListStorageMock(importOriginal)
);

vi.mock('@/components/sessions/chatListItems', async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListItemsModuleMock(({ messageIdsOldestFirst, messagesById }: any) => {
        if (renderMode === 'tool') {
            return [{
                kind: 'tool-calls-group',
                id: 'tool-group-1',
                toolMessageIds: ['tool-1'],
                createdAt: 1,
            }];
        }
        return (messageIdsOldestFirst ?? []).map((id: string) => {
            const message = messagesById?.[id];
            return { kind: 'message', id: `msg:${id}`, messageId: id, createdAt: message?.createdAt ?? 0, seq: null };
        });
    })
);

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('@/components/sessions/pending/PendingMessagesTranscriptBlock', () => ({
    PendingMessagesTranscriptBlock: () => React.createElement('PendingMessagesTranscriptBlock'),
}));

vi.mock('@/components/sessions/actions/SessionActionDraftCard', () => ({
    SessionActionDraftCard: () => React.createElement('SessionActionDraftCard'),
}));

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: (props: any) => {
        renderedTurnViewProps.push(props);
        return React.createElement('TurnView', props);
    },
    TurnViewWithSessionCommon: (props: any) => {
        renderedTurnViewProps.push(props);
        return React.createElement('TurnView', props);
    },
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
    ToolCallsGroupRow: (props: any) => React.createElement(
        Pressable,
        {
            testID: 'transcript-tool-calls-header',
            onPress: () => props.onSetExpanded({
                toolCallsGroupId: props.toolCallsGroupId,
                toolMessageIds: props.toolMessageIds,
                expanded: !props.expanded,
            }),
        },
        null,
    ),
    ToolCallsGroupRowWithSessionCommon: (props: any) => React.createElement(
        Pressable,
        {
            testID: 'transcript-tool-calls-header',
            onPress: () => props.onSetExpanded({
                toolCallsGroupId: props.toolCallsGroupId,
                toolMessageIds: props.toolMessageIds,
                expanded: !props.expanded,
            }),
        },
        null,
    ),
}));

vi.mock('./MessageView', () => ({
    MessageView: (props: any) => {
        renderedMessageViewProps.push(props);
        return React.createElement(
            Pressable,
            {
                testID: props.onThinkingExpandedChange ? 'transcript-thinking-header' : `transcript-message-${props.message?.id ?? 'unknown'}`,
                onPress: props.onThinkingExpandedChange ? () => props.onThinkingExpandedChange(!(props.thinkingExpanded === true)) : undefined,
            },
            null,
        );
    },
    MessageViewWithSessionCommon: (props: any) => {
        renderedMessageViewProps.push(props);
        return React.createElement(
            Pressable,
            {
                testID: props.onThinkingExpandedChange ? 'transcript-thinking-header' : `transcript-message-${props.message?.id ?? 'unknown'}`,
                onPress: props.onThinkingExpandedChange ? () => props.onThinkingExpandedChange(!(props.thinkingExpanded === true)) : undefined,
            },
            null,
        );
    },
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptMotionProvider', () => ({
    TranscriptMotionProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/transcript/motion/resolveTranscriptMotionConfig', () => ({
    resolveTranscriptMotionConfig: () => ({ preset: 'subtle', animateThinkingEnabled: true, animateToolExpandCollapseEnabled: true }),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
    TranscriptEnterWrapper: ({ children }: any) => React.createElement(React.Fragment, null, children),
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
    fireAndForget: (p: any) => p,
}));

vi.mock('@/sync/sync', async () =>
    (await import('@/dev/testkit/harness/chatListHarness')).createFlashListChatListSyncModuleMock({
        loadOlderMessages: vi.fn(),
        loadNewerMessages: vi.fn(),
    })
);

describe('ChatList (FlashList v2 local expansion scroll stability)', () => {
    it('does not auto-pin on content growth caused by a local tool group expansion', async () => {
        renderMode = 'tool';
        const { ChatList } = await import('./ChatList');

        const screen = await renderFlashListChatList(
            <ChatList session={flashListChatListHarnessState.sessionState} />,
        );

        await triggerFlashListChatListInitialFill({
            layoutHeight: 500,
            contentHeight: 1000,
        });

        scrollToOffsetSpy.mockClear();

        await act(async () => {
            await screen.pressByTestIdAsync('transcript-tool-calls-header');
        });

        await triggerFlashListChatListContentSizeChange(400, 1200);

        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
    });

    it('does not auto-pin on content growth caused by a local thinking expansion', async () => {
        renderMode = 'thinking';
        flashListChatListHarnessState.settingValues.transcriptGroupingMode = 'turns';
        flashListChatListHarnessState.sessionMessagesState = {
            messages: [{ kind: 'agent-text', id: 'thinking-1', localId: 'thinking-1-local', createdAt: 1, text: 'thinking', isThinking: true }],
            isLoaded: true,
        };

        const { ChatList } = await import('./ChatList');
        const screen = await renderFlashListChatList(
            <ChatList session={{ ...flashListChatListHarnessState.sessionState, thinking: true }} />,
        );

        await triggerFlashListChatListInitialFill({
            layoutHeight: 500,
            contentHeight: 1000,
        });

        scrollToOffsetSpy.mockClear();

        const turnProps = renderedTurnViewProps[renderedTurnViewProps.length - 1];
        expect(typeof turnProps?.setThinkingExpanded).toBe('function');

        await act(async () => {
            turnProps.setThinkingExpanded('thinking-1', true);
        });

        await triggerFlashListChatListContentSizeChange(400, 1180);

        expect(scrollToOffsetSpy).not.toHaveBeenCalled();
    });
});
