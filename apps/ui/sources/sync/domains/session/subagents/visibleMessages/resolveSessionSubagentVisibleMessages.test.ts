import { describe, expect, it } from 'vitest';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';

function createToolMessage(params: {
    id: string;
    name: string;
    state: 'running' | 'completed' | 'error';
    input?: any;
    result?: any;
    toolExtras?: Record<string, unknown>;
    children?: readonly Message[];
}): ToolCallMessage {
    const now = Date.now();
    return {
        kind: 'tool-call',
        id: params.id,
        localId: null,
        createdAt: now,
        children: [...(params.children ?? [])],
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
    };
}

function createAgentTextMessage(id: string, text: string): Message {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt: Date.now(),
        text,
        meta: undefined,
    };
}

async function resolveVisibleMessages(params: {
    session: any;
    tool: ToolCallMessage['tool'];
    messages: readonly Message[];
    focusedMessages?: readonly Message[];
    activeExecutionRuns?: readonly { runId: string; status?: string | null }[];
}) {
    const module = await import('./resolveSessionSubagentVisibleMessages');
    return module.resolveSessionSubagentVisibleMessages(params);
}

describe('resolveSessionSubagentVisibleMessages', () => {
    it('filters ignored Claude teammate lifecycle events from focused transcript messages', async () => {
        const focusedMessages = [
            createAgentTextMessage('m1', 'Meaningful teammate output'),
            createAgentTextMessage('m2', '{"type":"idle_notification","from":"beta"}'),
            createAgentTextMessage('m3', '{"type":"shutdown_approved","from":"beta"}'),
        ] satisfies readonly Message[];
        const agentMessage = createToolMessage({
            id: 'tool-agent-1',
            name: 'Agent',
            state: 'completed',
            input: { name: 'beta' },
            toolExtras: { id: 'toolu_beta' },
            children: focusedMessages,
        });

        const visibleMessages = await resolveVisibleMessages({
            session: { metadata: { flavor: 'claude' } },
            tool: agentMessage.tool,
            focusedMessages,
            messages: [
                createToolMessage({
                    id: 'team-create',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'qa121482' },
                }),
                agentMessage,
            ],
        });

        expect(visibleMessages).toEqual([
            expect.objectContaining({
                id: 'm1',
                text: 'Meaningful teammate output',
            }),
        ]);
    });

    it('keeps execution-run focused messages unchanged', async () => {
        const focusedMessages = [
            createAgentTextMessage('m1', '{"type":"shutdown_approved","from":"beta"}'),
        ] satisfies readonly Message[];
        const runMessage = createToolMessage({
            id: 'tool-run-1',
            name: 'SubAgentRun',
            state: 'running',
            input: { runId: 'run_1' },
            toolExtras: { id: 'toolu_run_1' },
            children: focusedMessages,
        });

        const visibleMessages = await resolveVisibleMessages({
            session: { metadata: { flavor: 'codex' } },
            tool: runMessage.tool,
            focusedMessages,
            messages: [runMessage],
        });

        expect(visibleMessages).toEqual(focusedMessages);
    });
});
