import * as React from 'react';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';

import { ReviewCommentCard } from '@/components/reviews/ReviewCommentCard';
import { ReviewFindingAnchor, ReviewFindingAnchorContext } from '@/components/reviews/ReviewFindingAnchor';
import { buildReviewCommentLabels } from '@/components/reviews/sessionSurfaceLabels';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import type { ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { resolveCodeLineAnchor } from './resolveCodeLineAnchor';

export function SavedReviewCommentNotes(props: Readonly<{
    comments: readonly ReviewCommentV1[];
    serverId?: string;
}>) {
    const openFinding = React.useContext(ReviewFindingAnchorContext);
    if (props.comments.length === 0) return null;
    const labels = buildReviewCommentLabels();
    return <>{props.comments.map(comment => openFinding && comment.finding
        ? <ReviewFindingAnchor key={comment.id} comment={comment} onOpen={openFinding} />
        : <ReviewCommentCard key={comment.id} comment={comment} serverId={props.serverId} labels={labels} />)}</>;
}

export function getSavedReviewFileNotes(params: Readonly<{
    comments?: readonly ReviewCommentV1[];
    filePath: string;
    previousFilePath?: string;
}>) {
    return params.comments?.filter(comment => !comment.parentCommentId && comment.anchor.kind === 'file'
        && (comment.anchor.filePath === params.filePath || comment.anchor.filePath === params.previousFilePath)) ?? [];
}

export function useSavedReviewCommentLines(params: Readonly<{
    comments?: readonly ReviewCommentV1[];
    filePath: string;
    previousFilePath?: string;
    source: ReviewCommentSource;
    lines: readonly CodeLine[];
    serverId?: string;
}>) {
    const commentsByLineId = React.useMemo(() => {
        const result = new Map<string, ReviewCommentV1[]>();
        for (const comment of params.comments ?? []) {
            if (comment.parentCommentId || (comment.anchor.kind !== 'line' && comment.anchor.kind !== 'range')) continue;
            const filePath = comment.anchor.side === 'before' && comment.anchor.filePath === params.previousFilePath
                ? comment.anchor.filePath : params.filePath;
            const resolution = resolveCodeLineAnchor({ filePath, source: params.source, lines: params.lines, anchor: comment.anchor });
            const lineId = resolution.lines.at(-1)?.id;
            if (!lineId) continue;
            const comments = result.get(lineId);
            if (comments) comments.push(comment);
            else result.set(lineId, [comment]);
        }
        return result;
    }, [params.comments, params.filePath, params.previousFilePath, params.lines, params.source]);
    const renderAfterLine = React.useCallback((line: CodeLine) => {
        const comments = commentsByLineId.get(line.id);
        return comments ? <SavedReviewCommentNotes comments={comments} serverId={params.serverId} /> : null;
    }, [commentsByLineId, params.serverId]);
    return commentsByLineId.size > 0 ? renderAfterLine : undefined;
}
