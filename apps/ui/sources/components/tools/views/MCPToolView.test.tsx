import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { ToolCall } from '@/sync/typesMessage';
import { collectHostText, makeToolCall, makeToolViewProps } from '../ToolView.testHelpers';

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
    function makeMcpTool(overrides: Partial<ToolCall> = {}): ToolCall {
        return makeToolCall({
            name: 'mcp__linear__create_issue',
            state: 'completed',
            input: { title: 'Bug: MCP tool rendering summary' },
            result: { text: 'Created issue LIN-42' },
            ...overrides,
        });
    }

    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { MCPToolView } = await import('./MCPToolView');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(
                    MCPToolView,
                    makeToolViewProps(tool, detailLevel ? { detailLevel } : {}),
                ),
            );
        });
        return tree;
    }

    it('renders a compact subtitle + output preview in summary mode', async () => {
        const tool = makeMcpTool({
            input: {
                title: 'Bug: MCP tool rendering summary',
                _mcp: { display: { subtitle: 'Bug: MCP tool rendering summary' } },
            },
        });
        const tree = await renderView(tool, 'summary');
        const rendered = collectHostText(tree).join('\n');

        expect(rendered).toContain('Bug: MCP tool rendering summary');
        expect(rendered).toContain('Created issue LIN-42');
    });

    it('uses stable subtitle fallbacks and omits non-string output previews in summary mode', async () => {
        const tool = makeMcpTool({
            input: {
                _mcp: { display: { subtitle: 99 } },
                path: '/repo/src/file.ts',
                query: 'ignored because path exists',
            },
            result: { output: { status: 'ok' } },
        });
        const tree = await renderView(tool, 'summary');
        const rendered = collectHostText(tree).join('\n').replace(/\s+/g, ' ');

        expect(rendered).toContain('/repo/src/file.ts');
        expect(rendered).not.toContain('ok');
    });

    it('exports subtitle precedence for subtitle, title, path, and query', async () => {
        const { formatMCPSubtitle } = await import('./MCPToolView');

        expect(formatMCPSubtitle({ _mcp: { display: { subtitle: '  subtitle  ' } }, title: 'Title' })).toBe('subtitle');
        expect(formatMCPSubtitle({ title: '  Hello title  ' })).toBe('Hello title');
        expect(formatMCPSubtitle({ path: '/tmp/a.ts', query: 'x' })).toBe('/tmp/a.ts');
        expect(formatMCPSubtitle({ query: 'find me' })).toBe('find me');
    });

    it('renders input + output blocks in full mode', async () => {
        const tree = await renderView(makeMcpTool(), 'full');
        const rendered = collectHostText(tree).join('\n');

        expect(rendered).toContain('MCP: Linear Create Issue');
        expect(rendered).toContain('Input');
        expect(rendered).toContain('Output');
        expect(rendered).toContain('Created issue LIN-42');
    });

    it('renders nothing in title mode', async () => {
        const tree = await renderView(makeMcpTool(), 'title');
        expect(tree.root.findAllByType('Text' as any)).toHaveLength(0);
    });
});
