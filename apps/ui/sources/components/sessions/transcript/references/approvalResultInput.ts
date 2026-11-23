import { readSessionMessageProvenance } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { ApprovalExecutionV2Schema, ApprovalRequestV2StatusSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { readActionFailurePresentationV1 } from '@happier-dev/protocol/actions/actionFailurePresentation';
import { formatApprovalStatusLabel } from '@/components/approvals/approvalStatusLabel';
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
export function readApprovalResultReceipt(
  message: Readonly<{ localId?: string | null; text: string; meta?: unknown }>,
) {
  const artifactId = readApprovalResultArtifactId(message);
  if (artifactId === null) return null;
  let payload: { actionId?: unknown; status?: unknown; execution?: unknown } | null;
  try {
    payload = JSON.parse(message.text);
  } catch {
    payload = null;
  }
  const action = resolveActionTitle(typeof payload?.actionId === 'string' ? payload.actionId : '', null);
  const parsedStatus = ApprovalRequestV2StatusSchema.safeParse(payload?.status);
  const status = parsedStatus.success ? parsedStatus.data : null;
  const execution = ApprovalExecutionV2Schema.safeParse(payload?.execution);
  // An approved Action whose run failed never reads as a success. Its cause is said once, on the card.
  if ((status === 'approved' || status === 'executed') && execution.success && !execution.data.ok) {
    return { artifactId, status, text: [formatApprovalStatusLabel('failed'), action].join(' · ') };
  }
  if (status === 'approved' || status === 'executed') {
    return { artifactId, status, text: t('message.approvalResult', { action }) };
  }
  const refusal = execution.success && !execution.data.ok
    ? readActionFailurePresentationV1(execution.data.errorCode, execution.data.details) : null;
  return { artifactId, status, text: [status && formatApprovalStatusLabel(status), action, refusal?.message]
    .filter(Boolean).join(' · ') };
}

export function readApprovalResultReceiptText(
  message: Parameters<typeof readApprovalResultReceipt>[0],
): string | null {
  return readApprovalResultReceipt(message)?.text ?? null;
}
