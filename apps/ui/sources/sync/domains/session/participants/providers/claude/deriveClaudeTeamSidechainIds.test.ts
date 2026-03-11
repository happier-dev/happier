import { describe, expect, it } from 'vitest';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';

import { deriveClaudeTeamSidechainIds } from './deriveClaudeTeamSidechainIds';

function createToolMessage(params: {
    id: string;
    toolId?: string;
    name: string;
    state: 'running' | 'completed' | 'error';
    input?: any;
    result?: any;
}): ToolCallMessage {
    const now = Date.now();
    return {
        kind: 'tool-call',
        id: params.id,
        localId: null,
        createdAt: now,
        tool: {
            id: params.toolId,
            name: params.name,
            state: params.state,
            input: params.input ?? {},
            createdAt: now,
            startedAt: now,
            completedAt: params.state === 'running' ? null : now + 1,
            description: null,
            ...(params.result !== undefined ? { result: params.result } : {}),
        },
        children: [],
    };
}

describe('deriveClaudeTeamSidechainIds', () => {
    it('returns Task and Agent tool ids for spawned Claude teammates', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 'create',
                toolId: 'toolu_create',
                name: 'AgentTeamCreate',
                state: 'completed',
                input: { team_name: 'probe' },
                result: { ok: true },
            }),
            createToolMessage({
                id: 'task-alpha',
                toolId: 'toolu_alpha',
                name: 'Task',
                state: 'completed',
                input: { team_name: 'probe', name: 'alpha' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
            }),
            createToolMessage({
                id: 'agent-beta',
                toolId: 'toolu_beta',
                name: 'Agent',
                state: 'completed',
                input: { team_name: 'probe', name: 'beta' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'beta@probe', team_name: 'probe', name: 'beta' } },
            }),
            createToolMessage({
                id: 'plain-task',
                toolId: 'toolu_plain',
                name: 'Task',
                state: 'completed',
                input: { description: 'not a team tool' },
                result: { ok: true },
            }),
        ];

        expect(deriveClaudeTeamSidechainIds({ messages })).toEqual(['toolu_alpha', 'toolu_beta']);
    });
});
