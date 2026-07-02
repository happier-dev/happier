import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios',
}));

let timestampDisplayMode = 'hover_web_hidden_mobile';
let copyButtonsVisible = false;

installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformState.os;
                },
                select: (values: Record<string, unknown>) =>
                    values?.[platformState.os] ?? values?.default,
            },
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'transcriptMessageTimestampDisplayMode') return timestampDisplayMode;
                    if (key === 'sessionThinkingDisplayMode') return 'inline';
                    if (key === 'sessionThinkingInlinePresentation') return 'summary';
                    if (key === 'sessionThinkingInlineChrome') return 'plain';
                    if (key === 'toolViewTimelineChromeMode') return 'cards';
                    return null;
                },
                useSessionForkSupportSource: () => null,
                useSessionWorkspacePath: () => null,
                useSessionMessagesById: () => ({}),
                useSessionMessagesReducerState: () => ({} as any),
            },
        });
    },
});

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props, props.children),
}));

vi.mock('@/components/sessions/transcript/messageCopyVisibility', () => ({
    shouldShowMessageCopyButton: () => copyButtonsVisible,
    shouldShowMessageSelectButton: () => copyButtonsVisible,
}));

vi.mock('@/components/sessions/transcript/structured/StructuredMessageBlock', () => ({
    StructuredMessageBlock: () => null,
    renderStructuredMessage: () => null,
}));

vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
    extractWorkspaceFileMentions: () => [],
}));

vi.mock('@/components/sessions/linkedFiles/LinkedWorkspaceFilesRow', () => ({
    LinkedWorkspaceFilesRow: () => null,
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
    ToolView: () => null,
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: () => null,
}));

vi.mock('@/components/sessions/transcript/thinking/ThinkingTimelineRow', () => ({
    ThinkingTimelineRow: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/attachments/messages/AttachmentsMessageRow', () => ({
    AttachmentsMessageRow: () => null,
}));

vi.mock('@/components/sessions/attachments/messages/AttachmentsInlineImages', () => ({
    AttachmentsInlineImages: () => null,
}));

