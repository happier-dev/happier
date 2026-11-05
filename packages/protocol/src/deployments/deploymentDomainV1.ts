import { z } from 'zod/mini';
export { DeploymentDomainHealthCheckV1Schema, type DeploymentDomainHealthCheckV1 } from './deploymentDomainHealthCheckV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision,
    DeploymentTimestampV1Schema as timestamp } from './deploymentIdentifiersV1.js';
import { DeploymentArtifactContentReferenceV1Schema } from './deploymentArtifactContentReferenceV1.js';
import { MachineInstallationProofV1Schema, type MachineInstallationProofPayloadV1 } from '../machines/identity/installationIdentity.js';
import { decodeBase64 } from '../crypto/base64.js';
import { verifyEd25519Signature } from '../crypto/ed25519.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { MachinePrivateNetworkObservationV1Schema } from '../plugins/contributions/accessProviders.js';
import { ArtifactJsonUpdateHttpInputV1Schema } from '../artifacts/artifactMutationHttpV1.js';
import { ActionOperationAddressV1Schema } from '../actions/operations/addressV1.js';

/** Content-free native service refusal facts; the host adds its actual operation receipt. */
export const deploymentDomainFailureFactsV1 = {
    service_docker: 'managedServiceDocker',
    container_identity: 'nativeContainerIdentity',
    service_replicas: 'nativeServiceReplicas',
    route_upstreams: 'routeUpstreams',
} as const;
export type DeploymentDomainFailureStepV1 = keyof typeof deploymentDomainFailureFactsV1;
const domainFailureSteps = Object.keys(deploymentDomainFailureFactsV1) as [DeploymentDomainFailureStepV1, ...DeploymentDomainFailureStepV1[]];
const deploymentDomainServiceFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
    environmentId: id, domainId: id, step: z.enum(domainFailureSteps),
    requiredFact: z.enum(Object.values(deploymentDomainFailureFactsV1)),
    operation: z.optional(ActionOperationAddressV1Schema),
}).check(z.refine(value => deploymentDomainFailureFactsV1[value.step] === value.requiredFact)));
export const DeploymentDomainFailureDetailsV1Schema = lazyZodSchema(() => z.union([
    deploymentDomainServiceFailureDetailsV1Schema,
    z.strictObject({ environmentId: id, domainId: id, step: z.literal('native_execution'),
        requiredFact: z.optional(z.literal('reachabilityPosture')),
        remedy: z.optional(z.string().check(z.trim(), z.minLength(1))),
        operation: z.optional(ActionOperationAddressV1Schema) }),
]));
export type DeploymentDomainFailureDetailsV1 = z.infer<typeof DeploymentDomainFailureDetailsV1Schema>;

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
export const NativeCaddyRemovalV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('removed'), placement: NativeCaddyRoutePlacementV1Schema,
    routeIds: z.array(id).check(z.minLength(1)), proof: MachineInstallationProofV1Schema,
}));
export type NativeCaddyRemoval = z.infer<typeof NativeCaddyRemovalV1Schema>;

