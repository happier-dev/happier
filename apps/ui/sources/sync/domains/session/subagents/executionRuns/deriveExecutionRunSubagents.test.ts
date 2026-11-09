import { describe, expect, it } from 'vitest';

import type { Message, ToolCallMessage } from "@happier-dev/session-core/messages";

import { deriveExecutionRunSubagents } from './deriveExecutionRunSubagents';
import { findTranscriptExecutionRunState } from './deriveTranscriptExecutionRunStateIndex';
import { buildExecutionRunPublicStateFromTranscriptState } from './executionRunPublicStateFromTranscript';

function createRunToolMessage(params: {
    id: string;
    runId: string;
    state: 'running' | 'completed' | 'error';
    seq?: number;
    createdAt?: number;
    input?: Record<string, unknown>;
    result?: unknown;
}): ToolCallMessage {
    const now = params.createdAt ?? 1_700_000_000_000;
    return {
        kind: 'tool-call',
        id: params.id,
        ...(typeof params.seq === 'number' ? { seq: params.seq } : {}),
        localId: null,
        createdAt: now,
        tool: {
            id: `toolu_${params.runId}`,
            name: 'SubAgentRun',
            state: params.state,
            input: { runId: params.runId, ...(params.input ?? {}) },
            createdAt: now,
            startedAt: now,
            completedAt: params.state === 'running' ? null : now + 1,
            description: null,
            ...(params.result !== undefined ? { result: params.result } : {}),
        },
        children: [],
    } as unknown as ToolCallMessage;
}

function createAgentTextMessage(params: { id: string; text: string; seq?: number }): Message {
    return {
        kind: 'agent-text',
        id: params.id,
        ...(typeof params.seq === 'number' ? { seq: params.seq } : {}),
        localId: null,
        createdAt: 1_700_000_000_100,
        text: params.text,
    } as unknown as Message;
}

function deriveStatus(messages: readonly Message[], runId: string): string | undefined {
    return deriveExecutionRunSubagents({ messages }).find((subagent) => subagent.runRef?.runId === runId)?.status;
}

