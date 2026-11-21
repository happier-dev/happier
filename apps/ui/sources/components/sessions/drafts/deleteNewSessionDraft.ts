import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { AppShellActionOutputSchemas } from '@happier-dev/protocol/actions/appShellActionFamily';

import { Modal } from '@/modal';
import {
  resolveActionExecutionErrorMessage,
  resolveActionExecutionFailureMessage,
  resolveActionExecutionFailureTitle,
} from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

type DeleteExecute = (
  actionId: 'session.draft.delete',
  input: Readonly<{ draftId: string }>,
) => Promise<ActionExecuteResult>;

function tell(message: string, failure?: unknown): void {
  Modal.alert(resolveActionExecutionFailureTitle(failure, t('sessionDrafts.delete.failedTitle')), message);
}

/**
 * The one way a surface deletes a New Session draft: the `session.draft.delete` Action, then its outcome.
 * Resolves `true` when the draft is gone. Action refusals are presented even
 * when the initiating view retires. An explicit decline settles in the review.
 */
export async function deleteNewSessionDraft(
  params: Readonly<{
    execute: DeleteExecute | null;
    draftId: string;
  }>,
): Promise<boolean> {
  const fallback = t('errors.operationFailed');
  let outcome: ActionExecuteResult;
  try {
    outcome = params.execute
      ? await params.execute('session.draft.delete', { draftId: params.draftId })
      : { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
  } catch (error) {
    tell(resolveActionExecutionErrorMessage(error, fallback), error);
    return false;
  }
  if (!outcome.ok) {
    if (!isActionApprovalDeclinedErrorCode(outcome.errorCode)) {
      const message = outcome.errorCode === 'action_account_scope_changed'
        ? t('errors.tryAgain')
        : resolveActionExecutionFailureMessage(outcome, fallback) ?? fallback;
      tell(message, outcome);
    }
    return false;
  }
  const parsed = AppShellActionOutputSchemas['session.draft.delete'].safeParse(
    outcome.result,
  );
  const status = parsed.success ? parsed.data.status : null;
  // Already gone counts as deleted: nothing of this draft is left to keep.
  if (status === 'deleted' || status === 'missing') return true;
  tell(
    status === 'launch_custody'
      ? t('sessionDrafts.delete.launchInCustody')
      : fallback,
  );
  return false;
}
