import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit';
import { TranscriptFindProvider } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { createTranscriptFindRowStore } from '@/components/sessions/transcript/find/transcriptFindRowStore';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: ({ code }: any) => React.createElement('Text', null, code),
}));

// Load the real renderer during collection; cold module transforms are setup, not an interaction timeout.
await import('./MCPToolView');

describe('MCPToolView', () => {
    it('previews canonical MCP content and historical text aliases equally', async () => {
        for (const result of [
            { content: [{ type: 'text', text: 'Kept result body' }] },
            { content: 'Kept result body' },
            { stdout: 'Kept result body' },
            { text: 'Kept result body' },
        ]) {
            const tool = makeToolCall({ name: 'mcp__example__read', state: 'completed', result });
            expect((await renderView(tool, 'summary')).getTextContent()).toContain('Kept result body');
        }
    });
    it('indexes its decoded preview and exact full JSON, and reveals a preview match beyond the summary clamp', async () => {
        const { MCPToolView, projectMCPDisplayText } = await import('./MCPToolView');
        const text = 'x'.repeat(850) + 'needle\nnext line';
        const tool = makeMcpTool({ result: { text, nested: { value: 'visible in full JSON' } } });
        const blocks = projectMCPDisplayText(tool);
        expect(blocks.find((block) => block.id === 'tool-output-preview')?.text).toBe(text);
        expect(blocks.find((block) => block.id === 'tool-output')?.text).toBe(JSON.stringify(tool.result, null, 2));
        const store = createTranscriptFindRowStore();
        store.publish(new Map([['find-mcp', { blocks: [{ id: 'tool-output-preview', sourceRanges: [{ start: 850, end: 856, current: true }] }], reveal: { blockId: 'tool-output-preview', requestId: 1 } }]]));
        const screen = await renderScreen(<TranscriptFindProvider store={store}><MCPToolView {...makeToolViewProps(tool, { detailLevel: 'summary', messageId: 'find-mcp' })} /></TranscriptFindProvider>);
        expect(screen.getTextContent()).toContain(text);
    });
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
        return renderScreen(React.createElement(
            MCPToolView,
            makeToolViewProps(tool, detailLevel ? { detailLevel } : {}),
        ));
    }

    it('renders only the call outcome in summary mode: the row header owns the title and line', async () => {
        const tool = makeMcpTool({
            input: {
                title: 'Bug: MCP tool rendering summary',
                _mcp: { display: { subtitle: 'Bug: MCP tool rendering summary' } },
            },
        });
        const screen = await renderView(tool, 'summary');
        const rendered = screen.getTextContent();

        expect(rendered).not.toContain('Bug: MCP tool rendering summary');
        expect(rendered).toContain('Created issue LIN-42');
    });

    it('omits non-string output previews in summary mode and renders nothing when there is no outcome', async () => {
        const tool = makeMcpTool({
            input: { path: '/repo/src/file.ts' },
            result: { output: { status: 'ok' } },
        });
        const screen = await renderView(tool, 'summary');
        expect(screen.getTextContent().replace(/\s+/g, ' ')).not.toContain('ok');
        expect(screen.findAllByType('Text' as any)).toHaveLength(0);
    });

    it('keeps a refused Action call\'s typed code in the summary body without repeating the row line', async () => {
        const text = JSON.stringify({ errorCode: 'unsupported_action', error: 'unsupported_action:session.stop', details: { cause: 'target_outside_led_subtree' } });
        const tool = makeToolCall({
            name: 'mcp__happier__action_execute',
            state: 'completed',
            input: { actionId: 'session.stop', input: {} },
            result: { content: [{ type: 'text', text }], structuredContent: null, text, _mcp: { serverId: 'happier', toolId: 'action_execute' } },
        });
        const rendered = (await renderView(tool, 'summary')).getTextContent();

        expect(rendered).toContain('unsupported_action · target_outside_led_subtree');
        expect(rendered).not.toContain('Stop a running session');
    });

    it('says an acknowledged section move in words instead of its JSON (lab clsections:agent)', async () => {
        const result = { ok: true, result: { sessionId: 'session_1', sectionId: null, previousSectionId: 'launch' } };
        const text = JSON.stringify(result);
        const tool = makeToolCall({
            name: 'mcp__happier__action_execute',
            state: 'completed',
            input: { actionId: 'session.section.set', input: { sessionId: 'session_1', sectionId: null } },
            result: { content: [{ type: 'text', text }], structuredContent: null, text, _mcp: { serverId: 'happier', toolId: 'action_execute' } },
        });
        const rendered = (await renderView(tool, 'summary')).getTextContent();
        expect(rendered).toContain('Moved this session back to its project');
        expect(rendered).not.toContain('previousSectionId');
    });

    it('exports subtitle precedence for subtitle, title, path, and query', async () => {
        const { formatMCPSubtitle } = await import('./MCPToolView');

        expect(formatMCPSubtitle({ _mcp: { display: { subtitle: '  subtitle  ' } }, title: 'Title' })).toBe('subtitle');
        expect(formatMCPSubtitle({ title: '  Hello title  ' })).toBe('Hello title');
        expect(formatMCPSubtitle({ path: '/tmp/a.ts', query: 'x' })).toBe('/tmp/a.ts');
        expect(formatMCPSubtitle({ query: 'find me' })).toBe('find me');
    });

    it('renders input + output blocks in full mode', async () => {
        const screen = await renderView(makeMcpTool(), 'full');
        const rendered = screen.getTextContent();

        expect(rendered).toContain('MCP: Linear Create Issue');
        expect(rendered).toContain('Input');
        expect(rendered).toContain('Output');
        expect(rendered).toContain('Created issue LIN-42');
    });

    it('titles a Happier Action call by the Action it runs, through action_execute or its own binding', async () => {
        const { formatMCPTitle } = await import('./MCPToolView');
        const input = { actionId: 'workspace.sync.relationship.terminate', input: { relationshipId: 'relationship_1' } };
        expect(formatMCPTitle('mcp__happier__action_execute', undefined, input)).toBe('Stop workspace sync');
        expect(formatMCPTitle('mcp__happier__workspace_sync_relationship_terminate', undefined, { relationshipId: 'r' }))
            .toBe('Stop workspace sync');
        expect(formatMCPTitle('mcp__happier__action_execute', undefined, { actionId: 'not.an.action' }))
            .toBe('MCP: Happier Action Execute');
        expect(formatMCPTitle('mcp__linear__create_issue', undefined, input)).toBe('MCP: Linear Create Issue');
    });

    it('says what a Happier Action call does, never its raw actionId and input', async () => {
        const { formatMCPToolSubtitle } = await import('./MCPToolView');
        const unarchive = { actionId: 'session.unarchive', input: { sessionId: 'cmvfqvl9c00qomc8of6kuw4lz' } };
        // The CLI's MCP normalizer stores its generic key=value line as every call's display subtitle.
        const recorded = { ...unarchive, _mcp: { serverId: 'happier', toolId: 'action_execute', display: {
            title: 'MCP: happier action execute', subtitle: 'actionId=session.unarchive input={"sessionId":"cmvfqvl9c00qomc8of6kuw4lz"}',
        } } };
        for (const subtitle of [
            formatMCPToolSubtitle('mcp__happier__action_execute', unarchive),
            formatMCPToolSubtitle('mcp__happier__action_execute', recorded),
            formatMCPToolSubtitle('mcp__happier__session_unarchive', unarchive.input),
            formatMCPToolSubtitle('mcp__happier__action_execute', {
                actionId: 'workspace.sync.relationship.terminate', input: { relationshipId: 'relationship_1' },
            }),
        ]) {
            expect(subtitle).not.toBe('');
            expect(subtitle).not.toMatch(/actionId|input=|relationship_1|cmvfqvl9c00qomc8of6kuw4lz|[{}]/);
        }
        // Other MCP servers keep their key=value fallback.
        expect(formatMCPToolSubtitle('mcp__linear__create_issue', unarchive)).toContain('actionId=session.unarchive');
    });

    it('renders nothing in title mode', async () => {
        const screen = await renderView(makeMcpTool(), 'title');
        expect(screen.findAllByType('Text' as any)).toHaveLength(0);
    });
});
