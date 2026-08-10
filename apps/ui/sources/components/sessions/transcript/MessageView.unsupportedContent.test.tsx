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

// Developer diagnostics are enabled by a dev build or the `devModeEnabled` local setting. Tests run
// with `__DEV__` fixed to true by the Vitest config, so drive the decision through its owner.
const debugState = vi.hoisted(() => ({ enabled: true }));

vi.mock('@/components/sessions/debug/sessionDebugInformation', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/sessions/debug/sessionDebugInformation')>();
    return { ...actual, isSessionDebugInformationEnabled: () => debugState.enabled };
});

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props, props.children),
}));

// `messageCopyVisibility` is internal domain logic, not a boundary: it is a pure function of the row's
// platform/hover/selection input. The real owner runs here, so this file cannot drift away from its
// export names again. Under the Vitest React Native stub `Platform.OS` is `'node'` — a non-web,
// hoverless platform — so the row actions are revealed for every row, which is what the copy/select
// assertions below need.

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

const setClipboardStringSafeMock = vi.fn(async (_text: string) => true);
vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: (text: string) => setClipboardStringSafeMock(text),
}));

vi.mock('@/components/sessions/transcript/messageSelection/SelectMessageButton', () => ({
    SelectMessageButton: (props: any) => React.createElement('SelectMessageButton', props),
}));

describe('MessageView unsupported-content rendering', () => {
    beforeEach(() => {
        vi.resetModules();
        debugState.enabled = true;
    });

    afterEach(() => {
        standardCleanup();
    });

    describe('with developer diagnostics enabled', () => {
        it.each([
            ['unparsed user message', 'user-text', '[Unparsed user message]', 'unparsed-user-message'],
            ['unparsed agent message', 'agent-text', '[Unparsed agent message]', 'unparsed-agent-message'],
            ['unsupported agent output', 'agent-text', '[Unsupported agent output: future-type]', 'unsupported-agent-output'],
            ['unsupported transcript record', 'agent-text', '[Unsupported transcript record]', 'unsupported-transcript-record'],
        ] as const)('keeps the raw diagnostic text for an %s', async (_name, kind, rawText, marker) => {
            const { MessageView } = await import('./MessageView');

            const screen = await renderScreen(
                <MessageView
                    sessionId="s1"
                    metadata={null}
                    message={{
                        kind,
                        id: 'd1',
                        localId: 'local-d1',
                        createdAt: 1,
                        text: rawText,
                        meta: { happierUnsupportedContentV1: marker },
                    } as any}
                />,
            );

            const markdownView = screen.findByType('MarkdownView' as any);
            expect(markdownView.props.markdown).toBe(rawText);
        });

        it('copies the raw diagnostic so the offending payload type can be reported', async () => {
            setClipboardStringSafeMock.mockClear();
            const { MessageView } = await import('./MessageView');

            const screen = await renderScreen(
                <MessageView
                    sessionId="s1"
                    metadata={null}
                    message={{
                        kind: 'agent-text',
                        id: 'a5',
                        localId: 'local-a5',
                        createdAt: 1,
                        text: '[Unsupported agent output: future-type]',
                        meta: { happierUnsupportedContentV1: 'unsupported-agent-output' },
                    }}
                />,
            );

            await screen.pressByTestIdAsync('transcript-message-copy:a5');
            expect(setClipboardStringSafeMock).toHaveBeenCalledWith('[Unsupported agent output: future-type]');
        });
    });

    describe('with developer diagnostics disabled', () => {
        beforeEach(() => {
            debugState.enabled = false;
        });

        it.each([
            ['unparsed agent message', '[Unparsed agent message]', 'unparsed-agent-message'],
            ['unsupported agent output', '[Unsupported agent output: future-type]', 'unsupported-agent-output'],
            ['unsupported transcript record', '[Unsupported transcript record]', 'unsupported-transcript-record'],
        ] as const)('renders no transcript row for an %s', async (_name, rawText, marker) => {
            const { MessageView } = await import('./MessageView');

            const screen = await renderScreen(
                <MessageView
                    sessionId="s1"
                    metadata={null}
                    message={{
                        kind: 'agent-text',
                        id: 'h1',
                        localId: 'local-h1',
                        createdAt: 1,
                        text: rawText,
                        meta: { happierUnsupportedContentV1: marker },
                    }}
                />,
            );

            expect(screen.findAllByType('MarkdownView' as any)).toHaveLength(0);
        });

        it('keeps a localized placeholder for the user own unparsed message instead of dropping it', async () => {
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

        it('does not leak the raw fallback text into select-preview/copy text for the user own message', async () => {
            setClipboardStringSafeMock.mockClear();
            const { MessageView } = await import('./MessageView');

            const screen = await renderScreen(
                <MessageView
                    sessionId="s1"
                    metadata={null}
                    message={{
                        kind: 'user-text',
                        id: 'u2',
                        localId: 'local-u2',
                        createdAt: 1,
                        text: '[Unparsed user message]',
                        meta: { happierUnsupportedContentV1: 'unparsed-user-message' },
                    }}
                />,
            );

            const selectButton = screen.findByTestId('transcript-message-select:u2');
            expect(selectButton?.props.previewText).toBe('transcript.unsupportedContent.unparsedUserMessage');

            await screen.pressByTestIdAsync('transcript-message-copy:u2');
            expect(setClipboardStringSafeMock).toHaveBeenCalledWith('transcript.unsupportedContent.unparsedUserMessage');
        });
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

    it.each([
        ['[Unparsed user message]', undefined],
        ['[Unparsed agent message]', undefined],
        ['[Unsupported agent output]', { happierUnsupportedContentV1: 'not-a-real-kind' }],
        ['[Unsupported transcript record]', { happierUnsupportedContentV1: 42 }],
    ] as const)(
        'renders the literal raw placeholder text %s unchanged when the meta marker is absent or malformed (no string-sniffing)',
        async (rawText, meta) => {
            debugState.enabled = false;
            const { MessageView } = await import('./MessageView');

            const screen = await renderScreen(
                <MessageView
                    sessionId="s1"
                    metadata={null}
                    message={{ kind: 'agent-text', id: 'legacy', localId: 'local-legacy', createdAt: 1, text: rawText, meta }}
                />,
            );

            const markdownView = screen.findByType('MarkdownView' as any);
            expect(markdownView.props.markdown).toBe(rawText);
        },
    );
});
