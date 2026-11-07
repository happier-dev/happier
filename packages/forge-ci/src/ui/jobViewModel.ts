import type { ForgeCiAnnotationsListInputV1, ForgeCiJobLogReadInputV1, ForgeCiJobRefV1, ForgeCiJobV1, ForgeCiLogSelectionV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { forgeCiJobKeyV1, readForgeCiSelectionRunV1 } from '../runtime/identity.js';

export type ForgeCiJobViewModelV1 = Readonly<{
  job: ForgeCiJobV1 | null; failure: TriageSourceFailureV1 | null;
  annotationsCount: number | null;
  annotationsInput: ForgeCiAnnotationsListInputV1 | null;
  logInput: ForgeCiJobLogReadInputV1 | null;
}>;

/** Dependent evidence demand follows verified native membership, never a display name. */
export function projectForgeCiJobViewV1(input: Readonly<{
  expected: ForgeCiJobRefV1; job: ForgeCiJobV1 | null;
  annotationsExpanded: boolean; logExpanded: boolean; logSelection?: ForgeCiLogSelectionV1;
}>): ForgeCiJobViewModelV1 {
  const job = input.job;
  if (job === null) return { job: null, failure: null, annotationsCount: null, annotationsInput: null, logInput: null };
  if (forgeCiJobKeyV1(input.expected) !== forgeCiJobKeyV1(job.ref)) return {
    job: null, failure: { class: 'unsupportedContract', code: 'ci_job_selection_mismatch' },
    annotationsCount: null, annotationsInput: null, logInput: null,
  };
  const run = readForgeCiSelectionRunV1(job.ref.selection);
  const target = { repository: run.repository, runId: run.runId, jobId: job.ref.jobId,
    ...(job.ref.selection.kind === 'attempt' ? { attempt: job.ref.selection.attempt.attemptId } : {}) };
  return {
    job, failure: null, annotationsCount: job.annotationsCount ?? null,
    annotationsInput: input.annotationsExpanded && job.checkRunId ? { ...target, checkRunId: job.checkRunId } : null,
    logInput: input.logExpanded && job.state.phase === 'completed' ? { ...target, selection: input.logSelection ?? { kind: 'all' } } : null,
  };
}
