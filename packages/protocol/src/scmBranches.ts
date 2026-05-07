import { z } from 'zod';

import {
  ScmBranchIntegrationOperationSchema,
  ScmBranchSourceRefSchema,
  ScmOperationErrorCodeSchema,
  ScmOperationStateSchema,
  ScmRemoteResponseSchema,
  ScmRequestBaseSchema,
} from './scm.js';

export const ScmBranchTypeSchema = z.enum(['local', 'remote']);
export type ScmBranchType = z.infer<typeof ScmBranchTypeSchema>;

export const ScmBranchListRequestSchema = ScmRequestBaseSchema.extend({
  includeRemotes: z.boolean().optional(),
});
export type ScmBranchListRequest = z.infer<typeof ScmBranchListRequestSchema>;

export const ScmBranchListEntrySchema = z.object({
  name: z.string(),
  type: ScmBranchTypeSchema,
  upstream: z.string().nullable().optional(),
  isCurrent: z.boolean().optional(),
});
export type ScmBranchListEntry = z.infer<typeof ScmBranchListEntrySchema>;

export const ScmBranchListResponseSchema = z.object({
  success: z.boolean(),
  branches: z.array(ScmBranchListEntrySchema).optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmBranchListResponse = z.infer<typeof ScmBranchListResponseSchema>;

export const ScmBranchCreateRequestSchema = ScmRequestBaseSchema.extend({
  name: z.string().min(1),
  checkout: z.boolean().optional(),
  startPoint: z.string().optional(),
});
export type ScmBranchCreateRequest = z.infer<typeof ScmBranchCreateRequestSchema>;

export const ScmBranchCreateResponseSchema = z.object({
  success: z.boolean(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmBranchCreateResponse = z.infer<typeof ScmBranchCreateResponseSchema>;

export const ScmBranchCheckoutStrategySchema = z.enum(['stash_on_current_branch', 'bring_changes']);
export type ScmBranchCheckoutStrategy = z.infer<typeof ScmBranchCheckoutStrategySchema>;

export const ScmBranchCheckoutRequestSchema = ScmRequestBaseSchema.extend({
  name: z.string().min(1),
  strategy: ScmBranchCheckoutStrategySchema,
  overwriteCurrentBranchStash: z.boolean().optional(),
});
export type ScmBranchCheckoutRequest = z.infer<typeof ScmBranchCheckoutRequestSchema>;

export const ScmBranchCheckoutResponseSchema = z.object({
  success: z.boolean(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  didCreateStash: z.boolean().optional(),
  didPopStash: z.boolean().optional(),
  stashRef: z.string().nullable().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmBranchCheckoutResponse = z.infer<typeof ScmBranchCheckoutResponseSchema>;

export const ScmRemotePublishRequestSchema = ScmRequestBaseSchema.extend({
  remote: z.string().optional(),
});
export type ScmRemotePublishRequest = z.infer<typeof ScmRemotePublishRequestSchema>;

export const ScmRemotePublishResponseSchema = ScmRemoteResponseSchema;
export type ScmRemotePublishResponse = z.infer<typeof ScmRemotePublishResponseSchema>;

export const ScmBranchIntegrationRequestSchema = ScmRequestBaseSchema.extend({
  sourceRef: ScmBranchSourceRefSchema,
});
export type ScmBranchIntegrationRequest = z.infer<typeof ScmBranchIntegrationRequestSchema>;

export const ScmBranchOperationControlRequestSchema = ScmRequestBaseSchema.extend({
  operation: ScmBranchIntegrationOperationSchema,
});
export type ScmBranchOperationControlRequest = z.infer<typeof ScmBranchOperationControlRequestSchema>;

export const ScmBranchIntegrationResponseSchema = z.object({
  success: z.boolean(),
  operationState: ScmOperationStateSchema.nullable().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmBranchIntegrationResponse = z.infer<typeof ScmBranchIntegrationResponseSchema>;
