import { describe, expect, it } from 'vitest';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';

import { deriveClaudeTeamSubagents } from './deriveClaudeTeamSubagents';

const TEAM_ID = 'review-team';
const MEMBER_ID = 'teammate_1';
const SPAWNED_AT = 1_700_000_000_000;

function createTeamToolMessage(params: Readonly<{
    id: string;
    createdAt: number;
    state?: 'running' | 'completed';
}>): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: params.id,
        localId: null,
        createdAt: params.createdAt,
        tool: {
            id: `tool_${params.id}`,
            name: 'Task',
            state: params.state ?? 'running',
            input: { team_name: TEAM_ID, agent_id: MEMBER_ID, name: 'Reviewer' },
            createdAt: params.createdAt,
            startedAt: params.createdAt,
            completedAt: null,
            description: null,
        },
        children: [],
    } as ToolCallMessage;
}

function deriveSingle(messages: readonly Message[]) {
    const subagents = deriveClaudeTeamSubagents({ flavor: 'claude', messages });
    expect(subagents, 'fixture must derive exactly one team member').toHaveLength(1);
    return subagents[0]!;
}

describe('deriveClaudeTeamSubagents — a teammate’s start does not move (D-8)', () => {
    it('keeps the first observation as the start when the teammate is seen again', () => {
        const member = deriveSingle([
            createTeamToolMessage({ id: 'spawn', createdAt: SPAWNED_AT }),
            createTeamToolMessage({ id: 'followup', createdAt: SPAWNED_AT + 90_000 }),
        ]);

        // The defect: the latest observation overwrote the start, so a teammate that had been
        // working for 90 s reset its elapsed column to zero every time it was mentioned again.
        expect(member.timestamps.startedAtMs).toBe(SPAWNED_AT);
        expect(member.timestamps.updatedAtMs).toBe(SPAWNED_AT + 90_000);
    });

    it('records a start from a single observation', () => {
        const member = deriveSingle([createTeamToolMessage({ id: 'spawn', createdAt: SPAWNED_AT })]);

        expect(member.timestamps.startedAtMs).toBe(SPAWNED_AT);
        expect(member.timestamps.finishedAtMs).toBeUndefined();
    });
});
