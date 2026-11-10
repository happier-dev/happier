import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { ScmOperationErrorCodeSchema } from './operationError.js';
import { ScmOperationOutcomeSchema } from './operationOutcome.js';
import { ScmRequestBaseSchema } from './requestBase.js';

export const ScmStashKindSchema = lazyZodSchema(() => z.enum(['branch', 'transient', 'unmanaged']));
export type ScmStashKind = z.infer<typeof ScmStashKindSchema>;

export const ScmStashEntrySchema = lazyZodSchema(() => z.object({
  stashRef: z.string(),
  stashOid: z.optional(z.string()),
  kind: ScmStashKindSchema,
  branch: z.optional(z.string()),
  createdAt: z.optional(z.number().check(z.int())),
  message: z.optional(z.string()),
}));
export type ScmStashEntry = z.infer<typeof ScmStashEntrySchema>;

export const ScmStashListRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  includeAll: z.optional(z.boolean()),
}));
export type ScmStashListRequest = z.infer<typeof ScmStashListRequestSchema>;

export const ScmStashListResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  stashes: z.optional(z.array(ScmStashEntrySchema)),
  managedStashes: z.optional(z.array(ScmStashEntrySchema)),
  managedCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  totalCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmStashListResponse = z.infer<typeof ScmStashListResponseSchema>;

export const ScmStashCreateRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  message: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));
export type ScmStashCreateRequest = z.infer<typeof ScmStashCreateRequestSchema>;

export const ScmStashCreateResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: z.optional(ScmOperationOutcomeSchema),
  stashCreated: z.optional(z.boolean()),
  stashRef: z.optional(z.nullable(z.string())),
  stashOid: z.optional(z.string()),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmStashCreateResponse = z.infer<typeof ScmStashCreateResponseSchema>;

export const ScmStashDropRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  stashRef: z.string(),
}));
export type ScmStashDropRequest = z.infer<typeof ScmStashDropRequestSchema>;

export const ScmStashDropResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: z.optional(ScmOperationOutcomeSchema),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmStashDropResponse = z.infer<typeof ScmStashDropResponseSchema>;

export const ScmStashPopRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  stashRef: z.string(),
}));
export type ScmStashPopRequest = z.infer<typeof ScmStashPopRequestSchema>;

export const ScmStashPopResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: z.optional(ScmOperationOutcomeSchema),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmStashPopResponse = z.infer<typeof ScmStashPopResponseSchema>;

export const ScmStashApplyRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  stashRef: z.string(),
}));
export type ScmStashApplyRequest = z.infer<typeof ScmStashApplyRequestSchema>;

export const ScmStashApplyResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: z.optional(ScmOperationOutcomeSchema),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmStashApplyResponse = z.infer<typeof ScmStashApplyResponseSchema>;

export const ScmStashShowRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  stashRef: z.string(),
  maxBytes: z.optional(z.number().check(z.int(), z.positive())),
}));
export type ScmStashShowRequest = z.infer<typeof ScmStashShowRequestSchema>;

export const ScmStashShowResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  diff: z.optional(z.string()),
  truncated: z.optional(z.boolean()),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmStashShowResponse = z.infer<typeof ScmStashShowResponseSchema>;
