import { z } from '../zodRuntimePolicy.js';

import { lazyZodSchema } from '../lazyZodSchema.js';
import { PluginLocalizedStringV2Schema } from '../plugins/contributions/publicTypes.js';

/**
 * The pressed contribution's own declaration, carried in an `action.invoke` review preview by the receiver that
 * can read its catalog (`prepareApprovalRequest`). Presenters name the review, its verb and the declared input
 * from it instead of the generic host Action and its raw ids.
 */
export const ContributedActionReviewV1Schema = lazyZodSchema(() =>
  z.object({
    title: z.string().check(z.minLength(1)),
    confirmVerb: z.optional(PluginLocalizedStringV2Schema),
    description: z.optional(z.string().check(z.minLength(1))),
    fields: z.array(
      z.object({
        path: z.string().check(z.minLength(1)),
        title: z.string().check(z.minLength(1)),
      }),
    ),
  }),
);
export type ContributedActionReviewV1 = z.infer<
  typeof ContributedActionReviewV1Schema
>;

/** Reads the carried declaration from a review preview; `null` when the receiver could not read it. */
export function readContributedActionReviewV1(
  preview: unknown,
): ContributedActionReviewV1 | null {
  if (
    !preview ||
    typeof preview !== 'object' ||
    !('contributedAction' in preview)
  )
    return null;
  const parsed = ContributedActionReviewV1Schema.safeParse(
    preview.contributedAction,
  );
  return parsed.success ? parsed.data : null;
}
