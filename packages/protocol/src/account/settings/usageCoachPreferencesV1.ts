import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { UsageCoachDetectorIdSchema } from '../../usage/coach/coachDetectorIds.js';

const preferenceFields = {
    v: z._default(z.literal(1), 1),
    disabledChecks: z._default(z.array(UsageCoachDetectorIdSchema), []),
    modelSuggestion: z._default(z.enum(['off', 'suggest_with_estimates', 'complete_only']), 'suggest_with_estimates'),
};
export const UsageCoachPreferencesV1Schema = lazyZodSchema(() => z.strictObject(preferenceFields).check(z.superRefine((preferences, context) => {
    if (new Set(preferences.disabledChecks).size !== preferences.disabledChecks.length) {
        context.addIssue({ code: 'custom', path: ['disabledChecks'], message: 'Each check has one enabled state' });
    }
})));
export type UsageCoachPreferencesV1 = z.infer<typeof UsageCoachPreferencesV1Schema>;
export const DEFAULT_USAGE_COACH_PREFERENCES_V1 = UsageCoachPreferencesV1Schema.parse({});
/** Stored preferences and current writes share the same deliberate preference shape. */
export const UsageCoachPreferenceMutationV1Schema = UsageCoachPreferencesV1Schema;
