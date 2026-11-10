import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentTextV1Schema as text } from './storedAppInputV1.js';

export const DeploymentDomainProviderZoneV1Schema = lazyZodSchema(() => z.strictObject({ zoneId: text, name: text }));

/** Private provider observation. No timestamps: equivalent verification preserves the Domain revision. */
export const DeploymentDomainProviderResultV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), hostname: text, state: z.enum(['pending', 'active', 'failed', 'removed']),
    dns: z.array(z.strictObject({ type: text, name: text, value: text })),
}));
export type DeploymentDomainProviderResultV1 = z.infer<typeof DeploymentDomainProviderResultV1Schema>;
