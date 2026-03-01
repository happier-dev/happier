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
        if (key === 'toolViewTimelineChromeMode') return 'activity_feed';
        if (key === 'transcriptTurnActivityGroupCollapsedPreviewCount') return 0;
        return null;
    },
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
    ToolView: (props: any) => React.createElement('ToolView', props),
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: (props: any) => React.createElement('ToolTimelineRow', props),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
    TranscriptEnterWrapper: (props: any) => React.createElement('TranscriptEnterWrapper', props, props.children),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptCollapsible', () => ({
    TranscriptCollapsible: (props: any) => React.createElement('TranscriptCollapsible', props, props.children),
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

describe('ActivityGroupView (motion wiring)', () => {
    it('wraps tool rows in TranscriptEnterWrapper and uses TranscriptCollapsible for expand/collapse', async () => {
        const { ActivityGroupView } = await import('./ActivityGroupView');

        const toolMessages: ToolCallMessage[] = [makeToolMessage('m1', 1), makeToolMessage('m2', 2)];

        function Harness() {
            const [expanded, setExpanded] = React.useState(false);
            return (
                <ActivityGroupView
                    id="activity:1"
                    status="running"
                    toolMessages={toolMessages}
                    metadata={null}
                    sessionId="s1"
                    expanded={expanded}
                    setExpanded={setExpanded}
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />
            );
        }

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                <Harness />,
            );
        });

        expect(tree!.root.findAllByType('TranscriptEnterWrapper' as any)).toHaveLength(2);

        const collapsibles = tree!.root.findAllByType('TranscriptCollapsible' as any);
        expect(collapsibles).toHaveLength(1);
        expect(collapsibles[0]!.props.expanded).toBe(false);

        const header = tree!.root.findAllByType('Pressable' as any)[0]!;
        await act(async () => {
            header.props.onPress?.();
        });

        const collapsiblesAfter = tree!.root.findAllByType('TranscriptCollapsible' as any);
        expect(collapsiblesAfter[0]!.props.expanded).toBe(true);
    });
});
