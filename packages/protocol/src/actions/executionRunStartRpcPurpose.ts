import { REVIEW_START_ACTION_ID_V1, isContributedActionRoot } from './actionIds.js';
import { isScmDiffSummaryRunAction } from './scmGitActionSpecs.js';
import { SESSION_RPC_METHODS } from '../rpc/methods.js';

/** The exact nested Run Start effect these roots admit before transport. */
export function isExecutionRunStartActionPurpose(actionId: string, effectActionId: string | null): boolean {
  return (isScmDiffSummaryRunAction(actionId) || actionId === REVIEW_START_ACTION_ID_V1 || isContributedActionRoot(actionId))
    && effectActionId === 'execution.run.start';
}

/** Home and the receiving host bind the declared effect to the actual RPC method. */
export function isExecutionRunStartRpcPurpose(actionId: string, effectActionId: string | null, method: string): boolean {
  const separator = method.indexOf(':');
  return isExecutionRunStartActionPurpose(actionId, effectActionId)
    && separator > 0 && method.slice(separator + 1) === SESSION_RPC_METHODS.EXECUTION_RUN_START;
}