describe('deriveExecutionRunSubagents status derivation', () => {
    it('does not resurrect a completed run when an unsequenced row separates conflicting timestamps', () => {
        const runId = 'run_ordering1111';
        const messages = [
            createRunToolMessage({
                id: 'completed', runId, seq: 2, createdAt: 1_000, state: 'completed',
                result: { status: 'succeeded', runId },
            }),
            { ...createAgentTextMessage({ id: 'unsequenced', text: 'Working.' }), createdAt: 2_000 },
            createRunToolMessage({ id: 'started', runId, seq: 1, createdAt: 3_000, state: 'running' }),
        ];

        expect(deriveStatus(messages, runId)).toBe('succeeded');
    });

    it('projects additive launch-origin fields from retained transcript tool payloads', () => {
        const launchOrigin = {
            kind: 'discussion',
            serverId: 'server-a',
            discussionId: 'discussion-1',
            messageIds: ['message-1'],
        };
        const messages = [createRunToolMessage({
            id: 'msg-stored-origin',
            runId: 'run_storedorigin1',
            state: 'running',
            input: { launchOrigin: { ...launchOrigin, retiredOriginField: true } },
        })];

        expect(deriveExecutionRunSubagents({ messages })[0]?.runRef?.launchOrigin).toEqual(launchOrigin);
    });

    it('carries the canonical parsed launch origin into the execution-run roster row', () => {
        const messages = [createRunToolMessage({
            id: 'msg-origin',
            runId: 'run_origin1111',
            state: 'running',
            input: {
                launchOrigin: {
                    kind: 'discussion',
                    serverId: 'server-a',
                    discussionId: 'discussion-1',
                    messageIds: ['message-1'],
                },
            },
        })];

        expect(deriveExecutionRunSubagents({ messages })[0]?.runRef).toMatchObject({
            runId: 'run_origin1111',
            launchOrigin: {
                kind: 'discussion',
                serverId: 'server-a',
                discussionId: 'discussion-1',
                messageIds: ['message-1'],
            },
        });
    });

    it('reports a timed-out run as timed out rather than succeeded', () => {
        const messages = [createRunToolMessage({
            id: 'msg-1',
            runId: 'run_aaaa1111bb',
            state: 'completed',
            result: { runId: 'run_aaaa1111bb', status: 'timeout' },
        })];

        const subagent = deriveExecutionRunSubagents({ messages })[0];
        expect(subagent?.status).toBe('timedOut');
        expect(subagent?.capabilities.canStop).toBe(false);
        expect(subagent?.recipient).toBeNull();
    });

    it('translates a timed-out transcript state back to the wire status for the run detail surface', () => {
        const messages = [createRunToolMessage({
            id: 'msg-1',
            runId: 'run_aaaa1111bb',
            state: 'completed',
            input: { intent: 'delegate', runClass: 'bounded', backendId: 'codex' },
            result: { runId: 'run_aaaa1111bb', status: 'timeout' },
        })];

        const state = findTranscriptExecutionRunState(messages, 'run_aaaa1111bb');
        expect(state).not.toBeNull();
        expect(buildExecutionRunPublicStateFromTranscriptState(state!)?.status).toBe('timeout');
    });

    it('refuses an intent the protocol does not define instead of coercing it', () => {
        const messages = [createRunToolMessage({
            id: 'msg-1',
            runId: 'run_aaaa1111bb',
            state: 'completed',
            input: { intent: 'sideways_delegation', runClass: 'bounded', backendId: 'codex' },
            result: { runId: 'run_aaaa1111bb', status: 'succeeded' },
        })];

        const state = findTranscriptExecutionRunState(messages, 'run_aaaa1111bb');
        expect(buildExecutionRunPublicStateFromTranscriptState(state!)).toBeNull();
    });

    it('does not let prose written inside a result set the run status', () => {
        const messages = [createRunToolMessage({
            id: 'msg-1',
            runId: 'run_bbbb2222cc',
            state: 'completed',
            result: 'The child agent noted status: running while it worked, then stopped.',
        })];

        expect(deriveStatus(messages, 'run_bbbb2222cc')).toBe('succeeded');
    });

    it('does not read a status nested below the top level of the result', () => {
        const messages = [createRunToolMessage({
            id: 'msg-1',
            runId: 'run_cccc3333dd',
            state: 'completed',
            result: { runId: 'run_cccc3333dd', output: { status: 'running' } },
        })];

        expect(deriveStatus(messages, 'run_cccc3333dd')).toBe('succeeded');
    });

    it('does not let an agent start announcement resurrect a run the transcript already finished', () => {
        const messages = [
            createRunToolMessage({
                id: 'msg-1',
                runId: 'run_dddd4444ee',
                state: 'completed',
                seq: 1,
                result: { runId: 'run_dddd4444ee', status: 'succeeded' },
            }),
            createAgentTextMessage({
                id: 'msg-2',
                seq: 2,
                text: 'A new long-lived execution run started: run_dddd4444ee',
            }),
        ];

        expect(deriveStatus(messages, 'run_dddd4444ee')).toBe('succeeded');
    });

    it('still lets an agent start announcement recover a run whose call was interrupted', () => {
        const messages = [
            createRunToolMessage({
                id: 'msg-1',
                runId: 'run_eeee5555ff',
                state: 'error',
                seq: 1,
                result: 'Request interrupted by user',
            }),
            createAgentTextMessage({
                id: 'msg-2',
                seq: 2,
                text: 'A new long-lived execution run started: run_eeee5555ff',
            }),
        ];

        expect(deriveStatus(messages, 'run_eeee5555ff')).toBe('running');
    });

    it('keeps an interrupted call ambiguous when nothing else claims it is live', () => {
        const messages = [createRunToolMessage({
            id: 'msg-1',
            runId: 'run_ffff6666aa',
            state: 'error',
            result: { runId: 'run_ffff6666aa', status: 'aborted', detail: 'Request interrupted by user' },
        })];

        expect(deriveStatus(messages, 'run_ffff6666aa')).toBe('unknown');
    });

    it('reads a status persisted as an escaped JSON string, and older CLI spellings', () => {
        const escaped = [
            createRunToolMessage({
                id: 'msg-1',
                runId: 'run_1111aaaabb',
                state: 'completed',
                result: '{\\"runId\\":\\"run_1111aaaabb\\",\\"status\\":\\"failed\\"}',
            }),
        ];
        expect(deriveStatus(escaped, 'run_1111aaaabb')).toBe('failed');

        const legacyCompleted = [createRunToolMessage({
            id: 'msg-1',
            runId: 'run_2222bbbbcc',
            state: 'error',
            result: { runId: 'run_2222bbbbcc', status: 'completed' },
        })];
        expect(deriveStatus(legacyCompleted, 'run_2222bbbbcc')).toBe('succeeded');

        const legacyCanceled = [createRunToolMessage({
            id: 'msg-1',
            runId: 'run_3333ccccdd',
            state: 'completed',
            result: { runId: 'run_3333ccccdd', status: 'canceled' },
        })];
        expect(deriveStatus(legacyCanceled, 'run_3333ccccdd')).toBe('cancelled');
    });

    it('keeps the live run registry stronger than a finished transcript call', () => {
        const messages = [createRunToolMessage({
            id: 'msg-1',
            runId: 'run_4444ddddee',
            state: 'completed',
            result: { runId: 'run_4444ddddee', status: 'succeeded' },
        })];

        const subagents = deriveExecutionRunSubagents({
            messages,
            activeExecutionRuns: [{ runId: 'run_4444ddddee', status: 'running' }],
        });
        expect(subagents[0]?.status).toBe('running');
    });
});

describe('deriveExecutionRunSubagents display title', () => {
    it('names an unlabelled Run by what it is for, never by its id', () => {
        const runs = deriveExecutionRunSubagents({ messages: [
            createRunToolMessage({ id: 'm-summary', runId: 'run_b7a65528', state: 'completed', input: { intent: 'scm_diff_summary' } }),
            createRunToolMessage({ id: 'm-other', runId: 'run_c19f0a77', state: 'completed' }),
        ] });
        const summary = runs.find((run) => run.runRef?.runId === 'run_b7a65528');
        const other = runs.find((run) => run.runRef?.runId === 'run_c19f0a77');
        expect(summary?.display.title).toBe('Change summary');
        expect(other?.display.title).toBe('Agent run');
        expect(JSON.stringify([summary?.display, other?.display])).not.toContain('run_');
    });
});
