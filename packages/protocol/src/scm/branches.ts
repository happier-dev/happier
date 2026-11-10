import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import {
  ScmRemoteResponseSchema,
} from './remoteResponse.js';
import { ScmOperationErrorCodeSchema } from './operationError.js';
import { ScmOperationOutcomeSchema } from './operationOutcome.js';
import { ScmRequestBaseSchema } from './requestBase.js';
import { ScmCommitOidSchema } from './commitPublication.js';
import { RepositoryCheckpointCommitEvidenceSchema } from '../sessions/changes/schemas.js';
import { ScmBranchSourceRefSchema } from './remoteNormalization.js';

/** Ref labels only display identity; exact membership is witnessed against headSha. */
export const ScmBranchWorkIdentitySchema = lazyZodSchema(() => z.strictObject({
  ref: ScmBranchSourceRefSchema.check(z.refine(ref => ref.startsWith('refs/heads/'))), headSha: ScmCommitOidSchema,
}));
export const ScmBranchWorkEvidenceSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(RepositoryCheckpointCommitEvidenceSchema, {
  branch: ScmBranchWorkIdentitySchema,
})));
export type ScmBranchWorkEvidence = z.infer<typeof ScmBranchWorkEvidenceSchema>;

export const ScmBranchTypeSchema = lazyZodSchema(() => z.enum(['local', 'remote']));
export type ScmBranchType = z.infer<typeof ScmBranchTypeSchema>;

export const ScmBranchListRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  includeRemotes: z.optional(z.boolean()),
  workEvidence: z.optional(z.strictObject({ sessionId: z.string().check(z.minLength(1)) })),
}));
export type ScmBranchListRequest = z.infer<typeof ScmBranchListRequestSchema>;

export const ScmBranchListEntrySchema = lazyZodSchema(() => z.object({
  name: z.string(),
  type: ScmBranchTypeSchema,
  upstream: z.optional(z.nullable(z.string())),
  isCurrent: z.optional(z.boolean()),
}));
export type ScmBranchListEntry = z.infer<typeof ScmBranchListEntrySchema>;

export const ScmBranchListResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  branches: z.optional(z.array(ScmBranchListEntrySchema)),
  branchEvidence: z.optional(z.array(ScmBranchWorkEvidenceSchema)),
  branchEvidenceStatus: z.optional(z.enum(['partial', 'unavailable'])),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmBranchListResponse = z.infer<typeof ScmBranchListResponseSchema>;

export const ScmBranchCreateRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  name: z.string().check(z.minLength(1)),
  checkout: z.optional(z.boolean()),
  startPoint: z.optional(z.string()),
}));
export type ScmBranchCreateRequest = z.infer<typeof ScmBranchCreateRequestSchema>;

export const ScmBranchCreateResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: z.optional(ScmOperationOutcomeSchema),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmBranchCreateResponse = z.infer<typeof ScmBranchCreateResponseSchema>;

export const ScmBranchCheckoutStrategySchema = lazyZodSchema(() => z.enum(['stash_on_current_branch', 'bring_changes']));
export type ScmBranchCheckoutStrategy = z.infer<typeof ScmBranchCheckoutStrategySchema>;

export const ScmBranchCheckoutRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  name: z.string().check(z.minLength(1)),
  strategy: ScmBranchCheckoutStrategySchema,
  overwriteCurrentBranchStash: z.optional(z.boolean()),
}));
export type ScmBranchCheckoutRequest = z.infer<typeof ScmBranchCheckoutRequestSchema>;

export const ScmBranchCheckoutResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: z.optional(ScmOperationOutcomeSchema),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  didCreateStash: z.optional(z.boolean()),
  didPopStash: z.optional(z.boolean()),
  stashRef: z.optional(z.nullable(z.string())),
  stashOid: z.optional(z.string()),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmBranchCheckoutResponse = z.infer<typeof ScmBranchCheckoutResponseSchema>;

export const ScmRemotePublishRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  remote: z.optional(z.string()),
}));
export type ScmRemotePublishRequest = z.infer<typeof ScmRemotePublishRequestSchema>;

export const ScmRemotePublishResponseSchema = ScmRemoteResponseSchema;
export type ScmRemotePublishResponse = z.infer<typeof ScmRemotePublishResponseSchema>;
