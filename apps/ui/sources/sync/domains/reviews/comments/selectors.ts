import type {
    ReviewCommentStateV1,
    ReviewCommentV1,
} from '@happier-dev/protocol';

import type { ReviewCommentsState } from './store';

export type ReviewCommentFilters = Readonly<{
    engineId?: string;
    runId?: string;
    states?: readonly ReviewCommentStateV1[];
    authorKind?: ReviewCommentV1['author']['kind'];
    authorId?: string;
    filePath?: string;
}>;

function commentFilePath(comment: ReviewCommentV1): string | null {
    return 'filePath' in comment.anchor ? comment.anchor.filePath : null;
}

function commentAuthorId(comment: ReviewCommentV1): string {
    if (comment.author.kind === 'plugin') return comment.author.pluginId;
    if (comment.author.kind === 'agent') return comment.author.agentId;
    return comment.author.userId;
}

function matchesFilters(comment: ReviewCommentV1, filters: ReviewCommentFilters): boolean {
    if (filters.engineId && comment.engineId !== filters.engineId) return false;
    if (filters.runId && comment.runId !== filters.runId) return false;
    if (filters.states && filters.states.length > 0 && !filters.states.includes(comment.state)) return false;
    if (filters.authorKind && comment.author.kind !== filters.authorKind) return false;
    if (filters.authorId && commentAuthorId(comment) !== filters.authorId) return false;
    if (filters.filePath && commentFilePath(comment) !== filters.filePath) return false;
    return true;
}

export function selectReviewComments(
    state: ReviewCommentsState,
    filters: ReviewCommentFilters = {},
): readonly ReviewCommentV1[] {
    return state.ids
        .map((id) => state.byId[id])
        .filter((comment): comment is ReviewCommentV1 => Boolean(comment))
        .filter((comment) => matchesFilters(comment, filters))
        .sort((left, right) => right.updatedAt - left.updatedAt);
}
