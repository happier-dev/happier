import * as zMini from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

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
  z.looseObject({ kind: z.literal('none') }),
  z.looseObject({ kind: z.literal('branch'), baseBranch: z.string().check(z.minLength(1)) }),
  z.looseObject({ kind: z.literal('commit'), baseCommit: z.string().check(z.minLength(1)) }),
]));
export type ReviewBase = z.infer<typeof ReviewBaseSchema>;

export const ReviewEngineIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
export type ReviewEngineId = z.infer<typeof ReviewEngineIdSchema>;

export const ReviewEngineInputSchema = lazyZodSchema(() => z.looseObject({}));
export type ReviewEngineInput = z.infer<typeof ReviewEngineInputSchema>;

export const ReviewEngineInputsSchema = lazyZodSchema(() => z._default(z.record(ReviewEngineIdSchema, ReviewEngineInputSchema), {}));
export type ReviewEngineInputs = z.infer<typeof ReviewEngineInputsSchema>;
const DEFAULT_REVIEW_ENGINE_INPUTS: ReviewEngineInputs = ReviewEngineInputsSchema.parse({});

export const REVIEW_SCM_SCOPE_INPUT_KEY = 'scmReviewScope';

export const ReviewStartInputSchema = lazyZodSchema(() => z.looseObject({
    roleId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    launchProfileId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    approvalProfileId: ExecutionRunStartRequestBaseSchema.shape.approvalProfileId,
    sessionId: z.optional(z.string().check(z.minLength(1))),
    target: z.optional(z.strictObject({ kind: z.literal('detached') })),
    childSelection: ExecutionRunStartRequestBaseSchema.shape.childSelection,
    cwd: ExecutionRunStartRequestBaseSchema.shape.cwd,
    engineIds: z.array(ReviewEngineIdSchema).check(z.minLength(1)),
    instructions: z.string().check(z.trim(), z.minLength(1)),
    outputs: z.optional(z.array(z.literal('walkthrough')).check(z.minLength(1))),
    comparisonId: z.optional(z.string().check(z.minLength(1))),
    narrator: zMini.optional(ReviewNarratorSelectionSchema),
    notifyParentOnCompletion: z.optional(z.boolean()),
    reviewCommentAuthorIntent: z._default(z.enum(['open', 'propose']), 'propose'),
    // Intentionally default to uncommitted changes: the common "review what I just changed"
    // flow should stay narrowly scoped unless the user explicitly broadens it.
    changeType: z._default(ReviewChangeTypeSchema, 'uncommitted'),
    base: z._default(ReviewBaseSchema, { kind: 'none' }),
    engines: z.prefault(ReviewEngineInputsSchema, DEFAULT_REVIEW_ENGINE_INPUTS),
    scmReviewScope: zMini.optional(ReviewScmScopeV1Schema),
    // A selected pull request is scoped by its own strict sibling key, never by
    // widening the worktree scope above: `ReviewProfile` re-derives that one on
    // every start and would discard anything packed into it.
    [SCM_PULL_REQUEST_REVIEW_SCOPE_INPUT_KEY]: zMini.optional(ScmPullRequestReviewScopeV1Schema),
    permissionMode: z._default(z.string().check(z.minLength(1)), 'read_only'),
    profileId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    profileSourceCustody: zMini.optional(PluginSourceCustodyV1Schema),
    // Match the other fan-out Actions: exact target entries override the blanket selection.
    // The shared Action composer normalizes these before any Run starts.
    connectedServices: zMini.optional(StrictJsonValueSchema),
    connectedServicesByBackendTargetKey: z.optional(z.record(z.string(), StrictJsonValueSchema)),
    secretReferenceOverlay: zMini.optional(SecretReferenceOverlayV1Schema),
    modelSelection: ExecutionRunStartRequestBaseSchema.shape.modelSelection,
    teamCredentialModel: zMini.optional(TeamCredentialProviderModelSelectionV1Schema),
    teamCredentialSessionBindingConsent: zMini.optional(ExecutionRunTeamCredentialSessionBindingConsentV1Schema),
  }).check(z.superRefine((value, ctx) => {
    if (value.target && value.sessionId !== undefined) {
      ctx.addIssue({ code: "custom", path: ['target'], message: 'A detached review cannot target a Session' });
    }
    if (Boolean(value.profileId) !== Boolean(value.profileSourceCustody)) {
      ctx.addIssue({
        code: "custom",
        message: 'profileId and profileSourceCustody must be provided together',
        path: value.profileId ? ['profileSourceCustody'] : ['profileId'],
      });
    }
    if (value.teamCredentialModel && value.engineIds.length !== 1) {
      ctx.addIssue({
        code: "custom",
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
          code: "custom",
          message: 'Session binding consent must exactly match the selected Team resource revision',
          path: ['teamCredentialSessionBindingConsent'],
        });
      }
    }
  })))
  // Intentionally no engine-specific requirements here: this is a generalized,
  // cross-surface intent input. Engines may interpret optional `engines.*` blocks.
  ;
export type ReviewStartInput = z.infer<typeof ReviewStartInputSchema>;
