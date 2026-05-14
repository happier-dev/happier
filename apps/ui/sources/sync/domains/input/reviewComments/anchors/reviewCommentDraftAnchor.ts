import type { ReviewCommentAnchor } from '../reviewCommentTypes';

export type ReviewCommentDraftDurableAnchorTarget =
    | Readonly<{ kind: 'line'; filePath: string; line: number; side?: 'before' | 'after' }>
    | Readonly<{ kind: 'range'; filePath: string; startLine: number; endLine: number; side?: 'before' | 'after' }>;

export function getReviewCommentDraftAnchorPrimaryLine(anchor: ReviewCommentAnchor): number | null {
    if (anchor.kind === 'fileLine') return anchor.startLine;
    if (anchor.kind === 'diffLine') {
        const line = anchor.side === 'after' ? anchor.newLine : anchor.oldLine;
        return typeof line === 'number' && Number.isFinite(line) ? line : null;
    }
    if (anchor.kind === 'line') return anchor.line;
    return anchor.startLine;
}

function formatLineHashSuffix(hashes: readonly (string | undefined)[]): string {
    const present = hashes.filter((hash): hash is string => typeof hash === 'string' && hash.length > 0);
    return present.length > 0 ? ` - ${present.join(' - ')}` : '';
}

export function formatReviewCommentDraftAnchorLabel(anchor: ReviewCommentAnchor): string {
    if (anchor.kind === 'fileLine') {
        return `L${anchor.startLine}${formatLineHashSuffix([anchor.lineHash])}`;
    }
    if (anchor.kind === 'diffLine') {
        const sideText = anchor.side === 'after' ? 'after' : 'before';
        const line = getReviewCommentDraftAnchorPrimaryLine(anchor);
        const lineText = line == null ? 'L?' : `L${line}`;
        return `${sideText} ${lineText}${formatLineHashSuffix([anchor.lineHash])}`;
    }
    if (anchor.kind === 'line') {
        const sideText = anchor.side ? `${anchor.side} ` : '';
        return `${sideText}L${anchor.line}${formatLineHashSuffix([anchor.lineHash])}`;
    }
    const sideText = anchor.side ? `${anchor.side} ` : '';
    return `${sideText}L${anchor.startLine}-L${anchor.endLine}${formatLineHashSuffix([
        anchor.startLineHash,
        anchor.endLineHash,
    ])}`;
}

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
