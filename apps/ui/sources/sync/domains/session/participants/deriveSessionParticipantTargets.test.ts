import { describe, expect, it } from 'vitest';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';

import { deriveAutoRecipientFromFocusedToolTranscript, deriveSessionParticipantTargets } from './deriveSessionParticipantTargets';

function createToolMessage(params: {
    id: string;
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

describe('deriveSessionParticipantTargets', () => {
    it('includes running execution runs derived from SubAgentRun tool calls', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 'm1',
                name: 'SubAgentRun',
                state: 'running',
                input: { runId: 'run_1' },
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });

        expect(targets.some((t) => t.recipient.kind === 'execution_run' && t.recipient.runId === 'run_1')).toBe(true);
    });

    it('includes execution runs for SubAgentRun tools with abort-like errors (e.g. Request interrupted)', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 'm1',
                name: 'SubAgentRun',
                state: 'error',
                input: { runId: 'run_1' },
                result: { error: 'Request interrupted' },
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });

        expect(targets.some((t) => t.recipient.kind === 'execution_run' && t.recipient.runId === 'run_1')).toBe(true);
    });

    it('includes claude team members and broadcast derived from AgentTeamCreate + Task teammate_spawned results', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 't1',
                name: 'AgentTeamCreate',
                state: 'completed',
                input: { team_name: 'probe', description: 'x' },
                result: { ok: true },
            }),
            createToolMessage({
                id: 'task1',
                name: 'Task',
                state: 'completed',
                input: { description: 'spawn' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });

        expect(targets.some((t) => t.recipient.kind === 'agent_team_member' && t.recipient.memberId === 'alpha@probe' && t.recipient.teamId === 'probe')).toBe(true);
        expect(targets.some((t) => t.recipient.kind === 'agent_team_broadcast' && t.recipient.teamId === 'probe')).toBe(true);
    });

    it('includes claude team members and broadcast even when session flavor is missing (derived from tool names)', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 't1',
                name: 'AgentTeamCreate',
                state: 'completed',
                input: { team_name: 'probe', description: 'x' },
                result: { ok: true },
            }),
            createToolMessage({
                id: 'task1',
                name: 'Task',
                state: 'completed',
                input: { description: 'spawn' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: null } } as any,
            messages,
        });

        expect(targets.some((t) => t.recipient.kind === 'agent_team_member' && t.recipient.memberId === 'alpha@probe' && t.recipient.teamId === 'probe')).toBe(true);
        expect(targets.some((t) => t.recipient.kind === 'agent_team_broadcast' && t.recipient.teamId === 'probe')).toBe(true);
    });

    it('includes claude team members derived from Agent teammate_spawned tool results', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 't1',
                name: 'AgentTeamCreate',
                state: 'completed',
                input: { team_name: 'probe', description: 'x' },
                result: { ok: true },
            }),
            createToolMessage({
                id: 'agent1',
                name: 'Agent',
                state: 'completed',
                input: { name: 'Alpha', team_name: 'probe' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'Alpha', color: 'blue' } },
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });

        const member = targets.find((t) => t.recipient.kind === 'agent_team_member' && t.recipient.memberId === 'alpha@probe' && t.recipient.teamId === 'probe') as any;
        expect(Boolean(member)).toBe(true);
        expect(member.accentName).toBe('blue');
        expect(targets.some((t) => t.recipient.kind === 'agent_team_broadcast' && t.recipient.teamId === 'probe')).toBe(true);
    });

    it('includes claude team members derived from Task input when tool result is missing', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 't1',
                name: 'AgentTeamCreate',
                state: 'completed',
                input: { team_name: 'probe', description: 'x' },
                result: { ok: true },
            }),
            createToolMessage({
                id: 'task1',
                name: 'Task',
                state: 'completed',
                input: { team_name: 'probe', name: 'beta', description: 'Implement teammate Beta' },
                result: undefined,
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });

        expect(targets.some((t) => t.recipient.kind === 'agent_team_member' && t.recipient.memberId === 'beta@probe' && t.recipient.teamId === 'probe')).toBe(true);
        expect(targets.some((t) => t.recipient.kind === 'agent_team_broadcast' && t.recipient.teamId === 'probe')).toBe(true);
    });

    it('includes claude team members derived from Task tool result text containing agent_id and team_name inline', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 't1',
                name: 'AgentTeamCreate',
                state: 'completed',
                input: { team_name: 'probe', description: 'x' },
                result: { ok: true },
            }),
            createToolMessage({
                id: 'task1',
                name: 'Task',
                state: 'completed',
                input: { description: 'spawn' },
                result: {
                    content: [
                        {
                            type: 'text',
                            text: 'Spawned successfully. agent_id: alpha@probe name: alpha team_name: probe The agent is now running.',
                        },
                    ],
                },
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });

        expect(targets.some((t) => t.recipient.kind === 'agent_team_member' && t.recipient.memberId === 'alpha@probe' && t.recipient.teamId === 'probe')).toBe(true);
    });

    it('includes a claude team broadcast derived from TeamCreate (before any teammates spawn)', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 't1',
                name: 'TeamCreate',
                state: 'completed',
                input: { team_name: 'probe', description: 'x' },
                result: { ok: true },
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });

        expect(targets.some((t) => t.recipient.kind === 'agent_team_broadcast' && t.recipient.teamId === 'probe')).toBe(true);
    });
});

