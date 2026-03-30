import { describe, expect, it } from 'vitest';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';

function createToolMessage(params: {
    id: string;
    toolId: string;
    name: string;
    createdAt?: number;
    description?: string | null;
    input?: Record<string, unknown>;
    permission?: { id: string; status: 'pending' | 'approved' | 'denied' };
}): ToolCallMessage {
    const createdAt = params.createdAt ?? Date.now();
    return {
        kind: 'tool-call',
        id: params.id,
        localId: null,
        createdAt,
        tool: {
            id: params.toolId,
            name: params.name,
            state: 'running',
            input: params.input ?? {},
            createdAt,
            startedAt: createdAt,
            completedAt: null,
            description: params.description ?? null,
            ...(params.permission ? { permission: params.permission } : {}),
        },
        children: [],
    };
}

describe('resolvePendingPermissionRouteForSubAgentTool', () => {
    it('prefers the matching pending permission route for a blocked generic subagent', async () => {
        const { resolvePendingPermissionRouteForSubAgentTool } = await import('./resolvePendingPermissionRouteForSubAgentTool');

        const permissionMessage = createToolMessage({
            id: 'message_permission',
            toolId: 'per_subagent_1',
            name: 'task',
            createdAt: 10,
            input: {
                permission: 'task',
                patterns: ['general'],
                metadata: {
                    description: 'Run pwd',
                    subagent_type: 'general',
                },
            },
            permission: {
                id: 'per_subagent_1',
                status: 'pending',
            },
        });
        const subagentMessage = createToolMessage({
            id: 'message_subagent',
            toolId: 'call_subagent_1',
            name: 'SubAgent',
            createdAt: 11,
            description: 'Run pwd',
            input: {
                description: 'Run pwd',
                prompt: 'Use the Bash tool to run `pwd` and return the output.',
                subagent_type: 'general',
            },
        });

        expect(resolvePendingPermissionRouteForSubAgentTool({
            messages: [permissionMessage, subagentMessage],
            toolMessage: subagentMessage,
        })).toBe('tool:per_subagent_1');
    });

    it('ignores unrelated pending permissions when the description does not match', async () => {
        const { resolvePendingPermissionRouteForSubAgentTool } = await import('./resolvePendingPermissionRouteForSubAgentTool');

        const permissionMessage = createToolMessage({
            id: 'message_permission',
            toolId: 'per_subagent_1',
            name: 'task',
            input: {
                metadata: {
                    description: 'Inspect package.json',
                    subagent_type: 'general',
                },
            },
            permission: {
                id: 'per_subagent_1',
                status: 'pending',
            },
        });
        const subagentMessage = createToolMessage({
            id: 'message_subagent',
            toolId: 'call_subagent_1',
            name: 'SubAgent',
            description: 'Run pwd',
            input: {
                description: 'Run pwd',
                prompt: 'Use the Bash tool to run `pwd` and return the output.',
                subagent_type: 'general',
            },
        });

        expect(resolvePendingPermissionRouteForSubAgentTool({
            messages: [permissionMessage as Message, subagentMessage],
            toolMessage: subagentMessage,
        })).toBeNull();
    });
});
