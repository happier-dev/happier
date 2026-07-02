import { t } from '@/text';

import type { ReviewCommentLabels } from './labels';

export type ReviewCommentsPanelLabels = ReviewCommentLabels & Readonly<{ filtersTitle: string }>;

export function buildReviewCommentLabels(): ReviewCommentsPanelLabels {
    return {
        empty: t('files.reviewComments.durable.empty'),
        directWriteGranted: t('files.reviewComments.durable.directWriteGranted'),
        directWriteMissing: t('files.reviewComments.durable.directWriteMissing'),
        engine: t('files.reviewComments.durable.engine'),
        stale: t('files.reviewComments.durable.stale'),
        outdated: t('files.reviewComments.durable.outdated'),
        binarySnapshot: t('files.reviewComments.durable.binarySnapshot'),
        minified: t('files.reviewComments.durable.minified'),
        submoduleSnapshot: t('files.reviewComments.durable.submoduleSnapshot'),
        symlinkSnapshot: t('files.reviewComments.durable.symlinkSnapshot'),
        textSnapshot: t('files.reviewComments.durable.textSnapshot'),
        tooLargeSnapshot: t('files.reviewComments.durable.tooLargeSnapshot'),
        encryptedSnapshot: t('files.reviewComments.durable.encryptedSnapshot'),
        truncated: t('files.reviewComments.durable.truncated'),
        bidiControls: t('files.reviewComments.durable.bidiControls'),
        redacted: t('files.reviewComments.durable.redacted'),
        contentUnavailable: t('files.reviewComments.durable.contentUnavailable'),
        edit: t('files.reviewComments.durable.edit'),
        resolve: t('files.reviewComments.durable.resolve'),
        dismiss: t('files.reviewComments.durable.dismiss'),
        reopen: t('files.reviewComments.durable.reopen'),
        redact: t('files.reviewComments.durable.redact'),
        reply: t('files.reviewComments.durable.reply'),
        replyUnavailable: t('files.reviewComments.durable.replyUnavailable'),
        bulkResolve: t('files.reviewComments.durable.bulkResolve'),
        bulkDismiss: t('files.reviewComments.durable.bulkDismiss'),
        bulkPartialFailure: t('files.reviewComments.durable.bulkPartialFailure'),
        bulkFailure: ({ commentId, errorCode }: Readonly<{ commentId: string; errorCode: string }>) =>
            t('files.reviewComments.durable.bulkFailure', { commentId, errorCode }),
        filtersTitle: t('files.reviewComments.durable.filtersTitle'),
        states: {
            proposed: t('files.reviewComments.durable.states.proposed'),
            open: t('files.reviewComments.durable.states.open'),
            delegated: t('files.reviewComments.durable.states.delegated'),
            pending_review: t('files.reviewComments.durable.states.pendingReview'),
            resolved: t('files.reviewComments.durable.states.resolved'),
            dismissed: t('files.reviewComments.durable.states.dismissed'),
        },
    };
}

export function buildReviewCommentsHeaderLabels() {
    return {
        title: t('files.reviewComments.durable.headerTitle'),
        count: ({ count }: Readonly<{ count: number }>) => t('files.reviewComments.durable.count', { count }),
    };
}

export function buildReviewCommentDirectWriteGrantLabels() {
    return {
        title: t('files.reviewComments.durable.directWriteGrant.title'),
        body: ({ pluginId }: Readonly<{ pluginName: string; pluginId: string }>) =>
            t('files.reviewComments.durable.directWriteGrant.body', { pluginId }),
        grant: t('files.reviewComments.durable.directWriteGrant.grant'),
        cancel: t('files.reviewComments.durable.directWriteGrant.cancel'),
    };
}
