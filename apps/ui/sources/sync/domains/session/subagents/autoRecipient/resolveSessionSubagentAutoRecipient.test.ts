import { describe, expect, it } from 'vitest';

import type { AgentTextMessage, Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';

function createAgentTextMessage(params: { id: string; text: string }): AgentTextMessage {
    return {
        kind: 'agent-text',
        id: params.id,
        localId: null,
        createdAt: Date.now(),
        text: params.text,
    };
}

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

    /**
     * The composer's auto-recipient decides where the *user's next message* goes. Prose written by
     * the subagent itself — its own summary text, or a `<status>running</status>` line it echoed —
     * must never be able to re-open routing to a run the structured payload reports as finished.
     */
    describe('prose can never resurrect a finished run (D-3, routing)', () => {
        it('ignores a running status quoted in the run result prose', async () => {
            const toolMessage = createToolMessage({
                id: 'tool-run-1',
                name: 'SubAgentRun',
                state: 'completed',
                input: { runId: 'run_1' },
                // No top-level `status`: the only "running" here is narrative text the agent wrote.
                result: { sidechainId: 'toolu_run_1', summary: 'Earlier the run reported status: running before finishing.' },
                toolExtras: { id: 'toolu_run_1' },
            });

            const recipient = await resolveAutoRecipient({
                session: { metadata: { flavor: 'codex' } },
                tool: toolMessage.tool,
                messages: [toolMessage],
            });

            expect(recipient).toBeNull();
        });

        it('ignores a running status nested inside a structured review payload', async () => {
            const toolMessage = createToolMessage({
                id: 'tool-run-1',
                name: 'SubAgentRun',
                state: 'completed',
                input: { runId: 'run_1' },
                result: {
                    sidechainId: 'toolu_run_1',
                    triage: { findings: [{ id: 'f1', status: 'running' }] },
                },
                toolExtras: { id: 'toolu_run_1' },
            });

            const recipient = await resolveAutoRecipient({
                session: { metadata: { flavor: 'codex' } },
                tool: toolMessage.tool,
                messages: [toolMessage],
            });

            expect(recipient).toBeNull();
        });

        it('ignores a status line the subagent echoed into its own transcript after the run finished', async () => {
            const toolMessage = createToolMessage({
                id: 'tool-run-1',
                name: 'SubAgentRun',
                state: 'completed',
                input: { runId: 'run_1' },
                result: { sidechainId: 'toolu_run_1', status: 'succeeded' },
                toolExtras: { id: 'toolu_run_1' },
            });

            const recipient = await resolveAutoRecipient({
                session: { metadata: { flavor: 'codex' } },
                tool: toolMessage.tool,
                messages: [toolMessage],
                focusedMessages: [
                    createAgentTextMessage({
                        id: 'sidechain-text-1',
                        text: 'Handing back the notification: <status>running</status>',
                    }),
                ],
            });

            expect(recipient).toBeNull();
        });

        it('still recovers a run whose transcript state is ambiguous rather than terminal', async () => {
            const toolMessage = createToolMessage({
                id: 'tool-run-1',
                name: 'SubAgentRun',
                state: 'error',
                input: { runId: 'run_1' },
                // The parent turn was interrupted: no outcome was ever written, so the run may still be alive.
                result: 'Request interrupted by user',
                toolExtras: { id: 'toolu_run_1' },
            });

            const recipient = await resolveAutoRecipient({
                session: { metadata: { flavor: 'codex' } },
                tool: toolMessage.tool,
                messages: [toolMessage],
                focusedMessages: [
                    createAgentTextMessage({ id: 'sidechain-text-1', text: 'Command running in background' }),
                ],
            });

            expect(recipient).toEqual({ kind: 'execution_run', runId: 'run_1' });
        });
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
