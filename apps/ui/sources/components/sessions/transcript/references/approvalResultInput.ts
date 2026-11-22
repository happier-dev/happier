import { readSessionMessageProvenance } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { resolveActionTitle } from '@/text/actionTitles';
import { t } from '@/text';

/**
 * The local id `actionExecutor` gives the decided approval's result when it delivers it to the
 * requesting Session as host input (`packages/protocol/src/actions/actionExecutor.ts`).
 */
const APPROVAL_RESULT_LOCAL_ID_PREFIX = 'approval-result:';

export function approvalResultLocalId(artifactId: string): string {
  return `${APPROVAL_RESULT_LOCAL_ID_PREFIX}${artifactId}`;
}

export function readApprovalResultArtifactId(
  message: Readonly<{ localId?: string | null; meta?: unknown }>,
): string | null {
  if (!message.localId?.startsWith(APPROVAL_RESULT_LOCAL_ID_PREFIX))
    return null;
  if (readSessionMessageProvenance(message.meta, 'stored')?.kind !== 'host')
    return null;
  return message.localId.slice(APPROVAL_RESULT_LOCAL_ID_PREFIX.length);
}

/**
 * The Agent reads the result payload; a person reads one quiet receipt naming the decided Action.
 * The transcript row and the queued (pending) row both read it, so the payload shows nowhere a person reads.
 * Null for every other message, including a person's own words that happen to look like a payload.
 */
export function readApprovalResultReceiptText(
  message: Readonly<{ localId?: string | null; text: string; meta?: unknown }>,
): string | null {
  if (readApprovalResultArtifactId(message) === null) return null;
  let actionId: unknown;
  try {
    actionId = (JSON.parse(message.text) as { actionId?: unknown } | null)
      ?.actionId;
  } catch {
    actionId = undefined;
  }
  return t('message.approvalResult', {
    action: resolveActionTitle(
      typeof actionId === 'string' ? actionId : '',
      null,
    ),
  });
}
