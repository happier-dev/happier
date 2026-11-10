import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id } from './deploymentIdentifiersV1.js';
import { ActionOperationAddressV1Schema } from '../actions/operations/addressV1.js';
import { MachineElevationFailureV1Schema } from '../machines/adminAccessV1.js';
import { ExternalActionAuthorizationRefusalPhaseSchema } from '../actions/externalActionAuthorizationRefusalPhase.js';
import { DeploymentFailureRecoveryV1Schema } from './deploymentFailureRecoveryV1.js';

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
    remedy: z.optional(z.string().check(z.trim(), z.minLength(1))),
    operation: z.optional(ActionOperationAddressV1Schema),
}).check(z.refine(value => deploymentDomainFailureFactsV1[value.step] === value.requiredFact)));
export const deploymentDomainCaddyRequiredFactsV1 = [
    'caddyContainer', 'caddyMountedSeed', 'caddyAdminSocket', 'caddyAdminConfig',
    'caddyPublishedBindings', 'caddyListeners', 'caddyRoutedNetworks',
] as const;
export type DeploymentDomainCaddyRequiredFactV1 = typeof deploymentDomainCaddyRequiredFactsV1[number];
/** Safe native diagnostics only: command output and container error text stay private. */
export const DeploymentDomainCaddyFailureV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.enum(['native_observation_unavailable', 'native_effect_failed']),
    reason: z.enum(['required_fact_unavailable', 'native_effect_failed', 'port_in_use']),
    requiredFact: z.enum(deploymentDomainCaddyRequiredFactsV1),
    errorCode: z.optional(z.string().check(z.regex(/^(?:E[A-Z]+|HTTP_\d{3})$/))),
    stepId: z.optional(z.enum(['caddy-public-port', 'caddy-container-create', 'caddy-container-start',
        'caddy-container-stop', 'caddy-container-rm', 'caddy-container-wait', 'caddy-container-network-connect'])),
    nativeCommand: z.optional(z.strictObject({ command: z.literal('docker'),
        phase: z.enum(['create', 'start', 'stop', 'rm', 'wait', 'network-connect']),
        exitCode: z.nullable(z.number().check(z.int())) })),
    containerExitCode: z.optional(z.number().check(z.int())),
    containerError: z.optional(z.enum(['port_in_use', 'container_start_failed'])),
    port: z.optional(z.number().check(z.int(), z.gte(1), z.lte(65535))),
}));
export type DeploymentDomainCaddyFailureV1 = z.infer<typeof DeploymentDomainCaddyFailureV1Schema>;
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
