import type { ReviewCommentDraft } from './reviewCommentTypes';

export function normalizeReviewCommentDraftBody(body: string): string {
    return String(body).trim();
}

export function hasReviewCommentDraftBody(draft: Pick<ReviewCommentDraft, 'body'>): boolean {
    return normalizeReviewCommentDraftBody(draft.body).length > 0;
}

export function normalizeReviewCommentDraft(
    draft: ReviewCommentDraft,
): ReviewCommentDraft | null {
    const body = normalizeReviewCommentDraftBody(draft.body);
    if (!body) {
        return null;
    }

    if (body === draft.body) {
        return draft;
    }

    return {
        ...draft,
        body,
    };
}

export function normalizeReviewCommentDrafts(
    drafts: readonly ReviewCommentDraft[],
): ReviewCommentDraft[] {
    const normalized: ReviewCommentDraft[] = [];
    for (const draft of drafts) {
        const next = normalizeReviewCommentDraft(draft);
        if (next) {
            normalized.push(next);
        }
    }
    return normalized;
}
