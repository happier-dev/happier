import type { NotificationsService } from '@happier-dev/plugin-sdk/notifications';

/** The one declared notice category; Happier routes it to the person's channels. */
export const REVIEW_READY_NOTICE_CATEGORY = 'review-ready';

/** The Action's daemon handler: one notice through the host notifications service, idempotent by request id. */
export function sendReviewReadyNotice(
  notifications: Pick<NotificationsService, 'send'>,
  signal: AbortSignal,
): ReturnType<NotificationsService['send']> {
  return notifications.send({
    clientRequestId: 'external-review-ready',
    categoryId: REVIEW_READY_NOTICE_CATEGORY,
    title: 'Release review ready',
  }, { signal });
}
