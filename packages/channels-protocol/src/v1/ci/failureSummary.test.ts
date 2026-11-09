import { describe, expect, it } from 'vitest';
import { ForgeCiFailureSummaryV1Schema, ForgeCiJobRefV1Schema, ForgeCiStateV1Schema } from './index.js';

describe('Channels-owned CI evidence V1', () => {
    it('keeps the existing exact attempt, native state and closed summary shape', () => {
        const repository = { kind: 'github', deployment: 'https://github.com', repository: 'owner/repository' } as const;
        const job = ForgeCiJobRefV1Schema.parse({
            selection: { kind: 'attempt', attempt: { run: { v: 1, repository, runId: '101' }, attemptId: '2', number: 2 } },
            jobId: '202',
        });
        const state = ForgeCiStateV1Schema.parse({ phase: 'completed', outcome: 'startup_failure', nativeLabel: 'startup_failure', outcomeBucket: 'failed' });
        const summary = {
            repository, selection: job.selection,
            jobs: [{ job, name: 'Build', state, steps: [{ stepId: 'step-1', name: 'Compile', state }] }],
            annotations: [{ id: 'annotation-1', job, checkRunId: 'check-1', level: 'error', message: 'evidence', startLine: 1 }],
            excerpts: [{ job, startLine: 1, endLine: 2, startByte: 0, text: 'untrusted evidence' }],
            missing: [], ambiguous: [], omitted: [], continuation: null,
        };
        expect(ForgeCiFailureSummaryV1Schema.parse(summary)).toEqual(summary);
        for (const invalid of [
            { ...summary, unknown: true },
            { ...summary, jobs: [{ ...summary.jobs[0], steps: [{ ...summary.jobs[0].steps[0], unknown: true }] }] },
            { ...summary, excerpts: [{ ...summary.excerpts[0], startLine: 0 }] },
            { ...summary, repository: { ...repository, deployment: 'https://user:password@example.test' } },
        ]) expect(ForgeCiFailureSummaryV1Schema.safeParse(invalid).success).toBe(false);
        expect(ForgeCiStateV1Schema.safeParse({ phase: 'running', outcome: 'success', nativeLabel: 'running', outcomeBucket: 'pending' }).success).toBe(false);
    });
});
