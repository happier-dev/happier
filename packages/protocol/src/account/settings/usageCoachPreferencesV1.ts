import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { UsageCoachDetectorIdSchema } from '../../usage/coach/coachDetectorIds.js';

const evidenceKey = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
/** Shared current KV and historical Settings record shape; edits belong to the Coach KV owner. */
export const UsageCoachSuppressionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('dismissed'), evidenceKey }),
    z.strictObject({ kind: z.literal('snoozed'), evidenceKey, untilMs: z.number().check(z.int(), z.nonnegative(), z.int()) }),
]));
const preferenceFields = {
    v: z._default(z.literal(1), 1),
    disabledChecks: z._default(z.array(UsageCoachDetectorIdSchema), []),
    modelSuggestion: z._default(z.enum(['off', 'suggest_with_estimates', 'complete_only']), 'suggest_with_estimates'),
};
export const UsageCoachPreferencesV1Schema = lazyZodSchema(() => z.strictObject({
    ...preferenceFields,
    /** Read-only compatibility for stored pre-conversion Coach dismissals. */
    suppressions: z._default(z.array(UsageCoachSuppressionV1Schema), []),
}).check(z.superRefine((preferences, context) => {
    if (new Set(preferences.disabledChecks).size !== preferences.disabledChecks.length) {
        context.addIssue({ code: 'custom', path: ['disabledChecks'], message: 'Each check has one enabled state' });
    }
    const seen = new Set<string>();
    preferences.suppressions.forEach((suppression, index) => {
        if (seen.has(suppression.evidenceKey)) context.addIssue({ code: 'custom', path: ['suppressions', index, 'evidenceKey'],
            message: 'Each finding evidence has one suppression state' });
        seen.add(suppression.evidenceKey);
    });
})));
export type UsageCoachPreferencesV1 = z.infer<typeof UsageCoachPreferencesV1Schema>;
export const DEFAULT_USAGE_COACH_PREFERENCES_V1 = UsageCoachPreferencesV1Schema.parse({});
/** Current writes contain deliberate preferences only. */
export const UsageCoachPreferenceMutationV1Schema = lazyZodSchema(() => z.pipe(z.strictObject({
    ...preferenceFields,
    // Stored/default projections supply an empty compatibility field. Never
    // serialize it into a current mutation, including Settings Reset.
    suppressions: z.optional(z.tuple([])),
}).check(z.refine(value => new Set(value.disabledChecks).size === value.disabledChecks.length)),
z.transform(({ suppressions: _legacy, ...preferences }) => preferences)));
