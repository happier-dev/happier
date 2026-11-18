import * as zMini from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import {
  SCM_PULL_REQUEST_REVIEW_SCOPE_INPUT_KEY,
  ScmPullRequestReviewScopeV1Schema,
} from './scmPullRequestScope.js';
import { ReviewScmScopeV1Schema, ReviewScopeSchema } from './scope.js';
import { TeamCredentialProviderModelSelectionV1Schema } from '../teams/credentials/resourceV1.js';
import { ExecutionRunStartRequestBaseSchema, ExecutionRunTeamCredentialSessionBindingConsentV1Schema } from '../execution/runs/startRequest.js';
import { SecretReferenceOverlayV1Schema } from '../profiles/secretReferenceOverlayV1.js';
import { PluginSourceCustodyV1Schema } from '../plugins/runtime/sourceCustody.js';
import { ReviewOutputSelectionSchema } from './reviewNarration.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { defineProtocolJsonValue } from '../plugins/actions/protocolComposableSchema.js';
import { asProtocolZod, projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ActionSessionAddressV1Schema } from '../actions/sessionAddressV1.js';
import type { SessionTranscriptGetItem } from '../actions/specs/session/transcript.js';
import { ExecutableSessionParticipantSelectionV1Schema, ExecutableModelParticipantSelectionV1Schema } from '../discussions/executableParticipants.js';
import { ReviewRequestedReviewerInputV1Schema } from './reviewHumanV1.js';
import { ReviewRoundBindingV1Schema } from './reviewArtifactV1.js';

/** Admitted source evidence carried only by the host's live launch context. */
export type ReviewTranscriptEvidence = Readonly<{
  sourceSession: z.infer<typeof ActionSessionAddressV1Schema>;
  coverage: 'complete' | 'partial';
  items: readonly SessionTranscriptGetItem[];
}>;

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

const ReviewJsonInputSchema = lazyZodSchema(() => asProtocolZod(defineProtocolJsonValue()));
export const ReviewEngineInputSchema = lazyZodSchema(() => z.record(z.string(), ReviewJsonInputSchema));
export type ReviewEngineInput = z.infer<typeof ReviewEngineInputSchema>;

export const ReviewEngineInputsSchema = lazyZodSchema(() => z._default(z.record(ReviewEngineIdSchema, ReviewEngineInputSchema), {}));
export type ReviewEngineInputs = z.infer<typeof ReviewEngineInputsSchema>;
const DEFAULT_REVIEW_ENGINE_INPUTS: ReviewEngineInputs = ReviewEngineInputsSchema.parse({});

export const REVIEW_SCM_SCOPE_INPUT_KEY = 'scmReviewScope';

/** Each intentional engine invocation owns its selection, even when engine ids repeat. */
export const ReviewEngineReviewerSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('engine'),
  engineId: ReviewEngineIdSchema,
  includeSessionTranscript: z.optional(z.boolean()),
  options: z.optional(ReviewEngineInputSchema),
  modelId: ExecutionRunStartRequestBaseSchema.shape.modelId,
  modelSelection: ExecutionRunStartRequestBaseSchema.shape.modelSelection,
  roleId: ExecutionRunStartRequestBaseSchema.shape.roleId,
  launchProfileId: ExecutionRunStartRequestBaseSchema.shape.launchProfileId,
  approvalProfileId: ExecutionRunStartRequestBaseSchema.shape.approvalProfileId,
  profileId: ExecutionRunStartRequestBaseSchema.shape.profileId,
  profileSourceCustody: ExecutionRunStartRequestBaseSchema.shape.profileSourceCustody,
  connectedServices: z.optional(ReviewJsonInputSchema),
  secretReferenceOverlay: ExecutionRunStartRequestBaseSchema.shape.secretReferenceOverlay,
  teamCredentialModel: ExecutionRunStartRequestBaseSchema.shape.teamCredentialModel,
  teamCredentialSessionBindingConsent: ExecutionRunStartRequestBaseSchema.shape.teamCredentialSessionBindingConsent,
  sessionConfigOptionOverrides: ExecutionRunStartRequestBaseSchema.shape.sessionConfigOptionOverrides,
  childSelection: ExecutionRunStartRequestBaseSchema.shape.childSelection,
  cwd: ExecutionRunStartRequestBaseSchema.shape.cwd,
}).check(z.superRefine((value, ctx) => {
  if (Boolean(value.profileId) !== Boolean(value.profileSourceCustody)) {
    ctx.addIssue({ code: 'custom', path: value.profileId ? ['profileSourceCustody'] : ['profileId'],
      message: 'profileId and profileSourceCustody must be provided together' });
  }
  const consent = value.teamCredentialSessionBindingConsent;
  const selection = value.teamCredentialModel;
  if (consent && (!selection || consent.teamId !== selection.teamId || consent.resourceId !== selection.resourceId
    || consent.expectedResourceRevision !== selection.expectedResourceRevision)) {
    ctx.addIssue({ code: 'custom', path: ['teamCredentialSessionBindingConsent'],
      message: 'Session binding consent must exactly match the selected Team resource revision' });
  }
})));
export type ReviewEngineReviewerSelectionV1 = z.infer<typeof ReviewEngineReviewerSelectionV1Schema>;

