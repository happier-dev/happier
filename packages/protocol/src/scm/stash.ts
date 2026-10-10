import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { ScmOperationErrorCodeSchema } from './operationError.js';
import { ScmOperationOutcomeSchema } from './operationOutcome.js';
import { ScmRequestBaseSchema } from './requestBase.js';

export const ScmStashKindSchema = lazyZodSchema(() => z.enum(['branch', 'transient', 'unmanaged']));
export type ScmStashKind = z.infer<typeof ScmStashKindSchema>;

export const ScmStashEntrySchema = lazyZodSchema(() => z.object({
  stashRef: z.string(),
  stashOid: z.string().optional(),
  kind: ScmStashKindSchema,
  branch: z.string().optional(),
  createdAt: z.number().int().optional(),
  message: z.string().optional(),
}));
export type ScmStashEntry = z.infer<typeof ScmStashEntrySchema>;

export const ScmStashListRequestSchema = lazyZodSchema(() => ScmRequestBaseSchema.extend({
  includeAll: z.boolean().optional(),
}));
export type ScmStashListRequest = z.infer<typeof ScmStashListRequestSchema>;

export const ScmStashListResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  stashes: z.array(ScmStashEntrySchema).optional(),
  managedStashes: z.array(ScmStashEntrySchema).optional(),
  managedCount: z.number().int().nonnegative().optional(),
  totalCount: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
}));
export type ScmStashListResponse = z.infer<typeof ScmStashListResponseSchema>;

export const ScmStashCreateRequestSchema = lazyZodSchema(() => ScmRequestBaseSchema.extend({
  message: z.string().trim().min(1).optional(),
}));
export type ScmStashCreateRequest = z.infer<typeof ScmStashCreateRequestSchema>;

export const ScmStashCreateResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: ScmOperationOutcomeSchema.optional(),
  stashCreated: z.boolean().optional(),
  stashRef: z.string().nullable().optional(),
  stashOid: z.string().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
}));
export type ScmStashCreateResponse = z.infer<typeof ScmStashCreateResponseSchema>;

export const ScmStashDropRequestSchema = lazyZodSchema(() => ScmRequestBaseSchema.extend({
  stashRef: z.string(),
}));
export type ScmStashDropRequest = z.infer<typeof ScmStashDropRequestSchema>;

export const ScmStashDropResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: ScmOperationOutcomeSchema.optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
}));
export type ScmStashDropResponse = z.infer<typeof ScmStashDropResponseSchema>;

export const ScmStashPopRequestSchema = lazyZodSchema(() => ScmRequestBaseSchema.extend({
  stashRef: z.string(),
}));
export type ScmStashPopRequest = z.infer<typeof ScmStashPopRequestSchema>;

export const ScmStashPopResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: ScmOperationOutcomeSchema.optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
}));
export type ScmStashPopResponse = z.infer<typeof ScmStashPopResponseSchema>;

export const ScmStashApplyRequestSchema = lazyZodSchema(() => ScmRequestBaseSchema.extend({
  stashRef: z.string(),
}));
export type ScmStashApplyRequest = z.infer<typeof ScmStashApplyRequestSchema>;

export const ScmStashApplyResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: ScmOperationOutcomeSchema.optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
}));
export type ScmStashApplyResponse = z.infer<typeof ScmStashApplyResponseSchema>;

export const ScmStashShowRequestSchema = lazyZodSchema(() => ScmRequestBaseSchema.extend({
  stashRef: z.string(),
  maxBytes: z.number().int().positive().optional(),
}));
export type ScmStashShowRequest = z.infer<typeof ScmStashShowRequestSchema>;

export const ScmStashShowResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  diff: z.string().optional(),
  truncated: z.boolean().optional(),
  error: z.string().optional(),
  errorCode: ScmOperationErrorCodeSchema.optional(),
}));
export type ScmStashShowResponse = z.infer<typeof ScmStashShowResponseSchema>;
