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

export const DeploymentDomainTopologyV1Schema = lazyZodSchema(() => z.strictObject({
    members: z.array(z.strictObject({ machineId: id, installationId: id })),
    machines: z.array(DeploymentDomainMachineTopologyV1Schema),
    tunnelOrigin: z.optional(z.strictObject({ service: id, members: z.array(z.strictObject({
        machineId: id, installationId: id, containerId: id, networkName: id, nativeServer: id,
    })) })),
}));
export type DeploymentDomainTopologyV1 = z.infer<typeof DeploymentDomainTopologyV1Schema>;

export const NativeCaddyRoutePlacementV1Schema = lazyZodSchema(() => z.strictObject({
    serverId: id, accountId: id, environmentId: id, targetLinkId: id, domainId: id,
    machineId: id, installationId: id, actionOperationId: id, requestId: id, nativeServer: id,
}));
export type NativeCaddyRoutePlacement = z.infer<typeof NativeCaddyRoutePlacementV1Schema>;

/** Current desired and unresolved native custody only; removed predecessors are discarded on settlement. */
export const DeploymentDomainPlacementV1Schema = lazyZodSchema(() => z.strictObject({
    placement: NativeCaddyRoutePlacementV1Schema, content: DeploymentArtifactContentReferenceV1Schema, desired: z.boolean(),
    listener: z.enum(['privateOrigin', 'public']), dockerEngineId: z.optional(id),
    /** Decided once by the Domain owner at removal admission for the Environment's shared tunnel. */
    retireSharedTunnel: z.optional(z.boolean()),
    environmentContent: z.optional(DeploymentArtifactContentReferenceV1Schema),
    targetLinkContent: z.optional(DeploymentArtifactContentReferenceV1Schema),
}));
export type DeploymentDomainPlacementV1 = z.infer<typeof DeploymentDomainPlacementV1Schema>;

const environment = { serverId: id, environmentId: id };
const domain = { ...environment, domainId: id };
const mutation = { ...domain, expectedRevision: revision, requestKey: id };
export const DeploymentDomainAddInputV1Schema = lazyZodSchema(() => z.strictObject({
    ...mutation, expectedDomainRevision: z.optional(revision), targetLinkId: id, expectedTargetLinkRevision: revision,
    ...DeploymentArtifactContentReferenceV1Schema.shape,
    placements: z.optional(z.array(z.strictObject({ machineId: id, installationId: id, nativeServer: id, dockerEngineId: id,
        listener: z.enum(['privateOrigin', 'public']) })).check(z.minLength(1),
        z.refine(items => new Set(items.map(item => `${item.machineId}:${item.installationId}:${item.nativeServer}`)).size === items.length,
            { message: 'Native placements must be unique.' }))),
}));
export const DeploymentDomainAddAdmissionInputV1Schema = lazyZodSchema(() => z.extend(DeploymentDomainAddInputV1Schema, {
    actionOperationId: id, requestId: id, placements: z.nonoptional(DeploymentDomainAddInputV1Schema.shape.placements),
}));
export const DeploymentDomainRemoveInputV1Schema = lazyZodSchema(() => z.strictObject({ ...mutation, expectedDomainRevision: revision }));
export const DeploymentDomainRemoveAdmissionInputV1Schema = lazyZodSchema(() => z.extend(DeploymentDomainRemoveInputV1Schema, {
    actionOperationId: id, requestId: id,
}));
export const DeploymentDomainGetInputV1Schema = lazyZodSchema(() => z.strictObject(domain));
export const DeploymentDomainListInputV1Schema = lazyZodSchema(() => z.strictObject({ ...environment,
    cursor: z.optional(id), limit: z.optional(z.number().check(z.int(), z.positive())),
}));
export const DeploymentDomainVerifyInputV1Schema = DeploymentDomainRemoveInputV1Schema;
