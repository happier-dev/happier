import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { readHostAdmittedReviewedChildRoleV1, readHostAdmittedReviewedRootV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { MANAGED_EXEC_ACTION_ID_V1, MANAGED_POWER_SET_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';

/** Only an admitted exec wake settles at native power, independently of the guest daemon. */
export function isReviewedManagedExecWake(actionId: string, input: unknown, context?: ActionExecutorContext): boolean {
    return actionId === MANAGED_POWER_SET_ACTION_ID_V1
        && readHostAdmittedReviewedChildRoleV1(context, actionId, input) === 'managed-wake'
        && readHostAdmittedReviewedRootV1(context)?.actionId === MANAGED_EXEC_ACTION_ID_V1;
}
