import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { flattenTestStyle } from '@/dev/testkit/harness/popoverHarness';

import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installMessageViewCommonModuleMocks({
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        // A distinctive part radius proves the component reads the theme's part token, not a constant.
        return createUnistylesMock({ theme: { parts: { userBubble: { radius: 37 } }, transcript: { messageGap: 31 } } });
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (value: Record<string, unknown>) => value.web ?? value.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useSetting: () => null,
            useSession: () => null,
        });
    },
});

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
    ToolView: (props: any) => React.createElement('ToolView', props),
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: (props: any) => React.createElement('ToolTimelineRow', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props, props.children),
}));

vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
    extractWorkspaceFileMentions: () => [],
}));

vi.mock('@/components/sessions/transcript/references/StructuredReferencesRow', () => ({
    StructuredReferencesRow: () => null,
}));

vi.mock('@/utils/sessions/discardedCommittedMessages', () => ({
    isCommittedMessageDiscarded: () => false,
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/sync/sync', () => ({
    sync: { submitMessage: vi.fn(), sendMessage: vi.fn() },
}));

/** MessageView reads its session through the transcript source; a read-only source is the smallest real one. */
async function renderMessageView(MessageView: typeof import('./MessageView').MessageView, message: any) {
    const { SessionTranscriptSourceProvider } = await import('./source/SessionTranscriptSourceContext');
    const { createReadOnlySessionTranscriptSource } = await import('./source/readOnlySessionTranscriptSource');
    const source = createReadOnlySessionTranscriptSource({ sessionId: 's1', messages: [message], reducerState: null, metadata: null, agentState: null });
    return renderScreen(
        <SessionTranscriptSourceProvider source={source}>
            <MessageView message={message} metadata={{} as any} sessionId="s1" />
        </SessionTranscriptSourceProvider>,
    );
}

await import('./MessageView');

describe('MessageView (shrinkable transcript layout)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('keeps the message content wrapper shrinkable in constrained panes on web', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'user-text',
            localId: 'local-1',
            id: 'm1',
            text: 'hello',
        };

        const screen = await renderMessageView(MessageView, message);

        const markdown = screen.tree.root.findByType('MarkdownView');
        const messageContent = findAncestorWithStyle(markdown, (style) => {
            return style != null && typeof style === 'object' && 'maxWidth' in style && 'flexGrow' in style;
        });

        expect(flattenTestStyle(messageContent?.props?.style)).toEqual(
            expect.objectContaining({
                flexGrow: 1,
                flexBasis: 0,
                minWidth: 0,
            }),
        );
    });

    it('shapes the user bubble and message rhythm from the theme part and transcript tokens', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = { kind: 'user-text', localId: 'local-2', id: 'm2', text: 'hello' };

        const screen = await renderMessageView(MessageView, message);

        expect(findStyledNodes(screen.tree.root, 'borderRadius', 37).length).toBeGreaterThan(0);
        expect(findStyledNodes(screen.tree.root, 'paddingBottom', 31).length).toBeGreaterThan(0);
    });
});

function findAncestorWithStyle(
    node: { parent?: { parent?: unknown; props?: { style?: unknown } } | null } | null | undefined,
    predicate: (style: unknown) => boolean,
) {
    let current = node?.parent ?? null;
    while (current) {
        if (predicate(flattenTestStyle(current.props?.style))) return current;
        current = current.parent ?? null;
    }
    return null;
}

function findStyledNodes(root: { findAll: (predicate: (node: any) => boolean) => any[] }, key: string, value: unknown) {
    const flatten = (style: unknown): Record<string, unknown> => {
        if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
        return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
    };
    return root.findAll((node) => typeof node.type === 'string' && flatten(node.props?.style)[key] === value);
}
