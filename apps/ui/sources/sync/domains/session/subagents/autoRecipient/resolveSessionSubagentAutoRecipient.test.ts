import { describe, expect, it } from 'vitest';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';

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

async function resolveAutoRecipient(params: {
    session: any;
    tool: ToolCallMessage['tool'];
    messages: readonly Message[];
    activeExecutionRuns?: readonly { runId: string; status?: string | null }[];
    focusedMessages?: readonly Message[];
}) {
    const module = await import('./resolveSessionSubagentAutoRecipient');
    return module.resolveSessionSubagentAutoRecipient(params);
}

describe('resolveSessionSubagentAutoRecipient', () => {
    it('resolves running execution runs through the execution-run descriptor', async () => {
        const toolMessage = createToolMessage({
            id: 'tool-run-1',
            name: 'SubAgentRun',
            state: 'running',
            input: { runId: 'run_1' },
            result: { sidechainId: 'toolu_run_1' },
            toolExtras: { id: 'toolu_run_1' },
        });

        const recipient = await resolveAutoRecipient({
            session: { metadata: { flavor: 'codex' } },
            tool: toolMessage.tool,
            messages: [toolMessage],
        });

        expect(recipient).toEqual({
            kind: 'execution_run',
            runId: 'run_1',
        });
    });

    it('refuses to address a finished run that later prose still calls running', async () => {
        const toolMessage = createToolMessage({
            id: 'tool-run-done',
            name: 'SubAgentRun',
            state: 'completed',
            input: { runId: 'run_dddd4444ee' },
            result: { runId: 'run_dddd4444ee', status: 'succeeded' },
            toolExtras: { id: 'toolu_run_done' },
        });

        const recipient = await resolveAutoRecipient({
            session: { metadata: { flavor: 'codex' } },
            tool: toolMessage.tool,
            messages: [toolMessage],
            focusedMessages: [
                toolMessage,
                { kind: 'agent-text', id: 'text-1', localId: null, createdAt: Date.now(), text: 'Checked in: <status>running</status>' } as unknown as Message,
            ],
        });

        expect(recipient).toBeNull();
    });

    it('still addresses a run whose call was interrupted, matching the roster that keeps it ambiguous', async () => {
        const toolMessage = createToolMessage({
            id: 'tool-run-interrupted',
            name: 'SubAgentRun',
            state: 'error',
            input: { runId: 'run_eeee5555ff' },
            result: { runId: 'run_eeee5555ff', status: 'aborted', detail: 'Request interrupted by user' },
            toolExtras: { id: 'toolu_run_interrupted' },
        });
        const messages = [toolMessage];

        const { deriveSessionSubagents } = await import('../deriveSessionSubagents');
        const rosterStatus = deriveSessionSubagents({ session: { metadata: { flavor: 'codex' } } as any, messages })
            .find((subagent) => subagent.runRef?.runId === 'run_eeee5555ff')?.status;

        const recipient = await resolveAutoRecipient({
            session: { metadata: { flavor: 'codex' } },
            tool: toolMessage.tool,
            messages,
            focusedMessages: [
                toolMessage,
                { kind: 'agent-text', id: 'text-1', localId: null, createdAt: Date.now(), text: 'The background task is already running.' } as unknown as Message,
            ],
        });

        expect(rosterStatus).toBe('unknown');
        expect(recipient).toEqual({ kind: 'execution_run', runId: 'run_eeee5555ff' });
    });

    it('refuses to address a voice-agent run the roster also refuses as a recipient', async () => {
        const toolMessage = createToolMessage({
            id: 'tool-run-voice',
            name: 'SubAgentRun',
            state: 'running',
            input: { runId: 'run_ffff6666aa', intent: 'voice_agent' },
            result: { sidechainId: 'toolu_run_voice' },
            toolExtras: { id: 'toolu_run_voice' },
        });

        const recipient = await resolveAutoRecipient({
            session: { metadata: { flavor: 'codex' } },
            tool: toolMessage.tool,
            messages: [toolMessage],
        });

        expect(recipient).toBeNull();
    });

    it('resolves Claude teammate recipients through the Claude descriptor when team identity is inferred from transcript history', async () => {
        const agentMessage = createToolMessage({
            id: 'tool-agent-1',
            name: 'Agent',
            state: 'running',
            input: { name: 'Alpha' },
            toolExtras: { id: 'toolu_agent_1' },
        });

        const recipient = await resolveAutoRecipient({
            session: { metadata: { flavor: 'claude' } },
            tool: agentMessage.tool,
            messages: [
                createToolMessage({
                    id: 'team-create',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'probe' },
                }),
                agentMessage,
            ],
        });

        expect(recipient).toEqual({
            kind: 'agent_team_member',
            teamId: 'probe',
            memberId: 'Alpha@probe',
            memberLabel: 'Alpha',
        });
    });
});
