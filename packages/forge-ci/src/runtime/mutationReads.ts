import { sameScmHostingRepositoryIdentity, type ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import type { ForgeCiMutationResultV1, ForgeCiOperationIdV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { ForgeCiReadOperationV1 } from './reads.js';

type Affected = Exclude<ForgeCiMutationResultV1, { kind: 'rejected' }>['affected'];

/** Select retained queries from the Action's admitted change facts, never from a view's location. */
export function forgeCiMutationAffectsReadV1(
  mutation: ForgeCiOperationIdV1,
  affected: Affected,
  operation: ForgeCiReadOperationV1,
  input: Readonly<Record<string, unknown>>,
): boolean {
  if (!sameScmHostingRepositoryIdentity(input.repository as ScmHostingRepositoryIdentityV1, affected.repository)) return false;
  const workflowMetadata = mutation === 'enableWorkflow' || mutation === 'disableWorkflow';
  if (operation === 'listWorkflows') return workflowMetadata;
  if (operation === 'readWorkflow') return workflowMetadata && input.workflowId === affected.workflowId;
  if (workflowMetadata) return false;
  if (operation === 'listRuns') {
    // A new run changes the head; retained continuation pages keep their existing frontier.
    if (input.cursor !== undefined) return false;
    const filters = input.filters as Readonly<{ branch?: string }>;
    const workflowId = input.workflowId;
    return (workflowId === undefined || affected.workflowId === undefined || workflowId === affected.workflowId)
      && (filters.branch === undefined || affected.ref === undefined || filters.branch === affected.ref);
  }
  if (operation === 'readJob') return affected.jobId !== undefined && input.jobId === affected.jobId;
  if (operation === 'readRun' || operation === 'listJobs' || operation === 'listDeployments'
    || operation === 'readDeploymentHistory') {
    if (input.runId !== affected.run?.runId) return false;
    const attempt = affected.selection?.kind === 'attempt' ? affected.selection.attempt.attemptId : undefined;
    return input.attempt === undefined || attempt === undefined || input.attempt === attempt;
  }
  return false;
}
