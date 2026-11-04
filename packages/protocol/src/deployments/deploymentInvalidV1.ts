import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Public validation facts only; values, unknown property names and validator messages stay private. */
export const DeploymentInvalidV1Schema = lazyZodSchema(() => z.strictObject({
    ok: z.literal(false), error: z.literal('deployment_invalid'),
    diagnostic: z.optional(z.strictObject({
        step: z.enum(['target_link.provider_links_read', 'target_link.environment_read', 'target_link.associate']),
        field: z.string(),
        rule: z.enum(['invalid_type', 'unrecognized_keys', 'invalid_value', 'constraint', 'path_mismatch']),
    })),
}));
export type DeploymentInvalidV1 = z.infer<typeof DeploymentInvalidV1Schema>;
