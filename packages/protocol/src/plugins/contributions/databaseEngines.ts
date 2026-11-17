import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';

/** Structural capability grammar; each feature owns its operation vocabulary. */
export function createDatabaseEngineCapabilityV1Schema<TOperation extends z.ZodMiniType>(operation: TOperation) {
    return z.discriminatedUnion('available', [
        z.strictObject({ operation, available: z.literal(true) }),
        z.strictObject({ operation, available: z.literal(false), code: z.string().check(z.minLength(1)), reason: z.string() }),
    ]);
}

/** Cold declaration only; no credential or connection is serialized. */
export const PluginDatabaseEngineContributionV1Schema = lazyZodSchema(() => z.strictObject({
    id: asProtocolZod(PluginContributionLocalIdSchema),
    engineId: z.string().check(z.minLength(1)),
    scheme: z.string().check(z.regex(/^[a-z][a-z0-9+.-]*$/u)),
    capabilities: z.array(createDatabaseEngineCapabilityV1Schema(z.string().check(z.minLength(1)))),
}));
export type PluginDatabaseEngineContributionV1 = z.infer<typeof PluginDatabaseEngineContributionV1Schema>;
