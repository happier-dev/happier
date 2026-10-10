import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { ScmOperationErrorCodeSchema, type ScmOperationErrorCode } from './operationError.js';
import { ScmOperationStateSchema } from './operationState.js';
import type { ScmCommitPublication } from './commitPublication.js';

export const ScmOperationRepositoryStateSchema = lazyZodSchema(() => z.object({
  headOid: z.string().optional(),
  hasConflicts: z.boolean(),
  operation: ScmOperationStateSchema.nullable(),
}).strict());
export type ScmOperationRepositoryState = z.infer<typeof ScmOperationRepositoryStateSchema>;

export const ScmOperationEffectSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('commit'), commitSha: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('stash'), stashOid: z.string().min(1), stashRef: z.string().optional() }).strict(),
  z.object({ kind: z.literal('pull_request'), url: z.string().min(1), number: z.number().int().positive().optional() }).strict(),
  z.object({ kind: z.literal('branch'), name: z.string().min(1), headOid: z.string().optional() }).strict(),
  z.object({ kind: z.literal('remote'), remote: z.string().min(1), branch: z.string().optional(), remoteOid: z.string().optional() }).strict(),
]));
export type ScmOperationEffect = z.infer<typeof ScmOperationEffectSchema>;

export const ScmOperationReconciliationSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('repository_status'), cwd: z.string().optional() }).strict(),
  z.object({ kind: z.literal('commit'), commitSha: z.string().min(1) }).strict(),
  // A creation message is a read-only query when the creating process lost its result;
  // it is never permission to apply or drop a stash.
  z.object({ kind: z.literal('stash'), stashOid: z.string().optional(), message: z.string().optional() }).strict(),
  z.object({ kind: z.literal('remote_ref'), remote: z.string().min(1), branch: z.string().optional(), expectedOid: z.string().optional() }).strict(),
  z.object({ kind: z.literal('pull_request'), head: z.string().min(1), base: z.string().optional(), providerId: z.string().optional(), repository: z.string().optional(), url: z.string().optional() }).strict(),
]));
export type ScmOperationReconciliation = z.infer<typeof ScmOperationReconciliationSchema>;

export const ScmOperationNextActionSchema = lazyZodSchema(() => z.union([
  z.object({ kind: z.enum(['refresh', 'retry', 'resolve_conflicts', 'continue', 'skip', 'abort', 'reconcile_index', 'choose_dirty_policy', 'choose_reconcile', 'configure_upstream', 'authenticate']) }).strict(),
  z.object({ kind: z.literal('open_url'), url: z.string().min(1) }).strict(),
]));
export type ScmOperationNextAction = z.infer<typeof ScmOperationNextActionSchema>;

const common = {
  v: z.literal(1).default(1),
  nextActions: z.array(ScmOperationNextActionSchema).default([]),
  message: z.string().optional(),
  recoveryStash: z.object({ stashOid: z.string().min(1), stashRef: z.string().optional() }).strict().optional(),
};
const repositoryState = ScmOperationRepositoryStateSchema.optional();
export const ScmOperationOutcomeSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('succeeded'), effect: ScmOperationEffectSchema.optional(), repositoryState }).strict(),
  z.object({ ...common, kind: z.literal('needs_input'), errorCode: ScmOperationErrorCodeSchema, repositoryState }).strict(),
  z.object({ ...common, kind: z.literal('conflicted'), errorCode: ScmOperationErrorCodeSchema, repositoryState: ScmOperationRepositoryStateSchema }).strict(),
  z.object({ ...common, kind: z.literal('effect_applied_with_warning'), errorCode: ScmOperationErrorCodeSchema, effect: ScmOperationEffectSchema, repositoryState }).strict(),
  z.object({ ...common, kind: z.literal('failed'), errorCode: ScmOperationErrorCodeSchema, repositoryState }).strict(),
  z.object({ ...common, kind: z.literal('cancelled'), errorCode: ScmOperationErrorCodeSchema.optional(), repositoryState: ScmOperationRepositoryStateSchema }).strict(),
  z.object({ ...common, kind: z.literal('outcome_unknown'), errorCode: ScmOperationErrorCodeSchema, reconciliation: ScmOperationReconciliationSchema, repositoryState }).strict(),
]));
export type ScmOperationOutcome = z.infer<typeof ScmOperationOutcomeSchema>;

