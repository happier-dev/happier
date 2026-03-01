import { describe, expect, it, vi } from 'vitest';

import type { ToolCall } from '@/sync/domains/messages/messageTypes';

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        KnownTool: {
            title: 'Known title',
            extractSubtitle: () => 'Known subtitle',
            extractStatus: () => 'Running',
        },
    },
}));

let inferred: { normalizedToolName: string; source: string } = { normalizedToolName: 'UnknownTool', source: 'original' };
vi.mock('@/components/tools/normalization/policy/toolNameInference', () => ({
    inferToolNameForRendering: () => inferred,
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: (name: string) => `MCP:${name}`,
    formatMCPSubtitle: (input: any) => `sub:${String(input?.x ?? '')}`,
}));

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
    const now = 1;
    return {
        name: 'UnknownTool',
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

describe('resolveToolHeaderTextPresentation', () => {
    it('uses tool name as title when inference did not fall back', async () => {
        const { resolveToolHeaderTextPresentation } = await import('./resolveToolHeaderTextPresentation');
        const tool = makeToolCall({ name: 'UnknownTool', description: 'Execute' });
        inferred = { normalizedToolName: 'UnknownTool', source: 'original' };
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('UnknownTool');
        expect(model.subtitle).toBeNull();
    });

    it('uses description as title when inference fell back and tool is unknown', async () => {
        const { resolveToolHeaderTextPresentation } = await import('./resolveToolHeaderTextPresentation');
        const tool = makeToolCall({ name: 'UnknownTool', description: 'Search files' });
        inferred = { normalizedToolName: 'SomeInferred', source: 'description' };
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('Search files');
    });

    it('uses known tool title/subtitle/status when available', async () => {
        const { resolveToolHeaderTextPresentation } = await import('./resolveToolHeaderTextPresentation');
        const tool = makeToolCall({ name: 'KnownTool', description: 'Execute' });
        inferred = { normalizedToolName: 'KnownTool', source: 'original' };
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('Known title');
        expect(model.subtitle).toBe('Known subtitle');
        expect(model.statusText).toBe('Running');
    });

    it('uses MCP title and subtitle for mcp__ tools', async () => {
        const { resolveToolHeaderTextPresentation } = await import('./resolveToolHeaderTextPresentation');
        const tool = makeToolCall({ name: 'mcp__foo', input: { x: 1 } });
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('MCP:mcp__foo');
        expect(model.subtitle).toBe('sub:1');
    });

    it('compacts SubAgentRun JSON subtitle to summary text', async () => {
        const { resolveToolHeaderTextPresentation } = await import('./resolveToolHeaderTextPresentation');
        const tool = makeToolCall({
            name: 'SubAgentRun',
            description:
                '{"status":"timeout","summary":"Timed out after 120000ms","error":{"code":"execution_run_timeout","message":"Timed out after 120000ms"}}',
        });
        inferred = { normalizedToolName: 'SubAgentRun', source: 'original' };
        const model = resolveToolHeaderTextPresentation({ tool, metadata: null });
        expect(model.title).toBe('SubAgentRun');
        expect(model.subtitle).toBe('Timed out after 120000ms');
    });
});
