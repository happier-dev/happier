import { describe, expect, it } from 'vitest';

import type { TranscriptExecutionRunState } from './deriveTranscriptExecutionRunStateIndex';
import { buildExecutionRunPublicStateFromTranscriptState } from './executionRunPublicStateFromTranscript';

function runState(overrides: Partial<TranscriptExecutionRunState>): TranscriptExecutionRunState {
    return {
        runId: 'run_aaaa1111bb',
        status: 'succeeded',
        toolId: 'toolu_run_aaaa1111bb',
        sidechainId: 'toolu_run_aaaa1111bb',
        backendId: 'codex',
        intent: 'delegate',
        permissionMode: 'workspace_write',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        ...overrides,
    } as TranscriptExecutionRunState;
}

describe('buildExecutionRunPublicStateFromTranscriptState — start instant', () => {
    it('reports no start when the transcript recorded none, rather than borrowing the last update or the end', () => {
        const run = buildExecutionRunPublicStateFromTranscriptState(runState({
            startedAtMs: undefined,
            updatedAtMs: 15_000,
            finishedAtMs: 20_000,
        }));

        // `startedAtMs` is required on the wire, so 0 is the unknown sentinel and the detail card
        // guards on `> 0`. Standing a fabricated instant in its place renders a borrowed number as a
        // recorded fact — the update instant, or worse the end, which reports a zero-length run (D-8).
        expect(run?.startedAtMs).toBe(0);
        expect(run?.finishedAtMs).toBe(20_000);
    });

    it('still uses a genuinely recorded start instant', () => {
        const run = buildExecutionRunPublicStateFromTranscriptState(runState({
            startedAtMs: 4_000,
            updatedAtMs: 15_000,
            finishedAtMs: 20_000,
        }));

        expect(run?.startedAtMs).toBe(4_000);
    });
});
