import type { ReviewCommentDraft } from './reviewCommentTypes';
import { normalizeReviewCommentDrafts } from './reviewCommentDraftBody';
import { buildReviewCommentsV1MetaPayload } from './reviewCommentMeta';
import {
    buildReviewCommentsDisplayText,
    buildReviewCommentsPromptText,
    filterReviewCommentDraftsIncludedInPrompt,
} from './reviewCommentPrompt';

export function buildReviewCommentsOutboundMessage(params: Readonly<{
    sessionId: string;
    drafts: readonly ReviewCommentDraft[];
    additionalMessage: string;
    displayTextSuffix?: string | null;
    metaOverrides?: Record<string, unknown> | null;
}>): Readonly<{
    text: string;
    displayText: string;
    metaOverrides: Record<string, unknown>;
}> {
    const drafts = normalizeReviewCommentDrafts(filterReviewCommentDraftsIncludedInPrompt(params.drafts));
    const displayTextBase = buildReviewCommentsDisplayText({ drafts });
    const displayTextSuffix = String(params.displayTextSuffix ?? '').trim();
    const metaOverrides = preserveAttachmentEnvelope(params.metaOverrides);

    return {
        text: buildReviewCommentsPromptText({
            sessionId: params.sessionId,
            drafts,
            additionalMessage: params.additionalMessage,
        }),
        displayText: displayTextSuffix.length > 0
            ? `${displayTextBase}\n\n${displayTextSuffix}`
            : displayTextBase,
        metaOverrides: {
            ...metaOverrides,
            happier: {
                kind: 'review_comments.v1',
                payload: buildReviewCommentsV1MetaPayload({
                    sessionId: params.sessionId,
                    drafts,
                }),
            },
        },
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function preserveAttachmentEnvelope(metaOverrides: Record<string, unknown> | null | undefined): Record<string, unknown> {
    if (!metaOverrides) return {};

    const output = { ...metaOverrides };
    if (output.happierAttachments !== undefined) {
        return output;
    }

    const envelope = output.happier;
    if (isRecord(envelope) && envelope.kind === 'attachments.v1' && Object.prototype.hasOwnProperty.call(envelope, 'payload')) {
        output.happierAttachments = envelope;
    }

    return output;
}