vi.mock('@/components/sessions/media/SessionMediaInlineImages', () => ({
    SessionMediaInlineImages: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

describe('MessageView timestamps', () => {
    beforeEach(() => {
        platformState.os = 'web';
        timestampDisplayMode = 'hover_web_hidden_mobile';
        copyButtonsVisible = false;
        vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('legacy locale string');
        vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((() => ({
            format: () => 'May 19, 2026, 4:30 PM',
        })) as unknown as typeof Intl.DateTimeFormat);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        standardCleanup();
    });

    it('does not render message timestamps by default before web hover actions are visible', async () => {
        vi.resetModules();
        const { MessageView } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{ kind: 'user-text', id: 'm1', localId: 'local-1', createdAt: 1, text: 'hello' }}
            />,
        );

        expect(screen.findAllByTestId('transcript-message-timestamp:m1')).toHaveLength(0);
    });

    it('renders message timestamps with web hover actions in the default mode', async () => {
        copyButtonsVisible = true;
        vi.resetModules();
        const { MessageView } = await import('./MessageView');

        const userScreen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{ kind: 'user-text', id: 'u1', localId: 'local-u1', createdAt: 1, text: 'hello' }}
            />,
        );
        const agentScreen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{ kind: 'agent-text', id: 'a1', localId: 'local-a1', createdAt: 2, text: 'reply' }}
            />,
        );

        expect(userScreen.findByTestId('transcript-message-timestamp:u1')?.props.children).toBe('May 19, 2026, 4:30 PM');
        expect(agentScreen.findByTestId('transcript-message-timestamp:a1')?.props.children).toBe('May 19, 2026, 4:30 PM');
        expect(Intl.DateTimeFormat).toHaveBeenCalledWith(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        });
    });

    it('renders always-visible web timestamps after hover action space', async () => {
        timestampDisplayMode = 'always';
        copyButtonsVisible = false;
        vi.resetModules();
        const { MessageView } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{ kind: 'user-text', id: 'always-u1', localId: 'local-u1', createdAt: 1, text: 'hello' }}
            />,
        );

        const timestamp = screen.findByTestId('transcript-message-timestamp:always-u1');
        const row = screen.findByTestId('transcript-message-actions-row:always-u1');
        const actionContainer = screen.findByTestId('transcript-message-actions:always-u1');

        expect(timestamp?.props.children).toBe('May 19, 2026, 4:30 PM');
        expect(row?.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ flexDirection: 'row-reverse' })]));
        expect(actionContainer?.props.accessibilityElementsHidden).toBe(true);
    });

    it('does not render message timestamps in never mode even when actions are visible', async () => {
        timestampDisplayMode = 'never';
        copyButtonsVisible = true;
        vi.resetModules();
        const { MessageView } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{ kind: 'user-text', id: 'never-u1', localId: 'local-u1', createdAt: 1, text: 'hello' }}
            />,
        );

        expect(screen.findAllByTestId('transcript-message-timestamp:never-u1')).toHaveLength(0);
    });

    it('omits invalid message timestamps instead of throwing during render', async () => {
        timestampDisplayMode = 'always';
        vi.restoreAllMocks();
        vi.resetModules();
        const { MessageView } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{ kind: 'user-text', id: 'u1', localId: 'local-u1', createdAt: 1e100, text: 'hello' }}
            />,
        );

        expect(screen.findAllByTestId('transcript-message-timestamp:u1')).toHaveLength(0);
    });

    it('renders native message actions inline so text selection does not depend on long press', async () => {
        platformState.os = 'ios';
        timestampDisplayMode = 'hover_web_always_mobile';
        copyButtonsVisible = true;
        vi.resetModules();
        const { MessageView } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{ kind: 'user-text', id: 'native-u1', localId: 'local-u1', createdAt: 1, text: 'hello' }}
            />,
        );

        expect(screen.findByTestId('transcript-message-timestamp:native-u1')?.props.children).toBe('May 19, 2026, 4:30 PM');
        expect(screen.findByTestId('transcript-message-copy:native-u1')).toBeTruthy();
    });

    it('renders timestamps from parent-provided transcript session common', async () => {
        vi.resetModules();
        const { MessageViewWithSessionCommon } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageViewWithSessionCommon
                sessionId="s1"
                metadata={null}
                message={{ kind: 'user-text', id: 'parent-common-u1', localId: 'local-u1', createdAt: 1, text: 'hello' }}
                messageDisplayCommon={{
                    sessionThinkingDisplayMode: 'inline',
                    sessionThinkingInlineChrome: 'plain',
                    sessionThinkingInlinePresentation: 'summary',
                    transcriptMessageTimestampDisplayMode: 'always',
                    transcriptMessageSelectionEnabled: false,
                    transcriptMessageSendToSessionEnabled: false,
                    transcriptStreamingMarkdownRenderingEnabled: false,
                    transcriptStreamingPartialOutputEnabled: true,
                    transcriptStreamingSettleDelayMs: 0,
                    transcriptStreamingSmoothingEnabled: false,
                    workspacePath: null,
                }}
                forkCommon={{
                    executionRunsEnabled: false,
                    sessionForkSupportSource: null,
                    sessionReplayEnabled: false,
                    sessionReplayMaxSeedChars: 120_000,
                    sessionReplayStrategy: 'recent_messages',
                    sessionReplaySummaryRunnerV1: null,
                }}
                toolChromeCommon={{
                    toolViewTimelineChromeMode: 'cards',
                    transcriptToolCallsCollapsedPreviewCount: 1,
                    transcriptToolCallsGroupShowBackground: false,
                }}
                toolRouteCommon={{
                    messagesById: {},
                    reducerState: null,
                }}
            />,
        );

        expect(screen.findByTestId('transcript-message-timestamp:parent-common-u1')?.props.children).toBe('May 19, 2026, 4:30 PM');
    });
});
