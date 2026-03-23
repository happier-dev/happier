import { z } from 'zod';

import { ScmOperationErrorCodeSchema, ScmRequestBaseSchema } from './scm.js';

export const ScmStashKindSchema = z.enum(['branch', 'transient']);
export type ScmStashKind = z.infer<typeof ScmStashKindSchema>;

export const ScmStashEntrySchema = z.object({
  stashRef: z.string(),
  kind: ScmStashKindSchema,
  branch: z.string().optional(),
  createdAt: z.number().int().optional(),
  message: z.string().optional(),
});
export type ScmStashEntry = z.infer<typeof ScmStashEntrySchema>;

export const ScmStashListRequestSchema = ScmRequestBaseSchema.extend({
  includeAll: z.boolean().optional(),
});
export type ScmStashListRequest = z.infer<typeof ScmStashListRequestSchema>;

export const ScmStashListResponseSchema = z.object({
  success: z.boolean(),
  managedStashes: z.array(ScmStashEntrySchema).optional(),
  managedCount: z.number().int().nonnegative().optional(),
  totalCount: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmStashListResponse = z.infer<typeof ScmStashListResponseSchema>;

export const ScmStashDropRequestSchema = ScmRequestBaseSchema.extend({
  stashRef: z.string(),
});
export type ScmStashDropRequest = z.infer<typeof ScmStashDropRequestSchema>;

export const ScmStashDropResponseSchema = z.object({
  success: z.boolean(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmStashDropResponse = z.infer<typeof ScmStashDropResponseSchema>;

export const ScmStashPopRequestSchema = ScmRequestBaseSchema.extend({
  stashRef: z.string(),
});
export type ScmStashPopRequest = z.infer<typeof ScmStashPopRequestSchema>;

export const ScmStashPopResponseSchema = z.object({
  success: z.boolean(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmStashPopResponse = z.infer<typeof ScmStashPopResponseSchema>;

export const ScmStashApplyRequestSchema = ScmRequestBaseSchema.extend({
  stashRef: z.string(),
});
export type ScmStashApplyRequest = z.infer<typeof ScmStashApplyRequestSchema>;

export const ScmStashApplyResponseSchema = z.object({
  success: z.boolean(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmStashApplyResponse = z.infer<typeof ScmStashApplyResponseSchema>;

export const ScmStashShowRequestSchema = ScmRequestBaseSchema.extend({
  stashRef: z.string(),
  maxBytes: z.number().int().positive().optional(),
});
export type ScmStashShowRequest = z.infer<typeof ScmStashShowRequestSchema>;

export const ScmStashShowResponseSchema = z.object({
  success: z.boolean(),
  diff: z.string().optional(),
  truncated: z.boolean().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
});
export type ScmStashShowResponse = z.infer<typeof ScmStashShowResponseSchema>;

