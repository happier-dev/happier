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

describe('collectTaskLikeTools', () => {
    it('uses resolveToolHeaderTextPresentation for tool titles', async () => {
        const { collectTaskLikeTools } = await import('./collectTaskLikeTools');

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

        const tools = collectTaskLikeTools({ tool: taskTool, messages, metadata: null });
        expect(tools).toHaveLength(1);
        expect(tools[0]!.title).toBe('Fancy Tool Title');
    });
});
