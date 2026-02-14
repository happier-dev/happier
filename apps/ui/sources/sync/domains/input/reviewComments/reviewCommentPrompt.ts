import type { ReviewCommentDraft } from './reviewCommentTypes';

function formatAnchor(draft: ReviewCommentDraft): string {
    if (draft.anchor.kind === 'fileLine') {
        return `L${draft.anchor.startLine}`;
    }
    const side = draft.anchor.side;
    const line = side === 'after' ? draft.anchor.newLine : draft.anchor.oldLine;
    const lineText = typeof line === 'number' ? `L${line}` : 'L?';
    return `${side} ${lineText}`;
}

export function buildReviewCommentsPromptText(params: {
    sessionId: string;
    drafts: readonly ReviewCommentDraft[];
    additionalMessage: string;
}): string {
    const drafts = [...params.drafts].sort((a, b) => {
        if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
        const aLine = a.anchor.kind === 'fileLine' ? a.anchor.startLine : (a.anchor.newLine ?? a.anchor.oldLine ?? 0);
        const bLine = b.anchor.kind === 'fileLine' ? b.anchor.startLine : (b.anchor.newLine ?? b.anchor.oldLine ?? 0);
        if (aLine !== bLine) return aLine - bLine;
        return a.createdAt - b.createdAt;
    });

    const header = 'Review comments:\n';
    const blocks = drafts.map((draft, index) => {
        const snapshotLines = [
            ...draft.snapshot.beforeContext,
            ...draft.snapshot.selectedLines,
            ...draft.snapshot.afterContext,
        ];
        const snapshot = snapshotLines.length > 0
            ? `   - snippet:\n${snapshotLines.map((l) => `     ${l}`).join('\n')}\n`
            : '';
        return [
            `${index + 1}) ${draft.filePath} (${formatAnchor(draft)})`,
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

