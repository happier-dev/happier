import { z } from 'zod';
import { WorkspaceAnchorResolutionV1Schema } from '@happier-dev/protocol';

import { isLineContentHash, type LineContentHash } from '@/utils/text/lineContentHash';

import type { ReviewCommentDraft } from './reviewCommentTypes';
import { normalizeReviewCommentDrafts } from './reviewCommentDraftBody';

const LineContentHashSchema = z.custom<LineContentHash>(isLineContentHash);

export const ReviewCommentAnchorSchema = z.union([
    z.object({
        kind: z.literal('fileLine'),
        startLine: z.number().int().positive(),
        lineHash: LineContentHashSchema.optional(),
    }),
    z.object({
        kind: z.literal('diffLine'),
        startLine: z.number().int().positive(),
        side: z.enum(['before', 'after']),
        oldLine: z.number().int().positive().nullable(),
        newLine: z.number().int().positive().nullable(),
        lineHash: LineContentHashSchema.optional(),
    }),
    z.object({
        kind: z.literal('line'),
        filePath: z.string(),
        line: z.number().int().positive(),
        side: z.enum(['before', 'after']).optional(),
        lineHash: LineContentHashSchema.optional(),
    }),
    z.object({
        kind: z.literal('range'),
        filePath: z.string(),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        side: z.enum(['before', 'after']).optional(),
        startLineHash: LineContentHashSchema.optional(),
        endLineHash: LineContentHashSchema.optional(),
        selectedTextHash: LineContentHashSchema.optional(),
    }).refine((anchor) => anchor.endLine >= anchor.startLine, {
        message: 'endLine must be greater than or equal to startLine',
        path: ['endLine'],
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
    anchorResolution: WorkspaceAnchorResolutionV1Schema.optional(),
    snapshot: ReviewCommentSnapshotSchema,
    body: z.string(),
    includeInPrompt: z.boolean().optional(),
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
    const drafts = normalizeReviewCommentDrafts(params.drafts);
    return {
        sessionId: params.sessionId,
        comments: drafts.map((d) => {
            const comment = {
                id: d.id,
                filePath: d.filePath,
                source: d.source,
                anchor: d.anchor,
                ...(d.anchorResolution ? { anchorResolution: d.anchorResolution } : {}),
                snapshot: {
                    selectedLines: [...d.snapshot.selectedLines],
                    beforeContext: [...d.snapshot.beforeContext],
                    afterContext: [...d.snapshot.afterContext],
                },
                body: d.body,
                createdAt: d.createdAt,
            };
            return d.includeInPrompt === undefined ? comment : { ...comment, includeInPrompt: d.includeInPrompt };
        }),
    };
}

export function parseReviewCommentsV1(payload: unknown): ReviewCommentsV1 | null {
    const parsed = ReviewCommentsV1Schema.safeParse(payload);
    if (!parsed.success) return null;
    return parsed.data;
}
