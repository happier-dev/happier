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
 * Resolves `true` when the draft is gone. When it is not, the person is told why, once (JOURNEY-OPUS-83 D13:
 * a refused or unanswered Delete left the text and its row with no word). A declined confirmation, or a
 * surface that is no longer current, stays quiet.
 */
export async function deleteNewSessionDraft(
  params: Readonly<{
    execute: DeleteExecute;
    draftId: string;
    isCurrent?: () => boolean;
  }>,
): Promise<boolean> {
  const isCurrent = params.isCurrent ?? (() => true);
  const fallback = t('errors.operationFailed');
  let outcome: ActionExecuteResult;
  try {
    outcome = await params.execute('session.draft.delete', {
      draftId: params.draftId,
    });
  } catch (error) {
    if (isCurrent()) tell(resolveActionExecutionErrorMessage(error, fallback), error);
    return false;
  }
  if (!isCurrent()) return false;
  if (!outcome.ok) {
    if (!isActionApprovalDeclinedErrorCode(outcome.errorCode))
      tell(resolveActionExecutionFailureMessage(outcome, fallback) ?? fallback, outcome);
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
