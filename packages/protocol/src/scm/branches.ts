import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

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
export const ScmBranchWorkIdentitySchema = lazyZodSchema(() => z.object({
  ref: ScmBranchSourceRefSchema.refine(ref => ref.startsWith('refs/heads/')), headSha: ScmCommitOidSchema,
}).strict());
export const ScmBranchWorkEvidenceSchema = lazyZodSchema(() => RepositoryCheckpointCommitEvidenceSchema.extend({
  branch: ScmBranchWorkIdentitySchema,
}).strict());
export type ScmBranchWorkEvidence = z.infer<typeof ScmBranchWorkEvidenceSchema>;

export const ScmBranchTypeSchema = lazyZodSchema(() => z.enum(['local', 'remote']));
export type ScmBranchType = z.infer<typeof ScmBranchTypeSchema>;

export const ScmBranchListRequestSchema = lazyZodSchema(() => ScmRequestBaseSchema.extend({
  includeRemotes: z.boolean().optional(),
  workEvidence: z.object({ sessionId: z.string().min(1) }).strict().optional(),
}));
export type ScmBranchListRequest = z.infer<typeof ScmBranchListRequestSchema>;

export const ScmBranchListEntrySchema = lazyZodSchema(() => z.object({
  name: z.string(),
  type: ScmBranchTypeSchema,
  upstream: z.string().nullable().optional(),
  isCurrent: z.boolean().optional(),
}));
export type ScmBranchListEntry = z.infer<typeof ScmBranchListEntrySchema>;

export const ScmBranchListResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  branches: z.array(ScmBranchListEntrySchema).optional(),
  branchEvidence: z.array(ScmBranchWorkEvidenceSchema).optional(),
  branchEvidenceStatus: z.enum(['partial', 'unavailable']).optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
}));
export type ScmBranchListResponse = z.infer<typeof ScmBranchListResponseSchema>;

export const ScmBranchCreateRequestSchema = lazyZodSchema(() => ScmRequestBaseSchema.extend({
  name: z.string().min(1),
  checkout: z.boolean().optional(),
  startPoint: z.string().optional(),
}));
export type ScmBranchCreateRequest = z.infer<typeof ScmBranchCreateRequestSchema>;

export const ScmBranchCreateResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: ScmOperationOutcomeSchema.optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
}));
export type ScmBranchCreateResponse = z.infer<typeof ScmBranchCreateResponseSchema>;

export const ScmBranchCheckoutStrategySchema = lazyZodSchema(() => z.enum(['stash_on_current_branch', 'bring_changes']));
export type ScmBranchCheckoutStrategy = z.infer<typeof ScmBranchCheckoutStrategySchema>;

export const ScmBranchCheckoutRequestSchema = lazyZodSchema(() => ScmRequestBaseSchema.extend({
  name: z.string().min(1),
  strategy: ScmBranchCheckoutStrategySchema,
  overwriteCurrentBranchStash: z.boolean().optional(),
}));
export type ScmBranchCheckoutRequest = z.infer<typeof ScmBranchCheckoutRequestSchema>;

export const ScmBranchCheckoutResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: ScmOperationOutcomeSchema.optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  didCreateStash: z.boolean().optional(),
  didPopStash: z.boolean().optional(),
  stashRef: z.string().nullable().optional(),
  stashOid: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
}));
export type ScmBranchCheckoutResponse = z.infer<typeof ScmBranchCheckoutResponseSchema>;

export const ScmRemotePublishRequestSchema = lazyZodSchema(() => ScmRequestBaseSchema.extend({
  remote: z.string().optional(),
}));
export type ScmRemotePublishRequest = z.infer<typeof ScmRemotePublishRequestSchema>;

export const ScmRemotePublishResponseSchema = ScmRemoteResponseSchema;
export type ScmRemotePublishResponse = z.infer<typeof ScmRemotePublishResponseSchema>;
