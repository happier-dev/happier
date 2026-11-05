import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id } from './deploymentIdentifiersV1.js';
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
export const DeploymentDomainNativeRequiredFactV1Schema = lazyZodSchema(() => z.enum([
    'reachabilityPosture', 'cloudflarePreparation', 'activeDomainMembers', 'domainIngress',
    'memberCaddyObservation', 'privateCaddyListener', 'sharedTunnelOrigin',
    'edgeCaddyMachine', 'publicCaddyObservation', 'publicCaddyListener',
]));
export const DeploymentDomainFailureDetailsV1Schema = lazyZodSchema(() => z.union([
    deploymentDomainServiceFailureDetailsV1Schema,
    z.strictObject({ environmentId: id, domainId: id, step: z.literal('native_execution'),
        requiredFact: z.optional(DeploymentDomainNativeRequiredFactV1Schema),
        remedy: z.optional(z.string().check(z.trim(), z.minLength(1))),
        operation: z.optional(ActionOperationAddressV1Schema) }),
]));
export type DeploymentDomainFailureDetailsV1 = z.infer<typeof DeploymentDomainFailureDetailsV1Schema>;
