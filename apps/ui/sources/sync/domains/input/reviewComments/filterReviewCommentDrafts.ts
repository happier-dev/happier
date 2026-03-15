import type { ReviewCommentDraft, ReviewCommentSource } from './reviewCommentTypes';

export function filterReviewCommentDraftsForFile(params: Readonly<{
    enabled: boolean;
    filePath: string;
    source: ReviewCommentSource;
    drafts: readonly ReviewCommentDraft[];
}>): readonly ReviewCommentDraft[] {
    if (!params.enabled) return [];
    return params.drafts.filter((d) => d.filePath === params.filePath && d.source === params.source);
}
