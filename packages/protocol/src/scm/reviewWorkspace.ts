import { z } from 'zod';

import { ScmOperationErrorCodeSchema } from './operationError.js';
import { ScmHostingProviderKindSchema } from './pullRequests.js';

/**
 * Provider-authorized checkout facts for one pull-request source tip.
 *
 * The generic SCM Action never selects a provider, account, pull request, or
 * workspace. Its caller has already proved those facts and supplies this
 * bounded checkout authority so the selected local backend can verify the
 * matching remote, fetch the exact ref, and resolve currentness from local
 * Git state.
 */
export const ScmReviewWorkspaceSourceTipSchema = z.object({
  repository: z.object({
    kind: ScmHostingProviderKindSchema,
    deployment: z.string().min(1),
    repository: z.string().min(1),
  }).strict(),
  cloneUrl: z.string().min(1),
  branch: z.string().min(1),
  sourceHeadSha: z.string().regex(/^[0-9a-fA-F]{7,64}$/),
  fetchRef: z.string().min(1),
}).strict();
export type ScmReviewWorkspaceSourceTip = z.infer<typeof ScmReviewWorkspaceSourceTipSchema>;

/**
 * The selected backend's resolved local-head fact. It is deliberately separate
 * from the Triage projection: SCM owns the Git safety decision and sources
 * project this result without asking Triage to derive a second currentness
 * rule from a path or a successful fetch.
 */
export const ScmReviewWorkspaceCurrentnessSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('currentAtObservedHead'),
  }).strict(),
  z.object({
    kind: z.literal('movedToObservedHead'),
    fromSha: z.string().regex(/^[0-9a-fA-F]{7,64}$/),
    observedHeadSha: z.string().regex(/^[0-9a-fA-F]{7,64}$/),
    recoveryRef: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('preservedStale'),
    resolvedHeadSha: z.string().regex(/^[0-9a-fA-F]{7,64}$/),
    observedHeadSha: z.string().regex(/^[0-9a-fA-F]{7,64}$/),
    reason: z.enum(['localCommits', 'dirtyWorktree', 'unresolvedHead']),
  }).strict(),
]);
export type ScmReviewWorkspaceCurrentness = z.infer<typeof ScmReviewWorkspaceCurrentnessSchema>;

/**
 * The source-neutral request to materialize an already selected local
 * workspace. Provider/account/ref authority stays with the source plugin; this
 * owner receives only the exact root and prepared checkout facts.
 */
export const ScmReviewWorkspaceMaterializePreparedRequestSchema = z.object({
  cwd: z.string().min(1),
  displayName: z.string().min(1),
  sourceTip: ScmReviewWorkspaceSourceTipSchema,
}).strict();
export type ScmReviewWorkspaceMaterializePreparedRequest = z.infer<
  typeof ScmReviewWorkspaceMaterializePreparedRequestSchema
>;

export const ScmReviewWorkspaceMaterializePreparedResponseSchema = z.union([
  z.object({
    success: z.literal(true),
    targetPath: z.string().min(1),
    branchName: z.string().min(1),
    created: z.boolean(),
    currentness: ScmReviewWorkspaceCurrentnessSchema,
  }).strict(),
  z.object({
    success: z.literal(false),
    error: z.string().min(1),
    errorCode: ScmOperationErrorCodeSchema,
  }).strict(),
]);
export type ScmReviewWorkspaceMaterializePreparedResponse = z.infer<
  typeof ScmReviewWorkspaceMaterializePreparedResponseSchema
>;
