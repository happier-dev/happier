import type { WorkspaceAnchorResolutionV1 } from '@happier-dev/protocol';

import type { ReviewCommentAnchor, ReviewCommentDraft, ReviewCommentSnapshot } from './reviewCommentTypes';
import {
    formatReviewCommentDraftAnchorLabel,
    getReviewCommentDraftAnchorPrimaryLine,
} from './anchors/reviewCommentDraftAnchor';

export function isReviewCommentDraftIncludedInPrompt(draft: ReviewCommentDraft): boolean {
    return draft.includeInPrompt !== false;
}

export function filterReviewCommentDraftsIncludedInPrompt(drafts: readonly ReviewCommentDraft[]): ReviewCommentDraft[] {
    return drafts.filter(isReviewCommentDraftIncludedInPrompt);
}

function formatAnchor(draft: ReviewCommentDraft): string {
    return formatReviewCommentDraftAnchorLabel(draft.anchor);
}

function formatResolvedAnchor(anchor: WorkspaceAnchorResolutionV1['resolvedAnchor']): string | null {
    if (!anchor) return null;
    return formatReviewCommentDraftAnchorLabel(anchor as ReviewCommentAnchor);
}

function formatSnapshot(snapshot: ReviewCommentSnapshot): string {
    const snapshotLines = [
        ...snapshot.beforeContext,
        ...snapshot.selectedLines,
        ...snapshot.afterContext,
    ];
    return snapshotLines.length > 0
        ? `   - snippet:\n${snapshotLines.map((l) => `     ${l}`).join('\n')}\n`
        : '';
}

function formatResolution(resolution: WorkspaceAnchorResolutionV1 | undefined): string {
    if (!resolution) return '';
    const resolvedAnchor = formatResolvedAnchor(resolution.resolvedAnchor);
    const statusLine = resolvedAnchor
        ? `   - resolved: ${resolution.status} ${resolvedAnchor}`
        : `   - resolved: ${resolution.status}`;
    const details = [
        statusLine,
        `   - confidence: ${resolution.confidence}`,
        resolution.reason ? `   - reason: ${resolution.reason}` : '',
        resolution.preview ? formatSnapshot(resolution.preview).trimEnd() : '',
    ].filter(Boolean);
    return details.length > 0 ? details.join('\n') : '';
}

export function buildReviewCommentsPromptText(params: {
    sessionId: string;
    drafts: readonly ReviewCommentDraft[];
    additionalMessage: string;
}): string {
    const drafts = filterReviewCommentDraftsIncludedInPrompt(params.drafts).sort((a, b) => {
        if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
        const aLine = getReviewCommentDraftAnchorPrimaryLine(a.anchor) ?? 0;
        const bLine = getReviewCommentDraftAnchorPrimaryLine(b.anchor) ?? 0;
        if (aLine !== bLine) return aLine - bLine;
        return a.createdAt - b.createdAt;
    });

    const header = 'Review comments:\n';
    const blocks = drafts.map((draft, index) => {
        const snapshot = formatSnapshot(draft.snapshot);
        return [
            `${index + 1}) ${draft.filePath} (${formatAnchor(draft)})`,
            formatResolution(draft.anchorResolution),
            snapshot.trimEnd(),
            `   - comment: ${draft.body}`,
        ].filter(Boolean).join('\n');
    });

    const message = params.additionalMessage.trim();
    const messageBlock = message.length > 0 ? `\n\nAdditional message:\n${message}` : '';

    return `${header}\n${blocks.join('\n\n')}${messageBlock}`.trimEnd() + '\n';
}

export function buildReviewCommentsDisplayText(params: { drafts: readonly ReviewCommentDraft[] }): string {
    const count = params.drafts.length;
    if (count === 0) return 'Review comments';
    return `Review comments (${count})`;
}
