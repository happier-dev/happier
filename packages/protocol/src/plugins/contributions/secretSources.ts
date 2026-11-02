import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';

/** Value-free declaration. Native acquisition belongs to the executing Machine. */
export const PluginSecretSourceContributionV1Schema = lazyZodSchema(() => z.strictObject({
    id: asProtocolZod(PluginContributionLocalIdSchema),
    title: z.string().check(z.trim(), z.minLength(1)),
}));
export type PluginSecretSourceContributionV1 = z.infer<typeof PluginSecretSourceContributionV1Schema>;
