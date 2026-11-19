import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import type { ReviewCommentGetResponseV1 } from '@happier-dev/protocol/reviews/comments/actions';
import { REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ReviewCommentUiActionExecutor } from './api';
import { recordReviewCommentWrites, resolveReviewCommentExecutor } from './reviewRunComments';

const changedCommentReads = new Map<string, Promise<ReviewCommentV1>>();

/** Shared finite reads keep two mounted views from opening the same changed comment twice. */
function readChangedComment(scope: ServerAccountScope, commentId: string, reviewId: string | undefined, revision: number,
    execute?: ReviewCommentUiActionExecutor, appearanceCount?: number): Promise<ReviewCommentV1> {
    const key = `${serverAccountScopeKeySuffix(scope)}\u0000${commentId}`;
    const pending = changedCommentReads.get(key);
    if (pending) return pending.then(comment =>
        comment.serverRevision >= revision && (appearanceCount === undefined || (comment.appearances?.length ?? 0) >= appearanceCount)
            ? comment : readChangedComment(scope, commentId, reviewId, revision, execute, appearanceCount));
    const result = Promise.resolve().then(async () => {
        const response = await resolveReviewCommentExecutor(scope, execute)('reviews.comments.get', { commentId, ...(reviewId ? { reviewId } : {}), includeHistory: true }) as ReviewCommentGetResponseV1;
        recordReviewCommentWrites([response.comment], scope);
        return response.comment;
    }).finally(() => { if (changedCommentReads.get(key) === result) changedCommentReads.delete(key); });
    changedCommentReads.set(key, result);
    return result;
}

/** Mounted comment slices consume the same parsed AccountChange owner and shared targeted read. */
export function observeReviewCommentChanges(params: Readonly<{
    scope: ServerAccountScope;
    reviewId?: string;
    readComments: () => readonly ReviewCommentV1[];
    execute?: ReviewCommentUiActionExecutor;
    reload: () => Promise<void>;
    onReadFailed?: (error: unknown) => void;
}>): () => void {
    return subscribeHomeAccountChange(event => {
        const held = params.readComments();
        if (event.reviewCommentChanges !== undefined) {
            let unseen = false;
            for (const change of event.reviewCommentChanges) {
                const comment = held.find(item => item.id === change.commentId && item.reviewId === change.reviewId);
                if (!comment) { unseen ||= params.reviewId === change.reviewId; continue; }
                if (comment.serverRevision >= change.serverRevision
                    && (change.appearanceCount === undefined || (comment.appearances?.length ?? 0) >= change.appearanceCount)) continue;
                void readChangedComment(params.scope, comment.id, comment.reviewId, change.serverRevision, params.execute,
                    change.appearanceCount).catch(error => params.onReadFailed?.(error));
            }
            if (unseen) void params.reload().catch(error => params.onReadFailed?.(error));
            return;
        }
        // Legacy/coarse repair has no comment ids; re-read only the demanded Review slice.
        const reviewIds = params.reviewId ? [params.reviewId] : held.flatMap(comment => comment.reviewId ? [comment.reviewId] : []);
        if (!event.entityIds || event.entityIds.some(id => reviewIds.includes(id))) void params.reload().catch(error => params.onReadFailed?.(error));
    }, { serverIds: [params.scope.serverId], artifactKinds: [REVIEW_ARTIFACT_KIND_V1], includeCatchUpPending: 'recovery' });
}
