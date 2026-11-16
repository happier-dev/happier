import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentTextV1Schema as text } from './storedAppInputV1.js';
import { ActionFailureCauseV1Schema } from '../actions/actionExecutionResult.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';

export const DeploymentDomainProviderZoneV1Schema = lazyZodSchema(() => z.strictObject({ zoneId: text, name: text }));

/** Private provider observation. No timestamps: equivalent verification preserves the Domain revision. */
export const DeploymentDomainProviderResultV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), hostname: text, state: z.enum(['pending', 'active', 'failed', 'removed']),
    dns: z.array(z.strictObject({ type: text, name: text, value: text })),
    failureCause: z.optional(ActionFailureCauseV1Schema),
}));
export type DeploymentDomainProviderResultV1 = z.infer<typeof DeploymentDomainProviderResultV1Schema>;

/** Creation is witnessed by the configuring provider, never inferred from a name. */
export const DeploymentDomainTunnelOwnershipV1Schema = z.enum(['created', 'adopted']);
export const DeploymentDomainTunnelOwnershipV1ProtocolSchema = projectZodProtocolSchema(DeploymentDomainTunnelOwnershipV1Schema);
export type DeploymentDomainTunnelOwnershipV1 = z.infer<typeof DeploymentDomainTunnelOwnershipV1Schema>;

/** A retained tunnel does not prevent removal of the Domain's own routes. */
export const DeploymentDomainTunnelDispositionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('removed'), tunnelId: z.optional(text) }),
    z.strictObject({ kind: z.literal('retained'), tunnelId: z.optional(text),
        reason: z.enum(['shared', 'adopted', 'ownership_unknown', 'foreign_routes']) }),
]));
export const DeploymentDomainTunnelDispositionV1ProtocolSchema = projectZodProtocolSchema(DeploymentDomainTunnelDispositionV1Schema);
export type DeploymentDomainTunnelDispositionV1 = z.infer<typeof DeploymentDomainTunnelDispositionV1Schema>;
