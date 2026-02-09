import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import { collectHostText, makeToolCall, makeToolViewProps } from '../../shell/views/ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'ios' },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#666',
                warning: '#f90',
                success: '#0a0',
                textDestructive: '#a00',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (_key: string, opts?: { count?: number }) => {
        if (opts && typeof opts.count === 'number') return `+ ${opts.count} more`;
        return _key;
    },
}));

vi.mock('../../catalog', () => ({
    knownTools: {},
}));

vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

describe('TaskView', () => {
    let messageId = 0;

    function makeTaskTool(overrides: Partial<ToolCall> = {}): ToolCall {
        return makeToolCall({
            name: 'Task',
            state: 'running',
            input: { operation: 'run', description: 'Explore' },
            result: null,
            ...overrides,
        });
    }

    function makeSubTool(name: string, createdAt: number): ToolCall {
        return makeToolCall({
            name,
            state: 'completed',
            input: {},
            result: {},
            createdAt,
            startedAt: createdAt,
            completedAt: createdAt,
        });
    }

    function makeToolMessage(tool: ToolCall): Message {
        messageId += 1;
        return {
            kind: 'tool-call',
            id: `tool-msg-${messageId}`,
            localId: null,
            createdAt: tool.createdAt,
            tool,
            children: [],
        };
    }

    function makeAgentTextMessage(text: string, createdAt: number): Message {
        messageId += 1;
        return {
            kind: 'agent-text',
            id: `agent-msg-${messageId}`,
            localId: null,
            createdAt,
            text,
            isThinking: false,
        };
    }

    async function renderView(
        tool: ToolCall,
        messages: Message[],
        detailLevel?: 'title' | 'summary' | 'full',
    ) {
        const { TaskView } = await import('./TaskView');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    TaskView,
                    makeToolViewProps(tool, { messages, ...(detailLevel ? { detailLevel } : {}) }),
                ),
            );
        });
        return tree;
    }

    describe('Summary Rendering', () => {
        it('renders a summary even when there are no sub-tools', async () => {
            const tree = await renderView(
                makeTaskTool({ input: { operation: 'create', subject: 'Validate tool testing' } }),
                [],
            );

            const joined = collectHostText(tree).join(' ');
            expect(joined).toContain('Create task: Validate tool testing');
        });

        it('renders only the last 3 sub-tools by default and shows a +more indicator', async () => {
            const base = Date.now();
            const taskTool = makeTaskTool({ createdAt: base, startedAt: base });
            const messages: Message[] = [
                makeToolMessage(makeSubTool('Bash', base + 1)),
                makeToolMessage(makeSubTool('Read', base + 2)),
                makeToolMessage(makeSubTool('Write', base + 3)),
                makeToolMessage(makeSubTool('Edit', base + 4)),
            ];
            const tree = await renderView(taskTool, messages);

            const joined = collectHostText(tree).join(' ');
            expect(joined).toContain('Read');
            expect(joined).toContain('Write');
            expect(joined).toContain('Edit');
            expect(joined).not.toContain('Bash');
            expect(joined).toContain('+ 1 more');
        });

        it('renders recent sidechain text messages in summary mode', async () => {
            const base = Date.now();
            const taskTool = makeTaskTool({ createdAt: base, startedAt: base });
            const messages: Message[] = [
                makeAgentTextMessage('First', base + 1),
                makeAgentTextMessage('Working...', base + 2),
            ];
            const tree = await renderView(taskTool, messages, 'summary');

            const joined = collectHostText(tree).join(' ');
            expect(joined).toContain('Working...');
        });
    });

    describe('Full Rendering', () => {
        it('renders more sub-tools when detailLevel=full', async () => {
            const base = Date.now();
            const taskTool = makeTaskTool({ createdAt: base, startedAt: base });
            const messages = Array.from({ length: 6 }, (_, index) =>
                makeToolMessage(makeSubTool(`Tool${index + 1}`, base + index + 1)),
            );
            const tree = await renderView(taskTool, messages, 'full');

            const joined = collectHostText(tree).join(' ');
            expect(joined).toContain('Tool1');
            expect(joined).toContain('Tool6');
            expect(joined).not.toContain('more');
        });

        it('renders sidechain text messages when detailLevel=full', async () => {
            const base = Date.now();
            const taskTool = makeTaskTool({ createdAt: base, startedAt: base });
            const messages: Message[] = [makeAgentTextMessage('Working...', base + 1)];
            const tree = await renderView(taskTool, messages, 'full');

            expect(collectHostText(tree).join(' ')).toContain('Working...');
        });

        it('shows the full sidechain text history when detailLevel=full', async () => {
            const base = Date.now();
            const taskTool = makeTaskTool({ createdAt: base, startedAt: base });
            const messages = Array.from({ length: 20 }, (_, index) =>
                makeAgentTextMessage(`Agent msg ${String(index + 1).padStart(2, '0')}`, base + index + 1),
            );
            const tree = await renderView(taskTool, messages, 'full');

            const joined = collectHostText(tree).join(' ');
            expect(joined).toContain('Agent msg 01');
            expect(joined).toContain('Agent msg 20');
        });
    });

    describe('Result Rendering', () => {
        it('renders task result content when present', async () => {
            const base = Date.now();
            const taskTool = makeTaskTool({
                state: 'completed',
                input: { operation: 'run', description: 'Do thing' },
                result: { content: 'SUBTASK_OK' },
                createdAt: base,
                startedAt: base,
                completedAt: base + 100,
            });
            const tree = await renderView(taskTool, []);

            expect(collectHostText(tree).join(' ')).toContain('SUBTASK_OK');
        });
    });
});
