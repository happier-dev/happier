import type {
    ReviewCommentListResponseV1,
    ReviewCommentV1,
} from '@happier-dev/protocol';

export type ReviewCommentsState = Readonly<{
    byId: Readonly<Record<string, ReviewCommentV1>>;
    ids: readonly string[];
    cursor: string | null;
}>;

export function createEmptyReviewCommentsState(): ReviewCommentsState {
    return { byId: {}, ids: [], cursor: null };
}

export function applyReviewCommentList(
    _state: ReviewCommentsState,
    response: ReviewCommentListResponseV1,
): ReviewCommentsState {
    const byId: Record<string, ReviewCommentV1> = {};
    const ids: string[] = [];
    for (const comment of response.items) {
        byId[comment.id] = comment;
        ids.push(comment.id);
    }
    return {
        byId,
        ids,
        cursor: response.cursor,
    };
}

export function upsertReviewComment(
    state: ReviewCommentsState,
    comment: ReviewCommentV1,
): ReviewCommentsState {
    const exists = Object.prototype.hasOwnProperty.call(state.byId, comment.id);
    return {
        byId: {
            ...state.byId,
            [comment.id]: comment,
        },
        ids: exists ? state.ids : [...state.ids, comment.id],
        cursor: state.cursor,
    };
}
