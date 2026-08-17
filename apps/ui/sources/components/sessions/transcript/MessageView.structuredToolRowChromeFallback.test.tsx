import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPartialStorageModuleMock, renderScreen, standardCleanup } from '@/dev/testkit';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createReducer } from '@/sync/reducer/reducer';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

const renderedToolTimelineRowProps: any[] = [];

installMessageViewCommonModuleMocks({
    reactNative: async () =>
        createReactNativeWebMock({
            Dimensions: {
                get: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
            View: 'View',
            Text: 'Text',
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    storage: async (importOriginal) =>
        await createPartialStorageModuleMock(importOriginal, {
            useSetting: (key: string) => {
                if (key === 'sessionThinkingDisplayMode') return 'inline';
                // Structured cards only replace the tool chrome in the activity feed.
                if (key === 'toolViewTimelineChromeMode') return 'activity_feed';
                return null;
            },
            useSession: () => null,
            useSessionMessagesById: () => ({}),
            useSessionMessagesReducerState: () => createReducer(),
        }),
});

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
    ToolView: (props: any) => React.createElement('ToolView', props),
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: (props: any) => {
        renderedToolTimelineRowProps.push(props);
        return React.createElement('ToolTimelineRow', props);
    },
}));

vi.mock('@/components/sessions/transcript/transcriptRowActionVisibility', () => ({
    shouldShowTranscriptRowActions: () => false,
    shouldShowTranscriptRowPinAction: () => false,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        submitMessage: vi.fn(),
    },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/utils/sessions/discardedCommittedMessages', () => ({
    isCommittedMessageDiscarded: () => false,
}));

vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
    extractWorkspaceFileMentions: () => [],
}));

vi.mock('@/components/sessions/transcript/references/StructuredReferencesRow', () => ({
    StructuredReferencesRow: () => null,
}));

function createToolCallMessage(meta: unknown): any {
    return {
        kind: 'tool-call',
        id: 'm1',
        localId: null,
        realID: 'server-m1',
        createdAt: 1,
        seq: 11,
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
    };
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

async function renderToolRow(message: any) {
    const { MessageView } = await import('./MessageView');
    return renderScreen(<MessageView message={message} metadata={null} sessionId="s1" />);
}

describe('MessageView tool row with a structured envelope', () => {
    afterEach(() => {
        renderedToolTimelineRowProps.length = 0;
        standardCleanup();
    });

    it('keeps the tool chrome when the structured card paints nothing', async () => {
        const screen = await renderToolRow(EMPTY_STRUCTURED_TOOL_MESSAGE);

        // The defect: the structured element exists but paints nothing, so the row
        // reserves height and renders an empty box.
        expect(JSON.stringify(screen.tree.toJSON() ?? '')).not.toContain('MarkdownView');
        expect(renderedToolTimelineRowProps).toHaveLength(1);
    });

    it('still replaces the tool chrome when the structured card paints', async () => {
        const screen = await renderToolRow(PAINTING_STRUCTURED_TOOL_MESSAGE);

        expect(renderedToolTimelineRowProps).toHaveLength(0);
        expect(JSON.stringify(screen.tree.toJSON() ?? '')).toContain('because it re-renders');
    });
});
