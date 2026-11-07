import type { ReactNode } from 'react';
import type { ForgeCiJobRefV1, ForgeCiJobV1, ForgeCiLogSelectionV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { ForgeCiReadValueV1, ForgeCiReadsV1 } from '../runtime/reads.js';
import type { ForgeCiLogIndexV1 } from '../runtime/logs/index.js';
import { readForgeCiSelectionRunV1 } from '../runtime/identity.js';
import { projectForgeCiJobViewV1, type ForgeCiJobViewModelV1 } from './jobViewModel.js';
import { useForgeCiQueryV1, useForgeCiQueryValueV1 } from './useForgeCiReads.js';
import { useForgeCiPagedQueryV1 } from './useForgeCiPagedQuery.js';

export type ForgeCiJobViewProps = Readonly<{
  reads: ForgeCiReadsV1 | null; job: ForgeCiJobRefV1; admittedJob?: ForgeCiJobV1 | null;
  annotationsExpanded?: boolean; logExpanded?: boolean; logSelection?: ForgeCiLogSelectionV1;
  children(model: ForgeCiJobViewModelV1 & Readonly<{
    jobQuery: ReturnType<typeof useForgeCiQueryV1<'readJob'>>;
    logQuery: ReturnType<typeof useForgeCiPagedQueryV1<'readJobLog'>>;
    annotationsQuery: ReturnType<typeof useForgeCiPagedQueryV1<'listAnnotations'>>;
    log: ForgeCiReadValueV1<'readJobLog'> | null;
    logIndex: ForgeCiLogIndexV1 | null;
    annotations: ForgeCiReadValueV1<'listAnnotations'> | null;
  }>): ReactNode;
}>;

/** Header, steps and logs consume the same admitted job; closed evidence admits no body. */
export function ForgeCiJobView(props: ForgeCiJobViewProps): ReactNode {
  const run = readForgeCiSelectionRunV1(props.job.selection);
  const jobQuery = useForgeCiQueryV1(props.reads, 'readJob', props.admittedJob === undefined ? { repository: run.repository, jobId: props.job.jobId } : null);
  const queriedJob = useForgeCiQueryValueV1(jobQuery);
  const model = projectForgeCiJobViewV1({
    expected: props.job, job: props.admittedJob === undefined ? queriedJob : props.admittedJob,
    annotationsExpanded: props.annotationsExpanded === true, logExpanded: props.logExpanded === true,
    ...(props.logSelection === undefined ? {} : { logSelection: props.logSelection }),
  });
  const logQuery = useForgeCiPagedQueryV1(props.reads, 'readJobLog', model.logInput);
  const annotationsQuery = useForgeCiPagedQueryV1(props.reads, 'listAnnotations', model.annotationsInput);
  const log = useForgeCiQueryValueV1(logQuery);
  const logIndex = log === null && model.logInput !== null
    ? props.reads?.getLogIndex(props.job) ?? null
    : logQuery?.indexLog(model.job?.steps.kind === 'available' ? model.job.steps.values : []) ?? null;
  const annotations = useForgeCiQueryValueV1(annotationsQuery);
  return props.children({ ...model, jobQuery, logQuery, annotationsQuery, log, logIndex, annotations });
}
