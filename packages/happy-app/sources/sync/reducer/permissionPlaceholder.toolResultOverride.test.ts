import { describe, expect, it } from 'vitest';

import { createReducer, reducer } from './reducer';
import type { NormalizedMessage } from '../typesRaw';
import type { AgentState } from '../storageTypes';

describe('Permission placeholder should not override real tool output', () => {
    it('updates an approved permission-only tool message when a tool-result arrives later (even without tool-call)', () => {
        const state = createReducer();

        const messages: NormalizedMessage[] = [
            {
                id: 'msg-tool-result',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'tool2',
                    content: { stdout: 'REAL_OUTPUT', exit_code: 0 },
                    is_error: false,
                    uuid: 'uuid-tool2',
                    parentUUID: null,
                }],
            },
        ];

        const agentState: AgentState = {
            requests: {},
            completedRequests: {
                tool2: {
                    tool: 'Write',
                    arguments: { file_path: '/tmp/a.txt', content: 'hello' },
                    status: 'approved',
                    createdAt: 1000,
                    completedAt: 1100,
                },
            },
        };

        const result = reducer(state, messages, agentState);
        const toolMsg = result.messages.find((m) => m.kind === 'tool-call' && m.tool?.permission?.id === 'tool2');
        expect(toolMsg).toBeTruthy();
        expect(toolMsg?.kind).toBe('tool-call');
        if (toolMsg?.kind !== 'tool-call') return;

        expect(toolMsg.tool?.state).toBe('completed');
        expect(toolMsg.tool?.result).toMatchObject({ stdout: 'REAL_OUTPUT', exit_code: 0 });
    });
});