// Every reviewer crosses Action JSON transport, including additive native launch metadata.
export const ReviewReviewerSelectionV1Schema = lazyZodSchema(() => asProtocolZod(projectZodProtocolSchema(z.discriminatedUnion('kind', [
  ReviewEngineReviewerSelectionV1Schema,
  ExecutableSessionParticipantSelectionV1Schema,
  ExecutableModelParticipantSelectionV1Schema,
  z.strictObject({ kind: z.literal('person'), ...ReviewRequestedReviewerInputV1Schema.shape }),
]))));
export type ReviewReviewerSelectionV1 = z.infer<typeof ReviewReviewerSelectionV1Schema>;

export const ReviewStepV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['review', 'verify']),
  reviewers: z.array(ReviewReviewerSelectionV1Schema).check(z.minLength(1)),
  instructions: z.string().check(z.trim(), z.minLength(1)),
}));
export type ReviewStepV1 = z.infer<typeof ReviewStepV1Schema>;

/** Provenance identifies the intentional stage selection, never its reusable engine id. */
export function reviewReviewerIdForSelectionV1(reviewerIndex: number, stepIndex = 0): string {
  return `step-${stepIndex + 1}-reviewer-${reviewerIndex + 1}`;
}

export function reviewReviewerIdsForStartV1(input: Pick<ReviewStartInput, 'reviewers' | 'steps'>): string[] {
  return (input.steps ?? [{ reviewers: input.reviewers }]).flatMap((step, stepIndex) =>
    step.reviewers.flatMap((reviewer, reviewerIndex) => reviewer.kind === 'person' ? []
      : [reviewReviewerIdForSelectionV1(reviewerIndex, stepIndex)]));
}

/** Read compatibility for observed persisted pre-roster Run inputs, once at this owner. */
export function decodeLegacyReviewStartInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  if (input.reviewers !== undefined || !Array.isArray(input.engineIds)) return value;
  const { engineIds, ...rest } = input;
  const { engines, connectedServicesByBackendTargetKey } = input;
  const optionsByEngine = engines && typeof engines === 'object' && !Array.isArray(engines) ? engines as Record<string, unknown> : {};
  const bindingsByEngine = connectedServicesByBackendTargetKey && typeof connectedServicesByBackendTargetKey === 'object'
    && !Array.isArray(connectedServicesByBackendTargetKey) ? connectedServicesByBackendTargetKey as Record<string, unknown> : {};
  const selection = Object.fromEntries(Object.keys(ReviewEngineReviewerSelectionV1Schema.shape)
    .filter(key => key !== 'kind' && key !== 'engineId' && key !== 'options'
      && key !== 'includeSessionTranscript' && input[key] !== undefined)
    .map(key => [key, input[key]]));
  return { ...rest, reviewers: engineIds.map(engineId => ({ ...selection, kind: 'engine', engineId,
    ...(typeof engineId === 'string' && optionsByEngine[engineId] !== undefined ? { options: optionsByEngine[engineId] } : {}),
    ...(typeof engineId === 'string' && bindingsByEngine[engineId] !== undefined
      ? { connectedServices: bindingsByEngine[engineId] } : {}),
  })) };
}

