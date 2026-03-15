import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { Message, ToolCall, ToolCallMessage } from '@/sync/domains/messages/messageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    return {
        Platform: { OS: 'web', select: (v: any) => v.web ?? v.default },
        AppState: {
            currentState: 'active',
            addEventListener: () => ({ remove: () => {} }),
        },
        View: ({ children, ...props }: any) => React.createElement('View', props, children),
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props),
    };
});

vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            text: '#111',
            textSecondary: '#666',
            success: '#0a0',
            warning: '#fa0',
            textDestructive: '#c00',
            surface: '#000',
            surfaceHigh: '#111',
            surfacePressedOverlay: '#222',
            shadow: { color: '#000', opacity: 0.1 },
        },
    };
    return {
        StyleSheet: { create: (styles: any) => (typeof styles === 'function' ? styles(theme, {}) : styles) },
        useUnistyles: () => ({ theme }),
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/tools/shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement('ToolSectionView', null, children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/text', () => ({
    t: (key: string, vars?: any) => (key === 'tools.taskView.moreTools' ? `more:${vars?.count ?? ''}` : key),
}));

const pushSpy = vi.fn();
vi.mock('expo-router', () => ({
    useRouter: () => ({ push: pushSpy }),
}));

function makeToolCall(overrides: Partial<ToolCall>): ToolCall {
    const now = 1;
    return {
        name: 'Unknown',
        state: 'completed',
        input: {},
        result: null,
        createdAt: now,
        startedAt: now,
        completedAt: now,
        description: null,
        permission: undefined,
        ...overrides,
    };
}

function makeToolCallMessage(id: string, tool: ToolCall): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: tool.createdAt ?? 1,
        tool,
        children: [],
    };
}

describe('TaskLikeSummarySection (+N more tools row)', () => {
    it('renders the +N more tools row above the visible tools (and makes it tappable)', async () => {
        pushSpy.mockClear();
        const { TaskLikeSummarySection } = await import('./TaskLikeSummarySection');

        const taskTool = makeToolCall({
            name: 'Task',
            state: 'running',
            input: { description: 'Tool stress ideas' },
            createdAt: 10,
            startedAt: 10,
            completedAt: null,
        });

        const toolMessages: Message[] = [
            makeToolCallMessage('m1', makeToolCall({ name: 'Read', input: { file_path: '/a.txt' }, createdAt: 11 })),
            makeToolCallMessage('m2', makeToolCall({ name: 'Glob', input: { pattern: '{package.json}' }, createdAt: 12 })),
            makeToolCallMessage('m3', makeToolCall({ name: 'Grep', input: { pattern: '\\\\bTODO\\\\b' }, createdAt: 13 })),
            makeToolCallMessage('m4', makeToolCall({ name: 'WebFetch', input: { url: 'https://example.com' }, createdAt: 14 })),
            makeToolCallMessage('m5', makeToolCall({ name: 'LS', input: { path: '.' }, createdAt: 15 })),
        ];

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <TaskLikeSummarySection
                    tool={taskTool}
                    metadata={null}
                    messages={toolMessages}
                    detailLevel="summary"
                    sessionId="s1"
                    messageId="msg-task-1"
                />,
            );
        });

        const moreRow = tree!.root.findByProps({ testID: 'task-like-summary-more-tools' });
        expect(typeof (moreRow.props as any).onPress).toBe('function');

        const order = tree!.root
            .findAll((n) =>
                (n.props as any).testID === 'task-like-summary-more-tools' ||
                (n.props as any).testID === 'task-like-summary-tool-item',
            )
            .map((n) => (n.props as any).testID);
        expect(order[0]).toBe('task-like-summary-more-tools');

        act(() => {
            moreRow.props.onPress?.();
        });
        expect(pushSpy).toHaveBeenCalledWith('/session/s1/message/msg-task-1');
    });
});
