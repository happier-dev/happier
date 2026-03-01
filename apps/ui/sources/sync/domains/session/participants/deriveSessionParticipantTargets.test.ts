import { describe, expect, it } from 'vitest';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';

import { deriveAutoRecipientFromFocusedToolTranscript, deriveSessionParticipantTargets } from './deriveSessionParticipantTargets';

function createToolMessage(params: {
    id: string;
    name: string;
    state: 'running' | 'completed' | 'error';
    seq?: number;
    input?: any;
    result?: any;
    children?: Message[];
    toolExtras?: Record<string, unknown>;
}): ToolCallMessage {
    const now = Date.now();
    return {
        kind: 'tool-call',
        id: params.id,
        ...(typeof params.seq === 'number' ? { seq: params.seq } : {}),
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
        children: params.children ?? [],
    };
}

function createAgentTextMessage(params: { id: string; text: string; seq?: number }): Message {
    return {
        kind: 'agent-text',
        id: params.id,
        ...(typeof params.seq === 'number' ? { seq: params.seq } : {}),
        localId: null,
        createdAt: Date.now(),
        text: params.text,
    } as Message;
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

    it('excludes execution runs for interrupted SubAgentRun tools when there is no prior running signal', () => {
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

        expect(targets.some((t) => t.recipient.kind === 'execution_run' && t.recipient.runId === 'run_1')).toBe(false);
    });

    it('includes execution runs from external running state when transcript only shows interrupted SubAgentRun', () => {
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
            activeExecutionRuns: [{ runId: 'run_1', status: 'running' }],
        });

        expect(targets.some((t) => t.recipient.kind === 'execution_run' && t.recipient.runId === 'run_1')).toBe(true);
    });

    it('includes execution runs when transcript reports run start text with run id and SubAgentRun is interrupted', () => {
        const runId = 'run_12345678';
        const messages: Message[] = [
            createToolMessage({
                id: 'm1',
                name: 'SubAgentRun',
                state: 'error',
                input: { runId },
                result: { error: 'Request interrupted' },
            }),
            createAgentTextMessage({
                id: 'agent-start-1',
                text: `The long-lived execution run has been started.\\n- Run ID: ${runId}\\n- Backend: claude`,
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });

        expect(targets.some((t) => t.recipient.kind === 'execution_run' && t.recipient.runId === runId)).toBe(true);
    });

    it('excludes bounded execution runs from start-text fallback when interrupted transcript has no active-running confirmation', () => {
        const runId = 'run_bounded_12345678';
        const messages: Message[] = [
            createToolMessage({
                id: 'm1',
                name: 'SubAgentRun',
                state: 'error',
                input: { runId, runClass: 'bounded' },
                result: { error: 'Request interrupted' },
            }),
            createAgentTextMessage({
                id: 'agent-start-bounded-1',
                text: `Bounded execution run started and running.\nRun ID: ${runId}`,
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });

        expect(targets.some((t) => t.recipient.kind === 'execution_run' && t.recipient.runId === runId)).toBe(false);
    });

    it('includes bounded interrupted execution runs when external active-running state confirms them', () => {
        const runId = 'run_bounded_23456789';
        const messages: Message[] = [
            createToolMessage({
                id: 'm1',
                name: 'SubAgentRun',
                state: 'error',
                input: { runId, runClass: 'bounded' },
                result: { error: 'Request interrupted' },
            }),
            createAgentTextMessage({
                id: 'agent-start-bounded-2',
                text: `Bounded execution run started and running.\nRun ID: ${runId}`,
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
            activeExecutionRuns: [{ runId, status: 'running' }],
        });

        expect(targets.some((t) => t.recipient.kind === 'execution_run' && t.recipient.runId === runId)).toBe(true);
    });

    it('keeps execution runs targetable when an interrupted SubAgentRun follows a running signal for the same run', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 'm1',
                name: 'SubAgentRun',
                state: 'running',
                input: { runId: 'run_1' },
            }),
            createToolMessage({
                id: 'm2',
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

    it('excludes execution runs that were explicitly stopped via tool call', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 'm1',
                name: 'SubAgentRun',
                state: 'running',
                input: { runId: 'run_1' },
            }),
            createToolMessage({
                id: 'stop-1',
                name: 'MCP: Happier Execution Run Stop',
                state: 'completed',
                input: { runId: 'run_1' },
                result: {
                    content: [
                        {
                            type: 'text',
                            text: '{"ok":true}',
                        },
                    ],
                },
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });

        expect(targets.some((t) => t.recipient.kind === 'execution_run' && t.recipient.runId === 'run_1')).toBe(false);
    });

    it('excludes execution runs when stop tool result embeds escaped ok payload text', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 'm1',
                name: 'SubAgentRun',
                state: 'running',
                input: { runId: 'run_escaped' },
            }),
            createToolMessage({
                id: 'stop-escaped',
                name: 'MCP: Happier Execution Run Stop',
                state: 'completed',
                input: { runId: 'run_escaped' },
                result: {
                    content: [{ type: 'text', text: '{\\"ok\\":true}' }],
                    tool_use_result: [{ type: 'text', text: '{\\"ok\\":true}' }],
                },
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });

        expect(targets.some((t) => t.recipient.kind === 'execution_run' && t.recipient.runId === 'run_escaped')).toBe(false);
    });

    it('excludes execution runs when stop tool reports not running', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 'm1',
                name: 'SubAgentRun',
                state: 'running',
                input: { runId: 'run_not_running' },
            }),
            createToolMessage({
                id: 'stop-not-running',
                name: 'MCP: Happier Execution Run Stop',
                state: 'completed',
                input: { runId: 'run_not_running' },
                result: {
                    content: [
                        {
                            type: 'text',
                            text: '{\\"ok\\":false,\\"error\\":\\"Not running\\",\\"errorCode\\":\\"execution_run_not_allowed\\"}',
                        },
                    ],
                    tool_use_result: [
                        {
                            type: 'text',
                            text: '{\\"ok\\":false,\\"error\\":\\"Not running\\",\\"errorCode\\":\\"execution_run_not_allowed\\"}',
                        },
                    ],
                },
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });

        expect(targets.some((t) => t.recipient.kind === 'execution_run' && t.recipient.runId === 'run_not_running')).toBe(false);
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

    it('includes claude team members when Agent tool result arrives as a JSON string payload', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 't1',
                name: 'AgentTeamCreate',
                state: 'completed',
                input: { team_name: 'repo-inspectors', description: 'x' },
                result: { ok: true },
            }),
            createToolMessage({
                id: 'agent1',
                name: 'Agent',
                state: 'completed',
                input: { name: 'readme-inspector' },
                result:
                    '{"content":[{"type":"text","text":"Spawned successfully.\\nagent_id: readme-inspector@snoopy-splashing-patterson\\nname: readme-inspector\\nteam_name: snoopy-splashing-patterson\\nThe agent is now running and will receive instructions via mailbox."}],"tool_use_result":{"status":"teammate_spawned","teammate_id":"readme-inspector@snoopy-splashing-patterson","agent_id":"readme-inspector@snoopy-splashing-patterson","name":"readme-inspector","color":"blue","team_name":"snoopy-splashing-patterson"}}',
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });

        expect(
            targets.some(
                (t) =>
                    t.recipient.kind === 'agent_team_member' &&
                    t.recipient.memberId === 'readme-inspector@snoopy-splashing-patterson',
            ),
        ).toBe(true);
        expect(targets.some((t) => t.recipient.kind === 'agent_team_broadcast' && t.recipient.teamId === 'repo-inspectors')).toBe(true);
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

    it('keeps the existing claude team broadcast when a later AgentTeamCreate attempt fails', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 'create-initial',
                name: 'AgentTeamCreate',
                state: 'completed',
                input: { team_name: 'probe' },
                result: { ok: true },
            }),
            createToolMessage({
                id: 'spawn-alpha',
                name: 'Agent',
                state: 'completed',
                input: { name: 'alpha', team_name: 'probe' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
            }),
            createToolMessage({
                id: 'create-failed',
                name: 'AgentTeamCreate',
                state: 'completed',
                input: { team_name: 'probe-next' },
                result: {
                    content: 'Already leading team "probe". A leader can only manage one team at a time.',
                    tool_use_result: 'Error: Already leading team "probe".',
                },
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });

        expect(targets.some((t) => t.recipient.kind === 'agent_team_broadcast' && t.recipient.teamId === 'probe')).toBe(true);
        expect(targets.some((t) => t.recipient.kind === 'agent_team_broadcast' && t.recipient.teamId === 'probe-next')).toBe(false);
        expect(
            targets.some(
                (t) =>
                    t.recipient.kind === 'agent_team_member'
                    && t.recipient.teamId === 'probe'
                    && t.recipient.memberId === 'alpha@probe',
            ),
        ).toBe(true);
    });

    it('removes broadcast and members after AgentTeamDelete for the same team', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 'create1',
                name: 'AgentTeamCreate',
                state: 'completed',
                input: { team_name: 'probe' },
                result: { ok: true },
            }),
            createToolMessage({
                id: 'agent1',
                name: 'Agent',
                state: 'completed',
                input: { name: 'Alpha', team_name: 'probe' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'Alpha' } },
            }),
            createToolMessage({
                id: 'delete1',
                name: 'AgentTeamDelete',
                state: 'completed',
                input: { team_name: 'probe' },
                result: { ok: true },
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });

        expect(targets.some((t) => t.recipient.kind === 'agent_team_broadcast' && t.recipient.teamId === 'probe')).toBe(false);
        expect(targets.some((t) => t.recipient.kind === 'agent_team_member' && t.recipient.teamId === 'probe')).toBe(false);
    });

    it('removes only targeted teammate when AgentTeamDelete includes teammate identity', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 'create1',
                name: 'AgentTeamCreate',
                state: 'completed',
                input: { team_name: 'probe' },
                result: { ok: true },
            }),
            createToolMessage({
                id: 'agent1',
                name: 'Agent',
                state: 'completed',
                input: { name: 'Alpha', team_name: 'probe' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'Alpha@probe', team_name: 'probe', name: 'Alpha' } },
            }),
            createToolMessage({
                id: 'agent2',
                name: 'Agent',
                state: 'completed',
                input: { name: 'Beta', team_name: 'probe' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'Beta@probe', team_name: 'probe', name: 'Beta' } },
            }),
            createToolMessage({
                id: 'delete-member',
                name: 'AgentTeamDelete',
                state: 'completed',
                input: { team_name: 'probe', name: 'Beta' },
                result: { ok: true },
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });

        expect(targets.some((t) => t.recipient.kind === 'agent_team_member' && t.recipient.memberId === 'Alpha@probe')).toBe(true);
        expect(targets.some((t) => t.recipient.kind === 'agent_team_member' && t.recipient.memberId === 'Beta@probe')).toBe(false);
        expect(targets.some((t) => t.recipient.kind === 'agent_team_broadcast' && t.recipient.teamId === 'probe')).toBe(true);
    });

    it('removes teammate when Agent sidechain reports shutdown_approved', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 'create1',
                name: 'AgentTeamCreate',
                state: 'completed',
                input: { team_name: 'probe' },
                result: { ok: true },
            }),
            createToolMessage({
                id: 'agent1',
                name: 'Agent',
                state: 'completed',
                input: { name: 'Alpha', team_name: 'probe' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'Alpha@probe', team_name: 'probe', name: 'Alpha' } },
            }),
            createToolMessage({
                id: 'agent2',
                name: 'Agent',
                state: 'completed',
                input: { name: 'Beta', team_name: 'probe' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'Beta@probe', team_name: 'probe', name: 'Beta' } },
                toolExtras: {
                    messages: [
                        {
                            kind: 'agent-text',
                            text: '{"type":"shutdown_approved","from":"Beta","timestamp":"2026-03-01T07:27:19.960Z"}',
                        },
                    ],
                },
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });

        expect(targets.some((t) => t.recipient.kind === 'agent_team_member' && t.recipient.memberId === 'Alpha@probe')).toBe(true);
        expect(targets.some((t) => t.recipient.kind === 'agent_team_member' && t.recipient.memberId === 'Beta@probe')).toBe(false);
        expect(targets.some((t) => t.recipient.kind === 'agent_team_broadcast' && t.recipient.teamId === 'probe')).toBe(true);
    });

    it('removes teammate when Agent sidechain shutdown_approved is emitted as tool-call children', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 'create1',
                name: 'AgentTeamCreate',
                state: 'completed',
                input: { team_name: 'probe' },
                result: { ok: true },
            }),
            createToolMessage({
                id: 'agent1',
                name: 'Agent',
                state: 'completed',
                input: { name: 'Alpha', team_name: 'probe' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'Alpha@probe', team_name: 'probe', name: 'Alpha' } },
            }),
            createToolMessage({
                id: 'agent2',
                name: 'Agent',
                state: 'completed',
                input: { name: 'Beta', team_name: 'probe' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'Beta@probe', team_name: 'probe', name: 'Beta' } },
                children: [
                    {
                        kind: 'agent-text',
                        id: 'child1',
                        localId: null,
                        createdAt: Date.now(),
                        text: '{"type":"shutdown_approved","from":"Beta","timestamp":"2026-03-01T10:24:03.984Z"}',
                    },
                ],
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });

        expect(targets.some((t) => t.recipient.kind === 'agent_team_member' && t.recipient.memberId === 'Alpha@probe')).toBe(true);
        expect(targets.some((t) => t.recipient.kind === 'agent_team_member' && t.recipient.memberId === 'Beta@probe')).toBe(false);
        expect(targets.some((t) => t.recipient.kind === 'agent_team_broadcast' && t.recipient.teamId === 'probe')).toBe(true);
    });

    it('removes teammate when team config edit removes agentId from members list', () => {
        const messages: Message[] = [
            createToolMessage({
                id: 'create1',
                name: 'AgentTeamCreate',
                state: 'completed',
                seq: 1,
                input: { team_name: 'qa-live' },
                result: { ok: true },
            }),
            createToolMessage({
                id: 'agent-alpha',
                name: 'Agent',
                state: 'completed',
                seq: 2,
                input: { name: 'alpha', team_name: 'qa-live' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha', team_name: 'qa-live', name: 'alpha' } },
            }),
            createToolMessage({
                id: 'agent-beta',
                name: 'Agent',
                state: 'completed',
                seq: 3,
                input: { name: 'beta', team_name: 'qa-live' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'beta', team_name: 'qa-live', name: 'beta' } },
            }),
            createToolMessage({
                id: 'edit-config',
                name: 'Edit',
                state: 'completed',
                seq: 4,
                input: {
                    file_path: '/Users/leeroy/.claude/teams/qa-live/config.json',
                    old_string: '{\"agentId\":\"beta@qa-live\"}',
                    new_string: '{}',
                },
                result: { content: 'updated' },
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages,
        });
        const memberIds = targets
            .filter((t) => t.recipient.kind === 'agent_team_member')
            .map((t) => (t.recipient as any).memberId);

        expect(memberIds.includes('alpha')).toBe(true);
        expect(memberIds.includes('beta')).toBe(false);
        expect(targets.some((t) => t.recipient.kind === 'agent_team_broadcast' && t.recipient.teamId === 'qa-live')).toBe(true);
    });

    it('keeps teammate removals when transcript tool messages arrive newest-first', () => {
        const newestFirstMessages: Message[] = [
            createToolMessage({
                id: 'edit-config',
                name: 'Edit',
                state: 'completed',
                seq: 4,
                input: {
                    file_path: '/Users/leeroy/.claude/teams/qa-live/config.json',
                    old_string: '{\"agentId\":\"beta@qa-live\"}',
                    new_string: '{}',
                },
                result: { content: 'updated' },
            }),
            createToolMessage({
                id: 'agent-beta',
                name: 'Agent',
                state: 'completed',
                seq: 3,
                input: { name: 'beta', team_name: 'qa-live' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'beta', team_name: 'qa-live', name: 'beta' } },
            }),
            createToolMessage({
                id: 'agent-alpha',
                name: 'Agent',
                state: 'completed',
                seq: 2,
                input: { name: 'alpha', team_name: 'qa-live' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha', team_name: 'qa-live', name: 'alpha' } },
            }),
            createToolMessage({
                id: 'create1',
                name: 'AgentTeamCreate',
                state: 'completed',
                seq: 1,
                input: { team_name: 'qa-live' },
                result: { ok: true },
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages: newestFirstMessages,
        });

        expect(targets.some((t) => t.recipient.kind === 'agent_team_member' && t.recipient.memberId === 'alpha')).toBe(true);
        expect(targets.some((t) => t.recipient.kind === 'agent_team_member' && t.recipient.memberId === 'beta')).toBe(false);
    });

    it('keeps teammate removals when transcript has no seq and arrives newest-first', () => {
        const newestFirstMessages: Message[] = [
            createToolMessage({
                id: 'edit-config',
                name: 'Edit',
                state: 'completed',
                input: {
                    file_path: '/Users/leeroy/.claude/teams/qa-live/config.json',
                    old_string: '{\"agentId\":\"beta@qa-live\"}',
                    new_string: '{}',
                },
                result: { content: 'updated' },
            }),
            createToolMessage({
                id: 'agent-beta',
                name: 'Agent',
                state: 'completed',
                input: { name: 'beta', team_name: 'qa-live' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'beta', team_name: 'qa-live', name: 'beta' } },
            }),
            createToolMessage({
                id: 'agent-alpha',
                name: 'Agent',
                state: 'completed',
                input: { name: 'alpha', team_name: 'qa-live' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha', team_name: 'qa-live', name: 'alpha' } },
            }),
            createToolMessage({
                id: 'create1',
                name: 'AgentTeamCreate',
                state: 'completed',
                input: { team_name: 'qa-live' },
                result: { ok: true },
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages: newestFirstMessages,
        });

        expect(targets.some((t) => t.recipient.kind === 'agent_team_member' && t.recipient.memberId === 'alpha')).toBe(true);
        expect(targets.some((t) => t.recipient.kind === 'agent_team_member' && t.recipient.memberId === 'beta')).toBe(false);
    });

    it('keeps teammate removals when transcript has mixed seq availability', () => {
        const newestFirstMessages: Message[] = [
            createToolMessage({
                id: 'edit-config',
                name: 'Edit',
                state: 'completed',
                input: {
                    file_path: '/Users/leeroy/.claude/teams/qa-live/config.json',
                    old_string: '{\"agentId\":\"beta@qa-live\"}',
                    new_string: '{}',
                },
                result: { content: 'updated' },
            }),
            createToolMessage({
                id: 'agent-beta',
                name: 'Agent',
                state: 'completed',
                input: { name: 'beta', team_name: 'qa-live' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'beta', team_name: 'qa-live', name: 'beta' } },
            }),
            createToolMessage({
                id: 'agent-alpha',
                name: 'Agent',
                state: 'completed',
                input: { name: 'alpha', team_name: 'qa-live' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha', team_name: 'qa-live', name: 'alpha' } },
            }),
            createToolMessage({
                id: 'create1',
                name: 'AgentTeamCreate',
                state: 'completed',
                seq: 1,
                input: { team_name: 'qa-live' },
                result: { ok: true },
            }),
        ];

        const targets = deriveSessionParticipantTargets({
            session: { metadata: { flavor: 'claude' } } as any,
            messages: newestFirstMessages,
        });

        expect(targets.some((t) => t.recipient.kind === 'agent_team_member' && t.recipient.memberId === 'alpha')).toBe(true);
        expect(targets.some((t) => t.recipient.kind === 'agent_team_member' && t.recipient.memberId === 'beta')).toBe(false);
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

    it('returns null for focused SubAgentRun tool with abort-like errors when there is no prior running signal', () => {
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
        expect(auto).toBeNull();
    });

    it('returns execution_run recipient for focused interrupted SubAgentRun when external running state reports run as running', () => {
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
            activeExecutionRuns: [{ runId: 'run_1', status: 'running' }],
        });
        expect(auto?.kind).toBe('execution_run');
        expect((auto as any)?.runId).toBe('run_1');
    });

    it('returns execution_run recipient for focused interrupted SubAgentRun when prior running signal exists', () => {
        const running = createToolMessage({
            id: 'm1',
            name: 'SubAgentRun',
            state: 'running',
            input: { runId: 'run_1' },
        });
        const interrupted = createToolMessage({
            id: 'm2',
            name: 'SubAgentRun',
            state: 'error',
            input: { runId: 'run_1' },
            result: { error: 'Request interrupted' },
        });
        const auto = deriveAutoRecipientFromFocusedToolTranscript({
            session: { metadata: { flavor: 'claude' } } as any,
            tool: interrupted.tool,
            messages: [running, interrupted],
        });
        expect(auto?.kind).toBe('execution_run');
        expect((auto as any)?.runId).toBe('run_1');
    });

    it('returns execution_run recipient for focused SubAgentRun when focused sidechain messages show running', () => {
        const focused = createToolMessage({
            id: 'm-focused',
            name: 'SubAgentRun',
            state: 'completed',
            input: { runId: 'run_sidechain_1' },
            result: { error: 'Request interrupted' },
        });
        const focusedRunningChild = createToolMessage({
            id: 'm-child',
            name: 'Task',
            state: 'running',
            input: {},
            result: { status: 'running' },
        });
        const auto = deriveAutoRecipientFromFocusedToolTranscript({
            session: { metadata: { flavor: 'claude' } } as any,
            tool: focused.tool,
            messages: [focused],
            focusedMessages: [focusedRunningChild],
        });
        expect(auto?.kind).toBe('execution_run');
        expect((auto as any)?.runId).toBe('run_sidechain_1');
    });

    it('returns null for focused SubAgentRun when run was explicitly stopped via tool call', () => {
        const toolMsg = createToolMessage({
            id: 'm1',
            name: 'SubAgentRun',
            state: 'running',
            input: { runId: 'run_1' },
        });
        const auto = deriveAutoRecipientFromFocusedToolTranscript({
            session: { metadata: { flavor: 'claude' } } as any,
            tool: toolMsg.tool,
            messages: [
                toolMsg,
                createToolMessage({
                    id: 'stop-1',
                    name: 'MCP: Happier Execution Run Stop',
                    state: 'completed',
                    input: { runId: 'run_1' },
                    result: {
                        content: [
                            {
                                type: 'text',
                                text: '{"ok":true}',
                            },
                        ],
                    },
                }),
            ],
        });
        expect(auto).toBeNull();
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
