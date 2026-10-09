import { z } from 'zod';

import { lazyZodSchema } from '../lazyZodSchema.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';

/** Requested human-review intent; neither scope is itself a setup grant. */
export const ProjectSetupConsentScopeV1Schema = lazyZodSchema(() => z.enum(['thisTime', 'untilChanged']));
export type ProjectSetupConsentScopeV1 = z.infer<typeof ProjectSetupConsentScopeV1Schema>;

/** Redacted producer facts on the incumbent typed Action failure envelope. */
export const ProjectSetupConsentFailureDetailsV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('pendingApproval'),
  code: z.enum(['project_setup_consent_required', 'project_setup_effect_changed']),
  reviewedEffect: StrictJsonValueSchema,
  reviewedEffectDigest: z.string().min(1),
  consentScope: ProjectSetupConsentScopeV1Schema.optional(),
}).strict());
export type ProjectSetupConsentFailureDetailsV1 = z.infer<typeof ProjectSetupConsentFailureDetailsV1Schema>;
