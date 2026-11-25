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
  kind: 'sent' | 'not_sent' | 'held' | 'unsure';
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
  options?: Readonly<{
    /**
     * The run failed: a result that did reach the asking Session says so, so a failed run is never
     * read as a failed delivery. A successful run's delivered result stays quiet.
     */
    sayDelivered?: boolean;
  }>,
): ApprovalResultDeliveryReceipt | null {
  if (options?.sayDelivered && (delivery?.status === 'accepted' || delivery?.status === 'alreadyAccepted')) {
    return { kind: 'sent', detail: t('session.askRecord.sent'), failure: null };
  }
  if (delivery?.status === 'rejected') {
    const failure = presentActionFailureOutcome({
      errorCode: delivery.code,
      error: delivery.code,
      failureCause: delivery.failureCause,
    });
    const cause = delivery.failureCause;
    const causeCode = cause && 'errorCode' in cause ? cause.errorCode : undefined;
    let subtitle = failure.reason ?? undefined;
    if (delivery.code === 'session_input_archived') {
      subtitle = t('session.pendingMessages.admissionRejected.archived');
    } else if (delivery.code === 'session_input_target_unavailable') {
      // This receipt code also wraps failures before the asking Session is read.
      subtitle = undefined;
      if (causeCode === 'requester_account_material_unavailable') {
        subtitle = t('approvals.deliveryRequesterAccountUnavailable');
      } else if (causeCode === 'machine_offline') {
        subtitle = t('session.machineOfflineNoticeTitle');
      } else if (
        (causeCode === 'session_input_target_unavailable'
          && (cause?.phase === 'session.message.target_lookup' || delivery.effectAttempted === false))
        || (!cause && delivery.effectAttempted === false)
      ) {
        subtitle = t('approvals.deliveryAskingSessionUnavailable');
      }
    }
    return {
      kind: 'not_sent',
      detail: t('session.askRecord.notSent'),
      subtitle,
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
      detail: t('session.askRecord.waitsForResume'),
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
