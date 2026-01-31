import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
}));

vi.mock('../../tools/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/CodeView', () => ({
    CodeView: ({ code }: any) => React.createElement('Text', null, code),
}));

describe('MCPToolView', () => {
    it('renders a compact subtitle + output preview in summary mode', async () => {
        const { MCPToolView } = await import('./MCPToolView');

        const tool: ToolCall = {
            name: 'mcp__linear__create_issue',
            state: 'completed',
            input: {
                title: 'Bug: MCP tool rendering summary',
                _mcp: { display: { subtitle: 'Bug: MCP tool rendering summary' } },
            } as any,
            result: { text: 'Created issue LIN-42' } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(MCPToolView, { tool, metadata: null, detailLevel: 'summary' } as any));
        });

        const textNodes = tree.root.findAllByType('Text' as any);
        const rendered = textNodes
            .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children)))
            .join('\n');

        expect(rendered).toContain('Bug: MCP tool rendering summary');
        expect(rendered).toContain('Created issue LIN-42');
    });

    it('renders input + output blocks in full mode', async () => {
        const { MCPToolView } = await import('./MCPToolView');

        const tool: ToolCall = {
            name: 'mcp__linear__create_issue',
            state: 'completed',
            input: { title: 'Bug: MCP tool rendering summary' } as any,
            result: { text: 'Created issue LIN-42' } as any,
            createdAt: Date.now(),
            startedAt: Date.now(),
            completedAt: Date.now(),
            description: null,
            permission: undefined,
        };

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(MCPToolView, { tool, metadata: null, detailLevel: 'full' } as any));
        });

        const textNodes = tree.root.findAllByType('Text' as any);
        const rendered = textNodes
            .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children)))
            .join('\n');

        expect(rendered).toContain('MCP: Linear Create Issue');
        expect(rendered).toContain('Input');
        expect(rendered).toContain('Output');
        expect(rendered).toContain('Created issue LIN-42');
    });
});

