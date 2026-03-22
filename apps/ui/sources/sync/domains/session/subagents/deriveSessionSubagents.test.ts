import { describe, expect, it } from 'vitest';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { MessageMeta } from '@/sync/domains/messages/messageMetaTypes';
import { deriveSessionSubagents } from './deriveSessionSubagents';

function createToolMessage(params: {
    id: string;
    name: string;
    state: 'running' | 'completed' | 'error';
    seq?: number;
    input?: any;
    result?: any;
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
        children: [],
    };
}

function createUserTextMessage(params: { id: string; text: string; seq?: number; meta?: MessageMeta }): Message {
    return {
        kind: 'user-text',
        id: params.id,
        ...(typeof params.seq === 'number' ? { seq: params.seq } : {}),
        localId: null,
        createdAt: Date.now(),
        text: params.text,
        ...(params.meta ? { meta: params.meta } : {}),
    } as Message;
}

function deriveSubagents(params: {
    session: any;
    messages: readonly Message[];
    activeExecutionRuns?: readonly { runId: string; status?: string | null }[];
}) {
    return deriveSessionSubagents(params);
}

describe('deriveSessionSubagents', () => {
    it('derives running execution run subagents with control capabilities', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: [
                createToolMessage({
                    id: 'message_run_1',
                    name: 'SubAgentRun',
                    state: 'running',
                    input: { runId: 'run_1', label: 'Reviewer A' },
                    result: { sidechainId: 'subagent_run_1' },
                    toolExtras: { id: 'tool_subagent_run_1' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'execution_run:run_1',
                    kind: 'execution_run',
                    status: 'running',
                    display: expect.objectContaining({ title: 'Reviewer A' }),
                    transcript: expect.objectContaining({
                        sidechainId: 'subagent_run_1',
                        toolMessageRouteId: 'message_run_1',
                        toolId: 'tool_subagent_run_1',
                    }),
                    recipient: expect.objectContaining({ kind: 'execution_run', runId: 'run_1' }),
                    capabilities: expect.objectContaining({
                        canOpen: true,
                        canSend: true,
                        canStop: true,
                        canOpenAdvancedRun: true,
                    }),
                }),
            ]),
        );
    });

    it('derives claude teammate subagents with sidechain routing and send capability', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: [
                createToolMessage({
                    id: 'message_team_create',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'probe' },
                }),
                createToolMessage({
                    id: 'message_task_spawn',
                    name: 'Task',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
                    toolExtras: { id: 'tool_task_alpha' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'agent_team_member:probe:alpha@probe',
                    kind: 'agent_team_member',
                    status: 'running',
                    display: expect.objectContaining({
                        title: 'alpha',
                        groupKey: 'probe',
                        groupLabel: 'probe',
                    }),
                    transcript: expect.objectContaining({
                        sidechainId: 'tool_task_alpha',
                        toolMessageRouteId: 'message_task_spawn',
                        toolId: 'tool_task_alpha',
                    }),
                    recipient: expect.objectContaining({
                        kind: 'agent_team_member',
                        teamId: 'probe',
                        memberId: 'alpha@probe',
                    }),
                    capabilities: expect.objectContaining({
                        canOpen: true,
                        canSend: true,
                        canDelete: true,
                    }),
                }),
            ]),
        );
    });

    it('keeps a newly launched Claude teammate visible from subagent_launch.v1 meta even after the session already has team tool history', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: [
                createToolMessage({
                    id: 'message_team_create',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'probe' },
                    result: { ok: true },
                }),
                createToolMessage({
                    id: 'message_task_spawn',
                    name: 'Task',
                    state: 'completed',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
                    toolExtras: { id: 'tool_task_alpha' },
                }),
                createUserTextMessage({
                    id: 'message_member_launch',
                    text: 'Launch teammate gamma',
                    meta: {
                        happier: {
                            kind: 'subagent_launch.v1',
                            payload: {
                                kind: 'agent_team_member_create',
                                teamId: 'probe',
                                memberLabel: 'gamma',
                                instructions: 'Investigate gamma and reply.',
                                runInBackground: true,
                            },
                        },
                    },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'agent_team_member:probe:gamma@probe',
                    kind: 'agent_team_member',
                    status: 'running',
                    display: expect.objectContaining({
                        title: 'gamma',
                        groupKey: 'probe',
                    }),
                    recipient: expect.objectContaining({
                        kind: 'agent_team_member',
                        teamId: 'probe',
                        memberId: 'gamma@probe',
                        memberLabel: 'gamma',
                    }),
                    capabilities: expect.objectContaining({
                        canOpen: false,
                        canSend: true,
                        canDelete: true,
                    }),
                }),
            ]),
        );
    });

    it('keeps the spawn tool route as the canonical full-open target for claude teammates', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: [
                createToolMessage({
                    id: 'message_team_create',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'probe' },
                }),
                createToolMessage({
                    id: 'message_task_spawn',
                    name: 'Task',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
                    toolExtras: { id: 'tool_task_alpha' },
                }),
                createToolMessage({
                    id: 'message_agent_descendant',
                    name: 'Agent',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { status: 'running' },
                    toolExtras: { id: 'tool_agent_descendant' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'agent_team_member:probe:alpha@probe',
                    transcript: expect.objectContaining({
                        toolMessageRouteId: 'message_task_spawn',
                        toolId: 'tool_task_alpha',
                        sidechainId: 'tool_task_alpha',
                    }),
                }),
            ]),
        );
    });

    it('upgrades a claude teammate route from a descendant agent tool to the later spawn task route', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: [
                createToolMessage({
                    id: 'message_team_create',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'probe' },
                }),
                createToolMessage({
                    id: 'message_agent_descendant',
                    name: 'Agent',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { status: 'running' },
                    toolExtras: { id: 'tool_agent_descendant' },
                }),
                createToolMessage({
                    id: 'message_task_spawn',
                    name: 'Task',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
                    toolExtras: { id: 'tool_task_alpha' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'agent_team_member:probe:alpha@probe',
                    transcript: expect.objectContaining({
                        toolMessageRouteId: 'message_task_spawn',
                        toolId: 'tool_task_alpha',
                        sidechainId: 'tool_task_alpha',
                    }),
                }),
            ]),
        );
    });

    it('keeps the explicit spawn task route when later teammate task activity appears', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: [
                createToolMessage({
                    id: 'message_team_create',
                    name: 'AgentTeamCreate',
                    state: 'completed',
                    input: { team_name: 'probe' },
                }),
                createToolMessage({
                    id: 'message_task_spawn',
                    name: 'Task',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha' },
                    result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@probe', team_name: 'probe', name: 'alpha' } },
                    toolExtras: { id: 'tool_task_spawn' },
                }),
                createToolMessage({
                    id: 'message_task_descendant',
                    name: 'Task',
                    state: 'running',
                    input: { team_name: 'probe', name: 'alpha', prompt: 'follow-up work' },
                    result: { status: 'running' },
                    toolExtras: { id: 'tool_task_descendant' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'agent_team_member:probe:alpha@probe',
                    transcript: expect.objectContaining({
                        toolMessageRouteId: 'message_task_spawn',
                        toolId: 'tool_task_spawn',
                        sidechainId: 'tool_task_spawn',
                    }),
                }),
            ]),
        );
    });

    it('derives generic SubAgent sidechains as monitor-only subagents when they are not execution runs or claude teammates', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'codex' } },
            messages: [
                createToolMessage({
                    id: 'message_task_generic',
                    name: 'SubAgent',
                    state: 'running',
                    input: { prompt: 'Search the repo' },
                    result: { status: 'running' },
                    toolExtras: { id: 'tool_task_generic' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'subagent_sidechain:tool_task_generic',
                    kind: 'subagent_sidechain',
                    status: 'running',
                    display: expect.objectContaining({
                        providerLabel: 'Codex',
                    }),
                    transcript: expect.objectContaining({
                        sidechainId: 'tool_task_generic',
                        toolMessageRouteId: 'tool:tool_task_generic',
                        toolId: 'tool_task_generic',
                    }),
                    recipient: null,
                    capabilities: expect.objectContaining({
                        canOpen: true,
                        canSend: false,
                        canStop: false,
                        canDelete: false,
                    }),
                }),
            ]),
        );
    });

    it('prefers a pending permission tool route for generic subagents until the provider sidechain can proceed', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'opencode' } },
            messages: [
                createToolMessage({
                    id: 'message_permission_generic',
                    name: 'task',
                    state: 'running',
                    input: {
                        permission: 'task',
                        patterns: ['general'],
                        always: ['*'],
                        metadata: {
                            description: 'Run pwd',
                            subagent_type: 'general',
                        },
                    },
                    toolExtras: {
                        id: 'per_subagent_1',
                        permission: {
                            id: 'per_subagent_1',
                            status: 'pending',
                            kind: 'permission',
                        },
                    },
                }),
                createToolMessage({
                    id: 'message_task_generic',
                    name: 'SubAgent',
                    state: 'running',
                    input: {
                        description: 'Run pwd',
                        prompt: 'Use the Bash tool to run `pwd` and return the output.',
                        subagent_type: 'general',
                    },
                    result: { status: 'running' },
                    toolExtras: { id: 'call_subagent_1' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'subagent_sidechain:call_subagent_1',
                    kind: 'subagent_sidechain',
                    transcript: expect.objectContaining({
                        sidechainId: 'call_subagent_1',
                        toolMessageRouteId: 'tool:per_subagent_1',
                        toolId: 'call_subagent_1',
                    }),
                }),
            ]),
        );
    });

    it('keeps legacy Task and Agent tool names compatible with generic subagent derivation', async () => {
        const subagents = await deriveSubagents({
            session: { metadata: { flavor: 'opencode' } },
            messages: [
                createToolMessage({
                    id: 'message_task_generic',
                    name: 'Task',
                    state: 'running',
                    input: { prompt: 'Search the repo' },
                    result: { status: 'running' },
                    toolExtras: { id: 'tool_task_generic' },
                }),
                createToolMessage({
                    id: 'message_agent_generic',
                    name: 'Agent',
                    state: 'completed',
                    input: { prompt: 'Summarize the repo' },
                    result: { status: 'completed' },
                    toolExtras: { id: 'tool_agent_generic' },
                }),
            ],
        });

        expect(subagents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'subagent_sidechain:tool_task_generic',
                    kind: 'subagent_sidechain',
                }),
                expect.objectContaining({
                    id: 'subagent_sidechain:tool_agent_generic',
                    kind: 'subagent_sidechain',
                }),
            ]),
        );
    });

});
