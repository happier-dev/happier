import type { ForgeCiJobRefV1, ForgeCiRunRefV1, ForgeCiSelectionV1 } from '@happier-dev/triage-protocol/ci/v1';

/** Already-admitted repository components; parsing/case policy stays with SCM. */
export function forgeCiRunKeyV1(run: ForgeCiRunRefV1): string {
  return JSON.stringify([run.repository.kind, run.repository.deployment, run.repository.repository, run.runId]);
}

export function readForgeCiSelectionRunV1(selection: ForgeCiSelectionV1): ForgeCiRunRefV1 {
  return selection.kind === 'run' ? selection.run : selection.attempt.run;
}

export function forgeCiSelectionKeyV1(selection: ForgeCiSelectionV1): string {
  return JSON.stringify([forgeCiRunKeyV1(readForgeCiSelectionRunV1(selection)), selection.kind,
    selection.kind === 'attempt' ? selection.attempt.attemptId : null]);
}

export function forgeCiJobKeyV1(job: ForgeCiJobRefV1): string {
  return JSON.stringify([forgeCiSelectionKeyV1(job.selection), job.jobId]);
}
