import * as React from 'react';

import { Modal } from '@/modal';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { storage } from '@/sync/domains/state/storage';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';

export function useWorkspaceReviewCommentDraftHandlers(scope: WorkspaceScopeBase | null | undefined): Readonly<{
    onUpsertReviewCommentDraft: (draft: ReviewCommentDraft) => void;
    onDeleteReviewCommentDraft: (commentId: string) => void;
    clearReviewCommentDrafts: () => void;
    onReviewCommentError: (message: string) => void;
}> {
    const cacheKey = React.useMemo(() => {
        if (!scope) return null;
        try {
            return buildWorkspaceCacheKey(scope);
        } catch {
            return null;
        }
    }, [scope]);

    const onUpsertReviewCommentDraft = React.useCallback((draft: ReviewCommentDraft) => {
        if (!cacheKey) return;
        storage.getState().upsertWorkspaceReviewCommentDraft(cacheKey, draft);
    }, [cacheKey]);

    const onDeleteReviewCommentDraft = React.useCallback((commentId: string) => {
        if (!cacheKey) return;
        storage.getState().deleteWorkspaceReviewCommentDraft(cacheKey, commentId);
    }, [cacheKey]);

    const clearReviewCommentDrafts = React.useCallback(() => {
        if (!cacheKey) return;
        storage.getState().clearWorkspaceReviewCommentDrafts(cacheKey);
    }, [cacheKey]);

    const onReviewCommentError = React.useCallback((message: string) => {
        Modal.alert(t('common.error'), message);
    }, []);

    return { onUpsertReviewCommentDraft, onDeleteReviewCommentDraft, clearReviewCommentDrafts, onReviewCommentError };
}
