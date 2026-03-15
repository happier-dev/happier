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

let toolChromeMode: 'activity_feed' | 'cards' = 'activity_feed';
let toolCallsGroupShowBackground: boolean = false;
vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'toolViewTimelineChromeMode') return toolChromeMode;
        if (key === 'transcriptToolCallsCollapsedPreviewCount') return 0;
        if (key === 'transcriptToolCallsGroupShowBackground') return toolCallsGroupShowBackground;
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

describe('ToolCallsGroupView (motion wiring)', () => {
    it('wraps tool rows in TranscriptEnterWrapper and uses TranscriptCollapsible for expand/collapse', async () => {
        const { ToolCallsGroupView } = await import('./ToolCallsGroupView');

        const toolMessages: ToolCallMessage[] = [makeToolMessage('m1', 1), makeToolMessage('m2', 2)];

        function Harness() {
            const [expanded, setExpanded] = React.useState(false);
            return (
                <ToolCallsGroupView
                    id="toolCalls:1"
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

    it('shows a stack icon and toggles chevron direction when expanded', async () => {
        const { ToolCallsGroupView } = await import('./ToolCallsGroupView');
        toolChromeMode = 'activity_feed';
        toolCallsGroupShowBackground = false;

        const toolMessages: ToolCallMessage[] = [makeToolMessage('m1', 1)];

        function Harness() {
            const [expanded, setExpanded] = React.useState(false);
            return (
                <ToolCallsGroupView
                    id="toolCalls:1"
                    status="completed"
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
            tree = renderer.create(<Harness />);
        });

        const iconsCollapsed = tree!.root.findAllByType('Ionicons' as any) as any[];
        expect(iconsCollapsed.some((i) => i.props?.name === 'layers-outline')).toBe(true);
        expect(iconsCollapsed.some((i) => i.props?.name === 'chevron-down-outline')).toBe(true);
        expect(iconsCollapsed.some((i) => i.props?.name === 'chevron-up-outline')).toBe(false);

        const header = tree!.root.findByProps({ testID: 'transcript-tool-calls-header' });
        await act(async () => {
            header.props.onPress?.();
        });

        const iconsExpanded = tree!.root.findAllByType('Ionicons' as any) as any[];
        expect(iconsExpanded.some((i) => i.props?.name === 'chevron-up-outline')).toBe(true);
    });

    it('applies a group background only when enabled in tool feed mode', async () => {
        const { ToolCallsGroupView } = await import('./ToolCallsGroupView');
        toolChromeMode = 'activity_feed';
        toolCallsGroupShowBackground = true;

        const toolMessages: ToolCallMessage[] = [makeToolMessage('m1', 1)];

        let tree: ReturnType<typeof renderer.create> | undefined;
        await act(async () => {
            tree = renderer.create(
                <ToolCallsGroupView
                    id="toolCalls:1"
                    status="completed"
                    toolMessages={toolMessages}
                    metadata={null}
                    sessionId="s1"
                    expanded={false}
                    setExpanded={vi.fn()}
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />,
            );
        });

        const container = tree!.root.findByProps({ testID: 'transcript-tool-calls-group' }) as any;
        const styles = Array.isArray(container.props.style) ? container.props.style : [container.props.style];
        const backgroundEntry = styles.find((s: any) => s?.backgroundColor);
        expect(backgroundEntry?.backgroundColor).toBe('#fafafa');

        toolChromeMode = 'cards';
        await act(async () => {
            tree!.update(
                <ToolCallsGroupView
                    id="toolCalls:1"
                    status="completed"
                    toolMessages={toolMessages}
                    metadata={null}
                    sessionId="s1"
                    expanded={false}
                    setExpanded={vi.fn()}
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />,
            );
        });

        const containerCards = tree!.root.findByProps({ testID: 'transcript-tool-calls-group' }) as any;
        const stylesCards = Array.isArray(containerCards.props.style) ? containerCards.props.style : [containerCards.props.style];
        const backgroundEntryCards = stylesCards.find((s: any) => s?.backgroundColor);
        expect(backgroundEntryCards?.backgroundColor).not.toBe('#fafafa');
    });
});
