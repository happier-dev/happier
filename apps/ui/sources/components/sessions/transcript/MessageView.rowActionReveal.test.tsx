import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import type { ModeSwitchMessage, UserTextMessage } from '@/sync/domains/messages/messageTypes';
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
                    if (key === 'transcriptMessageTimestampDisplayMode') return 'hover_web_hidden_mobile';
                    if (key === 'sessionThinkingDisplayMode') return 'inline';
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

vi.mock('@/components/sessions/transcript/structured/StructuredMessageBlock', () => ({
    StructuredMessageBlock: () => null,
    renderStructuredMessage: () => null,
}));

vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
    extractWorkspaceFileMentions: () => [],
}));

vi.mock('@/components/sessions/transcript/references/StructuredReferencesRow', () => ({
    StructuredReferencesRow: () => null,
}));

vi.mock('@/components/sessions/transcript/events/TranscriptEventRow', () => ({
    TranscriptEventRow: () => React.createElement('TranscriptEventRow', { testID: 'transcript-event-row' }),
}));

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

function readOpacity(style: unknown): number | undefined {
    const opacity = flattenStyle(style).opacity;
    if (typeof opacity === 'number') return opacity;
    const animated = opacity as { __getValue?: () => number } | undefined;
    return typeof animated?.__getValue === 'function' ? animated.__getValue() : undefined;
}

const userMessage: UserTextMessage = {
    kind: 'user-text',
    id: 'u1',
    localId: 'local-u1',
    createdAt: 1,
    text: 'hello',
    seq: 7,
    transcriptBlockIndex: 0,
};

const existingPin: PersistedSessionMessagePinV1 = {
    version: 1,
    sessionId: 's1',
    seq: 7,
    transcriptBlockIndex: 0,
    routeMessageId: 'local:local-u1',
    role: 'user',
    pinnedAtMs: 10,
    label: null,
};

async function renderUserMessage(pins: readonly PersistedSessionMessagePinV1[] = []) {
    const { MessageView } = await import('./MessageView');
    return renderScreen(
        <MessageView
            sessionId="s1"
            metadata={null}
            message={userMessage}
            messagePins={pins}
            onToggleMessagePin={toggleMessagePinSpy}
        />,
    );
}

describe('MessageView row action reveal', () => {
    beforeEach(() => {
        toggleMessagePinSpy.mockReset();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('keeps an unpinned pin hidden on fine-pointer web without forcing the timestamp or the rest of the row visible', async () => {
        const screen = await renderUserMessage();

        expect(readOpacity(screen.findByTestId('transcript-message-pin-slot:u1')?.props.style)).toBe(0);
        expect(readOpacity(screen.findByTestId('transcript-message-actions:u1')?.props.style)).toBe(0);
        expect(screen.findAllByTestId('transcript-message-timestamp:u1')).toHaveLength(0);
        expect(flattenStyle(screen.findByTestId('transcript-message-actions-row:u1')?.props.style).pointerEvents)
            .toBe('box-none');
    });

    it('reveals the row actions when keyboard focus enters the action slot', async () => {
        const screen = await renderUserMessage();

        await act(async () => {
            screen.findByTestId('transcript-message-actions:u1')?.props.onFocus?.();
        });

        expect(readOpacity(screen.findByTestId('transcript-message-actions:u1')?.props.style)).toBe(1);
        expect(readOpacity(screen.findByTestId('transcript-message-pin-slot:u1')?.props.style)).toBe(1);

        await act(async () => {
            screen.findByTestId('transcript-message-actions:u1')?.props.onBlur?.();
        });

        expect(readOpacity(screen.findByTestId('transcript-message-actions:u1')?.props.style)).toBe(0);
    });

    it('keeps a pinned row pin visible while the rest of the row stays hidden', async () => {
        const screen = await renderUserMessage([existingPin]);

        expect(readOpacity(screen.findByTestId('transcript-message-pin-slot:u1')?.props.style)).toBe(1);
        expect(readOpacity(screen.findByTestId('transcript-message-actions:u1')?.props.style)).toBe(0);
        expect(screen.findAllByTestId('transcript-message-timestamp:u1')).toHaveLength(0);
        expect(screen.findByTestId('transcript-message-pin:u1')?.props.accessibilityLabel)
            .toBe('session.transcriptNavigation.unpinMessageA11y');
    });

    it('renders no pin for an agent event row', async () => {
        const { MessageView } = await import('./MessageView');
        const event: ModeSwitchMessage = {
            kind: 'agent-event',
            id: 'e1',
            createdAt: 1,
            seq: 9,
            transcriptBlockIndex: 0,
            event: { type: 'message', message: 'something happened' },
        };

        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={event}
                messagePins={[]}
                onToggleMessagePin={toggleMessagePinSpy}
                onToggleToolPin={toggleMessagePinSpy}
            />,
        );

        expect(screen.findByTestId('transcript-event-row')).toBeTruthy();
        expect(screen.findAllByTestId('transcript-message-pin:e1')).toHaveLength(0);
        expect(screen.findAllByTestId('transcript-tool-call-pin:e1')).toHaveLength(0);
    });
});