/** Static Workflow validation has no value yet for a historical bound engines field. */
export function reviewStartDeferredFieldsV1(fields: ReadonlySet<string>): ReadonlySet<string> {
  return fields.has('engineIds') ? new Set([...fields, 'reviewers']) : fields;
}

/** Shared by public start validation and direct execution-run scope admission. */
export function hasConflictingReviewScope(input: Readonly<Record<string, unknown>>): boolean {
  return input.scope === 'repository'
    && Boolean(input.comparisonId || input[SCM_PULL_REQUEST_REVIEW_SCOPE_INPUT_KEY]);
}

export const ReviewStartInputFieldsSchema = lazyZodSchema(() => z.looseObject({
    roleId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    launchProfileId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    approvalProfileId: ExecutionRunStartRequestBaseSchema.shape.approvalProfileId,
    sessionId: z.optional(z.string().check(z.minLength(1))),
    target: z.optional(z.strictObject({ kind: z.literal('detached') })),
    childSelection: ExecutionRunStartRequestBaseSchema.shape.childSelection,
    cwd: ExecutionRunStartRequestBaseSchema.shape.cwd,
    reviewers: z.array(ReviewReviewerSelectionV1Schema).check(z.minLength(1)),
    steps: z.optional(z.array(ReviewStepV1Schema).check(z.minLength(1))),
    then: z.optional(z.enum(['report', 'fix'])),
    // Host-bound leaves reuse the admitted round; composition inputs retain only reviewId.
    reviewRound: z.optional(ReviewRoundBindingV1Schema),
    reviewReviewerId: z.optional(z.string().check(z.minLength(1))),
    reviewRoundSettlement: z.optional(z.enum(['execution', 'workflow'])),
    instructions: z.string().check(z.trim(), z.minLength(1)),
    scope: z._default(ReviewScopeSchema, 'changes'),
    sourceSession: z.optional(ActionSessionAddressV1Schema),
    outputs: z.optional(ReviewOutputSelectionSchema.shape.outputs),
    comparisonId: z.optional(z.string().check(z.minLength(1))),
    narrator: ReviewOutputSelectionSchema.shape.narrator,
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
    if (hasConflictingReviewScope(value)) {
      ctx.addIssue({ code: 'custom', path: ['scope'], message: 'Repository reviews cannot be restricted to a captured comparison or pull request' });
    }
    if (!value.sourceSession && [...value.reviewers, ...(value.steps?.flatMap(step => step.reviewers) ?? [])]
      .some(reviewer => reviewer.kind === 'engine' && reviewer.includeSessionTranscript === true)) {
      ctx.addIssue({ code: 'custom', path: ['sourceSession'], message: 'Selected transcript requires an explicit source Session and Home' });
    }
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
    if (value.teamCredentialModel && value.reviewers.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: 'A Team credential model requires exactly one review engine',
        path: ['reviewers'],
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
/** All start boundaries, including historical accepted graphs, spend this one decoder. */
export const ReviewStartInputSchema = lazyZodSchema(() => z.pipe(
  // Public authoring stays canonical; historical runtime values are decoded
  // before the same fields schema validates them.
  z.transform<z.input<typeof ReviewStartInputFieldsSchema>, unknown>(decodeLegacyReviewStartInput),
  ReviewStartInputFieldsSchema,
));
export type ReviewStartInput = z.infer<typeof ReviewStartInputSchema>;

/** A composed pass delegates executable admission to its concrete Workflow leaves. */
export function requiresReviewWorkflowCompositionV1(input: Pick<ReviewStartInput, 'reviewRound' | 'steps' | 'then' | 'reviewers'>): boolean {
  return !input.reviewRound && (input.steps !== undefined || input.then === 'fix'
    || input.reviewers.length !== 1 || input.reviewers[0]?.kind !== 'engine');
}
