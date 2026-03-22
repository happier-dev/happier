import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createExpoVectorIconsMock,
    createToolCallMessageFixture,
    renderToolCallsGroupView,
    standardCleanup,
} from '@/dev/testkit';
import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { createReducer } from '@/sync/reducer/reducer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                        Platform: { OS: 'ios', select: (values: any) => values?.ios ?? values?.default ?? null },
                    }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => createExpoVectorIconsMock());

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string) => key,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSetting: (key: string) => {
                if (key === 'toolViewTimelineChromeMode') return toolChromeMode;
                if (key === 'transcriptToolCallsCollapsedPreviewCount') return collapsedPreviewCount;
                if (key === 'transcriptToolCallsGroupShowBackground') return false;
                return null;
            },
            useSessionMessagesById: () => ({}),
            useSessionMessagesReducerState: () => createReducer(),
        },
    });
});

let toolChromeMode: 'cards' | 'activity_feed' = 'cards';
let collapsedPreviewCount = 0;

const renderedMessageViews: any[] = [];
const renderedToolTimelineRows: any[] = [];

vi.mock('@/components/sessions/transcript/MessageView', () => ({
    MessageView: (props: any) => {
        renderedMessageViews.push(props);
        return React.createElement('MessageView', props);
    },
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
    ToolView: () => React.createElement('ToolView'),
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: (props: any) => {
        renderedToolTimelineRows.push(props);
        return React.createElement('ToolTimelineRow', props);
    },
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
    TranscriptEnterWrapper: (props: any) => React.createElement('TranscriptEnterWrapper', props, props.children),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptCollapsible', () => ({
    TranscriptCollapsible: (props: any) => React.createElement('TranscriptCollapsible', props, props.expanded ? props.children : null),
}));

vi.mock('@/hooks/session/useEnsureSidechainsLoaded', () => ({
    useEnsureSidechainsLoaded: () => undefined,
}));

function makeStructuredReviewToolMessage(): ToolCallMessage {
    return createToolCallMessageFixture({
        id: 'tool-msg-1',
        createdAt: 1,
        tool: {
            id: 'subagent_run_1',
            name: 'SubAgentRun',
            state: 'completed',
            input: { intent: 'review' },
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: {
                status: 'succeeded',
                summary: 'No findings.',
                runId: 'run_1',
                callId: 'subagent_run_1',
                sidechainId: 'subagent_run_1',
                backendId: 'claude',
                intent: 'review',
                findingsDigest: {
                    total: 0,
                    items: [],
                },
            },
        },
        children: [],
        meta: {
            happier: {
                kind: 'review_findings.v1',
                payload: {
                    runRef: { runId: 'run_1', callId: 'subagent_run_1', backendId: 'claude' },
                    summary: 'No findings.',
                    findings: [],
                    generatedAtMs: 1,
                },
            },
        } as any,
    });
}

describe('ToolCallsGroupView (structured tool-call rendering)', () => {
    afterEach(standardCleanup);

    it('renders grouped expanded tool rows through MessageView so structured meta is preserved', async () => {
        renderedMessageViews.length = 0;
        renderedToolTimelineRows.length = 0;
        toolChromeMode = 'cards';
        collapsedPreviewCount = 0;
        await renderToolCallsGroupView({
            status: 'completed',
            toolMessages: [makeStructuredReviewToolMessage()],
            expanded: true,
        });

        expect(renderedMessageViews).toHaveLength(1);
        expect(renderedToolTimelineRows).toHaveLength(0);
        expect(renderedMessageViews[0]?.message?.id).toBe('tool-msg-1');
        expect(renderedMessageViews[0]?.message?.meta?.happier?.kind).toBe('review_findings.v1');
    });

    it('preserves structured review messages in activity feed mode too', async () => {
        renderedMessageViews.length = 0;
        renderedToolTimelineRows.length = 0;
        toolChromeMode = 'activity_feed';
        collapsedPreviewCount = 0;
        await renderToolCallsGroupView({
            status: 'completed',
            toolMessages: [makeStructuredReviewToolMessage()],
            expanded: true,
        });

        expect(renderedMessageViews).toHaveLength(1);
        expect(renderedToolTimelineRows).toHaveLength(0);
        expect(renderedMessageViews[0]?.message?.meta?.happier?.kind).toBe('review_findings.v1');
    });

    it('renders collapsed SubAgentRun previews through MessageView in activity feed mode', async () => {
        renderedMessageViews.length = 0;
        renderedToolTimelineRows.length = 0;
        toolChromeMode = 'activity_feed';
        collapsedPreviewCount = 1;
        const baseMessage = makeStructuredReviewToolMessage();
        const collapsedPreviewMessage: ToolCallMessage = {
            ...baseMessage,
            meta: undefined,
            tool: {
                ...baseMessage.tool,
                state: 'running',
                completedAt: null,
                result: undefined,
            },
            children: [
                {
                    kind: 'agent-text',
                    id: 'child-1',
                    localId: null,
                    createdAt: 2,
                    text: 'Inspecting the workspace now.',
                } as any,
            ],
        };

        await renderToolCallsGroupView({
            status: 'completed',
            toolMessages: [collapsedPreviewMessage],
            expanded: false,
        });

        expect(renderedMessageViews).toHaveLength(1);
        expect(renderedToolTimelineRows).toHaveLength(0);
        expect(renderedMessageViews[0]?.message?.tool?.name).toBe('SubAgentRun');
    });
});
