import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PublicProfileUnavailableReasonV1Schema } from '../../account/publicProfilePublication.js';
import { HomeAccountTargetInputV1Schema } from './accounts.js';

export const HomePublicProfileModerationBodyV1Schema = lazyZodSchema(() => z.strictObject({
  reason: z.string().check(z.trim(), z.minLength(1)),
}));

/** One strict Action intent; the Home binder consumes the target into the route. */
export const HomePublicProfileModerationInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...HomeAccountTargetInputV1Schema.shape,
  ...HomePublicProfileModerationBodyV1Schema.shape,
}));
export type HomePublicProfileModerationInputV1 = z.infer<typeof HomePublicProfileModerationInputV1Schema>;

/** Operator acknowledgement must not disclose the target's private owner record. */
export const HomePublicProfileModerationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('updated'), record: z.null() }),
  z.strictObject({ kind: z.literal('unavailable'), reason: PublicProfileUnavailableReasonV1Schema }),
]));
export type HomePublicProfileModerationResultV1 = z.infer<typeof HomePublicProfileModerationResultV1Schema>;
