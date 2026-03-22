import { describe, expect, it } from 'vitest';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';

import { deriveExecutionRunPollingRefreshKey } from './deriveExecutionRunPollingRefreshKey';

function createToolMessage(params: {
    id: string;
    name: string;
    state: 'running' | 'completed' | 'error';
    input?: any;
    result?: any;
    toolExtras?: Record<string, unknown>;
}): ToolCallMessage {
    const now = Date.now();
    return {
        kind: 'tool-call',
        id: params.id,
        localId: null,
        createdAt: now,
        tool: {
            name: params.name,
            state: params.state,
            input: params.input ?? {},
            createdAt: now,
            startedAt: now,
            completedAt: params.state === 'running' ? null : now + 1,
            description: null,
            ...(params.result !== undefined ? { result: params.result } : {}),
            ...(params.toolExtras ?? {}),
        },
        children: [],
    };
}

describe('deriveExecutionRunPollingRefreshKey', () => {
    it('includes run ids exposed by execution-run start tool results', () => {
        const key = deriveExecutionRunPollingRefreshKey([
            createToolMessage({
                id: 'start-1',
                name: 'MCP: Happier Delegate Start',
                state: 'completed',
                result: {
                    content: [
                        {
                            type: 'text',
                            text:
                                'RUN_A=run_22d45bf4-bbea-426a-a9b4-74e004272ce5\n'
                                + 'RUN_B=run_1566b9d7-a556-4773-aa2f-2dec0b596af5',
                        },
                    ],
                },
            }),
        ] satisfies Message[]);

        expect(key).toContain('run_22d45bf4-bbea-426a-a9b4-74e004272ce5');
        expect(key).toContain('run_1566b9d7-a556-4773-aa2f-2dec0b596af5');
    });

    it('changes when stop and subagent signals change', () => {
        const before = deriveExecutionRunPollingRefreshKey([
            createToolMessage({
                id: 'subagent-1',
                name: 'SubAgentRun',
                state: 'running',
                input: { runId: 'run_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
            }),
        ] satisfies Message[]);

        const after = deriveExecutionRunPollingRefreshKey([
            createToolMessage({
                id: 'subagent-1',
                name: 'SubAgentRun',
                state: 'running',
                input: { runId: 'run_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
            }),
            createToolMessage({
                id: 'stop-1',
                name: 'MCP: Happier Execution Run Stop',
                state: 'completed',
                input: { runId: 'run_ffffffff-1111-2222-3333-444444444444' },
                result: { ok: true },
            }),
        ] satisfies Message[]);

        expect(after).not.toBe(before);
        expect(after).toContain('run_ffffffff-1111-2222-3333-444444444444');
    });

    it('includes transcript tool ids exposed by SubAgent transcript tool calls', () => {
        const key = deriveExecutionRunPollingRefreshKey([
            createToolMessage({
                id: 'subagent-legacy-1',
                name: 'SubAgent',
                state: 'running',
                input: { label: 'legacy' },
                result: { status: 'running' },
                toolExtras: { id: 'tool_subagent_legacy_1' },
            }),
        ] satisfies Message[]);

        expect(key).toContain('tool_subagent_legacy_1');
    });
});
