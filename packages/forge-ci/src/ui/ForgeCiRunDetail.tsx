import type { ReactNode } from 'react';
import type { ForgeCiSelectionV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { ForgeCiReadValueV1, ForgeCiReadsV1 } from '../runtime/reads.js';
import { readForgeCiSelectionRunV1 } from '../runtime/identity.js';
import { useForgeCiQueryV1, useForgeCiQueryValueV1 } from './useForgeCiReads.js';
import { useForgeCiPagedQueryV1 } from './useForgeCiPagedQuery.js';

export type ForgeCiRunDetailProps = Readonly<{
  reads: ForgeCiReadsV1 | null; selection: ForgeCiSelectionV1;
  children(model: Readonly<{
    runQuery: ReturnType<typeof useForgeCiQueryV1<'readRun'>>;
    jobsQuery: ReturnType<typeof useForgeCiPagedQueryV1<'listJobs'>>;
    run: ForgeCiReadValueV1<'readRun'> | null;
    jobs: ForgeCiReadValueV1<'listJobs'> | null;
  }>): ReactNode;
}>;

/** One exact run/attempt and jobs projection; the same body can mount in pane or page. */
export function ForgeCiRunDetail({ reads, selection, children }: ForgeCiRunDetailProps): ReactNode {
  const run = readForgeCiSelectionRunV1(selection);
  const input = { repository: run.repository, runId: run.runId,
    ...(selection.kind === 'attempt' ? { attempt: selection.attempt.attemptId } : {}) };
  const runQuery = useForgeCiQueryV1(reads, 'readRun', input);
  const jobsQuery = useForgeCiPagedQueryV1(reads, 'listJobs', input);
  const runValue = useForgeCiQueryValueV1(runQuery);
  const jobs = useForgeCiQueryValueV1(jobsQuery);
  return children({ runQuery, jobsQuery, run: runValue, jobs });
}
