import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return { ...rn, AppState: rn.AppState, Platform: { ...rn.Platform, OS: 'ios', select: (v: any) => v.ios } };
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
    useUnistyles: () => ({
        theme: {
            colors: {
                card: '#fff',
                text: '#000',
                textSecondary: '#666',
                textDestructive: '#c00',
                agentEventText: '#666',
                success: '#0a0',
                divider: '#ddd',
                surfacePressedOverlay: '#eee',
                input: { background: '#fafafa' },
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

let collapsedPreviewCount = 1;
vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'toolViewTimelineChromeMode') return 'activity_feed';
        if (key === 'transcriptToolCallsCollapsedPreviewCount') return collapsedPreviewCount;
        if (key === 'transcriptToolCallsGroupShowBackground') return false;
        return null;
    },
    useSessionMessagesById: () => ({}),
    useSessionMessagesReducerState: () => null,
}));

const renderedMessageViews: any[] = [];

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
    useEnsureSidechainsLoaded: () => undefined,
}));

function makeRunningReviewSubAgentMessage(): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: 'tool-msg-1',
        localId: null,
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
    };
}

function makeChildlessRunningReviewSubAgentMessage(): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: 'tool-msg-2',
        localId: null,
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
    };
}

describe('ToolCallsGroupView (subagent preview rendering)', () => {
    it('renders collapsed running review subagents through MessageView in activity feed mode', async () => {
        renderedMessageViews.length = 0;
        collapsedPreviewCount = 1;
        const { ToolCallsGroupView } = await import('./ToolCallsGroupView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(ToolCallsGroupView, {
                id: 'toolCalls:1',
                status: 'running',
                toolMessages: [makeRunningReviewSubAgentMessage()],
                metadata: null,
                sessionId: 's1',
                expanded: false,
                setExpanded: vi.fn(),
                interaction: { canSendMessages: true, canApprovePermissions: true },
            }));
        });

        expect(tree!.root.findAllByType('MessageView' as any)).toHaveLength(1);
        expect(tree!.root.findAllByType('ToolTimelineRow' as any)).toHaveLength(0);
        expect(renderedMessageViews[0]?.message?.tool?.name).toBe('SubAgentRun');
        expect(renderedMessageViews[0]?.message?.children?.[0]?.text).toBe('Inspecting the workspace now.');
    });

    it('falls back to ToolTimelineRow for collapsed running review subagents before transcript content arrives', async () => {
        renderedMessageViews.length = 0;
        collapsedPreviewCount = 1;
        const { ToolCallsGroupView } = await import('./ToolCallsGroupView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(ToolCallsGroupView, {
                id: 'toolCalls:2',
                status: 'running',
                toolMessages: [makeChildlessRunningReviewSubAgentMessage()],
                metadata: null,
                sessionId: 's1',
                expanded: false,
                setExpanded: vi.fn(),
                interaction: { canSendMessages: true, canApprovePermissions: true },
            }));
        });

        expect(tree!.root.findAllByType('MessageView' as any)).toHaveLength(0);
        expect(tree!.root.findAllByType('ToolTimelineRow' as any)).toHaveLength(1);
    });
});
