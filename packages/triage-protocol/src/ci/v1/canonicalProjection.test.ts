import { describe, expect, it } from 'vitest';
import * as canonical from '@happier-dev/channels-protocol/v1';
import * as triage from '@happier-dev/triage-protocol/ci/v1';
import { createForgeCiConformanceVectorsV1 } from '@happier-dev/triage-protocol/ci/testing/v1';

describe('the canonical CI evidence closure', () => {
    it('publishes the exact Channels-owned executable values through Triage', () => {
        const names = [
            'ForgeCiIdV1Schema', 'ForgeCiRunRefV1Schema', 'ForgeCiAttemptRefV1Schema',
            'ForgeCiSelectionV1Schema', 'ForgeCiJobRefV1Schema', 'ForgeCiStepRefV1Schema',
            'ForgeCiStateV1Schema', 'ForgeCiAnnotationV1Schema',
            'ForgeCiFailureExcerptV1Schema', 'ForgeCiFailureSummaryV1Schema',
        ] as const;
        for (const name of names) {
            expect(triage[name]).toBe(canonical[name]);
        }
    });

    it('keeps exact native provenance and closed nested evidence without changing V1 shapes', () => {
        const { github } = createForgeCiConformanceVectorsV1();
        const value = {
            repository: github.repository,
            selection: github.job.ref.selection,
            jobs: [{ job: github.job.ref, name: 'Build', state: github.job.state, steps: [] }],
            annotations: [],
            excerpts: [{ job: github.job.ref, startLine: 7, endLine: 9, startByte: 0, text: 'untrusted evidence' }],
            missing: [], ambiguous: [], omitted: [], continuation: null,
        };
        expect(canonical.ForgeCiFailureSummaryV1Schema.parse(value)).toEqual(value);
        expect(triage.ForgeCiFailureSummaryV1Schema.parse(value)).toEqual(value);
        expect(triage.ForgeCiFailureSummaryV1Schema.safeParse({ ...value, unexpected: true }).success).toBe(false);
        expect(triage.ForgeCiFailureSummaryV1Schema.safeParse({ ...value, jobs: [{ ...value.jobs[0], unexpected: true }] }).success).toBe(false);
        expect(triage.ForgeCiFailureSummaryV1Schema.safeParse({ ...value, excerpts: [{ ...value.excerpts[0], startLine: 0 }] }).success).toBe(false);
        expect(triage.ForgeCiFailureSummaryV1Schema.safeParse({ ...value, selection: { kind: 'attempt', attempt: { ...github.job.ref, attemptId: '2' } } }).success).toBe(false);
        expect(canonical.ForgeCiStateV1Schema.parse({ phase: 'completed', outcome: 'startup_failure', nativeLabel: 'startup_failure', outcomeBucket: 'failed' }).outcome).toBe('startup_failure');
        expect(canonical.ForgeCiStateV1Schema.safeParse({ phase: 'running', outcome: 'success', nativeLabel: 'running', outcomeBucket: 'pending' }).success).toBe(false);
    });
});
