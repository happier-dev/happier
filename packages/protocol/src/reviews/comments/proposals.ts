import { z } from 'zod';

export const REVIEW_COMMENT_PROPOSALS_MAX_ENCODED_BYTES_V1 = 1_048_576;

const WorkspaceRelativeReviewPathV1Schema = z.string().trim().min(1).max(4096).refine((value) => {
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split('/').some((segment) => segment === '..');
}, 'Review comment anchor paths must be workspace-relative and may not traverse parent directories');

const ReviewCommentProposalAnchorV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), filePath: WorkspaceRelativeReviewPathV1Schema }).strict(),
  z.object({
    kind: z.literal('line'),
    filePath: WorkspaceRelativeReviewPathV1Schema,
    line: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    side: z.enum(['before', 'after']).optional(),
  }).strict(),
  z.object({
    kind: z.literal('range'),
    filePath: WorkspaceRelativeReviewPathV1Schema,
    startLine: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    endLine: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    side: z.enum(['before', 'after']).optional(),
  }).strict().refine((value) => value.endLine >= value.startLine, {
    path: ['endLine'],
    message: 'endLine must be greater than or equal to startLine',
  }),
]);

export const ReviewCommentProposalV1Schema = z.object({
  findingId: z.string().trim().min(1).max(512).optional(),
  body: z.string().trim().min(1).max(65_536),
  anchor: ReviewCommentProposalAnchorV1Schema,
  severity: z.enum(['info', 'warning', 'error', 'critical']).optional(),
  taxonomyIds: z.array(z.string().trim().min(1).max(512)).max(32).optional(),
  tags: z.array(z.string().trim().min(1).max(256)).max(32).optional(),
}).strict();
export type ReviewCommentProposalV1 = z.infer<typeof ReviewCommentProposalV1Schema>;

export const ReviewCommentProposalsV1Schema = z.array(ReviewCommentProposalV1Schema).max(200).superRefine((value, ctx) => {
  const encodedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (encodedBytes > REVIEW_COMMENT_PROPOSALS_MAX_ENCODED_BYTES_V1) {
    ctx.addIssue({
      code: 'custom',
      message: `Proposed review comments exceed ${REVIEW_COMMENT_PROPOSALS_MAX_ENCODED_BYTES_V1} encoded bytes`,
    });
  }
});
export type ReviewCommentProposalsV1 = z.infer<typeof ReviewCommentProposalsV1Schema>;
