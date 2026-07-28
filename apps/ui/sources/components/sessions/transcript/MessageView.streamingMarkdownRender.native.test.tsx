import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type { AgentTextMessage } from '@/sync/domains/messages/messageTypes';
import type {
    TranscriptForkCommon,
    TranscriptMessageDisplayCommon,
    TranscriptToolChromeCommon,
    TranscriptToolRouteCommon,
} from './transcriptSessionCommon';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (values: Record<string, unknown>) => values?.ios ?? values?.native ?? values?.default,
            },
            View: 'View',
            Text: 'Text',
            Pressable: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
                React.createElement('Pressable', props, children),
            ActivityIndicator: 'ActivityIndicator',
            Dimensions: {
                get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    text: {
                        primary: '#f4f4f4',
                    },
                },
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { push: vi.fn() } }).module;
    },
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/sync/sync', () => ({ sync: { submitMessage: vi.fn(), sendMessage: vi.fn() } }));
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('Text', props, props.children),
}));
vi.mock('@/components/tools/shell/views/ToolView', () => ({ ToolView: () => React.createElement('ToolView') }));
vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: () => React.createElement('ToolTimelineRow'),
}));
vi.mock('@/components/sessions/transcript/structured/StructuredMessageBlock', () => ({
    renderStructuredMessage: () => null,
    StructuredMessageBlock: () => React.createElement('StructuredMessageBlock'),
}));
vi.mock('@/components/sessions/transcript/messageCopyVisibility', () => ({ shouldShowMessageCopyButton: () => false }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/utils/sessions/discardedCommittedMessages', () => ({ isCommittedMessageDiscarded: () => false }));
vi.mock('@/utils/url/sessionFileDeepLink', () => ({ buildSessionFileDeepLink: () => '' }));
vi.mock('@/utils/system/fireAndForget', () => ({ fireAndForget: (promise: Promise<unknown>) => promise }));
vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
    extractWorkspaceFileMentions: () => [],
}));
vi.mock('@/components/sessions/linkedFiles/LinkedWorkspaceFilesRow', () => ({
    LinkedWorkspaceFilesRow: () => React.createElement('LinkedWorkspaceFilesRow'),
}));
vi.mock('@/components/sessions/transcript/motion/TranscriptMotionContext', () => ({
    useTranscriptMotion: () => ({
        config: {
            preset: 'subtle',
            freshnessMs: 60_000,
            animateNewItemsEnabled: true,
            animateToolExpandCollapseEnabled: true,
            animateToolExpandCollapseFreshOnly: true,
            animateThinkingEnabled: true,
        },
    }),
}));
vi.mock('@/components/sessions/transcript/thinking/ThinkingTimelineRow', () => ({
    ThinkingTimelineRow: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('ThinkingTimelineRow', props, props.children),
}));
vi.mock('@/sync/ops', () => ({ forkSession: vi.fn() }));
vi.mock('@/sync/domains/sessionFork/forkUiSupport', () => ({ canForkFromMessage: () => false }));
vi.mock('@/sync/domains/sessionFork/forkFromMessageSemantics', () => ({ resolveForkFromMessageSemantics: () => null }));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({ executeAction: vi.fn() }),
}));
vi.mock('@/sync/ops/sessionMachineTarget', () => ({ readMachineTargetForSession: () => null }));
vi.mock('@/utils/ui/clipboard', () => ({ setClipboardStringSafe: vi.fn(async () => true) }));

const streamingMeta = {
    happierStreamSegmentV1: {
        v: 1,
        segmentKind: 'assistant',
        segmentLocalId: 'assistant-segment-1',
        segmentState: 'streaming',
        startedAtMs: 1_000,
        updatedAtMs: 1_000,
    },
} satisfies AgentTextMessage['meta'];

function createAgentMessage(text: string): AgentTextMessage {
    return {
        kind: 'agent-text',
        id: 'm1',
        localId: 'assistant-segment-1',
        createdAt: 1,
        text,
        isThinking: false,
        meta: streamingMeta,
    };
}

const messageDisplayCommon = {
    sessionThinkingDisplayMode: 'inline',
    sessionThinkingInlineChrome: 'plain',
    sessionThinkingInlinePresentation: 'summary',
    transcriptMessageTimestampDisplayMode: 'never',
    transcriptStreamingMarkdownRenderingEnabled: true,
    transcriptStreamingPartialOutputEnabled: true,
    transcriptStreamingSettleDelayMs: 200,
    transcriptStreamingSmoothingEnabled: true,
    transcriptMessageSelectionEnabled: true,
    transcriptMessageSendToSessionEnabled: false,
    debugInformationEnabled: false,
    workspacePath: null,
} satisfies TranscriptMessageDisplayCommon;

const forkCommon = {
    executionRunsEnabled: false,
    sessionForkSupportSource: null,
    sessionReplayEnabled: false,
    sessionReplayMaxSeedChars: 120_000,
    sessionReplayStrategy: 'recent_messages',
    sessionReplaySummaryRunnerV1: null,
} satisfies TranscriptForkCommon;

const toolChromeCommon = {
    toolViewTimelineChromeMode: 'cards',
    transcriptToolCallsCollapsedPreviewCount: 1,
    transcriptToolCallsGroupShowBackground: false,
} satisfies TranscriptToolChromeCommon;

const toolRouteCommon = {
    messagesById: {},
    reducerState: null,
} satisfies TranscriptToolRouteCommon;

describe('MessageView native streaming Markdown render', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers({ now: new Date(0) });
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    it('feeds active assistant streaming updates through one real native Markdown renderer', async () => {
        const { MessageViewWithSessionCommon } = await import('./MessageView');
        const renderStreamingMessage = (message: AgentTextMessage) => (
            <MessageViewWithSessionCommon
                sessionId="s1"
                metadata={null}
                message={message}
                messageDisplayCommon={messageDisplayCommon}
                forkCommon={forkCommon}
                toolChromeCommon={toolChromeCommon}
                toolRouteCommon={toolRouteCommon}
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />
        );

        const screen = await renderScreen(renderStreamingMessage(createAgentMessage('Hello **wor')));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('transcript-streaming-plain:m1')).toBe(null);
        expect(screen.findAllByType('EnrichedMarkdownText')).toHaveLength(1);
        expect(screen.findByType('EnrichedMarkdownText').props.markdown).toBe('Hello **wor**');
        expect(screen.findByType('EnrichedMarkdownText').props.streamingAnimation).toBe(true);
        expect(screen.findAllByTestId('markdown-static-render-content')).toHaveLength(1);

        await act(async () => {
            await screen.update(renderStreamingMessage(createAgentMessage('Hello **world**')));
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        await act(async () => {
            vi.advanceTimersByTime(250);
        });
        await flushHookEffects({ cycles: 3, turns: 3 });

        const markdownRuns = screen.findAllByType('EnrichedMarkdownText').map((node) => node.props.markdown);
        expect(markdownRuns).toEqual(['Hello **world**']);
        expect(markdownRuns).not.toContain('Hello **wor');
        expect(screen.findByType('EnrichedMarkdownText').props.streamingAnimation).toBe(true);
        expect(screen.findAllByTestId('markdown-static-render-content')).toHaveLength(1);
        expect(screen.findByTestId('transcript-streaming-plain:m1')).toBe(null);
    });
});
