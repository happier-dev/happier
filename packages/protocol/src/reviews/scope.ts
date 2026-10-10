import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { ScmBackendIdSchema } from '../scm/backendIdentity.js';
import { ScmEntryKindSchema, ScmRepoModeSchema } from '../scm/workingSnapshot.js';

export const ReviewScmScopeDiagnosticCodeV1Schema = lazyZodSchema(() => z.enum([
  'invalid_path',
  'not_repository',
  'scm_status_unavailable',
]));
export type ReviewScmScopeDiagnosticCodeV1 = z.infer<typeof ReviewScmScopeDiagnosticCodeV1Schema>;

export const ReviewScmScopeDiagnosticV1Schema = lazyZodSchema(() => z.object({
  code: ReviewScmScopeDiagnosticCodeV1Schema,
  severity: z.enum(['warning', 'error']),
  message: z.string().min(1),
}).passthrough());
export type ReviewScmScopeDiagnosticV1 = z.infer<typeof ReviewScmScopeDiagnosticV1Schema>;

export const ReviewScmScopeBaseRefSourceV1Schema = lazyZodSchema(() => z.enum([
  'explicit',
  'branch_upstream',
  'default_branch',
  'unavailable',
]));
export type ReviewScmScopeBaseRefSourceV1 = z.infer<typeof ReviewScmScopeBaseRefSourceV1Schema>;

export const ReviewScmScopeBaseRefV1Schema = lazyZodSchema(() => z.object({
  source: ReviewScmScopeBaseRefSourceV1Schema,
  ref: z.string().min(1).nullable(),
}).passthrough());
export type ReviewScmScopeBaseRefV1 = z.infer<typeof ReviewScmScopeBaseRefV1Schema>;

export const ReviewScmScopePathDiffV1Schema = lazyZodSchema(() => z.object({
  committedAvailable: z.boolean(),
  uncommittedAvailable: z.boolean(),
  isBinary: z.boolean(),
}).passthrough());
export type ReviewScmScopePathDiffV1 = z.infer<typeof ReviewScmScopePathDiffV1Schema>;

export const ReviewScmScopePathV1Schema = lazyZodSchema(() => z.object({
  path: z.string().min(1),
  previousPath: z.string().min(1).nullable(),
  kind: ScmEntryKindSchema,
  hasCommittedDelta: z.boolean(),
  hasUncommittedDelta: z.boolean(),
  diff: ReviewScmScopePathDiffV1Schema,
}).passthrough());
export type ReviewScmScopePathV1 = z.infer<typeof ReviewScmScopePathV1Schema>;

export const ReviewScmScopeDiffV1Schema = lazyZodSchema(() => z.object({
  committedAvailable: z.boolean(),
  uncommittedAvailable: z.boolean(),
  byteLimit: z.number().int().positive().nullable().optional(),
}).passthrough());
export type ReviewScmScopeDiffV1 = z.infer<typeof ReviewScmScopeDiffV1Schema>;

export const ReviewScmScopeV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('review_scm_scope.v1'),
  status: z.enum(['supported', 'unsupported']),
  scmBackendId: ScmBackendIdSchema.nullable(),
  scmMode: ScmRepoModeSchema.nullable(),
  repositoryRoot: z.string().min(1).nullable(),
  worktreeRoot: z.string().min(1).nullable(),
  baseRef: ReviewScmScopeBaseRefV1Schema,
  selectedPaths: z.array(z.string().min(1)),
  committedPaths: z.array(ReviewScmScopePathV1Schema),
  uncommittedPaths: z.array(ReviewScmScopePathV1Schema),
  changedPaths: z.array(ReviewScmScopePathV1Schema),
  diff: ReviewScmScopeDiffV1Schema,
  diagnostics: z.array(ReviewScmScopeDiagnosticV1Schema),
}).passthrough());
export type ReviewScmScopeV1 = z.infer<typeof ReviewScmScopeV1Schema>;
