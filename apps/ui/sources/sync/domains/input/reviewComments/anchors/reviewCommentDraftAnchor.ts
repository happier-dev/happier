import { getReviewCommentDraftAnchorPrimaryLine } from '@happier-dev/protocol/messages/structured/reviewCommentsInput';
import type { ReviewCommentAnchor } from '../reviewCommentTypes';

export { getReviewCommentDraftAnchorPrimaryLine, formatReviewCommentDraftAnchorLabel } from '@happier-dev/protocol/messages/structured/reviewCommentsInput';

export type ReviewCommentDraftDurableAnchorTarget =
    | Readonly<{ kind: 'line'; filePath: string; line: number; side?: 'before' | 'after' }>
    | Readonly<{ kind: 'range'; filePath: string; startLine: number; endLine: number; side?: 'before' | 'after' }>;

export function mapReviewCommentDraftAnchorToDurableV1Target(params: {
    filePath: string;
    anchor: ReviewCommentAnchor;
}): ReviewCommentDraftDurableAnchorTarget | null {
    const { anchor, filePath } = params;
    if (anchor.kind === 'fileLine') return { kind: 'line', filePath, line: anchor.startLine };
    if (anchor.kind === 'diffLine') {
        const line = getReviewCommentDraftAnchorPrimaryLine(anchor);
        return line == null ? null : { kind: 'line', filePath, line, side: anchor.side };
    }
    if (anchor.kind === 'line') {
        return { kind: 'line', filePath: anchor.filePath || filePath, line: anchor.line, side: anchor.side };
    }
    return {
        kind: 'range',
        filePath: anchor.filePath || filePath,
        startLine: anchor.startLine,
        endLine: anchor.endLine,
        side: anchor.side,
    };
}
