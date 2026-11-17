import type {
    ReviewCommentListResponseV1} from '@happier-dev/protocol/reviews/comments/actions';
import type {
    ReviewCommentV1,
} from '@happier-dev/protocol/reviews/comments/v1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

export type ReviewCommentsState = Readonly<{
    byId: Readonly<Record<string, ReviewCommentV1>>;
    ids: readonly string[];
    cursor: string | null;
}>;

export function createEmptyReviewCommentsState(): ReviewCommentsState {
    return { byId: {}, ids: [], cursor: null };
}

export function applyReviewCommentList(
    state: ReviewCommentsState,
    response: ReviewCommentListResponseV1,
): ReviewCommentsState {
    const byId: Record<string, ReviewCommentV1> = {};
    const ids: string[] = [];
    for (const comment of response.items) {
        const held = state.byId[comment.id];
        byId[comment.id] = held && sameStrictJsonValue(held, comment) ? held : comment;
        ids.push(comment.id);
    }
    const sameIds = ids.length === state.ids.length && ids.every((id, index) => id === state.ids[index]);
    const sameRows = ids.length === state.ids.length && ids.every((id) => byId[id] === state.byId[id]);
    if (sameIds && sameRows && response.cursor === state.cursor) return state;
    return {
        byId: sameRows ? state.byId : byId,
        ids: sameIds ? state.ids : ids,
        cursor: response.cursor,
    };
}

export function upsertReviewComment(
    state: ReviewCommentsState,
    comment: ReviewCommentV1,
): ReviewCommentsState {
    if (sameStrictJsonValue(state.byId[comment.id], comment)) return state;
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
