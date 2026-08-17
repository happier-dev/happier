import { describe, expect, it } from 'vitest';

import type { ToolCall } from '@/sync/domains/messages/messageTypes';

import { deriveTranscriptExecutionRunStatus } from './executionRunSubagentStatus';

function createRunTool(params: { state: ToolCall['state']; result?: unknown }): ToolCall {
    const now = 1_700_000_000_000;
    return {
        id: 'toolu_run_1',
        name: 'SubAgentRun',
        state: params.state,
        input: { runId: 'run_1' },
        createdAt: now,
        startedAt: now,
        completedAt: params.state === 'running' ? null : now + 1,
        description: null,
        ...(params.result !== undefined ? { result: params.result } : {}),
    };
}

describe('deriveTranscriptExecutionRunStatus', () => {
    it('keeps an interrupted call ambiguous whichever lifecycle state it landed in', () => {
        // The abort placeholder is written by the *parent* turn, so which of the two lifecycle
        // states the call settles into is an accident of when the interrupt landed. Reading
        // `completed` as a run outcome invents a success the run never reported.
        expect(deriveTranscriptExecutionRunStatus(
            createRunTool({ state: 'completed', result: { error: 'Request interrupted' } }),
        )).toBe('unknown');
        expect(deriveTranscriptExecutionRunStatus(
            createRunTool({ state: 'error', result: { error: 'Request interrupted' } }),
        )).toBe('unknown');
    });

    it('lets the structured status win over an interruption marker in the same result', () => {
        // Order matters: the execution-run manager's own `status` is the run's outcome, and an
        // interruption marker sitting beside it must not downgrade a reported terminal run back to
        // ambiguous — that would re-open the routing an announcement could then resurrect.
        expect(deriveTranscriptExecutionRunStatus(
            createRunTool({ state: 'completed', result: { status: 'succeeded', error: 'Request interrupted' } }),
        )).toBe('succeeded');
        expect(deriveTranscriptExecutionRunStatus(
            createRunTool({ state: 'error', result: { status: 'failed', error: 'Request interrupted' } }),
        )).toBe('failed');
    });

    it('reports a timed-out run as timed out rather than succeeded', () => {
        expect(deriveTranscriptExecutionRunStatus(
            createRunTool({ state: 'completed', result: { status: 'timeout' } }),
        )).toBe('timedOut');
    });

    it('still reads an ordinary completion and an ordinary failure from the tool lifecycle', () => {
        expect(deriveTranscriptExecutionRunStatus(
            createRunTool({ state: 'completed', result: { summary: 'done' } }),
        )).toBe('succeeded');
        expect(deriveTranscriptExecutionRunStatus(
            createRunTool({ state: 'error', result: { error: 'boom' } }),
        )).toBe('failed');
    });

    it('does not read a status out of a nested value the subagent controls', () => {
        expect(deriveTranscriptExecutionRunStatus(
            createRunTool({ state: 'completed', result: { output: { status: 'running' } } }),
        )).toBe('succeeded');
    });
});
