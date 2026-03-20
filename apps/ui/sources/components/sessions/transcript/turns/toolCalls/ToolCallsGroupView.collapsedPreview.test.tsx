import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { ToolCallsGroupView } from './ToolCallsGroupView';

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
                surfacePressedOverlay: '#eee',
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

let collapsedPreviewCount: number = 1;
vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'toolViewTimelineChromeMode') return 'activity_feed';
        if (key === 'transcriptToolCallsCollapsedPreviewCount') return collapsedPreviewCount;
        return null;
    },
    useSessionMessagesById: () => ({}),
    useSessionMessagesReducerState: () => null,
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
    ToolView: () => null,
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: (props: any) => React.createElement('ToolTimelineRow', props),
}));

vi.mock('@/components/tools/shell/views/timeline/ToolTimelinePreviewRow', () => ({
    ToolTimelinePreviewRow: (props: any) => React.createElement('ToolTimelinePreviewRow', props),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
    TranscriptEnterWrapper: (props: any) => React.createElement('TranscriptEnterWrapper', props, props.children),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptCollapsible', () => ({
    TranscriptCollapsible: (props: any) => React.createElement(
        'TranscriptCollapsible',
        props,
        props.expanded ? props.children : null,
    ),
}));

function makeToolMessage(id: string, createdAt: number): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt,
        tool: {
            name: 'edit',
            state: 'running',
            input: {},
            createdAt,
            startedAt: createdAt,
            completedAt: null,
            description: null,
        },
        children: [],
    };
}

describe('ToolCallsGroupView (collapsed preview)', () => {
    it('renders the last N tool previews when collapsed', async () => {
        collapsedPreviewCount = 2;

        const toolMessages: ToolCallMessage[] = [makeToolMessage('m1', 1), makeToolMessage('m2', 2), makeToolMessage('m3', 3)];

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                <ToolCallsGroupView
                    id="toolCalls:1"
                    status="running"
                    toolMessages={toolMessages}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                    expanded={false}
                    setExpanded={vi.fn()}
                />,
            );
        });

        const previews = tree!.root.findAll((node) => (node.props as any).testID === 'transcript-tool-calls-preview-row');
        expect(previews).toHaveLength(2);

        const previewIds = previews.map((p) => (p.props as any).children?.props?.messageId).filter(Boolean);
        expect(previewIds).toEqual(['m2', 'm3']);

        const moreRows = tree!.root.findAll((node) => (node.props as any).testID === 'transcript-tool-calls-preview-more');
        expect(moreRows).toHaveLength(1);

        const order = tree!.root
            .findAll((node) =>
                (node.props as any).testID === 'transcript-tool-calls-preview-more' ||
                (node.props as any).testID === 'transcript-tool-calls-preview-row',
            )
            .map((n) => (n.props as any).testID);
        expect(order).toEqual([
            'transcript-tool-calls-preview-more',
            'transcript-tool-calls-preview-row',
            'transcript-tool-calls-preview-row',
        ]);
    });

    it('renders no previews when count is 0', async () => {
        collapsedPreviewCount = 0;

        const toolMessages: ToolCallMessage[] = [makeToolMessage('m1', 1), makeToolMessage('m2', 2)];

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                <ToolCallsGroupView
                    id="toolCalls:1"
                    status="running"
                    toolMessages={toolMessages}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                    expanded={false}
                    setExpanded={vi.fn()}
                />,
            );
        });

        const previews = tree!.root.findAll((node) => (node.props as any).testID === 'transcript-tool-calls-preview-row');
        expect(previews).toHaveLength(0);

        const moreRows = tree!.root.findAll((node) => (node.props as any).testID === 'transcript-tool-calls-preview-more');
        expect(moreRows).toHaveLength(0);
    });

    it('clamps preview count to 15', async () => {
        collapsedPreviewCount = 999;

        const toolMessages: ToolCallMessage[] = Array.from({ length: 20 }, (_, i) => makeToolMessage(`m${i + 1}`, i + 1));

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                <ToolCallsGroupView
                    id="toolCalls:1"
                    status="running"
                    toolMessages={toolMessages}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                    expanded={false}
                    setExpanded={vi.fn()}
                />,
            );
        });

        const previews = tree!.root.findAll((node) => (node.props as any).testID === 'transcript-tool-calls-preview-row');
        expect(previews).toHaveLength(15);
    });

    it('requests expansion via setExpanded(true) when tapping the +N more row', async () => {
        collapsedPreviewCount = 1;

        const toolMessages: ToolCallMessage[] = [makeToolMessage('m1', 1), makeToolMessage('m2', 2)];
        const setExpanded = vi.fn();

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                <ToolCallsGroupView
                    id="toolCalls:1"
                    status="running"
                    toolMessages={toolMessages}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                    expanded={false}
                    setExpanded={setExpanded}
                />,
            );
        });

        const moreRow = tree!.root.findByProps({ testID: 'transcript-tool-calls-preview-more' });
        await act(async () => {
            moreRow.props.onPress?.();
        });

        expect(setExpanded).toHaveBeenCalledWith(true);
    });

    it('does not pass nested tool message ids when tool navigation is disabled', async () => {
        collapsedPreviewCount = 2;

        const toolMessages: ToolCallMessage[] = [makeToolMessage('m1', 1), makeToolMessage('m2', 2), makeToolMessage('m3', 3)];

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                <ToolCallsGroupView
                    id="toolCalls:1"
                    status="running"
                    toolMessages={toolMessages}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true }}
                    expanded={false}
                    setExpanded={vi.fn()}
                />,
            );
        });

        const previewRows = tree!.root.findAllByType('ToolTimelineRow');
        expect(previewRows.length).toBeGreaterThan(0);
        expect(previewRows.every((node) => node.props.messageId === undefined)).toBe(true);

        await act(async () => {
            tree!.update(
                <ToolCallsGroupView
                    id="toolCalls:1"
                    status="running"
                    toolMessages={toolMessages}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true }}
                    expanded={true}
                    setExpanded={vi.fn()}
                />,
            );
        });

        const expandedRows = tree!.root.findAllByType('ToolTimelineRow');
        expect(expandedRows.length).toBe(toolMessages.length);
        expect(expandedRows.every((node) => node.props.messageId === undefined)).toBe(true);
    });

    it('passes stable route ids to grouped tool rows when server ids exist', async () => {
        collapsedPreviewCount = 2;

        const toolMessages: ToolCallMessage[] = [
            {
                ...makeToolMessage('internal-1', 1),
                realID: 'server-msg-1',
                tool: { ...makeToolMessage('internal-1', 1).tool, id: 'call_read_1' },
            } as ToolCallMessage,
            {
                ...makeToolMessage('internal-2', 2),
                realID: 'server-msg-2',
                tool: { ...makeToolMessage('internal-2', 2).tool, id: 'call_read_2' },
            } as ToolCallMessage,
        ];

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                <ToolCallsGroupView
                    id="toolCalls:1"
                    status="running"
                    toolMessages={toolMessages}
                    metadata={null}
                    sessionId="s1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                    expanded={true}
                    setExpanded={vi.fn()}
                />,
            );
        });

        const rows = tree!.root.findAllByType('ToolTimelineRow');
        expect(rows).toHaveLength(2);
        expect(rows.map((node) => node.props.messageId)).toEqual(['server:server-msg-1', 'server:server-msg-2']);
    });
});
