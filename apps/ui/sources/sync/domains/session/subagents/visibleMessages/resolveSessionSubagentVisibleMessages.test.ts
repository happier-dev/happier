import { afterEach, describe, expect, it } from 'vitest';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import {
    clearProjectedAgentUiBehaviorDescriptors,
    publishProjectedAgentUiBehaviorDescriptors,
} from '@/agents/registry/agentUiBehaviorProjection';

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
    afterEach(() => {
        clearProjectedAgentUiBehaviorDescriptors();
    });

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

    it('does not apply Claude lifecycle filtering to an external Agent that uses the Agent tool name', async () => {
        const focusedMessages = [
            createAgentTextMessage('m1', '{"type":"idle_notification","from":"worker"}'),
            createAgentTextMessage('m2', '{"type":"shutdown_approved","from":"worker"}'),
        ] satisfies readonly Message[];
        const agentMessage = createToolMessage({
            id: 'tool-agent-external',
            name: 'Agent',
            state: 'completed',
            input: { name: 'worker' },
            children: focusedMessages,
        });

        const visibleMessages = await resolveVisibleMessages({
            session: {
                metadata: {
                    machineId: 'machine-external',
                    runtimeDescriptorV1: { v: 1, agentId: 'acme.agent', agent: {} },
                },
            },
            tool: agentMessage.tool,
            focusedMessages,
            messages: [agentMessage],
        });

        expect(visibleMessages).toEqual(focusedMessages);
    });

    it('applies an external Agent visible-message declaration only on its owning machine', async () => {
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'machine-external',
            descriptorsByAgentId: {
                'acme.agent': {
                    kind: 'plugin.ui.v1',
                    pluginId: 'acme',
                    agentId: 'acme.agent',
                    version: 1,
                    session: {
                        visibleMessages: {
                            kind: 'session.visibleMessages.v1',
                            subagentKinds: ['generic'],
                            fallbackToolNames: ['AcmeWorker'],
                            excludeJsonEventTypes: ['acme_internal'],
                        },
                    },
                },
            },
        });
        const focusedMessages = [
            createAgentTextMessage('m1', 'Visible output'),
            createAgentTextMessage('m2', '{"type":"acme_internal"}'),
        ] satisfies readonly Message[];
        const tool = createToolMessage({
            id: 'tool-acme',
            name: 'AcmeWorker',
            state: 'completed',
            children: focusedMessages,
        }).tool;
        const sessionMetadata = {
            runtimeDescriptorV1: { v: 1, agentId: 'acme.agent', agent: {} },
        };

        expect(await resolveVisibleMessages({
            session: { metadata: { ...sessionMetadata, machineId: 'machine-external' } },
            tool,
            focusedMessages,
            messages: [],
        })).toEqual([expect.objectContaining({ id: 'm1' })]);
        expect(await resolveVisibleMessages({
            session: { metadata: { ...sessionMetadata, machineId: 'different-machine' } },
            tool,
            focusedMessages,
            messages: [],
        })).toEqual(focusedMessages);
    });
});
