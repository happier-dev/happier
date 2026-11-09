import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { Modal } from '@/modal';
import { t } from '@/text';

/** Both Settings authors present the canonical typed refusal without losing its reason. */
export function presentSettingWriteFailure(failure: unknown): void {
    const code = failure && typeof failure === 'object'
        ? 'errorCode' in failure ? failure.errorCode : 'code' in failure ? failure.code : undefined
        : undefined;
    if (code === 'action_account_scope_changed' || isActionApprovalDeclinedErrorCode(code)) return;
    if (presentActionTurnedOffNoticeIfOff({ errorCode: code }, 'settings.set')) return;
    Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(failure, t('common.unavailable')));
}