/** Exact existing native signature bytes; native custody does not expose route material. */
export function nativeCaddyRemovalSigningBytes(placement: NativeCaddyRoutePlacement, routeIds: readonly string[]): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(['happier-native-caddy-removal-v1', placement.serverId, placement.accountId,
        placement.environmentId, placement.targetLinkId, placement.domainId, placement.machineId, placement.installationId,
        placement.actionOperationId, placement.requestId, placement.nativeServer, routeIds]));
}
export function nativeCaddyDomainRouteIdsV1(domainId: string, listener: 'privateOrigin' | 'public') {
    const routeId = `happier-route-${domainId}-${listener}`, proxyId = `happier-proxy-${domainId}-${listener}`;
    const fallbackId = `happier-fallback-${domainId}-${listener}`, redirectId = `happier-redirect-${domainId}-${listener}`;
    const tlsPolicyId = `happier-tls-policy-${domainId}-${listener}`, automationPolicyId = `happier-automation-policy-${domainId}-${listener}`;
    const certificateId = `happier-certificate-${domainId}-${listener}`;
    return { routeId, proxyId, fallbackId, redirectId, tlsPolicyId, automationPolicyId, certificateId,
        removalIds: listener === 'public' ? [routeId, fallbackId, redirectId, tlsPolicyId, automationPolicyId, certificateId]
            : [routeId, fallbackId] };
}
export function verifyNativeCaddyRemovalProofV1(result: NativeCaddyRemoval, expected: NativeCaddyRoutePlacement,
    expectedRouteIds: readonly string[], publicKey: Uint8Array): boolean {
    const parsed = NativeCaddyRemovalV1Schema.safeParse(result);
    return parsed.success && createCanonicalJsonSigningInput(parsed.data.placement) === createCanonicalJsonSigningInput(expected)
        && createCanonicalJsonSigningInput(parsed.data.routeIds) === createCanonicalJsonSigningInput(expectedRouteIds)
        && verifyEd25519Signature(nativeCaddyRemovalSigningBytes(parsed.data.placement, parsed.data.routeIds),
            decodeBase64(parsed.data.proof.signature, 'base64url'), publicKey);
}

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
/** Installation-signed, last-observed facts; no addresses, route material or reachability claim. */
export const DeploymentDomainNetworkExposureV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('ready'), listener: z.enum(['privateOrigin', 'public']),
        listeners: z.array(z.strictObject({ tls: z.boolean(), automaticHttpsDisabled: z.boolean(),
            endpoints: z.array(z.strictObject({ audience: z.enum(['loopback', 'privateNetwork', 'wildcard', 'other']),
                hostPort: z.number().check(z.int(), z.positive()),
                containerPort: z.number().check(z.int(), z.positive()), protocol: z.literal('tcp') })) })),
        localOrigin: z.boolean(), fallback: z.boolean() }),
    z.strictObject({ kind: z.literal('unavailable'), reason: id }),
]));
export type DeploymentDomainNetworkExposureV1 = z.infer<typeof DeploymentDomainNetworkExposureV1Schema>;
export const DeploymentDomainCapturedPlacementsV1Schema = lazyZodSchema(() => z.array(z.extend(DeploymentDomainPlacementV1Schema, {
    installationPublicKey: z.string().check(z.minLength(1)),
    networkExposure: z.optional(DeploymentDomainNetworkExposureV1Schema),
    execution: z.optional(z.strictObject({ controller: z.strictObject({ machineId: id, installationId: id }),
        requestEnvelopeDigest: z.string().check(z.minLength(1)), actionId: z.enum(['deployments.domains.add', 'deployments.domains.remove']),
    })),
})));

export const DeploymentDomainStateV1Schema = lazyZodSchema(() => z.enum([
    'pending', 'applying', 'active', 'warning', 'failed', 'removing',
]));

/** Source-admitted metadata records a reference, not current private-body access. */
export const DeploymentDomainHeaderV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), id, environmentId: id, targetLinkId: id, revision,
    state: DeploymentDomainStateV1Schema, ...DeploymentArtifactContentReferenceV1Schema.shape,
    createdByAccountId: id, observedAtMs: z.optional(timestamp),
    placements: z.optional(z.array(DeploymentDomainPlacementV1Schema)),
    networkExposure: z.optional(z.array(z.strictObject({ machineId: id, installationId: id, nativeServer: id,
        listener: z.enum(['privateOrigin', 'public']), observation: DeploymentDomainNetworkExposureV1Schema }))),
    createdAtMs: timestamp, updatedAtMs: timestamp, deletedAtMs: z.optional(timestamp),
}));
export type DeploymentDomainHeaderV1 = z.infer<typeof DeploymentDomainHeaderV1Schema>;

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
export const DeploymentDomainObservationBodyV1Schema = lazyZodSchema(() => z.strictObject({
    capture: DeploymentDomainPlacementV1Schema, state: z.enum(['active', 'warning', 'failed', 'removed']),
    networkExposure: z.optional(DeploymentDomainNetworkExposureV1Schema),
    removal: z.optional(NativeCaddyRemovalV1Schema),
}).check(z.refine(value => (value.state === 'removed') === (value.removal !== undefined),
    { message: 'Removed observations require exact native absence.' })));
