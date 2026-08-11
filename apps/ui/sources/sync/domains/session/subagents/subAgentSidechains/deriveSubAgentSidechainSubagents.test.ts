import { describe, expect, it } from 'vitest';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';

import { deriveSubAgentSidechainSubagents } from './deriveSubAgentSidechainSubagents';

const REQUESTED_AT = 1_700_000_000_000;

function createSubAgentMessage(params: Readonly<{
    state: 'running' | 'completed' | 'error';
    toolId?: string;
    createdAt?: number;
    toolStartedAt?: number | null;
    toolCompletedAt?: number | null;
    input?: Record<string, unknown>;
}>): ToolCallMessage {
    const createdAt = params.createdAt ?? REQUESTED_AT;
    return {
        kind: 'tool-call',
        id: 'message_subagent',
        localId: null,
        createdAt,
        tool: {
            id: params.toolId ?? 'tool_subagent',
            name: 'Task',
            state: params.state,
            input: params.input ?? { name: 'Reviewer' },
            createdAt,
            startedAt: params.toolStartedAt !== undefined ? params.toolStartedAt : createdAt,
            completedAt: params.toolCompletedAt !== undefined
                ? params.toolCompletedAt
                : (params.state === 'running' ? null : createdAt + 1_000),
            description: null,
        },
        children: [],
    } as ToolCallMessage;
}

function deriveSingle(messages: readonly Message[]) {
    const subagents = deriveSubAgentSidechainSubagents({ messages, flavor: 'claude' });
    expect(subagents, 'fixture must derive exactly one sidechain subagent').toHaveLength(1);
    return subagents[0]!;
}

describe('deriveSubAgentSidechainSubagents — elapsed time is never fabricated (D-8)', () => {
    it('records the genuine finish instant once the sidechain tool completes', () => {
        const subagent = deriveSingle([
            createSubAgentMessage({
                state: 'completed',
                createdAt: REQUESTED_AT,
                toolStartedAt: REQUESTED_AT + 500,
                toolCompletedAt: REQUESTED_AT + 42_000,
            }),
        ]);

        expect(subagent.status).toBe('succeeded');
        expect(subagent.timestamps.startedAtMs).toBe(REQUESTED_AT + 500);
        // Without this the row keeps a LIVE clock on a finished agent: the time slot only stops
        // counting when it is given a finish instant.
        expect(subagent.timestamps.finishedAtMs).toBe(REQUESTED_AT + 42_000);
    });

    it('leaves a running sidechain subagent with no finish instant', () => {
        const subagent = deriveSingle([
            createSubAgentMessage({
                state: 'running',
                createdAt: REQUESTED_AT,
                toolStartedAt: REQUESTED_AT,
                toolCompletedAt: null,
            }),
        ]);

        expect(subagent.status).toBe('running');
        expect(subagent.timestamps.startedAtMs).toBe(REQUESTED_AT);
        expect(subagent.timestamps.finishedAtMs).toBeUndefined();
    });

    it('claims no finish instant for a terminal tool that never recorded one', () => {
        const subagent = deriveSingle([
            createSubAgentMessage({
                state: 'error',
                createdAt: REQUESTED_AT,
                toolStartedAt: REQUESTED_AT,
                toolCompletedAt: null,
            }),
        ]);

        expect(subagent.status).toBe('failed');
        expect(subagent.timestamps.finishedAtMs).toBeUndefined();
    });

    it('falls back to the request instant while a permission prompt holds the call', () => {
        const subagent = deriveSingle([
            createSubAgentMessage({
                state: 'running',
                createdAt: REQUESTED_AT,
                toolStartedAt: null,
                toolCompletedAt: null,
            }),
        ]);

        expect(subagent.timestamps.startedAtMs).toBe(REQUESTED_AT);
    });
});

describe('deriveSubAgentSidechainSubagents — the row title reads the names producers actually ship', () => {
    function titleFor(input: Record<string, unknown>): string {
        return deriveSingle([createSubAgentMessage({ state: 'running', input })]).display.title;
    }

    // Codex spawns agents with a human-assigned nickname (rollout `new_agent_nickname`, e.g.
    // "Lovelace") that buildCodexSyntheticSubagentToolCall already puts on the wire. It is the one
    // field that tells sibling agents apart, so it outranks the categorical role and the prompt.
    it('prefers the Codex-assigned nickname over the role and the spawn prompt', () => {
        expect(titleFor({
            threadId: 'thread_lovelace',
            nickname: 'Lovelace',
            role: 'reviewer',
            prompt: 'Review the diff and report every correctness defect you find.',
        })).toBe('Lovelace');
    });

    it('falls back to the Codex role when the agent was spawned without a nickname', () => {
        expect(titleFor({
            threadId: 'thread_unnamed',
            role: 'reviewer',
            prompt: 'Review the diff and report every correctness defect you find.',
        })).toBe('reviewer');
    });

    // The task description says what this run is doing; subagent_type only says which category of
    // agent it is. This locks that ordering, and matches the CLI's own chain.
    it('prefers the task description over the categorical subagent type', () => {
        expect(titleFor({
            description: 'Search TypeScript 5.6 features',
            subagent_type: 'general-purpose',
            prompt: 'Search the web for information about TypeScript 5.6 new features.',
        })).toBe('Search TypeScript 5.6 features');
    });

    it('uses subagent_type rather than the prompt when no description was shipped', () => {
        expect(titleFor({
            subagent_type: 'general-purpose',
            prompt: 'Search the web for information about TypeScript 5.6 new features.',
        })).toBe('general-purpose');
    });

    it('bounds the prompt fallback so a whole prompt can never become the row title', () => {
        const title = titleFor({ prompt: 'a'.repeat(900) });

        expect(title).toHaveLength(512);
        expect(title.endsWith('…')).toBe(true);
    });
});
