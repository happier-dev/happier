import * as React from 'react';

import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { storage } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { t } from '@/text';

export function useSessionReviewCommentDraftHandlers(sessionId: string | null | undefined): Readonly<{
    onUpsertReviewCommentDraft: (draft: ReviewCommentDraft) => void;
    onDeleteReviewCommentDraft: (commentId: string) => void;
    onReviewCommentError: (message: string) => void;
}> {
    const resolvedSessionId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;

    const onUpsertReviewCommentDraft = React.useCallback((draft: ReviewCommentDraft) => {
        if (!resolvedSessionId) return;
        storage.getState().upsertSessionReviewCommentDraft(resolvedSessionId, draft);
    }, [resolvedSessionId]);

    const onDeleteReviewCommentDraft = React.useCallback((commentId: string) => {
        if (!resolvedSessionId) return;
        storage.getState().deleteSessionReviewCommentDraft(resolvedSessionId, commentId);
    }, [resolvedSessionId]);

    const onReviewCommentError = React.useCallback((message: string) => {
        Modal.alert(t('common.error'), message);
    }, []);

    return { onUpsertReviewCommentDraft, onDeleteReviewCommentDraft, onReviewCommentError };
}
