import { describe, expect, it } from 'vitest';
import { projectForgeCiJobViewV1 } from './jobViewModel.js';
import type { ForgeCiJobV1 } from '@happier-dev/triage-protocol/ci/v1';

const run = { v: 1, repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repository' }, runId: '1' } as const;
const selection = { kind: 'attempt', attempt: { run, attemptId: '2' } } as const;
const expected = { selection, jobId: '1' };
const job: ForgeCiJobV1 = { ref: expected, name: 'test', state: { phase: 'completed', outcome: 'failure', outcomeBucket: 'failed', nativeLabel: 'failure' }, steps: { kind: 'unsupported' } };

describe('shared job view projection', () => {
  it('never associates another native attempt and cannot open dependent log or annotations', () => {
    const mismatched = { ...job, ref: { ...expected, selection: { kind: 'attempt', attempt: { run, attemptId: '1' } } as const } };
    const model = projectForgeCiJobViewV1({ expected, job: mismatched, annotationsExpanded: true, logExpanded: true });
    expect(model.job).toBeNull();
    expect(model.logInput).toBeNull();
    expect(model.annotationsInput).toBeNull();
    expect(model.failure).toMatchObject({ code: 'ci_job_selection_mismatch' });
  });
  it('keeps native annotation count unknown and only admits the exact selected disclosure body', () => {
    const closed = projectForgeCiJobViewV1({ expected, job, annotationsExpanded: false, logExpanded: false });
    expect(closed.annotationsCount).toBeNull();
    expect(closed.annotationsInput).toBeNull();
    expect(closed.logInput).toBeNull();
    const opened = projectForgeCiJobViewV1({ expected, job: { ...job, annotationsCount: 7, checkRunId: 'check-1' }, annotationsExpanded: true, logExpanded: true });
    expect(opened.annotationsCount).toBe(7);
    expect(opened.annotationsInput).toMatchObject({ runId: '1', attempt: '2', jobId: '1', checkRunId: 'check-1' });
    expect(opened.logInput).toMatchObject({ runId: '1', attempt: '2', jobId: '1', selection: { kind: 'all' } });
  });
});