describe('deriveAutoRecipientFromFocusedToolTranscript', () => {
    it('returns execution_run recipient for focused SubAgentRun tool while running', () => {
        const toolMsg = createToolMessage({
            id: 'm1',
            name: 'SubAgentRun',
            state: 'running',
            input: { runId: 'run_1' },
        });
        const auto = deriveAutoRecipientFromFocusedToolTranscript({
            session: { metadata: { flavor: 'claude' } } as any,
            tool: toolMsg.tool,
            messages: [],
        });
        expect(auto?.kind).toBe('execution_run');
        expect((auto as any)?.runId).toBe('run_1');
    });

    it('returns execution_run recipient for focused SubAgentRun tool with abort-like errors', () => {
        const toolMsg = createToolMessage({
            id: 'm1',
            name: 'SubAgentRun',
            state: 'error',
            input: { runId: 'run_1' },
            result: { error: 'Request interrupted' },
        });
        const auto = deriveAutoRecipientFromFocusedToolTranscript({
            session: { metadata: { flavor: 'claude' } } as any,
            tool: toolMsg.tool,
            messages: [],
        });
        expect(auto?.kind).toBe('execution_run');
        expect((auto as any)?.runId).toBe('run_1');
    });

    it('returns agent_team_member recipient for focused Task tool with teammate_spawned result (claude)', () => {
        const toolMsg = createToolMessage({
            id: 'm1',
            name: 'Task',
            state: 'completed',
            result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
        });
        const auto = deriveAutoRecipientFromFocusedToolTranscript({
            session: { metadata: { flavor: 'claude' } } as any,
            tool: toolMsg.tool,
            messages: [],
        });
        expect(auto?.kind).toBe('agent_team_member');
        expect((auto as any)?.teamId).toBe('probe');
        expect((auto as any)?.memberId).toBe('alpha@probe');
    });

    it('returns agent_team_member recipient for focused Agent tool with teammate_spawned result (claude)', () => {
        const toolMsg = createToolMessage({
            id: 'm1',
            name: 'Agent',
            state: 'completed',
            result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'Alpha' } },
        });
        const auto = deriveAutoRecipientFromFocusedToolTranscript({
            session: { metadata: { flavor: 'claude' } } as any,
            tool: toolMsg.tool,
            messages: [],
        });
        expect(auto?.kind).toBe('agent_team_member');
        expect((auto as any)?.teamId).toBe('probe');
        expect((auto as any)?.memberId).toBe('alpha@probe');
    });

    it('returns agent_team_member recipient for focused Agent tool when teammate identity is only in tool input (claude)', () => {
        const toolMsg = createToolMessage({
            id: 'm1',
            name: 'Agent',
            state: 'running',
            input: { team_name: 'probe', name: 'Alpha' },
            result: null,
        });
        const auto = deriveAutoRecipientFromFocusedToolTranscript({
            session: { metadata: { flavor: 'claude' } } as any,
            tool: toolMsg.tool,
            messages: [],
        });
        expect(auto?.kind).toBe('agent_team_member');
        expect((auto as any)?.teamId).toBe('probe');
        expect((auto as any)?.memberId).toBe('Alpha@probe');
        expect((auto as any)?.memberLabel).toBe('Alpha');
    });

    it('returns agent_team_member recipient for focused Agent tool when tool input uses `team` instead of `team_name` (claude)', () => {
        const toolMsg = createToolMessage({
            id: 'm1',
            name: 'Agent',
            state: 'running',
            input: { team: 'probe', name: 'Alpha' },
            result: null,
        });
        const auto = deriveAutoRecipientFromFocusedToolTranscript({
            session: { metadata: { flavor: 'claude' } } as any,
            tool: toolMsg.tool,
            messages: [],
        });
        expect(auto?.kind).toBe('agent_team_member');
        expect((auto as any)?.teamId).toBe('probe');
        expect((auto as any)?.memberId).toBe('Alpha@probe');
        expect((auto as any)?.memberLabel).toBe('Alpha');
    });

    it('returns agent_team_member recipient for focused Agent tool by inferring teamId from transcript when tool input omits it (claude)', () => {
        const toolMsg = createToolMessage({
            id: 'm1',
            name: 'Agent',
            state: 'running',
            input: { name: 'Alpha' },
            result: null,
        });
        const auto = deriveAutoRecipientFromFocusedToolTranscript({
            session: { metadata: { flavor: 'claude' } } as any,
            tool: toolMsg.tool,
            messages: [
                createToolMessage({
                    id: 'm_team',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'probe' },
                }),
            ],
        });
        expect(auto?.kind).toBe('agent_team_member');
        expect((auto as any)?.teamId).toBe('probe');
        expect((auto as any)?.memberId).toBe('Alpha@probe');
        expect((auto as any)?.memberLabel).toBe('Alpha');
    });

    it('returns agent_team_member recipient for focused Task tool with teammate_spawned result even when session flavor is missing', () => {
        const toolMsg = createToolMessage({
            id: 'm1',
            name: 'Task',
            state: 'completed',
            result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
        });
        const auto = deriveAutoRecipientFromFocusedToolTranscript({
            session: { metadata: { flavor: null } } as any,
            tool: toolMsg.tool,
            messages: [],
        });
        expect(auto?.kind).toBe('agent_team_member');
        expect((auto as any)?.teamId).toBe('probe');
        expect((auto as any)?.memberId).toBe('alpha@probe');
    });
});
