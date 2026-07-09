import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createToolCallMessageFixture, renderScreen } from '@/dev/testkit';
import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { createReducer } from '@/sync/reducer/reducer';
import { installToolCallsGroupViewCommonModuleMocks } from './toolCallsGroupViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let collapsedPreviewCount = 1;

installToolCallsGroupViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios', select: (values: any) => values?.ios ?? values?.default ?? null },
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'toolViewTimelineChromeMode') return 'activity_feed';
                    if (key === 'transcriptToolCallsCollapsedPreviewCount') return collapsedPreviewCount;
                    if (key === 'transcriptToolCallsGroupShowBackground') return false;
                    return null;
                },
                useSessionMessagesById: () => ({}),
                useSessionMessagesReducerState: () => createReducer(),
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
});

const renderedMessageViews: any[] = [];
const ensureSidechainsLoadedCalls: any[] = [];

vi.mock('@/components/sessions/transcript/MessageView', () => ({
    MessageView: (props: any) => {
        renderedMessageViews.push(props);
        return React.createElement('MessageView', props);
    },
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: (props: any) => React.createElement('ToolTimelineRow', props),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
    TranscriptEnterWrapper: (props: any) => React.createElement('TranscriptEnterWrapper', props, props.children),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptCollapsible', () => ({
    TranscriptCollapsible: (props: any) => React.createElement('TranscriptCollapsible', props, props.expanded ? props.children : null),
}));

vi.mock('@/hooks/session/useEnsureSidechainsLoaded', () => ({
    useEnsureSidechainsLoaded: (params: any) => {
        ensureSidechainsLoadedCalls.push(params);
    },
}));

function makeRunningReviewSubAgentMessage(): ToolCallMessage {
    return createToolCallMessageFixture({
        id: 'tool-msg-1',
        createdAt: 1,
        tool: {
            id: 'subagent_run_1',
            name: 'SubAgentRun',
            state: 'running',
            input: { intent: 'review' },
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: 'Review the workspace',
        },
        children: [
            {
                kind: 'agent-text',
                id: 'child-msg-1',
                localId: null,
                createdAt: 2,
                text: 'Inspecting the workspace now.',
            } as any,
        ],
    });
}

function makeChildlessRunningReviewSubAgentMessage(): ToolCallMessage {
    return createToolCallMessageFixture({
        id: 'tool-msg-2',
        createdAt: 1,
        tool: {
            id: 'subagent_run_2',
            name: 'SubAgentRun',
            state: 'running',
            input: { intent: 'review' },
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: 'Review the workspace',
        },
        children: [],
    });
}

describe('ToolCallsGroupView (subagent preview rendering)', () => {
    it('does not load preview sidechains when tool navigation is disabled', async () => {
        ensureSidechainsLoadedCalls.length = 0;
        collapsedPreviewCount = 1;
        const { ToolCallsGroupView } = await import('./ToolCallsGroupView');

        await renderScreen(React.createElement(ToolCallsGroupView, {
            id: 'toolCalls:read-only',
            status: 'running',
            toolMessages: [makeChildlessRunningReviewSubAgentMessage()],
            metadata: null,
            sessionId: 'child-session',
            expanded: false,
            setExpanded: vi.fn(),
            interaction: {
                canSendMessages: false,
                canApprovePermissions: false,
                permissionDisabledReason: 'readOnly',
                disableToolNavigation: true,
            },
        }));

        expect(ensureSidechainsLoadedCalls).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    enabled: false,
                    sessionId: 'child-session',
                }),
            ]),
        );
    });

    it('renders collapsed running review subagents through ToolTimelineRow in activity feed mode', async () => {
        renderedMessageViews.length = 0;
        ensureSidechainsLoadedCalls.length = 0;
        collapsedPreviewCount = 1;
        const { ToolCallsGroupView } = await import('./ToolCallsGroupView');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(React.createElement(ToolCallsGroupView, {
                id: 'toolCalls:1',
                status: 'running',
                toolMessages: [makeRunningReviewSubAgentMessage()],
                metadata: null,
                sessionId: 's1',
                expanded: false,
                setExpanded: vi.fn(),
                interaction: { canSendMessages: true, canApprovePermissions: true },
            }))).tree;

        expect(tree!.findAllByType('MessageView' as any)).toHaveLength(0);
        const toolTimelineRows = tree!.findAllByType('ToolTimelineRow' as any);
        expect(toolTimelineRows).toHaveLength(1);
        expect(toolTimelineRows[0]?.props.tool?.name).toBe('SubAgentRun');
        expect(toolTimelineRows[0]?.props.messages?.[0]?.text).toBe('Inspecting the workspace now.');
        expect(renderedMessageViews).toHaveLength(0);
    });

    it('falls back to ToolTimelineRow for collapsed running review subagents before transcript content arrives', async () => {
        renderedMessageViews.length = 0;
        collapsedPreviewCount = 1;
        const { ToolCallsGroupView } = await import('./ToolCallsGroupView');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(React.createElement(ToolCallsGroupView, {
                id: 'toolCalls:2',
                status: 'running',
                toolMessages: [makeChildlessRunningReviewSubAgentMessage()],
                metadata: null,
                sessionId: 's1',
                expanded: false,
                setExpanded: vi.fn(),
                interaction: { canSendMessages: true, canApprovePermissions: true },
            }))).tree;

        expect(tree!.findAllByType('MessageView' as any)).toHaveLength(0);
        expect(tree!.findAllByType('ToolTimelineRow' as any)).toHaveLength(1);
    });
});
