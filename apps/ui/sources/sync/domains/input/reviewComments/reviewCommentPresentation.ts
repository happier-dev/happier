import type { ReviewCommentDraft } from './reviewCommentTypes';

export function getReviewCommentAnchorLine(draft: ReviewCommentDraft): number | null {
    if (draft.anchor.kind === 'fileLine') return draft.anchor.startLine;
    const line = draft.anchor.side === 'after' ? draft.anchor.newLine : draft.anchor.oldLine;
    return typeof line === 'number' && Number.isFinite(line) ? line : null;
}

export function formatReviewCommentAnchorLabel(draft: ReviewCommentDraft): string {
    const line = getReviewCommentAnchorLine(draft);
    const lineText = line == null ? 'L?' : `L${line}`;
    if (draft.anchor.kind === 'fileLine') {
        return draft.anchor.lineHash ? `${lineText} - ${draft.anchor.lineHash}` : lineText;
    }
    const sideText = draft.anchor.side === 'after' ? 'after' : 'before';
    return draft.anchor.lineHash ? `${sideText} ${lineText} - ${draft.anchor.lineHash}` : `${sideText} ${lineText}`;
}
