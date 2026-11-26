import { REVIEW_START_ACTION_ID_V1, isContributedActionRoot } from './actionIds.js';
import { isScmDiffSummaryRunAction } from './scmGitActionSpecs.js';
import { SESSION_RPC_METHODS } from '../rpc/methods.js';

/** Home and the receiving host share each root's declared nested Run Start effect. */
export function isExecutionRunStartRpcPurpose(actionId: string, effectActionId: string | null, method: string): boolean {
  const separator = method.indexOf(':');
  return (isScmDiffSummaryRunAction(actionId) || actionId === REVIEW_START_ACTION_ID_V1 || isContributedActionRoot(actionId))
    && effectActionId === 'execution.run.start'
    && separator > 0 && method.slice(separator + 1) === SESSION_RPC_METHODS.EXECUTION_RUN_START;
}
