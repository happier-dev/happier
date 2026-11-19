import { z } from '../zodRuntimePolicy.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';

/** The exact admitted Review and round, shared by receipts and their relations. */
export const ReviewRoundBindingV1Schema = z.strictObject({ reviewId: z.string().check(z.minLength(1)), roundOrdinal: z.number().check(z.int(), z.minimum(1)) });
export type ReviewRoundBindingV1 = z.infer<typeof ReviewRoundBindingV1Schema>;
export const ReviewRoundBindingV1ProtocolSchema = projectZodProtocolSchema(ReviewRoundBindingV1Schema);
