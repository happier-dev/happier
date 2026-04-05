import type { ReviewCommentDraft } from './reviewCommentTypes';
import { buildReviewCommentsV1MetaPayload } from './reviewCommentMeta';
import { buildReviewCommentsDisplayText, buildReviewCommentsPromptText } from './reviewCommentPrompt';

export function buildReviewCommentsOutboundMessage(params: Readonly<{
    sessionId: string;
    drafts: readonly ReviewCommentDraft[];
    additionalMessage: string;
    displayTextSuffix?: string | null;
}>): Readonly<{
    text: string;
    displayText: string;
    metaOverrides: Record<string, unknown>;
}> {
    const displayTextBase = buildReviewCommentsDisplayText({ drafts: params.drafts });
    const displayTextSuffix = String(params.displayTextSuffix ?? '').trim();

    return {
        text: buildReviewCommentsPromptText({
            sessionId: params.sessionId,
            drafts: params.drafts,
            additionalMessage: params.additionalMessage,
        }),
        displayText: displayTextSuffix.length > 0
            ? `${displayTextBase}\n\n${displayTextSuffix}`
            : displayTextBase,
        metaOverrides: {
            happier: {
                kind: 'review_comments.v1',
                payload: buildReviewCommentsV1MetaPayload({
                    sessionId: params.sessionId,
                    drafts: params.drafts,
                }),
            },
        },
    };
}
