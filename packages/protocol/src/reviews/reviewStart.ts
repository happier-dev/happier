import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import {
  SCM_PULL_REQUEST_REVIEW_SCOPE_INPUT_KEY,
  ScmPullRequestReviewScopeV1Schema,
} from './scmPullRequestScope.js';
import { ReviewScmScopeV1Schema } from './scope.js';
import { TeamCredentialProviderModelSelectionV1Schema } from '../teams/credentials/resourceV1.js';
import { ExecutionRunStartRequestBaseSchema, ExecutionRunTeamCredentialSessionBindingConsentV1Schema } from '../execution/runs/startRequest.js';
import { SecretReferenceOverlayV1Schema } from '../profiles/secretReferenceOverlayV1.js';
import { PluginSourceCustodyV1Schema } from '../plugins/runtime/sourceCustody.js';
import { ReviewNarratorSelectionSchema } from './reviewNarration.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';

/**
 * Canonical, cross-surface input contract for starting reviews.
 *
 * This is not a “backend contract”. It is a generalized review intent input that
 * can be interpreted by different review engines (LLM prompt reviews, native CLIs).
 */

export const ReviewChangeTypeSchema = lazyZodSchema(() => z.enum(['all', 'committed', 'uncommitted']));
export type ReviewChangeType = z.infer<typeof ReviewChangeTypeSchema>;

export const ReviewBaseSchema = lazyZodSchema(() => z.union([
  z.object({ kind: z.literal('none') }).passthrough(),
  z.object({ kind: z.literal('branch'), baseBranch: z.string().min(1) }).passthrough(),
  z.object({ kind: z.literal('commit'), baseCommit: z.string().min(1) }).passthrough(),
]));
export type ReviewBase = z.infer<typeof ReviewBaseSchema>;

export const ReviewEngineIdSchema = lazyZodSchema(() => z.string().trim().min(1));
export type ReviewEngineId = z.infer<typeof ReviewEngineIdSchema>;

export const ReviewEngineInputSchema = lazyZodSchema(() => z.object({}).passthrough());
export type ReviewEngineInput = z.infer<typeof ReviewEngineInputSchema>;

export const ReviewEngineInputsSchema = lazyZodSchema(() => z.record(ReviewEngineIdSchema, ReviewEngineInputSchema).default({}));
export type ReviewEngineInputs = z.infer<typeof ReviewEngineInputsSchema>;
const DEFAULT_REVIEW_ENGINE_INPUTS: ReviewEngineInputs = ReviewEngineInputsSchema.parse({});

export const REVIEW_SCM_SCOPE_INPUT_KEY = 'scmReviewScope';

export const ReviewStartInputSchema = lazyZodSchema(() => z
  .object({
    roleId: z.string().trim().min(1).optional(),
    launchProfileId: z.string().trim().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    target: z.object({ kind: z.literal('detached') }).strict().optional(),
    engineIds: z.array(ReviewEngineIdSchema).min(1),
    instructions: z.string().trim().min(1),
    outputs: z.array(z.literal('walkthrough')).min(1).optional(),
    comparisonId: z.string().min(1).optional(),
    narrator: ReviewNarratorSelectionSchema.optional(),
    notifyParentOnCompletion: z.boolean().optional(),
    reviewCommentAuthorIntent: z.enum(['open', 'propose']).default('propose'),
    // Intentionally default to uncommitted changes: the common "review what I just changed"
    // flow should stay narrowly scoped unless the user explicitly broadens it.
    changeType: ReviewChangeTypeSchema.default('uncommitted'),
    base: ReviewBaseSchema.default({ kind: 'none' }),
    engines: ReviewEngineInputsSchema.prefault(DEFAULT_REVIEW_ENGINE_INPUTS),
    scmReviewScope: ReviewScmScopeV1Schema.optional(),
    // A selected pull request is scoped by its own strict sibling key, never by
    // widening the worktree scope above: `ReviewProfile` re-derives that one on
    // every start and would discard anything packed into it.
    [SCM_PULL_REQUEST_REVIEW_SCOPE_INPUT_KEY]: ScmPullRequestReviewScopeV1Schema.optional(),
    permissionMode: z.string().min(1).default('read_only'),
    profileId: z.string().trim().min(1).optional(),
    profileSourceCustody: PluginSourceCustodyV1Schema.optional(),
    // Match the other fan-out Actions: exact target entries override the blanket selection.
    // The shared Action composer normalizes these before any Run starts.
    connectedServices: StrictJsonValueSchema.optional(),
    connectedServicesByBackendTargetKey: z.record(z.string(), StrictJsonValueSchema).optional(),
    secretReferenceOverlay: SecretReferenceOverlayV1Schema.optional(),
    modelSelection: ExecutionRunStartRequestBaseSchema.shape.modelSelection,
    teamCredentialModel: TeamCredentialProviderModelSelectionV1Schema.optional(),
    teamCredentialSessionBindingConsent: ExecutionRunTeamCredentialSessionBindingConsentV1Schema.optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.target && value.sessionId !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['target'], message: 'A detached review cannot target a Session' });
    }
    if (Boolean(value.profileId) !== Boolean(value.profileSourceCustody)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'profileId and profileSourceCustody must be provided together',
        path: value.profileId ? ['profileSourceCustody'] : ['profileId'],
      });
    }
    if (value.teamCredentialModel && value.engineIds.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A Team credential model requires exactly one review engine',
        path: ['engineIds'],
      });
    }
    if (value.teamCredentialSessionBindingConsent) {
      const consent = value.teamCredentialSessionBindingConsent;
      const selection = value.teamCredentialModel;
      if (
        !selection
        || consent.teamId !== selection.teamId
        || consent.resourceId !== selection.resourceId
        || consent.expectedResourceRevision !== selection.expectedResourceRevision
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Session binding consent must exactly match the selected Team resource revision',
          path: ['teamCredentialSessionBindingConsent'],
        });
      }
    }
  }))
  // Intentionally no engine-specific requirements here: this is a generalized,
  // cross-surface intent input. Engines may interpret optional `engines.*` blocks.
  ;
export type ReviewStartInput = z.infer<typeof ReviewStartInputSchema>;
