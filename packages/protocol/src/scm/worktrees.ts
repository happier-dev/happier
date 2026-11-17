import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import {
  ScmOperationErrorCodeSchema,
} from './operationError.js';
import { ScmRequestBaseSchema } from './requestBase.js';
import { ScmOperationOutcomeSchema } from './operationOutcome.js';

export const SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN = 'remove-worktree' as const;

export const ScmWorktreeCommandResponseSchema = lazyZodSchema(() => z.object({
  success: z.boolean(),
  outcome: z.optional(ScmOperationOutcomeSchema),
  stdout: z.optional(z.string()),
  stderr: z.optional(z.string()),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}));
export type ScmWorktreeCommandResponse = z.infer<typeof ScmWorktreeCommandResponseSchema>;

export const ScmWorktreeCreateRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  displayName: z.optional(z.string().check(z.minLength(1))),
  baseRef: z.optional(z.string().check(z.minLength(1))),
  branchMode: z.optional(z.enum(['new', 'existing'])),
}));
export type ScmWorktreeCreateRequest = z.infer<typeof ScmWorktreeCreateRequestSchema>;

export const ScmWorktreeCreateResponseSchema = lazyZodSchema(() => z.discriminatedUnion('success', [z.object({
  success: z.literal(true),
  outcome: z.optional(ScmOperationOutcomeSchema),
  worktreePath: z.string(),
  branchName: z.string(),
  sourceRootPath: z.optional(z.string()),
  repositoryRootPath: z.optional(z.string()),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
}), z.object({
  success: z.literal(false),
  outcome: z.optional(ScmOperationOutcomeSchema),
  error: z.optional(z.string()),
  errorCode: z.optional(ScmOperationErrorCodeSchema),
})]));
export type ScmWorktreeCreateResponse = z.infer<typeof ScmWorktreeCreateResponseSchema>;

export const ScmWorktreeRemoveRequestSchema = lazyZodSchema(() => z.extend(ScmRequestBaseSchema, {
  worktreePath: z.string().check(z.minLength(1)),
  confirmed: z.literal(true),
  authorizationToken: z.literal(SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN),
  /** Explicit consequential removal choice; never inferred from failed cleanup. */
  skipCleanup: z.optional(z.boolean()),
}));
export type ScmWorktreeRemoveRequest = z.infer<typeof ScmWorktreeRemoveRequestSchema>;

export const ScmWorktreeRemoveResponseSchema = ScmWorktreeCommandResponseSchema;
export type ScmWorktreeRemoveResponse = z.infer<typeof ScmWorktreeRemoveResponseSchema>;

/** Separate advertised operations: an older backend must never ignore a retention request. */
export const ScmWorktreeRetireRequestSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ScmRequestBaseSchema, {
  worktreePath: z.string().check(z.minLength(1)),
  targetPath: z.string().check(z.minLength(1)),
  entryId: z.string().check(z.minLength(1)),
})));
export type ScmWorktreeRetireRequest = z.infer<typeof ScmWorktreeRetireRequestSchema>;
export const ScmWorktreeReinstateRequestSchema = ScmWorktreeRetireRequestSchema;
export type ScmWorktreeReinstateRequest = ScmWorktreeRetireRequest;

export const ScmWorktreePruneRequestSchema = ScmRequestBaseSchema;
export type ScmWorktreePruneRequest = z.infer<typeof ScmWorktreePruneRequestSchema>;

export const ScmWorktreePruneResponseSchema = ScmWorktreeCommandResponseSchema;
export type ScmWorktreePruneResponse = z.infer<typeof ScmWorktreePruneResponseSchema>;
