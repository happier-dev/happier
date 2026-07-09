import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import type { AgentTextMessage, UserTextMessage } from '@/sync/domains/messages/messageTypes';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toggleMessagePinSpy = vi.fn<(pin: PersistedSessionMessagePinV1) => void>();

installMessageViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        const { createReducer } = await import('@/sync/reducer/reducer');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'transcriptMessageTimestampDisplayMode') return 'never';
                    if (key === 'sessionThinkingDisplayMode') return 'inline';
                    if (key === 'sessionThinkingInlinePresentation') return 'summary';
                    if (key === 'sessionThinkingInlineChrome') return 'plain';
                    if (key === 'toolViewTimelineChromeMode') return 'cards';
                    return null;
                },
                useSessionForkSupportSource: () => null,
                useSessionWorkspacePath: () => null,
                useSessionMessagesById: () => ({}),
                useSessionMessagesReducerState: () => createReducer(),
            },
        });
    },
});

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('MarkdownView', props, props.children),
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
    ThinkingTimelineRow: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/attachments/messages/AttachmentsMessageRow', () => ({
    AttachmentsMessageRow: () => null,
}));

vi.mock('@/components/sessions/sessionMedia/SessionMediaInlineImages', () => ({
    SessionMediaInlineImages: () => null,
}));

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

describe('MessageView message pin button', () => {
    beforeEach(() => {
        toggleMessagePinSpy.mockReset();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders a user-message pin action from message identity facts and routes the callback', async () => {
        const { MessageView } = await import('./MessageView');
        const message: UserTextMessage = {
            kind: 'user-text',
            id: 'u1',
            localId: 'local-u1',
            createdAt: 1,
            text: 'hello',
            seq: 7,
            transcriptBlockIndex: 0,
        };

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={message}
                messagePins={[]}
                onToggleMessagePin={toggleMessagePinSpy}
            />,
        );

        const pinButton = screen.findByTestId('transcript-message-pin:u1');
        expect(pinButton?.props.accessibilityLabel).toBe('session.transcriptNavigation.pinMessageA11y');

        screen.pressByTestId('transcript-message-pin:u1');

        expect(toggleMessagePinSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1',
            seq: 7,
            transcriptBlockIndex: 0,
            routeMessageId: 'local:local-u1',
            role: 'user',
        }));
    });

    it('renders an assistant unpin action when an existing pin matches the row identity', async () => {
        const { MessageView } = await import('./MessageView');
        const message: AgentTextMessage = {
            kind: 'agent-text',
            id: 'a1',
            localId: 'local-a1',
            createdAt: 1,
            text: 'reply',
            seq: 8,
            transcriptBlockIndex: 1,
        };
        const pin: PersistedSessionMessagePinV1 = {
            version: 1,
            sessionId: 's1',
            seq: 8,
            transcriptBlockIndex: 1,
            routeMessageId: 'local:local-a1',
            role: 'assistant',
            pinnedAtMs: 1_000,
            label: null,
        };

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={message}
                messagePins={[pin]}
                onToggleMessagePin={toggleMessagePinSpy}
            />,
        );

        expect(screen.findByTestId('transcript-message-pin:a1')?.props.accessibilityLabel).toBe('session.transcriptNavigation.unpinMessageA11y');
    });
});
