import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

/**
 * How several reviewers' quality scores read as one (Account preference). A leaf module on purpose: Account settings
 * import it, so it must not pull the Session runtime graph in (order-sensitive load failure, 2026-11-19).
 */
export const ReviewQualityAggregationV1Schema = lazyZodSchema(() => z.enum(['lowest', 'median']));
export type ReviewQualityAggregationV1 = z.infer<typeof ReviewQualityAggregationV1Schema>;
