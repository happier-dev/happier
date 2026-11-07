import type { ReactNode } from 'react';
import type { ForgeCiWorkflowReadInputV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { ForgeCiReadValueV1, ForgeCiReadsV1 } from '../runtime/reads.js';
import { useForgeCiQueryV1, useForgeCiQueryValueV1 } from './useForgeCiReads.js';
import { useForgeCiPagedQueryV1 } from './useForgeCiPagedQuery.js';

export type ForgeCiWorkflowDetailProps = Readonly<{
  reads: ForgeCiReadsV1 | null; input: ForgeCiWorkflowReadInputV1;
  children(model: Readonly<{
    workflowQuery: ReturnType<typeof useForgeCiQueryV1<'readWorkflow'>>;
    runsQuery: ReturnType<typeof useForgeCiPagedQueryV1<'listRuns'>>;
    workflow: ForgeCiReadValueV1<'readWorkflow'> | null;
    runs: ForgeCiReadValueV1<'listRuns'> | null;
  }>): ReactNode;
}>;

/** Only the selected workflow admits history; no workflow-file read on ordinary detail. */
export function ForgeCiWorkflowDetail({ reads, input, children }: ForgeCiWorkflowDetailProps): ReactNode {
  const workflowQuery = useForgeCiQueryV1(reads, 'readWorkflow', input);
  const runsQuery = useForgeCiPagedQueryV1(reads, 'listRuns', { repository: input.repository, workflowId: input.workflowId, filters: {} });
  const workflow = useForgeCiQueryValueV1(workflowQuery);
  const runs = useForgeCiQueryValueV1(runsQuery);
  return children({ workflowQuery, runsQuery, workflow, runs });
}
