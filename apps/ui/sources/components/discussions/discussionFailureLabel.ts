import { t } from '@/text';
import { DiscussionErrorCodeV1Schema } from '@happier-dev/protocol/discussions/api';
import { readTransientAvailabilityFailure } from '@/utils/errors/transientAvailability';

/**
 * One presenter for the typed refusal vocabulary the repository already
 * classifies: the reason a person can act on, not a generic "Failed".
 */
export function discussionFailureLabel(errorCode: string | undefined): string {
    const transient = readTransientAvailabilityFailure(errorCode, { safeToRetry: true });
    if (transient) return transient.message;
    switch (errorCode) {
        case 'outcome_unknown': return t('session.collaboration.discussion.deliveryUnknown');
        // A file the send could not read stays in the tray with its reason, as in a Session.
        case 'attachment_too_large': return t('files.transfers.failureReasons.tooLarge');
        case 'attachment_source_unavailable':
        case 'attachment_source_changed':
        case 'discussion_content_unavailable': return t('common.unavailable');
        case 'offline': return t('session.collaboration.discussion.offline');
        case 'locked': return t('session.access.preparing');
        case 'discussion_post_denied': return t('session.collaboration.discussion.postDenied');
        case 'discussion_task_share_required': return t('session.collaboration.discussion.controls.taskShareRequired');
        case 'discussion_access_forbidden':
        case 'discussion_manage_denied': return t('errors.permissionDenied');
        case 'discussion_invalid_mention': return t('session.collaboration.discussion.invalidMention');
        case 'discussion_invalid_content': return t('session.collaboration.discussion.invalidContent');
        case 'discussion_archived': return t('session.collaboration.discussion.archivedNotice');
        case 'discussion_encryption_mode_mismatch': return t('session.collaboration.discussion.locked');
        case 'discussion_idempotency_conflict': return t('session.collaboration.discussion.idempotencyConflict');
        case 'discussions_unavailable': return t('session.collaboration.discussion.unavailable');
        case 'doc_passage_mismatch':
        case 'server_target_mismatch':
        case 'invalid_parameters':
            return t('errors.errorWithCode', { message: t('session.collaboration.discussion.sendFailed'), code: errorCode });
        default: {
            // Only the closed protocol vocabulary is displayable; opaque diagnostics may contain private data.
            const reason = DiscussionErrorCodeV1Schema.safeParse(errorCode);
            return reason.success
                ? t('errors.errorWithCode', { message: t('session.collaboration.discussion.sendFailed'), code: reason.data })
                : t('session.collaboration.discussion.sendFailed');
        }
    }
}
