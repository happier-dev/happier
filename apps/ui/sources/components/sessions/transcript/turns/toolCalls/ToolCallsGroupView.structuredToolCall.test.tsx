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

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'toolViewTimelineChromeMode') return toolChromeMode;
        if (key === 'transcriptToolCallsCollapsedPreviewCount') return collapsedPreviewCount;
        if (key === 'transcriptToolCallsGroupShowBackground') return false;
        return null;
    },
    useSessionMessagesById: () => ({}),
    useSessionMessagesReducerState: () => null,
}));

let toolChromeMode: 'cards' | 'activity_feed' = 'cards';
let collapsedPreviewCount = 0;

const renderedMessageViews: any[] = [];

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
    ToolTimelineRow: () => React.createElement('ToolTimelineRow'),
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
    return {
        kind: 'tool-call',
        id: 'tool-msg-1',
        localId: null,
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
    };
}

describe('ToolCallsGroupView (structured tool-call rendering)', () => {
    it('renders grouped expanded tool rows through MessageView so structured meta is preserved', async () => {
        renderedMessageViews.length = 0;
        toolChromeMode = 'cards';
        collapsedPreviewCount = 0;
        const { ToolCallsGroupView } = await import('./ToolCallsGroupView');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                <ToolCallsGroupView
                    id="toolCalls:1"
                    status="completed"
                    toolMessages={[makeStructuredReviewToolMessage()]}
                    metadata={null}
                    sessionId="s1"
                    expanded
                    setExpanded={vi.fn()}
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />,
            );
        });

        expect(tree!.root.findAllByType('MessageView' as any)).toHaveLength(1);
        expect(renderedMessageViews).toHaveLength(1);
        expect(renderedMessageViews[0]?.message?.id).toBe('tool-msg-1');
        expect(renderedMessageViews[0]?.message?.meta?.happier?.kind).toBe('review_findings.v1');
    });

    it('preserves structured review messages in activity feed mode too', async () => {
        renderedMessageViews.length = 0;
        toolChromeMode = 'activity_feed';
        collapsedPreviewCount = 0;
        const { ToolCallsGroupView } = await import('./ToolCallsGroupView');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                <ToolCallsGroupView
                    id="toolCalls:1"
                    status="completed"
                    toolMessages={[makeStructuredReviewToolMessage()]}
                    metadata={null}
                    sessionId="s1"
                    expanded
                    setExpanded={vi.fn()}
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />,
            );
        });

        expect(tree!.root.findAllByType('MessageView' as any)).toHaveLength(1);
        expect(tree!.root.findAllByType('ToolTimelineRow' as any)).toHaveLength(0);
        expect(renderedMessageViews).toHaveLength(1);
        expect(renderedMessageViews[0]?.message?.meta?.happier?.kind).toBe('review_findings.v1');
    });

    it('renders collapsed SubAgentRun previews through MessageView in activity feed mode', async () => {
        renderedMessageViews.length = 0;
        toolChromeMode = 'activity_feed';
        collapsedPreviewCount = 1;
        const { ToolCallsGroupView } = await import('./ToolCallsGroupView');

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                <ToolCallsGroupView
                    id="toolCalls:1"
                    status="completed"
                    toolMessages={[
                        {
                            ...makeStructuredReviewToolMessage(),
                            meta: undefined,
                            tool: {
                                ...makeStructuredReviewToolMessage().tool,
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
                        },
                    ]}
                    metadata={null}
                    sessionId="s1"
                    expanded={false}
                    setExpanded={vi.fn()}
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />,
            );
        });

        expect(tree!.root.findAllByType('MessageView' as any)).toHaveLength(1);
        expect(tree!.root.findAllByType('ToolTimelineRow' as any)).toHaveLength(0);
        expect(renderedMessageViews[0]?.message?.tool?.name).toBe('SubAgentRun');
    });
});
