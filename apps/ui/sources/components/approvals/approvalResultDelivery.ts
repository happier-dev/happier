import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { SessionInputAdmissionResultV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

import { presentActionFailureOutcome } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { t } from '@/text';

/** The stored receipt of where an approved Action's result went, as the approval record carries it. */
export function readApprovalResultDelivery(
  request: ApprovalRequest,
): SessionInputAdmissionResultV1 | undefined {
  return request.v === 2 ? request.delivery : undefined;
}

/** A result that did not reach its asking Session: refused, held, or of unknown outcome. Delivered stays quiet. */
export function isApprovalResultUndelivered(
  delivery: SessionInputAdmissionResultV1 | undefined,
): boolean {
  return (
    delivery?.status === 'rejected' ||
    delivery?.status === 'held' ||
    delivery?.status === 'outcomeUnknown'
  );
}

export type ApprovalResultDeliveryReceipt = Readonly<{
  kind: 'not_sent' | 'held' | 'unsure';
  /** The Session ask-record word for where the result went. */
  detail: string;
  /** Why, when the receipt knows. */
  subtitle?: string;
  failure: ReturnType<typeof presentActionFailureOutcome> | null;
}>;

/**
 * The one presentation of a result's delivery receipt, read by the approval page's Delivery row and the
 * settled card in the asking Session's transcript, in the Session ask-record words.
 */
export function presentApprovalResultDelivery(
  delivery: SessionInputAdmissionResultV1 | undefined,
): ApprovalResultDeliveryReceipt | null {
  if (delivery?.status === 'rejected') {
    const failure = presentActionFailureOutcome({
      errorCode: delivery.code,
      error: delivery.code,
      failureCause: delivery.failureCause,
    });
    return {
      kind: 'not_sent',
      detail: t('session.askRecord.notSent'),
      // The Session that asked is gone: say that, not the message-send words for an unavailable conversation.
      subtitle: delivery.code === 'session_input_target_unavailable'
        ? t('approvals.deliveryAskingSessionUnavailable')
        : failure.reason ?? undefined,
      failure,
    };
  }
  if (delivery?.status === 'held') {
    const heldCause =
      delivery.failureCause && 'errorCode' in delivery.failureCause
        ? delivery.failureCause.errorCode
        : null;
    return {
      kind: 'held',
      detail: t('session.askRecord.waitsForYou'),
      subtitle:
        heldCause === 'held_by_person'
          ? t('errors.sessionHeldByPerson')
          : undefined,
      failure: null,
    };
  }
  if (delivery?.status === 'outcomeUnknown') {
    return {
      kind: 'unsure',
      detail: t('session.askRecord.unsure'),
      subtitle: t('session.askRecord.unsureHint'),
      failure: null,
    };
  }
  return null;
}
