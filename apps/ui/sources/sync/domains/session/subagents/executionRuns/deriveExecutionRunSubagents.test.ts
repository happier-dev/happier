import { ExecutionRunIntentSchema } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';

import {
    buildExecutionRunPublicStateFromTranscriptState,
    deriveExecutionRunSubagents,
    findTranscriptExecutionRunState,
} from './deriveExecutionRunSubagents';

const RUN_ID = 'run_0f1e2d3c4b5a';

function createSubAgentRunMessage(params: Readonly<{
    id?: string;
    state: 'running' | 'completed' | 'error';
    input?: Record<string, unknown>;
    result?: unknown;
    seq?: number;
}>): ToolCallMessage {
    const createdAt = 1_700_000_000_000;
    return {
        kind: 'tool-call',
        id: params.id ?? 'message_subagent_run',
        ...(typeof params.seq === 'number' ? { seq: params.seq } : {}),
        localId: null,
        createdAt,
        tool: {
            id: 'tool_subagent_run',
            name: 'SubAgentRun',
            state: params.state,
            input: { runId: RUN_ID, ...(params.input ?? {}) },
            createdAt,
            startedAt: createdAt,
            completedAt: params.state === 'running' ? null : createdAt + 1_000,
            description: null,
            ...(params.result !== undefined ? { result: params.result } : {}),
        },
        children: [],
    } as ToolCallMessage;
}

function createAgentTextMessage(params: Readonly<{ id: string; text: string; seq?: number }>): Message {
    return {
        kind: 'agent-text',
        id: params.id,
        ...(typeof params.seq === 'number' ? { seq: params.seq } : {}),
        localId: null,
        createdAt: 1_700_000_001_000,
        text: params.text,
    } as unknown as Message;
}

function deriveSingleRun(messages: readonly Message[]) {
    const subagents = deriveExecutionRunSubagents({ messages });
    const run = subagents.find((subagent) => subagent.id === `execution_run:${RUN_ID}`);
    // Guard against a vacuously green assertion on an empty derivation.
    expect(run, 'fixture must derive exactly one execution-run subagent').toBeDefined();
    return run!;
}

describe('deriveExecutionRunSubagents — terminal status truthfulness (D-1)', () => {
    it('never renders a timeout run as succeeded', () => {
        const run = deriveSingleRun([
            createSubAgentRunMessage({
                state: 'completed',
                result: {
                    status: 'timeout',
                    summary: 'Execution run timed out after 600s',
                    runId: RUN_ID,
                },
            }),
        ]);

        expect(run.status).toBe('timedOut');
        expect(run.status).not.toBe('succeeded');
    });

    it('renders an errored timeout result as timedOut rather than a generic failure', () => {
        const run = deriveSingleRun([
            createSubAgentRunMessage({
                state: 'error',
                result: {
                    status: 'timeout',
                    summary: 'Execution run timed out after 600s',
                    runId: RUN_ID,
                    error: { code: 'execution_run_failed', message: 'Execution run timed out after 600s' },
                },
            }),
        ]);

        expect(run.status).toBe('timedOut');
    });

    it('keeps the run stoppable only while it is running', () => {
        const run = deriveSingleRun([
            createSubAgentRunMessage({
                state: 'error',
                result: { status: 'timeout', runId: RUN_ID },
            }),
        ]);

        expect(run.capabilities.canStop).toBe(false);
        expect(run.recipient).toBeNull();
    });

    it('carries the timeout status back to the execution-run public state used by the details view', () => {
        const messages = [
            createSubAgentRunMessage({
                state: 'error',
                input: { intent: 'review', backendId: 'claude', runClass: 'bounded', ioMode: 'request_response' },
                result: { status: 'timeout', runId: RUN_ID, sidechainId: 'sidechain_1' },
            }),
        ];

        const transcriptState = findTranscriptExecutionRunState(messages, RUN_ID);
        expect(transcriptState).not.toBeNull();
        const publicState = buildExecutionRunPublicStateFromTranscriptState(transcriptState!);

        expect(publicState).not.toBeNull();
        expect(publicState?.status).toBe('timeout');
    });
});

