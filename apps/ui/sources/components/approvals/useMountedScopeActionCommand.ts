import * as React from 'react';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ScopeActionInputById } from '@happier-dev/protocol/actions/scopeActionFamily';

import { useMountedActionExecution } from './useMountedActionExecution';
import type { MountedScopeActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import { Modal } from '@/modal';
import { t } from '@/text';

/** View controls share mounted Action admission, approval retention and refusal presentation. */
export function useMountedScopeActionCommand(scope: Parameters<typeof useMountedActionExecution>[0]) {
    const { execute, isCurrent } = useMountedActionExecution(scope);
    return React.useCallback(async <TAction extends 'shell.column.set'>(
        actionId: TAction, input: ScopeActionInputById[TAction], owner: MountedScopeActionOwner,
    ): Promise<boolean> => {
        try {
            const result = await execute(actionId, input, { executorOptions: { scopeActionOwner: owner } });
            if (!isCurrent()) return false;
            if (result.ok) return true;
            if (isActionApprovalDeclinedErrorCode(result.errorCode) || result.errorCode === 'action_cancelled') return false;
            if (!presentActionTurnedOffNoticeIfOff(result, actionId)) Modal.alert(t('common.error'), t('common.unavailable'));
        } catch {
            if (isCurrent()) Modal.alert(t('common.error'), t('common.unavailable'));
        }
        return false;
    }, [execute, isCurrent]);
}