/** A missing mutation result permits reconciliation, never an automatic replay. */
export function createScmOperationUnknownOutcome(
  reconciliation: ScmOperationReconciliation,
): Extract<ScmOperationOutcome, { kind: 'outcome_unknown' }> {
  return { v: 1, kind: 'outcome_unknown', errorCode: 'COMMAND_OUTCOME_UNKNOWN', reconciliation, nextActions: [{ kind: 'refresh' }] };
}

/** Adapt legacy results once at the protocol seam. Diagnostics never confer authority. */
export function normalizeScmOperationOutcome(response: Readonly<{
  success: boolean;
  outcome?: ScmOperationOutcome;
  errorCode?: ScmOperationErrorCode;
  error?: string;
  commitSha?: string;
  publication?: ScmCommitPublication;
}>): ScmOperationOutcome {
  // Publication is the writer's observed fact; success/diagnostics cannot turn uncertainty into retry authority.
  if (response.publication?.state === 'unknown') {
    return createScmOperationUnknownOutcome(response.publication.candidateOid
      ? { kind: 'commit', commitSha: response.publication.candidateOid }
      : { kind: 'repository_status' });
  }
  if (response.publication?.state === 'published' && response.outcome) {
    const commitSha = response.publication.candidateOid ?? response.commitSha;
    if (!commitSha) return createScmOperationUnknownOutcome({ kind: 'repository_status' });
    const effect = { kind: 'commit' as const, commitSha };
    if (response.outcome.kind === 'succeeded' || response.outcome.kind === 'effect_applied_with_warning') return { ...response.outcome, effect };
    return {
      v: 1, kind: 'effect_applied_with_warning', effect,
      errorCode: response.errorCode ?? ('errorCode' in response.outcome ? response.outcome.errorCode : undefined) ?? 'COMMAND_FAILED',
      nextActions: [{ kind: response.publication.indexReconciliation === 'failed' ? 'reconcile_index' : 'refresh' }],
      ...(response.outcome.message ? { message: response.outcome.message } : {}),
    };
  }
  if (response.outcome) return response.outcome;
  const common = { v: 1 as const, nextActions: [], ...(response.error ? { message: response.error } : {}) };
  const commitSha = response.publication?.state === 'published' ? response.publication.candidateOid ?? response.commitSha
    : response.publication?.state === 'not_published' ? undefined : response.commitSha;
  const effect = commitSha ? { kind: 'commit' as const, commitSha } : undefined;
  if (response.publication?.state === 'published' && !effect) return createScmOperationUnknownOutcome({ kind: 'repository_status' });
  if (response.success) return { ...common, kind: 'succeeded', ...(effect ? { effect } : {}) };
  const errorCode = response.errorCode ?? 'COMMAND_FAILED';
  if (effect) return { ...common, kind: 'effect_applied_with_warning', effect, errorCode };
  switch (errorCode) {
    case 'REMOTE_AUTH_REQUIRED': return { ...common, kind: 'needs_input', errorCode, nextActions: [{ kind: 'authenticate' }] };
    case 'REMOTE_UPSTREAM_REQUIRED': return { ...common, kind: 'needs_input', errorCode, nextActions: [{ kind: 'configure_upstream' }] };
    case 'REMOTE_NON_FAST_FORWARD':
    case 'REMOTE_FF_ONLY_REQUIRED': return { ...common, kind: 'needs_input', errorCode, nextActions: [{ kind: 'choose_reconcile' }] };
    case 'COMMIT_REQUIRED': return { ...common, kind: 'needs_input', errorCode };
    case 'COMMIT_HOOK_CONTENT_CHANGED': return { ...common, kind: 'needs_input', errorCode };
    case 'COMMIT_HEAD_CHANGED':
    case 'COMMIT_STAGING_CONFLICT':
    case 'SCM_SOURCE_CHANGED': return { ...common, kind: 'needs_input', errorCode, nextActions: [{ kind: 'refresh' }] };
    default: return { ...common, kind: 'failed', errorCode };
  }
}
