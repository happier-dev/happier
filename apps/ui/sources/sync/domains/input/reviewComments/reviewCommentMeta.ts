import { z } from 'zod';

import type { ReviewCommentDraft } from './reviewCommentTypes';

export const ReviewCommentAnchorSchema = z.union([
    z.object({
        kind: z.literal('fileLine'),
        startLine: z.number().int().positive(),
    }),
    z.object({
        kind: z.literal('diffLine'),
        startLine: z.number().int().positive(),
        side: z.enum(['before', 'after']),
        oldLine: z.number().int().positive().nullable(),
        newLine: z.number().int().positive().nullable(),
    }),
]);

export const ReviewCommentSnapshotSchema = z.object({
    selectedLines: z.array(z.string()).readonly(),
    beforeContext: z.array(z.string()).readonly(),
    afterContext: z.array(z.string()).readonly(),
});

export const ReviewCommentDraftSchema = z.object({
    id: z.string(),
    filePath: z.string(),
    source: z.enum(['file', 'diff']),
    anchor: ReviewCommentAnchorSchema,
    snapshot: ReviewCommentSnapshotSchema,
    body: z.string(),
    createdAt: z.number(),
});

export const ReviewCommentsV1Schema = z.object({
    sessionId: z.string(),
    comments: z.array(ReviewCommentDraftSchema),
});

export type ReviewCommentsV1 = z.infer<typeof ReviewCommentsV1Schema>;

export function buildReviewCommentsV1MetaPayload(params: {
    sessionId: string;
    drafts: readonly ReviewCommentDraft[];
}): ReviewCommentsV1 {
    return {
        sessionId: params.sessionId,
        comments: params.drafts.map((d) => ({
            id: d.id,
            filePath: d.filePath,
            source: d.source,
            anchor: d.anchor,
            snapshot: {
                selectedLines: [...d.snapshot.selectedLines],
                beforeContext: [...d.snapshot.beforeContext],
                afterContext: [...d.snapshot.afterContext],
            },
            body: d.body,
            createdAt: d.createdAt,
        })),
    };
}

export function parseReviewCommentsV1(payload: unknown): ReviewCommentsV1 | null {
    const parsed = ReviewCommentsV1Schema.safeParse(payload);
    if (!parsed.success) return null;
    return parsed.data;
}
