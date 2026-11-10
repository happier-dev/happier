import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

const WorkspaceRelativeReviewPathV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(4096), z.refine((value) => {
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split('/').some((segment) => segment === '..');
}, 'Review comment anchor paths must be workspace-relative and may not traverse parent directories')));

const ReviewCommentProposalAnchorV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), filePath: WorkspaceRelativeReviewPathV1Schema }),
  z.strictObject({
    kind: z.literal('line'),
    filePath: WorkspaceRelativeReviewPathV1Schema,
    line: z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER)),
    side: z.optional(z.enum(['before', 'after'])),
  }),
  z.strictObject({
    kind: z.literal('range'),
    filePath: WorkspaceRelativeReviewPathV1Schema,
    startLine: z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER)),
    endLine: z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER)),
    side: z.optional(z.enum(['before', 'after'])),
  }).check(z.refine((value) => value.endLine >= value.startLine, {
    path: ['endLine'],
    message: 'endLine must be greater than or equal to startLine',
  })),
]));

export const ReviewCommentProposalV1Schema = lazyZodSchema(() => z.strictObject({
  findingId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  body: z.string().check(z.trim(), z.minLength(1), z.maxLength(65_536)),
  anchor: ReviewCommentProposalAnchorV1Schema,
  severity: z.optional(z.enum(['info', 'warning', 'error', 'critical'])),
  taxonomyIds: z.optional(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))).check(z.maxLength(32))),
  tags: z.optional(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))).check(z.maxLength(32))),
}));
export type ReviewCommentProposalV1 = z.infer<typeof ReviewCommentProposalV1Schema>;

export const ReviewCommentProposalsV1Schema = lazyZodSchema(() => z.array(ReviewCommentProposalV1Schema));
export type ReviewCommentProposalsV1 = z.infer<typeof ReviewCommentProposalsV1Schema>;