describe('deriveExecutionRunSubagents — status comes from the structured payload only (D-3)', () => {
    it('reads the terminal status from the structured tool result', () => {
        const run = deriveSingleRun([
            createSubAgentRunMessage({
                state: 'completed',
                result: { status: 'cancelled', summary: 'Cancelled', runId: RUN_ID },
            }),
        ]);

        expect(run.status).toBe('cancelled');
    });

    it('ignores a status quoted in the subagent’s own prose', () => {
        const run = deriveSingleRun([
            createSubAgentRunMessage({
                state: 'completed',
                result: {
                    ok: true,
                    summary: 'Lane A reported status: "failed" in its handoff; every lane has since recovered.',
                    runId: RUN_ID,
                },
            }),
        ]);

        expect(run.status).toBe('succeeded');
    });

    it('ignores a status nested inside a structured review payload', () => {
        const run = deriveSingleRun([
            createSubAgentRunMessage({
                state: 'completed',
                result: {
                    summary: 'Review completed',
                    runId: RUN_ID,
                    triage: { findings: [{ id: 'finding_1', status: 'failed' }] },
                },
            }),
        ]);

        expect(run.status).toBe('succeeded');
    });

    it('ignores a status word that is not part of the execution-run vocabulary', () => {
        const run = deriveSingleRun([
            createSubAgentRunMessage({
                state: 'completed',
                result: { status: 'teammate_spawned', runId: RUN_ID },
            }),
        ]);

        expect(run.status).toBe('succeeded');
    });

    it('still reads the top level status of a JSON-encoded legacy result payload', () => {
        const run = deriveSingleRun([
            createSubAgentRunMessage({
                state: 'completed',
                result: `{\\"status\\":\\"cancelled\\",\\"runId\\":\\"${RUN_ID}\\"}`,
            }),
        ]);

        expect(run.status).toBe('cancelled');
    });

    it('does not let run-start prose resurrect a run the transcript reports as finished', () => {
        const run = deriveSingleRun([
            createSubAgentRunMessage({
                seq: 1,
                state: 'completed',
                result: { status: 'succeeded', summary: 'Done', runId: RUN_ID },
            }),
            createAgentTextMessage({
                id: 'agent_start_text',
                seq: 2,
                text: `The long-lived execution run has been started.\n- Run ID: ${RUN_ID}`,
            }),
        ]);

        expect(run.status).toBe('succeeded');
    });

    it('still recovers liveness from run-start prose when the transcript state is ambiguous', () => {
        const run = deriveSingleRun([
            createSubAgentRunMessage({
                seq: 1,
                state: 'error',
                result: { error: 'Request interrupted' },
            }),
            createAgentTextMessage({
                id: 'agent_start_text',
                seq: 2,
                text: `The long-lived execution run has been started.\n- Run ID: ${RUN_ID}`,
            }),
        ]);

        expect(run.status).toBe('running');
    });
});

describe('buildExecutionRunPublicStateFromTranscriptState — protocol-owned vocabularies (S-1)', () => {
    function buildForIntent(intent: string) {
        const messages = [
            createSubAgentRunMessage({
                state: 'running',
                input: { intent, backendId: 'claude', runClass: 'bounded', ioMode: 'request_response' },
                result: { sidechainId: 'sidechain_1' },
            }),
        ];
        const transcriptState = findTranscriptExecutionRunState(messages, RUN_ID);
        expect(transcriptState).not.toBeNull();
        return buildExecutionRunPublicStateFromTranscriptState(transcriptState!);
    }

    it('accepts every intent the protocol schema declares', () => {
        for (const intent of ExecutionRunIntentSchema.options) {
            expect(buildForIntent(intent)?.intent, `intent ${intent} must round-trip`).toBe(intent);
        }
    });

    it('rejects an intent the protocol schema does not declare', () => {
        expect(buildForIntent('not_a_real_intent')).toBeNull();
    });
});
