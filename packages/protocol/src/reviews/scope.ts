import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { ScmBackendIdSchema } from '../scm/backendIdentity.js';
import { ScmComparisonSchema, ScmRevisionRangeV1Schema } from '../scm/comparison.js';
import { ScmEntryKindSchema, ScmRepoModeSchema } from '../scm/workingSnapshot.js';

export const ReviewScopeSchema = lazyZodSchema(() => z.enum(['changes', 'repository']));
export type ReviewScope = z.infer<typeof ReviewScopeSchema>;

export const ReviewScmScopeDiagnosticCodeV1Schema = lazyZodSchema(() => z.enum([
  'invalid_path',
  'not_repository',
  'scm_status_unavailable',
]));
export type ReviewScmScopeDiagnosticCodeV1 = z.infer<typeof ReviewScmScopeDiagnosticCodeV1Schema>;

export const ReviewScmScopeDiagnosticV1Schema = lazyZodSchema(() => z.looseObject({
  code: ReviewScmScopeDiagnosticCodeV1Schema,
  severity: z.enum(['warning', 'error']),
  message: z.string().check(z.minLength(1)),
}));
export type ReviewScmScopeDiagnosticV1 = z.infer<typeof ReviewScmScopeDiagnosticV1Schema>;

export const ReviewScmScopeBaseRefSourceV1Schema = lazyZodSchema(() => z.enum([
  'explicit',
  'branch_upstream',
  'default_branch',
  'unavailable',
]));
export type ReviewScmScopeBaseRefSourceV1 = z.infer<typeof ReviewScmScopeBaseRefSourceV1Schema>;

export const ReviewScmScopeBaseRefV1Schema = lazyZodSchema(() => z.looseObject({
  source: ReviewScmScopeBaseRefSourceV1Schema,
  ref: z.nullable(z.string().check(z.minLength(1))),
}));
export type ReviewScmScopeBaseRefV1 = z.infer<typeof ReviewScmScopeBaseRefV1Schema>;

export const ReviewScmScopePathDiffV1Schema = lazyZodSchema(() => z.looseObject({
  committedAvailable: z.boolean(),
  uncommittedAvailable: z.boolean(),
  isBinary: z.boolean(),
}));
export type ReviewScmScopePathDiffV1 = z.infer<typeof ReviewScmScopePathDiffV1Schema>;

export const ReviewScmScopePathV1Schema = lazyZodSchema(() => z.looseObject({
  path: z.string().check(z.minLength(1)),
  previousPath: z.nullable(z.string().check(z.minLength(1))),
  kind: ScmEntryKindSchema,
  hasCommittedDelta: z.boolean(),
  hasUncommittedDelta: z.boolean(),
  diff: ReviewScmScopePathDiffV1Schema,
}));
export type ReviewScmScopePathV1 = z.infer<typeof ReviewScmScopePathV1Schema>;

export const ReviewScmScopeDiffV1Schema = lazyZodSchema(() => z.looseObject({
  committedAvailable: z.boolean(),
  uncommittedAvailable: z.boolean(),
  byteLimit: z.optional(z.nullable(z.number().check(z.int(), z.positive()))),
}));
export type ReviewScmScopeDiffV1 = z.infer<typeof ReviewScmScopeDiffV1Schema>;

export const ReviewScmScopeV1Schema = lazyZodSchema(() => z.looseObject({
  kind: z.literal('review_scm_scope.v1'),
  scope: z.optional(ReviewScopeSchema),
  status: z.enum(['supported', 'unsupported']),
  scmBackendId: z.nullable(ScmBackendIdSchema),
  scmMode: z.nullable(ScmRepoModeSchema),
  repositoryRoot: z.nullable(z.string().check(z.minLength(1))),
  worktreeRoot: z.nullable(z.string().check(z.minLength(1))),
  baseRef: ReviewScmScopeBaseRefV1Schema,
  // Bodies remain in the admitted comparison input; adapters consume its captured identity/endpoints.
  comparison: z.optional(z.strictObject({ id: ScmComparisonSchema.shape.id,
    source: ScmComparisonSchema.shape.source, endpoints: ScmComparisonSchema.shape.endpoints })),
  revisionRange: z.optional(ScmRevisionRangeV1Schema),
  selectedPaths: z.array(z.string().check(z.minLength(1))),
  committedPaths: z.array(ReviewScmScopePathV1Schema),
  uncommittedPaths: z.array(ReviewScmScopePathV1Schema),
  changedPaths: z.array(ReviewScmScopePathV1Schema),
  diff: ReviewScmScopeDiffV1Schema,
  diagnostics: z.array(ReviewScmScopeDiagnosticV1Schema),
}));
export type ReviewScmScopeV1 = z.infer<typeof ReviewScmScopeV1Schema>;
