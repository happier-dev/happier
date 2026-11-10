import { z } from '../zodRuntimePolicy.js';

import { lazyZodSchema } from '../lazyZodSchema.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';

/** Requested human-review intent; neither scope is itself a setup grant. */
export const ProjectSetupConsentScopeV1Schema = lazyZodSchema(() => z.enum(['thisTime', 'untilChanged']));
export type ProjectSetupConsentScopeV1 = z.infer<typeof ProjectSetupConsentScopeV1Schema>;

/** Passive target-produced review facts; never executable input or a consent grant. */
export const ProjectSetupReviewV1Schema = lazyZodSchema(() => z.strictObject({
  reviewedEffect: StrictJsonValueSchema,
  reviewedEffectDigest: z.string().check(z.minLength(1)),
}));
export type ProjectSetupReviewV1 = z.infer<typeof ProjectSetupReviewV1Schema>;

/** Redacted producer facts on the incumbent typed Action failure envelope. */
export const ProjectSetupConsentFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('pendingApproval'),
  code: z.enum(['project_setup_consent_required', 'project_setup_effect_changed']),
  ...ProjectSetupReviewV1Schema.shape,
  consentScope: z.optional(ProjectSetupConsentScopeV1Schema),
}));
export type ProjectSetupConsentFailureDetailsV1 = z.infer<typeof ProjectSetupConsentFailureDetailsV1Schema>;

/** A terminal Script review is not a setup grant or a resumable setup hold. */
export const ProjectScriptEffectChangedFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('pendingApproval'),
  code: z.literal('project_script_effect_changed'),
  reviewedEffect: StrictJsonValueSchema,
  reviewedEffectDigest: z.string().check(z.minLength(1)),
}));
export type ProjectScriptEffectChangedFailureDetailsV1 = z.infer<typeof ProjectScriptEffectChangedFailureDetailsV1Schema>;
