import { DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1 } from '../../deployments/deploymentActionIdsV1.js';
import { DeploymentReceiptGetResultV1Schema } from '../../deployments/deploymentActionsV1.js';
import { ScmPullRequestGetResponseSchema } from '../../scm/pullRequests.js';
import type { TodoLinkedEvidenceReaderV1 } from '../../todos/todoLinkedTaskV1.js';
import type { ActionId } from '../actionIds.js';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '../actionExecutionResult.js';

function refuse(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function unwrap(result: ActionExecuteResult): unknown {
  if (!result.ok) return refuse(result.errorCode);
  if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) {
    return refuse('task_evidence_approval_required');
  }
  return result.result;
}

export function createTodoLinkedEvidenceReaderV1(
  execute: (actionId: ActionId, input: unknown) => Promise<ActionExecuteResult>,
): TodoLinkedEvidenceReaderV1 {
  return {
    async readPullRequest({ sessionId, prRef }) {
      const output = unwrap(await execute('scm.pullRequest.get', { sessionId, prReference: prRef }));
      const parsed = ScmPullRequestGetResponseSchema.safeParse(output);
      if (!parsed.success) return refuse('invalid_action_output');
      if (!parsed.data.success) return refuse(parsed.data.errorCode ?? 'task_pr_unavailable');
      return parsed.data.pullRequest;
    },
    async readDeployment(address) {
      const output = unwrap(await execute(DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1, { ...address, projection: 'investigation' }));
      const parsed = DeploymentReceiptGetResultV1Schema.safeParse(output);
      if (!parsed.success) return refuse('invalid_action_output');
      if (!parsed.data.ok) return refuse(parsed.data.error);
      const { deployment, investigation } = parsed.data;
      const source = investigation?.source;
      const sourceLabel = investigation?.sourceLabel;
      const { id, environmentId, operation, state } = deployment;
      if (operation !== 'deploy' || (state !== 'succeeded' && state !== 'failed')
        || source?.kind !== 'repository' || sourceLabel?.kind !== 'repository') return null;
      return { deploymentId: id, environmentId, projectSourceId: source.projectSourceId, state, sha: sourceLabel.sha };
    },
  };
}