export const DeploymentDomainObservationV1Schema = lazyZodSchema(() => z.extend(DeploymentDomainObservationBodyV1Schema, {
    proof: MachineInstallationProofV1Schema,
}));
export const DeploymentDomainTransitionInputV1Schema = lazyZodSchema(() => z.strictObject({ ...domain,
    expectedDomainRevision: revision, observations: z.array(DeploymentDomainObservationV1Schema).check(z.minLength(1)),
}));
/** The admitted controller commits vendor provenance before dispatching the captured native effect. */
export const DeploymentDomainPreparedContentInputV1Schema = lazyZodSchema(() => z.strictObject({ ...domain,
    expectedDomainRevision: revision, actionOperationId: id, capture: DeploymentDomainPlacementV1Schema,
    // Artifact history retains bodies, not headers: predecessor captures must keep their exact readable header.
    contentUpdate: z.strictObject({
        body: z.nonoptional(ArtifactJsonUpdateHttpInputV1Schema.shape.body),
        expectedBodyVersion: z.nonoptional(ArtifactJsonUpdateHttpInputV1Schema.shape.expectedBodyVersion),
        expectedHeaderVersion: ArtifactJsonUpdateHttpInputV1Schema.shape.expectedHeaderVersion,
        kind: ArtifactJsonUpdateHttpInputV1Schema.shape.kind,
    }),
}));
export type DeploymentDomainAddInputV1 = z.infer<typeof DeploymentDomainAddInputV1Schema>;
export type DeploymentDomainAddAdmissionInputV1 = z.infer<typeof DeploymentDomainAddAdmissionInputV1Schema>;
export type DeploymentDomainRemoveInputV1 = z.infer<typeof DeploymentDomainRemoveInputV1Schema>;
export type DeploymentDomainRemoveAdmissionInputV1 = z.infer<typeof DeploymentDomainRemoveAdmissionInputV1Schema>;
export type DeploymentDomainGetInputV1 = z.infer<typeof DeploymentDomainGetInputV1Schema>;
export type DeploymentDomainListInputV1 = z.infer<typeof DeploymentDomainListInputV1Schema>;
export type DeploymentDomainTransitionInputV1 = z.infer<typeof DeploymentDomainTransitionInputV1Schema>;
export type DeploymentDomainPreparedContentInputV1 = z.infer<typeof DeploymentDomainPreparedContentInputV1Schema>;
export type DeploymentDomainObservationBodyV1 = z.infer<typeof DeploymentDomainObservationBodyV1Schema>;

/** The incumbent installation-proof envelope signs exact material, native evidence and Domain CAS. */
export function deploymentDomainObservationProofPayloadV1(input: Readonly<{
    expectedDomainRevision: number; observation: DeploymentDomainObservationBodyV1;
}>): MachineInstallationProofPayloadV1 {
    const observation = DeploymentDomainObservationBodyV1Schema.parse(input.observation);
    const placement = observation.capture.placement;
    return { version: 1, machineId: placement.machineId, installationId: placement.installationId, accountId: placement.accountId,
        deploymentDomainTransition: { serverId: placement.serverId, environmentId: placement.environmentId, domainId: placement.domainId,
            actionOperationId: placement.actionOperationId, expectedRevision: input.expectedDomainRevision,
            requestBodyDigest: computeCanonicalDomainSeparatedDigest('happier-deployment-domain-observation-v1',
                [createCanonicalJsonSigningInput(observation)]) } };
}
