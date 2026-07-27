import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installMessageViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) =>
                params ? `${key}::${JSON.stringify(params)}` : key,
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: () => null,
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
    shouldShowMessageCopyButton: () => false,
    shouldShowMessageSelectButton: () => false,
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

vi.mock('@/components/sessions/sessionMedia/SessionMediaInlineImages', () => ({
    SessionMediaInlineImages: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

describe('MessageView unsupported-content rendering', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders the localized label for an unparsed user message instead of the raw fallback text', async () => {
        const { MessageView } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{
                    kind: 'user-text',
                    id: 'u1',
                    localId: 'local-u1',
                    createdAt: 1,
                    text: '[Unparsed user message]',
                    meta: { happierUnsupportedContentV1: 'unparsed-user-message' },
                }}
            />,
        );

        const markdownView = screen.findByType('MarkdownView' as any);
        expect(markdownView.props.markdown).toBe('transcript.unsupportedContent.unparsedUserMessage');
    });

    it('renders the localized label for an unparsed agent message instead of the raw fallback text', async () => {
        const { MessageView } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{
                    kind: 'agent-text',
                    id: 'a1',
                    localId: 'local-a1',
                    createdAt: 1,
                    text: '[Unparsed agent message]',
                    meta: { happierUnsupportedContentV1: 'unparsed-agent-message' },
                }}
            />,
        );

        const markdownView = screen.findByType('MarkdownView' as any);
        expect(markdownView.props.markdown).toBe('transcript.unsupportedContent.unparsedAgentMessage');
    });

    it('renders the localized label for unsupported agent output', async () => {
        const { MessageView } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{
                    kind: 'agent-text',
                    id: 'a2',
                    localId: 'local-a2',
                    createdAt: 1,
                    text: '[Unsupported agent output]',
                    meta: { happierUnsupportedContentV1: 'unsupported-agent-output' },
                }}
            />,
        );

        const markdownView = screen.findByType('MarkdownView' as any);
        expect(markdownView.props.markdown).toBe('transcript.unsupportedContent.unsupportedAgentOutput');
    });

    it('renders the localized label for an unsupported transcript record', async () => {
        const { MessageView } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{
                    kind: 'agent-text',
                    id: 'a3',
                    localId: 'local-a3',
                    createdAt: 1,
                    text: '[Unsupported transcript record]',
                    meta: { happierUnsupportedContentV1: 'unsupported-transcript-record' },
                }}
            />,
        );

        const markdownView = screen.findByType('MarkdownView' as any);
        expect(markdownView.props.markdown).toBe('transcript.unsupportedContent.unsupportedTranscriptRecord');
    });

    it('renders normal message text unaffected when no unsupported-content marker is present', async () => {
        const { MessageView } = await import('./MessageView');

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={{ kind: 'agent-text', id: 'a4', localId: 'local-a4', createdAt: 1, text: 'hello world' }}
            />,
        );

        const markdownView = screen.findByType('MarkdownView' as any);
        expect(markdownView.props.markdown).toBe('hello world');
    });
});
