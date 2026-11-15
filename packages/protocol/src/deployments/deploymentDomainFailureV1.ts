import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id } from './deploymentIdentifiersV1.js';
import { ActionOperationAddressV1Schema } from '../actions/operations/addressV1.js';
import { MachineElevationFailureV1Schema } from '../machines/adminAccessV1.js';
import { ExternalActionAuthorizationRefusalPhaseSchema } from '../actions/externalActionAuthorizationRefusalPhase.js';
import { DeploymentFailureRecoveryV1Schema } from './deploymentFailureRecoveryV1.js';

export const DeploymentDomainCloudflareRecoveryV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('adopt'), tunnelId: id,
}));
export type DeploymentDomainCloudflareRecoveryV1 = z.infer<typeof DeploymentDomainCloudflareRecoveryV1Schema>;
const cloudflareRecoveryFields = {
    tunnelId: z.optional(id), recovery: z.optional(DeploymentDomainCloudflareRecoveryV1Schema),
};

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
    ...cloudflareRecoveryFields,
    requiredFact: z.enum(Object.values(deploymentDomainFailureFactsV1)),
    remedy: z.optional(z.string().check(z.trim(), z.minLength(1))),
    operation: z.optional(ActionOperationAddressV1Schema),
}).check(z.refine(value => deploymentDomainFailureFactsV1[value.step] === value.requiredFact)));
import { deploymentDomainCaddyRequiredFactsV1, DeploymentDomainCaddyFailureV1Schema } from './deploymentDomainCaddyFailureV1.js';
export { deploymentDomainCaddyRequiredFactsV1, DeploymentDomainCaddyFailureV1Schema, DeploymentDomainCaddyFailureDetailsV1Schema,
    type DeploymentDomainCaddyRequiredFactV1, type DeploymentDomainCaddyFailureV1,
    type DeploymentDomainCaddyFailureDetailsV1 } from './deploymentDomainCaddyFailureV1.js';
export const DeploymentDomainNativeRequiredFactV1Schema = lazyZodSchema(() => z.union([z.enum([
    'nativeExecutionResult', 'networkExposure',
    'reachabilityPosture', 'cloudflarePreparation', 'activeDomainMembers', 'domainIngress',
    'memberCaddyObservation', 'privateCaddyListener', 'sharedTunnelOrigin',
    'edgeCaddyMachine', 'publicCaddyObservation', 'publicCaddyListener', ...deploymentDomainCaddyRequiredFactsV1,
]), DeploymentFailureRecoveryV1Schema.shape.requiredFact]));
export const DeploymentDomainFailureDetailsV1Schema = lazyZodSchema(() => z.union([
    deploymentDomainServiceFailureDetailsV1Schema,
    z.strictObject({ environmentId: id, domainId: id, domainHostname: z.optional(id),
        step: z.literal('removeDomain'), partial: z.literal(true),
        requiredFact: z.union([DeploymentDomainNativeRequiredFactV1Schema,
            z.enum(Object.values(deploymentDomainFailureFactsV1)), ExternalActionAuthorizationRefusalPhaseSchema,
            z.nonoptional(MachineElevationFailureV1Schema.shape.requiredFact)]),
        remedy: z.string().check(z.trim(), z.minLength(1)) }),
    z.strictObject({ environmentId: id, domainId: id, step: z.literal('native_execution'),
        ...cloudflareRecoveryFields,
        /** Authored endpoint templates, issue paths and expected types; never response values. */
        providerOutput: z.optional(z.string().check(z.minLength(1))),
        requiredFact: z.optional(z.union([DeploymentDomainNativeRequiredFactV1Schema, ExternalActionAuthorizationRefusalPhaseSchema,
            MachineElevationFailureV1Schema.shape.requiredFact])),
        failure: z.optional(z.union([DeploymentDomainCaddyFailureV1Schema, MachineElevationFailureV1Schema])),
        remedy: z.optional(z.string().check(z.trim(), z.minLength(1))),
        operation: z.optional(ActionOperationAddressV1Schema) }).check(z.refine(value => value.requiredFact === undefined
            || DeploymentDomainNativeRequiredFactV1Schema.safeParse(value.requiredFact).success
            || ExternalActionAuthorizationRefusalPhaseSchema.safeParse(value.requiredFact).success
            || value.failure?.requiredFact === value.requiredFact)),
]));
export type DeploymentDomainFailureDetailsV1 = z.infer<typeof DeploymentDomainFailureDetailsV1Schema>;
