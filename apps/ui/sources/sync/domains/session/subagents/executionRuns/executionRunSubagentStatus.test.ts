import { describe, expect, it } from 'vitest';

import type { ToolCall } from '@/sync/domains/messages/messageTypes';

import {
    deriveTranscriptExecutionRunStatus,
    isTerminalSubagentStatus,
    readExecutionRunResultStatus,
} from './executionRunSubagentStatus';

const CREATED_AT = 1_700_000_000_000;

function createSubAgentRunTool(params: Readonly<{
    state: ToolCall['state'];
    result?: unknown;
}>): ToolCall {
    return {
        id: 'tool_subagent_run',
        name: 'SubAgentRun',
        state: params.state,
        input: { runId: 'run_0f1e2d3c4b5a' },
        createdAt: CREATED_AT,
        startedAt: CREATED_AT,
        completedAt: params.state === 'running' ? null : CREATED_AT + 1_000,
        description: null,
        ...(params.result !== undefined ? { result: params.result } : {}),
    };
}

describe('deriveTranscriptExecutionRunStatus', () => {
    it('does not fabricate success from an interruption marker on a completed call', () => {
        // The parent turn was interrupted, so the outer call closed without a run outcome. The
        // marker is the only thing in the result: it is ambiguity, never an outcome, and the
        // `completed` lifecycle arm must not read it as one.
        const status = deriveTranscriptExecutionRunStatus(createSubAgentRunTool({
            state: 'completed',
            result: { error: 'Request interrupted' },
        }));

        expect(status).toBe('unknown');
        expect(isTerminalSubagentStatus(status)).toBe(false);
    });

    it('treats an interrupted error call as ambiguous rather than failed', () => {
        expect(deriveTranscriptExecutionRunStatus(createSubAgentRunTool({
            state: 'error',
            result: { error: 'Request interrupted' },
        }))).toBe('unknown');
    });

    it('lets a structured terminal status outrank the interruption marker', () => {
        // The execution-run manager reported an outcome, so the marker in the prose alongside it is
        // just narration. Losing this ordering is what resurrects announced-but-finished runs.
        expect(deriveTranscriptExecutionRunStatus(createSubAgentRunTool({
            state: 'completed',
            result: { status: 'failed', summary: 'Request interrupted while retrying' },
        }))).toBe('failed');

        expect(deriveTranscriptExecutionRunStatus(createSubAgentRunTool({
            state: 'error',
            result: { status: 'succeeded', summary: 'Request interrupted mid-stream, recovered' },
        }))).toBe('succeeded');
    });

    it('keeps a timed-out run out of the success arm', () => {
        expect(deriveTranscriptExecutionRunStatus(createSubAgentRunTool({
            state: 'error',
            result: { status: 'timeout', summary: 'Timed out after 120000ms' },
        }))).toBe('timedOut');

        expect(deriveTranscriptExecutionRunStatus(createSubAgentRunTool({
            state: 'completed',
            result: { status: 'timeout' },
        }))).toBe('timedOut');
    });

    it('reports a run still running from either the lifecycle state or the reported status', () => {
        expect(deriveTranscriptExecutionRunStatus(createSubAgentRunTool({
            state: 'running',
            result: null,
        }))).toBe('running');

        expect(deriveTranscriptExecutionRunStatus(createSubAgentRunTool({
            state: 'completed',
            result: { status: 'running' },
        }))).toBe('running');
    });

    it('still derives success for a plain completed run and failure for a plain error', () => {
        expect(deriveTranscriptExecutionRunStatus(createSubAgentRunTool({
            state: 'completed',
            result: { summary: 'Delegated output.' },
        }))).toBe('succeeded');

        expect(deriveTranscriptExecutionRunStatus(createSubAgentRunTool({
            state: 'completed',
        }))).toBe('succeeded');

        expect(deriveTranscriptExecutionRunStatus(createSubAgentRunTool({
            state: 'error',
            result: { error: { code: 'execution_run_failed' } },
        }))).toBe('failed');
    });

    it('reads a status persisted as a JSON string result', () => {
        expect(deriveTranscriptExecutionRunStatus(createSubAgentRunTool({
            state: 'completed',
            result: '{"status":"cancelled"}',
        }))).toBe('cancelled');
    });

    it('carries no outcome for a call whose owning process disappeared', () => {
        expect(deriveTranscriptExecutionRunStatus(createSubAgentRunTool({
            state: 'unavailable',
            result: null,
        }))).toBe('unknown');
    });
});

describe('readExecutionRunResultStatus', () => {
    it('refuses a status the subagent merely wrote about', () => {
        expect(readExecutionRunResultStatus({ summary: 'status: succeeded' })).toBeNull();
        expect(readExecutionRunResultStatus({ nested: { status: 'succeeded' } })).toBeNull();
    });

    it('accepts the legacy wire spellings for terminal outcomes', () => {
        expect(readExecutionRunResultStatus({ status: 'completed' })).toBe('succeeded');
        expect(readExecutionRunResultStatus({ status: 'canceled' })).toBe('cancelled');
        expect(readExecutionRunResultStatus({ status: 'error' })).toBe('failed');
    });
});
