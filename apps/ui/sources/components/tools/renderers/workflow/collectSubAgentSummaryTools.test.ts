import { describe, expect, it, vi } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

vi.mock('@/components/tools/normalization/core/normalizeToolCallForRendering', () => ({
    normalizeToolCallForRendering: (t: any) => t,
}));

vi.mock('@/components/tools/shell/presentation/resolveToolHeaderTextPresentation', () => ({
    resolveToolHeaderTextPresentation: () => ({
        normalizedToolName: 'Anything',
        usedInferenceFallback: false,
        title: 'Fancy Tool Title',
        subtitle: null,
        statusText: null,
    }),
}));

describe('collectSubAgentSummaryTools', () => {
    it('uses resolveToolHeaderTextPresentation for tool titles', async () => {
        const { collectSubAgentSummaryTools } = await import('./collectSubAgentSummaryTools');

        const taskTool: any = {
            name: 'Task',
            state: 'running',
            input: {},
            createdAt: 10,
            startedAt: 10,
            completedAt: null,
            description: null,
            result: null,
        };

        const messages: Message[] = [
            {
                kind: 'tool-call',
                id: 'm1',
                localId: null,
                createdAt: 11,
                tool: {
                    name: 'SomeTool',
                    state: 'completed',
                    input: {},
                    createdAt: 11,
                    startedAt: 11,
                    completedAt: 12,
                    description: null,
                    result: {},
                } as any,
                children: [],
            } as any,
        ];

        const tools = collectSubAgentSummaryTools({ tool: taskTool, messages, metadata: null });
        expect(tools).toHaveLength(1);
        expect(tools[0]!.title).toBe('Fancy Tool Title');
    });

    it('returns task tool calls sorted by createdAt (oldest first)', async () => {
        const { collectSubAgentSummaryTools } = await import('./collectSubAgentSummaryTools');

        const taskTool: any = {
            name: 'Task',
            state: 'running',
            input: {},
            createdAt: 10,
            startedAt: 10,
            completedAt: null,
            description: null,
            result: null,
        };

        const messages: Message[] = [
            {
                kind: 'tool-call',
                id: 'm2',
                localId: null,
                createdAt: 12,
                tool: { name: 'ToolB', state: 'completed', input: {}, createdAt: 12, startedAt: 12, completedAt: 13, description: null, result: {} } as any,
                children: [],
            } as any,
            {
                kind: 'tool-call',
                id: 'm1',
                localId: null,
                createdAt: 11,
                tool: { name: 'ToolA', state: 'completed', input: {}, createdAt: 11, startedAt: 11, completedAt: 12, description: null, result: {} } as any,
                children: [],
            } as any,
        ];

        const tools = collectSubAgentSummaryTools({ tool: taskTool, messages, metadata: null });
        expect(tools.map((t) => t.tool.createdAt)).toEqual([11, 12]);
    });
});
