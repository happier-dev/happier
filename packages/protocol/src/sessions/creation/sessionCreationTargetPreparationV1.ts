import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { readRpcErrorCode } from '../../rpc/errors.js';

import { SessionAuthoringCheckoutCreationDraftV1Schema } from '../authoring/creationFieldsV1.js';
import { SessionExecutionTargetV1Schema } from './sessionExecutionTargetV1.js';
import { SessionDirectoryIntentV1Schema, refineSessionDirectoryIntentCheckoutV1 } from './sessionDirectoryIntentV1.js';
import { SessionCreationTagV1Schema } from './sessionCreationIdentityV1.js';
import type { SessionSpawnNewInputV2 } from './sessionSpawnNewInputV2.js';
import type { SessionSpawnNewResultV1 } from './sessionSpawnNewResultV1.js';
import type { SessionExecutionTargetV1 } from './sessionExecutionTargetV1.js';

/**
 * Host-only evidence that a user approved creation of this exact canonical
 * target directory. It is retained with the existing Action approval artifact,
 * never accepted from the public Session-spawn input, and is discarded once
 * the daemon has consumed it to materialize the directory.
 */
export const SessionCreationDirectoryApprovalV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  executionTarget: SessionExecutionTargetV1Schema,
  directory: z.string().check(z.trim(), z.minLength(1)),
}));
export type SessionCreationDirectoryApprovalV1 = z.infer<
  typeof SessionCreationDirectoryApprovalV1Schema
>;

export const SessionCreationTargetPreparationRequestV1Schema = lazyZodSchema(() => z.strictObject({
  directory: SessionDirectoryIntentV1Schema,
  sessionCreationTag: z.optional(SessionCreationTagV1Schema),
  checkoutCreationDraft: z.optional(z.nullable(SessionAuthoringCheckoutCreationDraftV1Schema)),
}).check(z.superRefine(refineSessionDirectoryIntentCheckoutV1)));
export type SessionCreationTargetPreparationRequestV1 = z.infer<
  typeof SessionCreationTargetPreparationRequestV1Schema
>;

export const SessionCreationPreparedCheckoutV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('git_worktree'),
  finalDirectory: z.string().check(z.trim(), z.minLength(1)),
  baseRef: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  branchMode: z.enum(['new', 'existing']),
  /** Last observed actual branch; null proves detached, omission is unavailable. */
  branchName: z.optional(z.nullable(z.string())),
  /**
   * Target-owned materialization receipt. Only an explicit `true` proves this
   * preparation created the checkout and may authorize a compensating remove.
   * Older targets omit it and are therefore never cleaned up speculatively.
   */
  created: z.optional(z.boolean()),
}));
export type SessionCreationPreparedCheckoutV1 = z.infer<
  typeof SessionCreationPreparedCheckoutV1Schema
>;

export const SessionCreationTargetPreparationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    directory: z.string().check(z.trim(), z.minLength(1)),
    directoryKind: z.enum(['path', 'managed']),
    /** Whether this direct target requires user authorization before mkdir. */
    directoryCreationRequired: z.boolean(),
    checkout: z.nullable(SessionCreationPreparedCheckoutV1Schema),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum([
      'invalid_directory',
      'checkout_unavailable',
      'checkout_failed',
    ]),
  }),
]));
export type SessionCreationTargetPreparationResultV1 = z.infer<
  typeof SessionCreationTargetPreparationResultV1Schema
>;

/** One response owner for UI and CLI preparation, including pre-handler RPC refusals.
 * Only classified preparation causes are exposed; daemon error prose stays private.
 */
export function readSessionCreationTargetPreparationResultV1(raw: unknown):
  | Readonly<{ ok: true; preparedTarget: Extract<SessionCreationTargetPreparationResultV1, { ok: true }> }>
  | Readonly<{ ok: false; result: Extract<SessionSpawnNewResultV1, { type: 'error' }> }> {
  const prepared = SessionCreationTargetPreparationResultV1Schema.safeParse(raw);
  if (prepared.success) return prepared.data.ok
    ? { ok: true, preparedTarget: prepared.data }
    : { ok: false, result: projectSessionCreationTargetPreparationFailureV1(prepared.data) };
  const refusal = projectSessionCreationTargetPreparationRpcFailureV1(raw);
  if (refusal) return { ok: false, result: refusal };
  return { ok: false, result: { type: 'error', code: 'incompatible_target', retryable: false,
    incompatibleTarget: { reason: 'target_preparation_invalid_result' } } };
}

/** Raw UI replies and CLI transport exceptions carry the same classified refusal. */
export function projectSessionCreationTargetPreparationRpcFailureV1(
  error: unknown,
): Extract<SessionSpawnNewResultV1, { type: 'error' }> | null {
  const code = readRpcErrorCode(error) ?? (
    error !== null && typeof error === 'object' && !('ok' in error)
      && 'error' in error && typeof error.error === 'string' && 'errorCode' in error
      ? error.errorCode : undefined
  );
  return code === 'agent_isolation_unavailable' || code === 'filesystem_identity_custody_unavailable'
    || code === 'MACHINE_ENCRYPTION_UNAVAILABLE'
    ? { type: 'error', code: 'spawn_failed', retryable: false,
      launchError: { kind: 'launch_error', code, message: code } }
    : null;
}

/** Creation adapters preserve the target's closed refusal vocabulary identically. */
export function projectSessionCreationTargetPreparationFailureV1(
  failure: Extract<SessionCreationTargetPreparationResultV1, { ok: false }>,
): Extract<SessionSpawnNewResultV1, { type: 'error' }> {
  switch (failure.code) {
    case 'invalid_directory':
      return { type: 'error', code: 'invalid_input', retryable: false };
    case 'checkout_unavailable':
      return { type: 'error', code: 'incompatible_target', retryable: false,
        incompatibleTarget: { reason: 'checkout_unavailable' } };
    case 'checkout_failed':
      return { type: 'error', code: 'spawn_failed', retryable: true,
        launchError: { kind: 'launch_error', code: failure.code, message: failure.code } };
  }
}

/** Worktrees and managed directories retain their separate materialization owner. */
export function needsSessionCreationDirectoryApprovalPreflightV1(
  input: Pick<SessionSpawnNewInputV2, 'directory' | 'checkoutCreationDraft'>,
): boolean {
  return input.directory.kind === 'path' && !input.checkoutCreationDraft;
}

/** UI and CLI retain the same target-produced proof before asking for consent. */
export function projectSessionCreationDirectoryApprovalV1(
  executionTarget: SessionExecutionTargetV1,
  preparedTarget: Extract<SessionCreationTargetPreparationResultV1, { ok: true }>,
): SessionCreationDirectoryApprovalV1 | null {
  return preparedTarget.directoryCreationRequired
    ? { v: 1, executionTarget, directory: preparedTarget.directory }
    : null;
}
