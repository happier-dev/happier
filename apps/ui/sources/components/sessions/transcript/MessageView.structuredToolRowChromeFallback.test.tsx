import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
                    if (key === 'sessionThinkingDisplayMode') return 'inline';
                    // Structured cards only replace the tool chrome in the activity feed.
                    if (key === 'toolViewTimelineChromeMode') return 'activity_feed';
                    return null;
                },
                useSession: () => null,
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

vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
    extractWorkspaceFileMentions: () => [],
}));

vi.mock('@/components/sessions/transcript/references/StructuredReferencesRow', () => ({
    StructuredReferencesRow: () => null,
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
    ToolView: (props: Record<string, unknown>) =>
        React.createElement('ToolView', { ...props, testID: 'tool-chrome-cards' }),
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: (props: Record<string, unknown>) =>
        React.createElement('ToolTimelineRow', { ...props, testID: 'tool-chrome-feed' }),
}));

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

function createToolCallMessage(meta: unknown): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: 'm1',
        localId: 'local-m1',
        realID: 'server-m1',
        createdAt: 1,
        seq: 11,
        transcriptBlockIndex: 3,
        meta,
        tool: {
            name: 'read',
            state: 'completed',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: {},
        },
        children: [],
    } as unknown as ToolCallMessage;
}

// A tool-call message that carries a subagent_launch envelope: the registry card only
// paints for `user-text` messages, so on a tool call it renders nothing at all.
const EMPTY_STRUCTURED_TOOL_MESSAGE = createToolCallMessage({
    happier: {
        kind: 'subagent_launch.v1',
        payload: {
            kind: 'agent_team_member_create',
            teamId: 'team_1',
            memberLabel: 'alpha',
            instructions: 'Handle the linting lane',
            runInBackground: true,
        },
    },
});

// Control: a structured envelope whose card always paints. The chrome must stay
// suppressed here, otherwise the row would render the card *and* the tool chrome.
const PAINTING_STRUCTURED_TOOL_MESSAGE = createToolCallMessage({
    happier: {
        kind: 'review_follow_up.v1',
        payload: {
            parentRunRef: { runId: 'r1', callId: 'c1', backendId: 'b1' },
            threadId: 't1',
            requestMarkdown: 'why is this slow',
            answerMarkdown: 'because it re-renders',
            generatedAtMs: 1,
        },
    },
});

async function renderToolRow(message: ToolCallMessage) {
    const { MessageView } = await import('./MessageView');
    return renderScreen(
        <MessageView
            sessionId="s1"
            metadata={null}
            message={message}
            messagePins={[]}
        />,
    );
}

describe('MessageView tool row with a structured envelope', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('keeps the tool chrome when the structured card paints nothing', async () => {
        const screen = await renderToolRow(EMPTY_STRUCTURED_TOOL_MESSAGE);

        // The defect: the structured element exists but paints nothing, so the row
        // reserves height and renders an empty box.
        expect(JSON.stringify(screen.tree.toJSON() ?? '')).not.toContain('MarkdownView');
        expect(screen.findAllByTestId('tool-chrome-feed')).toHaveLength(1);
    });

    it('still replaces the tool chrome when the structured card paints', async () => {
        const screen = await renderToolRow(PAINTING_STRUCTURED_TOOL_MESSAGE);

        expect(screen.findAllByTestId('tool-chrome-feed')).toHaveLength(0);
        expect(JSON.stringify(screen.tree.toJSON() ?? '')).toContain('because it re-renders');
    });
});
