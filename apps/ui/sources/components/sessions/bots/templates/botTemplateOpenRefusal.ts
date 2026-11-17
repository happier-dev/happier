import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { t } from '@/text';

/** A template the person can't open: retrying the same address won't change it (lab r2 install-states "No longer shared"). */
export type BotTemplateOpenRefusal =
  | 'plain_account'
  | 'not_found'
  | 'no_access';

/** One reading of a refused template open, for the preview and the signed-in link alike. */
export function readBotTemplateOpenRefusal(
  result: Extract<ActionExecuteResult, { ok: false }>,
): BotTemplateOpenRefusal | null {
  const details = result.details;
  if (
    result.errorCode === 'recipient_key_unavailable' &&
    details &&
    typeof details === 'object' &&
    'reason' in details &&
    details.reason === 'plain_account'
  )
    return 'plain_account';
  if (
    result.errorCode === 'artifact_not_found' ||
    result.errorCode === 'not_found'
  )
    return 'not_found';
  if (
    result.errorCode === 'artifact_access_forbidden' ||
    result.errorCode === 'artifact_access_revoked'
  )
    return 'no_access';
  return null;
}

export function describeBotTemplateOpenRefusal(
  refusal: BotTemplateOpenRefusal,
): string {
  // Deleted and unshared read the same to a recipient: the template is gone from them, their copies are not.
  return refusal === 'plain_account'
    ? t('botTemplates.encryptedAccountRequired')
    : t('botTemplates.noLongerShared');
}
