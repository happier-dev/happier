import { z } from 'zod';

import { SessionAuthoringCheckoutCreationDraftV1Schema } from '../authoring/fieldCatalog.js';
import { SessionExecutionTargetV1Schema } from './sessionSpawnNewResultV1.js';

/**
 * Host-only evidence that a user approved creation of this exact canonical
 * target directory. It is retained with the existing Action approval artifact,
 * never accepted from the public Session-spawn input, and is discarded once
 * the daemon has consumed it to materialize the directory.
 */
export const SessionCreationDirectoryApprovalV1Schema = z.object({
  v: z.literal(1),
  executionTarget: SessionExecutionTargetV1Schema,
  directory: z.string().trim().min(1),
}).strict();
export type SessionCreationDirectoryApprovalV1 = z.infer<
  typeof SessionCreationDirectoryApprovalV1Schema
>;

export const SessionCreationTargetPreparationRequestV1Schema = z.object({
  directory: z.string().trim().min(1),
  checkoutCreationDraft: SessionAuthoringCheckoutCreationDraftV1Schema.nullable().optional(),
}).strict();
export type SessionCreationTargetPreparationRequestV1 = z.infer<
  typeof SessionCreationTargetPreparationRequestV1Schema
>;

export const SessionCreationPreparedCheckoutV1Schema = z.object({
  kind: z.literal('git_worktree'),
  finalDirectory: z.string().trim().min(1),
  baseRef: z.string().trim().min(1).nullable(),
  branchMode: z.enum(['new', 'existing']),
}).strict();
export type SessionCreationPreparedCheckoutV1 = z.infer<
  typeof SessionCreationPreparedCheckoutV1Schema
>;

export const SessionCreationTargetPreparationResultV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    directory: z.string().trim().min(1),
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
]);
export type SessionCreationTargetPreparationResultV1 = z.infer<
  typeof SessionCreationTargetPreparationResultV1Schema
>;
