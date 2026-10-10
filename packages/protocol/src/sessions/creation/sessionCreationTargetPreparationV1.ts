import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { SessionAuthoringCheckoutCreationDraftV1Schema } from '../authoring/creationFieldsV1.js';
import { SessionExecutionTargetV1Schema } from './sessionExecutionTargetV1.js';
import { SessionDirectoryIntentV1Schema, refineSessionDirectoryIntentCheckoutV1 } from './sessionDirectoryIntentV1.js';
import { SessionCreationTagV1Schema } from './sessionCreationIdentityV1.js';

/**
 * Host-only evidence that a user approved creation of this exact canonical
 * target directory. It is retained with the existing Action approval artifact,
 * never accepted from the public Session-spawn input, and is discarded once
 * the daemon has consumed it to materialize the directory.
 */
export const SessionCreationDirectoryApprovalV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  executionTarget: SessionExecutionTargetV1Schema,
  directory: z.string().trim().min(1),
}).strict());
export type SessionCreationDirectoryApprovalV1 = z.infer<
  typeof SessionCreationDirectoryApprovalV1Schema
>;

export const SessionCreationTargetPreparationRequestV1Schema = lazyZodSchema(() => z.object({
  directory: SessionDirectoryIntentV1Schema,
  sessionCreationTag: SessionCreationTagV1Schema.optional(),
  checkoutCreationDraft: SessionAuthoringCheckoutCreationDraftV1Schema.nullable().optional(),
}).strict().superRefine(refineSessionDirectoryIntentCheckoutV1));
export type SessionCreationTargetPreparationRequestV1 = z.infer<
  typeof SessionCreationTargetPreparationRequestV1Schema
>;

export const SessionCreationPreparedCheckoutV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('git_worktree'),
  finalDirectory: z.string().trim().min(1),
  baseRef: z.string().trim().min(1).nullable(),
  branchMode: z.enum(['new', 'existing']),
  /**
   * Target-owned materialization receipt. Only an explicit `true` proves this
   * preparation created the checkout and may authorize a compensating remove.
   * Older targets omit it and are therefore never cleaned up speculatively.
   */
  created: z.boolean().optional(),
}).strict());
export type SessionCreationPreparedCheckoutV1 = z.infer<
  typeof SessionCreationPreparedCheckoutV1Schema
>;

export const SessionCreationTargetPreparationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    directory: z.string().trim().min(1),
    directoryKind: z.enum(['path', 'managed']),
    /** Whether this direct target requires user authorization before mkdir. */
    directoryCreationRequired: z.boolean(),
    checkout: SessionCreationPreparedCheckoutV1Schema.nullable(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'invalid_directory',
      'checkout_unavailable',
      'checkout_failed',
    ]),
  }).strict(),
]));
export type SessionCreationTargetPreparationResultV1 = z.infer<
  typeof SessionCreationTargetPreparationResultV1Schema
>;
