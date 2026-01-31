import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

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
    t: (_key: string, opts?: any) => {
        if (opts && typeof opts.count === 'number') return `+ ${opts.count} more`;
        return _key;
    },
}));

vi.mock('../../tools/knownTools', () => ({
    knownTools: {},
}));

vi.mock('../ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('TaskView', () => {
    it('renders a summary even when there are no sub-tools', async () => {
        const { TaskView } = await import('./TaskView');

        const tool: ToolCall = {
            name: 'Task',
            state: 'running',
            input: { operation: 'create', subject: 'Validate tool testing' } as any,
            result: null,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: null,
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(TaskView, { tool, metadata: null, messages: [] } as any));
        });

        const joined = tree.root.findAllByType('Text' as any).map((n: any) => String(n.props.children)).join(' ');
        expect(joined).toContain('Create task: Validate tool testing');
    });

    it('renders only the last 3 sub-tools by default and shows a +more indicator', async () => {
        const { TaskView } = await import('./TaskView');
        const base = Date.now();

        const tool: ToolCall = {
            name: 'Task',
            state: 'running',
            input: { operation: 'run', description: 'Explore' } as any,
            result: null,
            createdAt: base,
            startedAt: base,
            completedAt: null,
            description: null,
            permission: undefined,
        };

        const mkTool = (name: string, createdAt: number): ToolCall => ({
            name,
            state: 'completed',
            input: {},
            result: {},
            createdAt,
            startedAt: createdAt,
            completedAt: createdAt,
            description: null,
            permission: undefined,
        });

        const messages = [
            { kind: 'tool-call', tool: mkTool('Bash', base + 1) },
            { kind: 'tool-call', tool: mkTool('Read', base + 2) },
            { kind: 'tool-call', tool: mkTool('Write', base + 3) },
            { kind: 'tool-call', tool: mkTool('Edit', base + 4) },
        ] as any[];

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(TaskView, { tool, metadata: null, messages } as any));
        });

        const joined = tree.root.findAllByType('Text' as any).map((n: any) => String(n.props.children)).join(' ');
        expect(joined).toContain('Read');
        expect(joined).toContain('Write');
        expect(joined).toContain('Edit');
        expect(joined).not.toContain('Bash');
        expect(joined).toContain('+ 1 more');
    });

    it('renders more sub-tools when detailLevel=full', async () => {
        const { TaskView } = await import('./TaskView');
        const base = Date.now();

        const tool: ToolCall = {
            name: 'Task',
            state: 'running',
            input: { operation: 'run', description: 'Explore' } as any,
            result: null,
            createdAt: base,
            startedAt: base,
            completedAt: null,
            description: null,
            permission: undefined,
        };

        const mkTool = (name: string, createdAt: number): ToolCall => ({
            name,
            state: 'completed',
            input: {},
            result: {},
            createdAt,
            startedAt: createdAt,
            completedAt: createdAt,
            description: null,
            permission: undefined,
        });

        const messages = Array.from({ length: 6 }).map((_, i) => ({
            kind: 'tool-call',
            tool: mkTool(`Tool${i + 1}`, base + i + 1),
        })) as any[];

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(TaskView, { tool, metadata: null, messages, detailLevel: 'full' } as any));
        });

        const joined = tree.root.findAllByType('Text' as any).map((n: any) => String(n.props.children)).join(' ');
        expect(joined).toContain('Tool1');
        expect(joined).toContain('Tool6');
        expect(joined).not.toContain('more');
    });
});

