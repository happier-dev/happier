import { describe, expect, it } from 'vitest';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';

import { deriveSubAgentSidechainSubagents } from './deriveSubAgentSidechainSubagents';

const LAUNCHED_AT = 1_700_000_000_000;

/**
 * The acknowledgement Claude Code returns ~3ms after an asynchronous agent launch.
 *
 * The transcript normalizer JSON-encodes the raw `toolUseResult`, so this is what the reducer hands
 * the derivation — a string, not an object.
 */
const ASYNC_LAUNCH_ACKNOWLEDGEMENT = JSON.stringify({
    isAsync: true,
    status: 'async_launched',
    agentId: 'aec7336148831a599',
    description: 'Fix fork identity and UI gaps',
    outputFile: '/tmp/tasks/aec7336148831a599.output',
});

function subAgentToolMessage(params: Readonly<{
    name?: string;
    state: 'running' | 'completed' | 'error';
    result?: unknown;
}>): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: 'message_subagent',
        localId: null,
        createdAt: LAUNCHED_AT,
        tool: {
            id: 'toolu_01HuJR8jRr2sKnGNb1T4ReD4',
            name: params.name ?? 'Agent',
            state: params.state,
            input: { name: 'Reviewer' },
            createdAt: LAUNCHED_AT,
            startedAt: LAUNCHED_AT,
            completedAt: params.state === 'running' ? null : LAUNCHED_AT + 3,
            description: null,
            ...(params.result !== undefined ? { result: params.result } : {}),
        },
        children: [],
    } as unknown as ToolCallMessage;
}

function deriveSingle(messages: readonly Message[]) {
    const subagents = deriveSubAgentSidechainSubagents({ messages, flavor: 'claude' });
    expect(subagents, 'fixture must derive exactly one sidechain sub-agent').toHaveLength(1);
    return subagents[0]!;
}

describe('deriveSubAgentSidechainSubagents — a launch is not a result', () => {
    it('keeps an asynchronously launched agent running while only its launch was acknowledged', () => {
        // OBSERVED (live session d85429b7, 2026-08-17): the launching call completes in milliseconds
        // and the agent then runs for hours. Reading the acknowledgement as the agent's answer drew
        // every live sub-agent as finished seconds after it started.
        const subagent = deriveSingle([subAgentToolMessage({
            state: 'completed',
            result: ASYNC_LAUNCH_ACKNOWLEDGEMENT,
        })]);

        expect(subagent.status).toBe('running');
    });

    it('still reads a genuine result as the agent finishing', () => {
        const subagent = deriveSingle([subAgentToolMessage({
            state: 'completed',
            result: 'All six findings closed at one owner each.',
        })]);

        expect(subagent.status).toBe('succeeded');
    });

    it('still reads a failed launch as a failure', () => {
        const subagent = deriveSingle([subAgentToolMessage({
            state: 'error',
            result: ASYNC_LAUNCH_ACKNOWLEDGEMENT,
        })]);

        expect(subagent.status).toBe('failed');
    });
});
