import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision,
    DeploymentTimestampV1Schema as timestamp } from './deploymentIdentifiersV1.js';
import { DeploymentArtifactContentReferenceV1Schema } from './deploymentArtifactContentReferenceV1.js';

import { MachinePrivateNetworkObservationV1Schema } from '../plugins/contributions/accessProviders.js';

/** Finite installed observations remain inside the private controller-to-target payload. */
export const DeploymentDomainMachineTopologyV1Schema = lazyZodSchema(() => z.strictObject({
    machineId: id, installationId: id, dockerEngineId: id, privateNetworks: z.array(MachinePrivateNetworkObservationV1Schema),
    caddy: z.strictObject({ status: z.literal('ready'), containerId: id, containerName: id, adminSocketPath: id,
        networkNames: z.array(id), servers: z.array(z.strictObject({ serverId: id, listen: z.array(id), tls: z.boolean(),
            automaticHttpsDisabled: z.boolean(), endpoints: z.array(z.strictObject({ hostAddress: id,
                hostPort: z.number().check(z.int(), z.positive()), containerPort: z.number().check(z.int(), z.positive()) })) })),
        containerOrigins: z.optional(z.array(z.strictObject({ serverId: id, networkName: id, service: id }))),
        privateOrigins: z.optional(z.array(z.strictObject({ serverId: id, endpoint: id, network: MachinePrivateNetworkObservationV1Schema }))),
    }), replicas: z.array(z.strictObject({ containerName: id, networkNames: z.array(id) })),
}));
export type DeploymentDomainMachineTopologyV1 = z.infer<typeof DeploymentDomainMachineTopologyV1Schema>;
export const DeploymentDomainStateV1Schema = lazyZodSchema(() => z.enum([
    'pending', 'applying', 'active', 'warning', 'failed', 'removing',
]));

/** Source-admitted metadata records a reference, not current private-body access. */
export const DeploymentDomainHeaderV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), id, environmentId: id, targetLinkId: id, revision,
    state: DeploymentDomainStateV1Schema, ...DeploymentArtifactContentReferenceV1Schema.shape,
    createdByAccountId: id, observedAtMs: z.optional(timestamp),
    createdAtMs: timestamp, updatedAtMs: timestamp, deletedAtMs: z.optional(timestamp),
}));
export type DeploymentDomainHeaderV1 = z.infer<typeof DeploymentDomainHeaderV1Schema>;
